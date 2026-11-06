#!/usr/bin/env node
const childProcess = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');
const Database = require('better-sqlite3');
const { loadEnvironment } = require('../config/load-env');
const { SAFE_PM2_APP, isProtectedPublicationPath, validateCandidate } = require('../lib/automation-publication');
const { reconcilePublications, resolveAutomationConfig } = require('../routes/automation');
const { backupAll } = require('../lib/platform-backup');
const { createStorage, resolveDataDir } = require('../lib/storage');

loadEnvironment();

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function run(command, args, options = {}) {
  const result = childProcess.spawnSync(command, args, {
    encoding: 'utf8',
    timeout: options.timeout || 300000,
    maxBuffer: 12 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const output = String(result.stderr || result.stdout || '').slice(-6000);
    throw new Error(`${path.basename(command)} wurde mit Status ${result.status} beendet.\n${output}`);
  }
  return String(result.stdout || '').trim();
}

function safeOutput(value, max = 16000) {
  return String(value || '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').slice(-max);
}

function resolvedLocalPath(value) {
  if (!value || /^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return null;
  try { return fs.realpathSync(path.resolve(value)); } catch { return null; }
}

function acquireLock(lockPath) {
  try {
    fs.mkdirSync(lockPath, { mode: 0o700 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const age = Date.now() - fs.statSync(lockPath).mtimeMs;
    if (age < 60 * 60 * 1000) throw new Error('Eine andere Veröffentlichung hält noch die exklusive Sperre.');
    fs.rmSync(lockPath, { recursive: true, force: true });
    fs.mkdirSync(lockPath, { mode: 0o700 });
  }
  fs.writeFileSync(path.join(lockPath, 'owner'), `${process.pid}\n${new Date().toISOString()}\n`, { mode: 0o600 });
}

function releaseLock(lockPath) {
  if (lockPath && fs.existsSync(lockPath)) fs.rmSync(lockPath, { recursive: true, force: true });
}

function waitForApplication(port, timeoutMs = 30000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const request = http.get({ host: '127.0.0.1', port, path: '/', timeout: 2500 }, response => {
        response.resume();
        if (response.statusCode >= 200 && response.statusCode < 500) return resolve();
        retry();
      });
      request.on('timeout', () => request.destroy());
      request.on('error', retry);
    };
    const retry = () => {
      if (Date.now() - started >= timeoutMs) return reject(new Error('Daybreak war nach dem Neustart nicht rechtzeitig erreichbar.'));
      setTimeout(attempt, 1000);
    };
    attempt();
  });
}

async function main() {
  const jobId = Number(argument('--job'));
  const dbPath = path.resolve(argument('--db') || 'loop.db');
  const projectRoot = path.resolve(argument('--project') || path.join(__dirname, '..'));
  if (!Number.isInteger(jobId) || jobId <= 0) throw new Error('Gültige --job ID fehlt.');
  const db = new Database(dbPath);
  db.pragma('busy_timeout = 10000');
  const config = resolveAutomationConfig(process.env, projectRoot);
  const steps = [];
  let lockPath = null;
  let lockAcquired = false;
  try {
    if (!config.publicationEnabled || !SAFE_PM2_APP.test(config.pm2App)) throw new Error('Die kontrollierte Veröffentlichung ist nicht freigeschaltet.');
    const claimed = db.prepare("UPDATE automation_jobs SET deployment_started_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=? AND deployment_status='publishing' AND deployment_started_at IS NULL").run(jobId);
    if (!claimed.changes) return;
    const job = db.prepare('SELECT * FROM automation_jobs WHERE id=?').get(jobId);
    const candidateError = validateCandidate(job);
    if (candidateError) throw new Error(candidateError);

    fs.mkdirSync(config.jobsRoot, { recursive: true, mode: 0o700 });
    lockPath = path.join(config.jobsRoot, 'publication.lock');
    acquireLock(lockPath);
    lockAcquired = true;
    steps.push('Exklusive Veröffentlichungssperre gesetzt.');

    const repositoryPath = fs.realpathSync(config.repository);
    const productionOrigin = run('git', ['remote', 'get-url', 'origin'], { cwd: projectRoot });
    if (resolvedLocalPath(productionOrigin) !== repositoryPath) throw new Error('Die produktive Arbeitskopie verwendet nicht das freigegebene zentrale Repository.');
    if (run('git', ['branch', '--show-current'], { cwd: projectRoot }) !== 'main') throw new Error('Die produktive Arbeitskopie befindet sich nicht auf main.');
    if (run('git', ['status', '--porcelain'], { cwd: projectRoot })) throw new Error('Die produktive Arbeitskopie enthält lokale Änderungen.');
    run('git', ['fetch', 'origin', 'main'], { cwd: projectRoot });
    const productionHead = run('git', ['rev-parse', 'HEAD'], { cwd: projectRoot });
    const remoteMain = run('git', ['rev-parse', 'origin/main'], { cwd: projectRoot });
    if (productionHead !== remoteMain) throw new Error('Die produktive Arbeitskopie und origin/main sind nicht synchron.');
    steps.push(`Produktionsstand ${productionHead.slice(0, 12)} ist sauber und synchron.`);

    const publicationRoot = path.join(config.jobsRoot, `publication-job-${jobId}`);
    const workspace = path.join(publicationRoot, 'workspace');
    fs.mkdirSync(publicationRoot, { recursive: true, mode: 0o700 });
    if (fs.existsSync(workspace)) fs.rmSync(workspace, { recursive: true, force: true });
    run('git', ['clone', '--no-local', repositoryPath, workspace]);
    run('git', ['fetch', 'origin', 'main', job.branch], { cwd: workspace });
    const remoteCandidate = run('git', ['rev-parse', `refs/remotes/origin/${job.branch}`], { cwd: workspace });
    if (remoteCandidate !== job.candidate_commit) throw new Error('Der Kandidaten-Branch zeigt nicht mehr auf den gespeicherten Commit.');
    run('git', ['merge-base', '--is-ancestor', job.base_commit, job.candidate_commit], { cwd: workspace });
    const files = run('git', ['diff', '--name-only', '-z', job.base_commit, job.candidate_commit], { cwd: workspace }).split('\0').filter(Boolean);
    if (!files.length) throw new Error('Der Kandidat enthält keine veröffentlichbare Änderung.');
    const protectedFiles = files.filter(isProtectedPublicationPath);
    if (protectedFiles.length) throw new Error(`Der Kandidat verändert geschützte Dateien: ${protectedFiles.join(', ')}`);
    for (const file of files) {
      const treeEntry = run('git', ['ls-tree', job.candidate_commit, '--', file], { cwd: workspace });
      if (treeEntry && !/^100(?:644|755)\s+blob\s/.test(treeEntry)) throw new Error(`Nicht erlaubter Dateityp im Kandidaten: ${file}`);
    }
    steps.push(`${files.length} geänderte Datei(en) gegen die Schutzliste geprüft.`);

    run('git', ['checkout', '-B', 'main', 'origin/main'], { cwd: workspace });
    const alreadyIntegrated = childProcess.spawnSync('git', ['merge-base', '--is-ancestor', job.candidate_commit, 'HEAD'], { cwd: workspace }).status === 0;
    if (!alreadyIntegrated) {
      run('git', ['-c', 'user.name=Daybreak Release', '-c', 'user.email=release@daybreak.local', 'merge', '--no-ff', '--no-edit', job.candidate_commit], { cwd: workspace });
    }
    const integratedCommit = run('git', ['rev-parse', 'HEAD'], { cwd: workspace });
    const testOutput = run('npm', ['test'], {
      cwd: workspace,
      timeout: 12 * 60 * 1000,
      env: { ...process.env, NODE_PATH: [path.join(projectRoot, 'node_modules'), process.env.NODE_PATH].filter(Boolean).join(path.delimiter) }
    });
    steps.push('Vollständiger Testlauf im zusammengeführten Stand erfolgreich.');
    if (!alreadyIntegrated) run('git', ['push', 'origin', 'main'], { cwd: workspace });
    steps.push(`Main auf ${integratedCommit.slice(0, 12)} aktualisiert.`);

    fs.mkdirSync(config.backupRoot, { recursive: true, mode: 0o700 });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(config.backupRoot, `daybreak_before_automation_job_${jobId}_${stamp}.db`);
    await db.backup(backupPath);
    fs.chmodSync(backupPath, 0o600);
    steps.push(`SQLite-Sicherung vor dem Neustart erstellt (${path.basename(backupPath)}).`);
    const tenantBackup = await backupAll({ storage: createStorage({ env: process.env, primaryDbPath: dbPath, dataDir: resolveDataDir(process.env, dbPath) }), backupRoot: config.backupRoot, stamp });
    if (tenantBackup.files.length) steps.push(`Alle Mandanten gesichert (${tenantBackup.files.length} Dateien in ${path.basename(tenantBackup.directory)}).`);

    run('git', ['fetch', 'origin', 'main'], { cwd: projectRoot });
    run('git', ['merge', '--ff-only', 'origin/main'], { cwd: projectRoot });
    if (run('git', ['rev-parse', 'HEAD'], { cwd: projectRoot }) !== integratedCommit) throw new Error('Die produktive Arbeitskopie konnte nicht auf den geprüften Commit aktualisiert werden.');
    steps.push('Produktive Arbeitskopie auf den geprüften Commit aktualisiert.');
    const preRestartOutput = safeOutput(`${steps.join('\n')}\n\nErneuter Testlauf:\n${testOutput}`);
    db.prepare("UPDATE automation_jobs SET deployment_status='restart_pending',deployment_commit=?,deployment_output=?,deployment_error=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=? AND deployment_status='publishing'")
      .run(integratedCommit, preRestartOutput, jobId);
    db.prepare('INSERT INTO automation_audit(actor_email,action,job_id,old_values,new_values) VALUES(?,?,?,?,?)')
      .run(job.deployed_by || 'root@root.de', 'automation_publication_restart_requested', jobId, JSON.stringify({ deploymentStatus: 'publishing' }), JSON.stringify({ deploymentStatus: 'restart_pending', deploymentCommit: integratedCommit }));
    releaseLock(lockPath);
    lockAcquired = false;
    run(config.pm2, ['restart', config.pm2App, '--update-env'], { cwd: projectRoot, timeout: 120000 });
    await waitForApplication(Number(process.env.PORT) || 3100);
    steps.push(`Produktionsprozess ${config.pm2App} neu gestartet und erreichbar.`);
    const output = safeOutput(`${steps.join('\n')}\n\nErneuter Testlauf:\n${testOutput}`);
    db.prepare("UPDATE automation_jobs SET deployment_output=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(output, jobId);
    reconcilePublications(db, projectRoot);
  } catch (error) {
    const message = safeOutput(error?.stack || error?.message || error, 10000);
    db.prepare("UPDATE automation_jobs SET deployment_status='publish_failed',deployment_error=?,deployment_output=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND deployment_status<>'published'")
      .run(message, safeOutput(steps.join('\n')), jobId);
    db.prepare('INSERT INTO automation_audit(actor_email,action,job_id,new_values) VALUES(?,?,?,?)')
      .run('automation@daybreak.local', 'automation_publication_failed', jobId, JSON.stringify({ error: message.slice(0, 1500) }));
    process.exitCode = 1;
  } finally {
    if (lockAcquired) releaseLock(lockPath);
    db.close();
  }
}

main().catch(error => {
  process.stderr.write(`${safeOutput(error?.stack || error)}\n`);
  process.exitCode = 1;
});
