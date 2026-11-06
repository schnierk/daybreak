const childProcess = require('child_process');
const express = require('express');
const fs = require('fs');
const path = require('path');
const { createCodexUsageReader, unavailableUsage } = require('../lib/codex-usage');
const { CONFIRMATION_TEXT, SAFE_PM2_APP, validateCandidate } = require('../lib/automation-publication');

const JOB_STATUSES = new Set(['draft', 'queued', 'running', 'candidate_ready', 'failed', 'cancelled']);

function initializeAutomation(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS automation_jobs (
      id INTEGER PRIMARY KEY,
      feedback_id INTEGER REFERENCES assistant_feedback(id) ON DELETE SET NULL,
      objective TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','queued','running','candidate_ready','failed','cancelled')),
      branch TEXT,
      base_commit TEXT,
      candidate_commit TEXT,
      summary TEXT,
      test_output TEXT,
      error_message TEXT,
      requested_by TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      started_at TEXT,
      finished_at TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_automation_jobs_status_created ON automation_jobs(status,created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_automation_jobs_feedback ON automation_jobs(feedback_id);
    CREATE TABLE IF NOT EXISTS automation_audit (
      id INTEGER PRIMARY KEY,
      actor_email TEXT NOT NULL,
      action TEXT NOT NULL,
      job_id INTEGER REFERENCES automation_jobs(id),
      old_values TEXT,
      new_values TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  const columns = new Set(db.prepare('PRAGMA table_info(automation_jobs)').all().map(column => column.name));
  const additions = {
    deployment_status: 'TEXT',
    deployment_commit: 'TEXT',
    deployment_output: 'TEXT',
    deployment_error: 'TEXT',
    deployment_requested_at: 'TEXT',
    deployment_started_at: 'TEXT',
    deployed_at: 'TEXT',
    deployed_by: 'TEXT'
  };
  for (const [column, definition] of Object.entries(additions)) {
    if (!columns.has(column)) db.exec(`ALTER TABLE automation_jobs ADD COLUMN ${column} ${definition}`);
  }
}

function commandStatus(command, args = []) {
  try {
    const result = childProcess.spawnSync(command, args, { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] });
    return { available: result.status === 0, detail: String(result.stdout || result.stderr || '').trim().split(/\r?\n/)[0].slice(0, 160) };
  } catch {
    return { available: false, detail: '' };
  }
}

function resolveAutomationConfig(env = process.env, projectRoot = path.resolve(__dirname, '..')) {
  const repository = path.resolve(env.DAYBREAK_GIT_REPOSITORY || path.join(projectRoot, '..', 'repositories', 'daybreak.git'));
  const jobsRoot = path.resolve(env.DAYBREAK_AUTOMATION_JOBS_ROOT || path.join(projectRoot, '..', 'daybreak_jobs'));
  const codex = env.DAYBREAK_CODEX_CLI || 'codex';
  const worker = path.join(projectRoot, 'scripts', 'run-automation-job.js');
  const publicationWorker = path.join(projectRoot, 'scripts', 'publish-automation-job.js');
  const backupRoot = path.resolve(env.DAYBREAK_BACKUP_ROOT || path.join(projectRoot, '..', 'backups'));
  return {
    repository,
    jobsRoot,
    codex,
    worker,
    publicationWorker,
    backupRoot,
    model: env.DAYBREAK_CODEX_MODEL || 'gpt-5.6-sol',
    publicationEnabled: env.DAYBREAK_AUTOMATION_PUBLISH_ENABLED === 'true',
    pm2App: env.DAYBREAK_PM2_APP || '',
    pm2: env.DAYBREAK_PM2_CLI || 'pm2'
  };
}

function automationReadiness(config, env = process.env) {
  const git = commandStatus('git', ['--version']);
  const codex = commandStatus(config.codex, ['--version']);
  const login = codex.available ? commandStatus(config.codex, ['login', 'status']) : { available: false, detail: '' };
  const repositoryReady = fs.existsSync(config.repository) && fs.existsSync(path.join(config.repository, 'HEAD'));
  return {
    ready: git.available && codex.available && login.available && repositoryReady && fs.existsSync(config.worker),
    gitReady: git.available,
    codexInstalled: codex.available,
    codexAuthenticated: login.available,
    repositoryReady,
    workerReady: fs.existsSync(config.worker),
    codexVersion: codex.detail || null,
    model: config.model
  };
}

function publicationReadiness(config) {
  const processManagerConfigured = SAFE_PM2_APP.test(config.pm2App);
  const repositoryReady = fs.existsSync(config.repository) && fs.existsSync(path.join(config.repository, 'HEAD'));
  const pm2 = config.publicationEnabled && processManagerConfigured ? commandStatus(config.pm2, ['--version']) : { available: false, detail: '' };
  return {
    publicationReady: config.publicationEnabled && processManagerConfigured && repositoryReady && pm2.available && fs.existsSync(config.publicationWorker),
    publicationEnabled: config.publicationEnabled,
    publicationWorkerReady: fs.existsSync(config.publicationWorker),
    publicationRepositoryReady: repositoryReady,
    processManagerReady: pm2.available,
    processManagerApp: config.pm2App || null
  };
}

function reconcilePublications(db, projectRoot = path.resolve(__dirname, '..')) {
  const head = childProcess.spawnSync('git', ['rev-parse', 'HEAD'], { cwd: projectRoot, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] });
  if (head.status !== 0) return { reconciled: 0, currentCommit: null };
  const currentCommit = String(head.stdout || '').trim();
  const pending = db.prepare("SELECT * FROM automation_jobs WHERE deployment_status IN ('publishing','restart_pending') ORDER BY id").all();
  let reconciled = 0;
  for (const job of pending) {
    const included = childProcess.spawnSync('git', ['merge-base', '--is-ancestor', job.candidate_commit, currentCommit], { cwd: projectRoot, timeout: 5000, stdio: 'ignore' });
    if (included.status !== 0) continue;
    const recoveryNote = job.deployment_status === 'restart_pending'
      ? 'Der neue Daybreak-Prozess hat den produktiven Commit nach dem Neustart bestätigt.'
      : 'Der produktive Commit war bereits aktiv; der beim Neustart unterbrochene Status wurde wiederhergestellt.';
    const output = [job.deployment_output, recoveryNote].filter(Boolean).join('\n');
    const changed = db.prepare("UPDATE automation_jobs SET deployment_status='published',deployment_commit=?,deployment_output=?,deployment_error=NULL,deployed_at=COALESCE(deployed_at,CURRENT_TIMESTAMP),updated_at=CURRENT_TIMESTAMP WHERE id=? AND deployment_status IN ('publishing','restart_pending')")
      .run(currentCommit, output, job.id);
    if (!changed.changes) continue;
    db.prepare('INSERT INTO automation_audit(actor_email,action,job_id,old_values,new_values) VALUES(?,?,?,?,?)')
      .run(job.deployed_by || 'automation@daybreak.local', 'automation_publication_completed', job.id, JSON.stringify({ deploymentStatus: job.deployment_status }), JSON.stringify({ deploymentStatus: 'published', deploymentCommit: currentCommit }));
    reconciled += 1;
  }
  return { reconciled, currentCommit };
}

function createAutomationModule({ db, auth, current, cleanText, env = process.env, projectRoot = path.resolve(__dirname, '..'), dbPath, codexUsageReader = null, spawnProcess = childProcess.spawn }) {
  const router = express.Router();
  const config = resolveAutomationConfig(env, projectRoot);
  const readCodexUsage = codexUsageReader || createCodexUsageReader(config.codex);
  let cachedReadiness = null;
  let readinessExpiresAt = 0;
  initializeAutomation(db);
  reconcilePublications(db, projectRoot);

  const superAdminOnly = (req, res, next) => current(req)?.role === 'super_admin' ? next() : res.status(403).json({ error: 'Nur die Systemadministration darf die Programmierfunktion verwenden.' });
  const audit = (actor, action, jobId, oldValues = null, newValues = null) => db.prepare('INSERT INTO automation_audit(actor_email,action,job_id,old_values,new_values) VALUES(?,?,?,?,?)').run(actor.email, action, jobId || null, oldValues ? JSON.stringify(oldValues) : null, newValues ? JSON.stringify(newValues) : null);
  const findJob = id => db.prepare('SELECT * FROM automation_jobs WHERE id=?').get(id);

  router.use('/automation', auth, superAdminOnly);

  const currentReadiness = () => {
    if (cachedReadiness && Date.now() < readinessExpiresAt) return cachedReadiness;
    cachedReadiness = automationReadiness(config, env);
    readinessExpiresAt = Date.now() + 30000;
    return cachedReadiness;
  };

  router.get('/automation/status', async (req, res) => {
    const readiness = currentReadiness();
    const publication = publicationReadiness(config);
    const counts = Object.fromEntries(db.prepare('SELECT status,COUNT(*) count FROM automation_jobs GROUP BY status').all().map(row => [row.status, row.count]));
    const codexUsage = readiness.codexAuthenticated ? await readCodexUsage() : unavailableUsage();
    res.json({ ...readiness, ...publication, counts, codexUsage, policy: { isolatedWorkspace: true, productionAutoDeploy: false, supervisedPublication: true, hrAccess: false } });
  });

  router.get('/automation/feedback', (req, res) => {
    const items = db.prepare(`SELECT feedback.id,feedback.question,feedback.answer,feedback.expected_answer,feedback.priority,feedback.status,feedback.created_at,person.name user_name,
      (SELECT jobs.status FROM automation_jobs jobs WHERE jobs.feedback_id=feedback.id ORDER BY jobs.id DESC LIMIT 1) automation_status
      FROM assistant_feedback feedback JOIN users person ON person.id=feedback.user_id
      WHERE feedback.rating=-1 AND feedback.status IN ('open','in_progress') ORDER BY CASE feedback.priority WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'normal' THEN 3 ELSE 4 END,feedback.created_at DESC LIMIT 100`).all();
    res.json({ items });
  });

  router.get('/automation/jobs', (req, res) => {
    const jobs = db.prepare('SELECT * FROM automation_jobs ORDER BY id DESC LIMIT 100').all();
    res.json({ jobs });
  });

  router.post('/automation/jobs', (req, res) => {
    const actor = current(req);
    const feedbackId = req.body?.feedbackId ? Number(req.body.feedbackId) : null;
    const feedback = feedbackId ? db.prepare("SELECT id,question,answer,expected_answer FROM assistant_feedback WHERE id=? AND rating=-1").get(feedbackId) : null;
    if (feedbackId && !feedback) return res.status(404).json({ error: 'Verbesserungsvorschlag nicht gefunden.' });
    const suggestedObjective = feedback ? `Verbessere Daybreak auf Grundlage dieses geprüften Feedbacks. Frage: ${feedback.question}\nBisherige Antwort: ${feedback.answer}\nErwartetes Ergebnis: ${feedback.expected_answer}` : '';
    const objective = cleanText(req.body?.objective || suggestedObjective, 4000);
    if (objective.length < 20) return res.status(400).json({ error: 'Bitte beschreibe das gewünschte Ergebnis konkret.' });
    const result = db.prepare('INSERT INTO automation_jobs(feedback_id,objective,requested_by) VALUES(?,?,?)').run(feedback?.id || null, objective, actor.email);
    audit(actor, 'automation_job_created', result.lastInsertRowid, null, { feedbackId: feedback?.id || null, status: 'draft' });
    res.status(201).json({ id: result.lastInsertRowid, status: 'draft' });
  });

  router.post('/automation/jobs/:id/queue', (req, res) => {
    const actor = current(req);
    const id = Number(req.params.id);
    const job = findJob(id);
    if (!job) return res.status(404).json({ error: 'Programmierauftrag nicht gefunden.' });
    if (!['draft', 'failed'].includes(job.status)) return res.status(409).json({ error: 'Dieser Auftrag kann in seinem aktuellen Status nicht gestartet werden.' });
    const readiness = automationReadiness(config, env);
    if (!readiness.ready) return res.status(503).json({ error: 'Git, Repository oder Codex-Zugang ist noch nicht vollständig eingerichtet.', readiness });
    const changed = db.prepare("UPDATE automation_jobs SET status='queued',error_message=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status IN ('draft','failed')").run(id);
    if (!changed.changes) return res.status(409).json({ error: 'Der Auftrag wurde bereits anderweitig gestartet.' });
    audit(actor, 'automation_job_queued', id, { status: job.status }, { status: 'queued' });
    const child = spawnProcess(process.execPath, [config.worker, '--job', String(id), '--db', dbPath], {
      detached: true,
      stdio: 'ignore',
      cwd: projectRoot,
      env: { ...env, DAYBREAK_GIT_REPOSITORY: config.repository, DAYBREAK_AUTOMATION_JOBS_ROOT: config.jobsRoot, DAYBREAK_CODEX_CLI: config.codex, DAYBREAK_CODEX_MODEL: config.model }
    });
    child.unref();
    res.status(202).json({ id, status: 'queued' });
  });

  router.post('/automation/jobs/:id/publish', (req, res) => {
    const actor = current(req);
    const id = Number(req.params.id);
    const job = findJob(id);
    if (!job) return res.status(404).json({ error: 'Programmierauftrag nicht gefunden.' });
    const candidateError = validateCandidate(job);
    if (candidateError) return res.status(409).json({ error: candidateError });
    if (req.body?.confirmation !== CONFIRMATION_TEXT) return res.status(400).json({ error: `Bitte bestätige die Veröffentlichung mit ${CONFIRMATION_TEXT}.` });
    const publication = publicationReadiness(config);
    if (!publication.publicationReady) return res.status(503).json({ error: 'Die kontrollierte Veröffentlichung ist auf diesem Server noch nicht freigeschaltet.', publication });
    if (job.deployment_status === 'published') return res.status(409).json({ error: 'Dieser Kandidat wurde bereits veröffentlicht.' });
    if (job.deployment_status === 'publishing') return res.status(409).json({ error: 'Dieser Kandidat wird bereits veröffentlicht.' });
    if (job.deployment_status === 'restart_pending') return res.status(409).json({ error: 'Der Produktiv-Neustart dieses Kandidaten wird gerade bestätigt.' });
    if (db.prepare("SELECT id FROM automation_jobs WHERE deployment_status IN ('publishing','restart_pending') AND id<>?").get(id)) return res.status(409).json({ error: 'Eine andere Veröffentlichung läuft bereits. Bitte warte auf deren Abschluss.' });
    const changed = db.prepare("UPDATE automation_jobs SET deployment_status='publishing',deployment_error=NULL,deployment_output=NULL,deployment_requested_at=CURRENT_TIMESTAMP,deployment_started_at=NULL,deployed_at=NULL,deployed_by=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='candidate_ready' AND COALESCE(deployment_status,'') NOT IN ('publishing','restart_pending','published')").run(actor.email, id);
    if (!changed.changes) return res.status(409).json({ error: 'Die Veröffentlichung wurde bereits anderweitig gestartet.' });
    audit(actor, 'automation_publication_requested', id, { deploymentStatus: job.deployment_status || null }, { deploymentStatus: 'publishing', candidateCommit: job.candidate_commit });
    try {
      const child = spawnProcess(process.execPath, [config.publicationWorker, '--job', String(id), '--db', dbPath, '--project', projectRoot], {
        detached: true,
        stdio: 'ignore',
        cwd: projectRoot,
        env: {
          ...env,
          DAYBREAK_GIT_REPOSITORY: config.repository,
          DAYBREAK_AUTOMATION_JOBS_ROOT: config.jobsRoot,
          DAYBREAK_BACKUP_ROOT: config.backupRoot,
          DAYBREAK_PM2_APP: config.pm2App,
          DAYBREAK_PM2_CLI: config.pm2
        }
      });
      child.unref();
    } catch (error) {
      const message = String(error?.message || error).slice(0, 1000);
      db.prepare("UPDATE automation_jobs SET deployment_status='publish_failed',deployment_error=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(message, id);
      audit(actor, 'automation_publication_spawn_failed', id, { deploymentStatus: 'publishing' }, { deploymentStatus: 'publish_failed', error: message });
      return res.status(500).json({ error: 'Der Veröffentlichungsprozess konnte nicht gestartet werden.' });
    }
    res.status(202).json({ id, deploymentStatus: 'publishing' });
  });

  router.post('/automation/jobs/:id/cancel', (req, res) => {
    const actor = current(req);
    const id = Number(req.params.id);
    const job = findJob(id);
    if (!job) return res.status(404).json({ error: 'Programmierauftrag nicht gefunden.' });
    if (!['draft', 'queued'].includes(job.status)) return res.status(409).json({ error: 'Nur noch nicht gestartete Aufträge können abgebrochen werden.' });
    db.prepare("UPDATE automation_jobs SET status='cancelled',finished_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(id);
    audit(actor, 'automation_job_cancelled', id, { status: job.status }, { status: 'cancelled' });
    res.json({ id, status: 'cancelled' });
  });

  return { router, config, initialize: () => initializeAutomation(db) };
}

module.exports = { JOB_STATUSES, automationReadiness, createAutomationModule, initializeAutomation, publicationReadiness, reconcilePublications, resolveAutomationConfig };
