const assert = require('node:assert/strict');
const childProcess = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { afterEach, test } = require('node:test');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const express = require('express');
const { loadEnvironment, parseLine } = require('../config/load-env');
const { updateEnvironmentValues } = require('../config/update-env');
const { createCodexUsageReader, normalizeCodexRateLimits } = require('../lib/codex-usage');
const { CONFIRMATION_TEXT, isProtectedPublicationPath, validateCandidate } = require('../lib/automation-publication');
const { createLoginLimiter, isSecureSuperAdminRequest, isSuperAdminConfigured, verifySuperAdminPassword, virtualSuperAdmin } = require('../lib/superadmin');
const { createAutomationModule, initializeAutomation } = require('../routes/automation');
const { updateEnvironmentFile, validatePassword } = require('../scripts/set-superadmin-password');

const temporaryDirectories = [];
afterEach(() => {
  while (temporaryDirectories.length) fs.rmSync(temporaryDirectories.pop(), { recursive: true, force: true });
});

function temporaryDirectory() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'daybreak-automation-test-'));
  temporaryDirectories.push(directory);
  return directory;
}

test('geschützte Env-Datei speichert ausschließlich einen bcrypt-Hash', () => {
  const directory = temporaryDirectory();
  const file = path.join(directory, 'daybreak.env');
  fs.writeFileSync(file, 'PORT=3100\n', { mode: 0o600 });
  const password = 'SehrSicher!2026Root';
  updateEnvironmentFile(file, bcrypt.hashSync(password, 12));
  const content = fs.readFileSync(file, 'utf8');
  assert.match(content, /DAYBREAK_SUPERADMIN_PASSWORD_HASH=\$2[aby]\$12\$/);
  assert.doesNotMatch(content, new RegExp(password));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const env = {};
  loadEnvironment({ env, file });
  assert.equal(isSuperAdminConfigured(env), true);
  assert.equal(verifySuperAdminPassword(password, env), true);
  assert.equal(verifySuperAdminPassword('falsch', env), false);
  assert.equal(virtualSuperAdmin({ user: { kind: 'super_admin' } }, env).role, 'super_admin');
  assert.equal(virtualSuperAdmin({ user: { kind: 'super_admin' } }, {}), null);
});

test('Passwortregeln und Env-Parser behandeln nur explizite Schlüssel', () => {
  assert.match(validatePassword('zu-kurz'), /16 Zeichen/);
  assert.match(validatePassword('abcdefghijklmnop'), /Groß- und Kleinbuchstaben/);
  assert.equal(validatePassword('SehrSicher!2026Root'), null);
  assert.deepEqual(parseLine('export PORT="3100"'), ['PORT', '3100']);
  assert.equal(parseLine('# SECRET=wert'), null);
});

test('Env-Aktualisierung bewahrt vorhandene Werte und verhindert Zeileninjektion', () => {
  const directory = temporaryDirectory();
  const file = path.join(directory, 'daybreak.env');
  fs.writeFileSync(file, 'PORT=3100\nOLLAMA_MODEL=qwen3:4b\n', { mode: 0o600 });
  updateEnvironmentValues(file, { DAYBREAK_CODEX_MODEL: 'gpt-5.6-sol', PORT: '3200' });
  const content = fs.readFileSync(file, 'utf8');
  assert.match(content, /^PORT=3200$/m);
  assert.match(content, /^OLLAMA_MODEL=qwen3:4b$/m);
  assert.match(content, /^DAYBREAK_CODEX_MODEL=gpt-5\.6-sol$/m);
  assert.throws(() => updateEnvironmentValues(file, { BAD: 'value\nINJECTED=true' }), /mehrzeiliger Wert/);
});

test('Super-Admin-Login ist auf Loopback begrenzt und wird gedrosselt', () => {
  assert.equal(isSecureSuperAdminRequest({ secure: false, socket: { remoteAddress: '127.0.0.1' } }), true);
  assert.equal(isSecureSuperAdminRequest({ secure: false, socket: { remoteAddress: '192.168.2.50' } }), false);
  assert.equal(isSecureSuperAdminRequest({ secure: true, socket: { remoteAddress: '192.168.2.50' } }), true);
  const limiter = createLoginLimiter({ maxAttempts: 2, windowMs: 10000 });
  const request = { socket: { remoteAddress: '127.0.0.1' } };
  assert.equal(limiter.blocked(request), false);
  limiter.fail(request);
  limiter.fail(request);
  assert.equal(limiter.blocked(request), true);
  limiter.success(request);
  assert.equal(limiter.blocked(request), false);
});

test('Codex-Kontingent zeigt Restwert und Resetzeit ohne Schätzung', () => {
  const usage = normalizeCodexRateLimits({
    rateLimitsByLimitId: {
      codex: {
        limitId: 'codex',
        planType: 'plus',
        primary: { usedPercent: 80, windowDurationMins: 10080, resetsAt: 1785258418 },
        secondary: null,
        credits: { hasCredits: false, unlimited: false, balance: '0' }
      }
    }
  }, Date.UTC(2026, 6, 24));
  assert.equal(usage.available, true);
  assert.equal(usage.planType, 'plus');
  assert.equal(usage.windows[0].remainingPercent, 20);
  assert.equal(usage.windows[0].windowDurationMins, 10080);
  assert.equal(usage.windows[0].resetsAt, new Date(1785258418 * 1000).toISOString());
});

test('Codex-Kontingent wird zwischengespeichert und bei fehlenden Daten verborgen', async () => {
  let calls = 0;
  const read = createCodexUsageReader('/nicht-vorhanden', {
    ttlMs: 60000,
    query: async () => { calls += 1; return { available: false, fetchedAt: new Date().toISOString(), windows: [] }; }
  });
  assert.equal((await read()).available, false);
  assert.equal((await read()).available, false);
  assert.equal(calls, 1);
  assert.equal(normalizeCodexRateLimits({}).available, false);
});

async function withAutomation(callback, options = {}) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY,name TEXT NOT NULL);
    CREATE TABLE assistant_feedback (id INTEGER PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id),rating INTEGER NOT NULL,question TEXT NOT NULL,answer TEXT NOT NULL,expected_answer TEXT,priority TEXT,status TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
    INSERT INTO users(id,name) VALUES(1,'Testperson');
    INSERT INTO assistant_feedback(id,user_id,rating,question,answer,expected_answer,priority,status) VALUES(1,1,-1,'Wie geht das?','Öffne das Menü.','Nenne den konkreten Weg.','high','open');
  `);
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.testRole = req.get('x-test-role'); req.session = req.testRole ? { user: {} } : {}; next(); });
  const auth = (req, res, next) => req.testRole ? next() : res.status(401).json({ error: 'Nicht angemeldet' });
  const current = req => ({ id: null, name: 'Test', email: req.testRole === 'super_admin' ? 'root@root.de' : 'hr@example.test', role: req.testRole });
  const cleanText = (value, max = 4000) => typeof value === 'string' ? value.replace(/[<>]/g, '').trim().slice(0, max) : '';
  const directory = temporaryDirectory();
  const module = createAutomationModule({
    db,
    auth,
    current,
    cleanText,
    env: {
      DAYBREAK_GIT_REPOSITORY: path.join(directory, 'missing.git'),
      DAYBREAK_CODEX_CLI: path.join(directory, 'missing-codex'),
      ...options.env
    },
    projectRoot: path.resolve(__dirname, '..'),
    dbPath: path.join(directory, 'test.db'),
    spawnProcess: options.spawnProcess
  });
  app.use('/api', module.router);
  app.get('/api/dashboard', (req, res) => res.json({ ok: true }));
  const server = await new Promise(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  try { await callback(`http://127.0.0.1:${server.address().port}`, db); }
  finally { await new Promise(resolve => server.close(resolve)); db.close(); }
}

test('Programmier-API ist ausschließlich für Super-Admin zugänglich', async () => {
  await withAutomation(async (baseUrl, db) => {
    assert.equal((await fetch(`${baseUrl}/api/automation/status`)).status, 401);
    assert.equal((await fetch(`${baseUrl}/api/dashboard`)).status, 200);
    assert.equal((await fetch(`${baseUrl}/api/automation/status`, { headers: { 'x-test-role': 'hr_admin' } })).status, 403);
    assert.equal((await fetch(`${baseUrl}/api/automation/status`, { headers: { 'x-test-role': 'hrbp' } })).status, 403);
    const status = await fetch(`${baseUrl}/api/automation/status`, { headers: { 'x-test-role': 'super_admin' } });
    assert.equal(status.status, 200);
    const statusBody = await status.json();
    assert.equal(statusBody.ready, false);
    assert.equal(statusBody.codexUsage.available, false);

    const forbiddenCreate = await fetch(`${baseUrl}/api/automation/jobs`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-test-role': 'hr_admin' }, body: JSON.stringify({ objective: 'Eine ausreichend konkrete unerlaubte Änderung.' }) });
    assert.equal(forbiddenCreate.status, 403);
    const created = await fetch(`${baseUrl}/api/automation/jobs`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-test-role': 'super_admin' }, body: JSON.stringify({ feedbackId: 1, objective: 'Zeige den konkreten Navigationsweg in Dayos Antwort.' }) });
    assert.equal(created.status, 201);
    const job = await created.json();
    assert.equal(db.prepare('SELECT status,requested_by FROM automation_jobs WHERE id=?').get(job.id).status, 'draft');
    assert.equal(db.prepare('SELECT requested_by FROM automation_jobs WHERE id=?').get(job.id).requested_by, 'root@root.de');
    assert.equal(db.prepare('SELECT actor_email FROM automation_audit WHERE job_id=?').get(job.id).actor_email, 'root@root.de');

    const queue = await fetch(`${baseUrl}/api/automation/jobs/${job.id}/queue`, { method: 'POST', headers: { 'x-test-role': 'super_admin' } });
    assert.equal(queue.status, 503);
    assert.equal(db.prepare('SELECT status FROM automation_jobs WHERE id=?').get(job.id).status, 'draft');
  });
});

test('Veröffentlichung schützt sicherheitskritische Dateien und Kandidatenmetadaten', () => {
  assert.equal(isProtectedPublicationPath('routes/assistant.js'), false);
  assert.equal(isProtectedPublicationPath('test/assistant.test.js'), false);
  assert.equal(isProtectedPublicationPath('server.js'), true);
  assert.equal(isProtectedPublicationPath('routes/automation.js'), true);
  assert.equal(isProtectedPublicationPath('package-lock.json'), true);
  assert.equal(isProtectedPublicationPath('../outside'), true);
  const valid = { status: 'candidate_ready', branch: 'automation/dayo-5-job-1', base_commit: 'a'.repeat(40), candidate_commit: 'b'.repeat(40) };
  assert.equal(validateCandidate(valid), null);
  assert.match(validateCandidate({ ...valid, status: 'running' }), /fertig getesteter Kandidat/);
  assert.match(validateCandidate({ ...valid, branch: 'main' }), /Branch/);
});

test('Nur der Super-Admin kann einen fertigen Kandidaten bewusst veröffentlichen', async () => {
  const spawned = [];
  // Die Prüfung braucht nur ein vorhandenes Repository. Ein heruntergeladenes Archiv hat keinen eigenen .git-Ordner.
  const repository = temporaryDirectory();
  fs.writeFileSync(path.join(repository, 'HEAD'), 'ref: refs/heads/main\n');
  await withAutomation(async (baseUrl, db) => {
    const columns = new Set(db.prepare('PRAGMA table_info(automation_jobs)').all().map(column => column.name));
    assert.equal(columns.has('deployment_status'), true);
    assert.equal(columns.has('deployment_commit'), true);
    const result = db.prepare(`INSERT INTO automation_jobs(objective,status,branch,base_commit,candidate_commit,requested_by)
      VALUES(?,?,?,?,?,?)`).run('Eine ausreichend konkrete getestete Änderung.', 'candidate_ready', 'automation/dayo-manual-job-1', 'a'.repeat(40), 'b'.repeat(40), 'root@root.de');
    const id = result.lastInsertRowid;
    const endpoint = `${baseUrl}/api/automation/jobs/${id}/publish`;
    const body = JSON.stringify({ confirmation: CONFIRMATION_TEXT });
    assert.equal((await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', 'x-test-role': 'hr_admin' }, body })).status, 403);
    assert.equal((await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', 'x-test-role': 'super_admin' }, body: JSON.stringify({ confirmation: 'ja' }) })).status, 400);
    const published = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', 'x-test-role': 'super_admin' }, body });
    assert.equal(published.status, 202);
    assert.equal(db.prepare('SELECT deployment_status,deployed_by FROM automation_jobs WHERE id=?').get(id).deployment_status, 'publishing');
    assert.equal(db.prepare('SELECT deployed_by FROM automation_jobs WHERE id=?').get(id).deployed_by, 'root@root.de');
    assert.equal(db.prepare("SELECT COUNT(*) count FROM automation_audit WHERE job_id=? AND action='automation_publication_requested'").get(id).count, 1);
    assert.equal(spawned.length, 1);
    assert.match(spawned[0].args.join(' '), /publish-automation-job\.js/);
    assert.equal((await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', 'x-test-role': 'super_admin' }, body })).status, 409);
  }, {
    env: {
      DAYBREAK_AUTOMATION_PUBLISH_ENABLED: 'true',
      DAYBREAK_GIT_REPOSITORY: repository,
      DAYBREAK_PM2_APP: 'daybreak',
      DAYBREAK_PM2_CLI: '/usr/bin/true'
    },
    spawnProcess(command, args) {
      spawned.push({ command, args });
      return { unref() {} };
    }
  });
});

test('Veröffentlichungsworker integriert, testet, sichert und aktualisiert eine isolierte Produktionskopie', async () => {
  const directory = temporaryDirectory();
  const seed = path.join(directory, 'seed');
  const repository = path.join(directory, 'daybreak.git');
  const production = path.join(directory, 'production');
  const candidate = path.join(directory, 'candidate');
  const jobsRoot = path.join(directory, 'jobs');
  const backupRoot = path.join(directory, 'backups');
  const dbPath = path.join(directory, 'daybreak.db');
  const pm2 = path.join(directory, 'pm2');
  const run = (command, args, options = {}) => childProcess.execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options }).trim();

  fs.mkdirSync(seed);
  run('git', ['init', '-b', 'main'], { cwd: seed });
  fs.writeFileSync(path.join(seed, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
  fs.mkdirSync(path.join(seed, 'test'));
  fs.writeFileSync(path.join(seed, 'test', 'base.test.js'), "require('node:test')('Basis',()=>{});\n");
  run('git', ['add', '-A'], { cwd: seed });
  run('git', ['-c', 'user.name=Test', '-c', 'user.email=test@daybreak.local', 'commit', '-m', 'base'], { cwd: seed });
  const baseCommit = run('git', ['rev-parse', 'HEAD'], { cwd: seed });
  run('git', ['clone', '--bare', seed, repository]);
  run('git', ['clone', repository, production]);
  run('git', ['clone', repository, candidate]);
  run('git', ['checkout', '-b', 'automation/dayo-manual-job-1'], { cwd: candidate });
  fs.mkdirSync(path.join(candidate, 'src'));
  fs.writeFileSync(path.join(candidate, 'src', 'feature.js'), "module.exports = 'bereit';\n");
  fs.writeFileSync(path.join(candidate, 'test', 'feature.test.js'), "const test=require('node:test');const assert=require('node:assert/strict');test('Feature',()=>assert.equal(require('../src/feature'),'bereit'));\n");
  run('git', ['add', '-A'], { cwd: candidate });
  run('git', ['-c', 'user.name=Automation', '-c', 'user.email=automation@daybreak.local', 'commit', '-m', 'candidate'], { cwd: candidate });
  const candidateCommit = run('git', ['rev-parse', 'HEAD'], { cwd: candidate });
  run('git', ['push', 'origin', 'automation/dayo-manual-job-1'], { cwd: candidate });

  const db = new Database(dbPath);
  db.exec('CREATE TABLE users(id INTEGER PRIMARY KEY); CREATE TABLE assistant_feedback(id INTEGER PRIMARY KEY,user_id INTEGER REFERENCES users(id));');
  initializeAutomation(db);
  const jobId = db.prepare(`INSERT INTO automation_jobs(objective,status,branch,base_commit,candidate_commit,requested_by,deployment_status,deployed_by)
    VALUES(?,?,?,?,?,?,?,?)`).run('Isolierter Veröffentlichungstest mit vollständiger Prüfung.', 'candidate_ready', 'automation/dayo-manual-job-1', baseCommit, candidateCommit, 'root@root.de', 'publishing', 'root@root.de').lastInsertRowid;
  db.close();
  fs.writeFileSync(pm2, '#!/bin/sh\nexit 0\n', { mode: 0o700 });

  const health = http.createServer((request, response) => response.end('ok'));
  await new Promise(resolve => health.listen(0, '127.0.0.1', resolve));
  try {
    const worker = childProcess.spawn(process.execPath, [path.resolve(__dirname, '../scripts/publish-automation-job.js'), '--job', String(jobId), '--db', dbPath, '--project', production], {
      cwd: path.resolve(__dirname, '..'),
      env: {
        ...process.env,
        PORT: String(health.address().port),
        DAYBREAK_AUTOMATION_PUBLISH_ENABLED: 'true',
        DAYBREAK_GIT_REPOSITORY: repository,
        DAYBREAK_AUTOMATION_JOBS_ROOT: jobsRoot,
        DAYBREAK_BACKUP_ROOT: backupRoot,
        DAYBREAK_PM2_APP: 'daybreak',
        DAYBREAK_PM2_CLI: pm2
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = '';
    worker.stdout.on('data', chunk => { output += chunk; });
    worker.stderr.on('data', chunk => { output += chunk; });
    const exitCode = await new Promise(resolve => worker.on('exit', resolve));
    assert.equal(exitCode, 0, output);
  } finally {
    await new Promise(resolve => health.close(resolve));
  }

  const verified = new Database(dbPath, { readonly: true });
  const published = verified.prepare('SELECT deployment_status,deployment_commit,deployment_output,deployment_error FROM automation_jobs WHERE id=?').get(jobId);
  assert.equal(published.deployment_status, 'published');
  assert.equal(published.deployment_error, null);
  assert.match(published.deployment_output, /Vollständiger Testlauf/);
  assert.equal(run('git', ['rev-parse', 'HEAD'], { cwd: production }), published.deployment_commit);
  assert.equal(run('git', ['merge-base', '--is-ancestor', candidateCommit, published.deployment_commit], { cwd: production }), '');
  assert.equal(verified.prepare("SELECT COUNT(*) count FROM automation_audit WHERE job_id=? AND action='automation_publication_completed'").get(jobId).count, 1);
  verified.close();
  assert.equal(fs.readdirSync(backupRoot).filter(file => file.endsWith('.db')).length, 1);
});
