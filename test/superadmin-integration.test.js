const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const { createStorage } = require('../lib/storage');

const projectRoot = path.resolve(__dirname, '..');
const isPostgres = Boolean(process.env.DAYBREAK_TEST_DATABASE_URL);

/** Öffnet nach dem Serverlauf die Daten des Hauptmandanten. */
function openPrimaryData(dbPath) {
  if (!isPostgres) return new Database(dbPath, { readonly: true });
  const storage = createStorage({ env: {}, primaryDbPath: dbPath });
  return storage.open(storage.primaryLocation);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForServer(baseUrl, child) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Testserver wurde unerwartet beendet.`);
    try {
      const response = await fetch(`${baseUrl}/api/auth/me`);
      if (response.status === 401) return;
    } catch {
      // Der Prozess initialisiert beim ersten Start das vollständige Demo-Schema.
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Testserver wurde nicht rechtzeitig erreichbar.');
}

async function stopServer(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise(resolve => child.once('exit', resolve)),
    new Promise(resolve => setTimeout(resolve, 3000))
  ]);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

test('Super-Admin besitzt HR-Vollzugriff, bleibt aber aus Personendaten ausgeblendet', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'daybreak-superadmin-test-'));
  const dbPath = path.join(directory, 'daybreak.db');
  const port = await freePort();
  const password = 'SuperRoot!Integration2026';
  const child = spawn(process.execPath, ['server.js'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      DAYBREAK_DB_PATH: dbPath,
      DAYBREAK_ENV_FILE: path.join(directory, 'nicht-vorhanden.env'),
      DAYBREAK_SUPERADMIN_PASSWORD_HASH: bcrypt.hashSync(password, 4),
      HOST: '127.0.0.1',
      PORT: String(port),
      SESSION_COOKIE_SECURE: 'false'
    },
    stdio: ['ignore', 'ignore', 'pipe']
  });

  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  let createdId;
  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    await waitForServer(baseUrl, child);
    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'root@root.de', password })
    });
    assert.equal(login.status, 200, stderr);
    const loginBody = await login.json();
    assert.equal(loginBody.user.role, 'super_admin');
    assert.ok(Number.isInteger(loginBody.user.id));
    const cookie = login.headers.get('set-cookie').split(';', 1)[0];
    const request = (url, options = {}) => fetch(`${baseUrl}${url}`, {
      ...options,
      headers: { cookie, ...(options.body ? { 'content-type': 'application/json' } : {}), ...options.headers }
    });

    for (const endpoint of [
      '/api/users',
      '/api/team',
      '/api/hierarchy',
      '/api/reports/overview',
      '/api/talent/overview',
      '/api/feedback/cycles',
      '/api/talent-review/periods',
      '/api/assistant/feedback?kind=improvements',
      // Die Automatisierung arbeitet nur mit SQLite.
      ...(isPostgres ? [] : ['/api/automation/status'])
    ]) {
      const response = await request(endpoint);
      assert.equal(response.status, 200, `${endpoint}: ${await response.text()}`);
    }

    const usersResponse = await request('/api/users');
    const users = (await usersResponse.json()).users;
    assert.equal(users.some(user => user.email === 'system-root@daybreak.internal'), false);

    const create = await request('/api/users', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Integration HR Admin',
        email: 'integration.hr@example.test',
        password: 'SicheresTestpasswort!2026',
        role: 'hr_admin',
        title: 'HR Administration'
      })
    });
    const createBody = await create.json();
    assert.equal(create.status, 200, JSON.stringify(createBody));
    createdId = createBody.id;
    assert.ok(Number.isInteger(createdId));
  } finally {
    await stopServer(child);
  }

  try {
    const db = openPrimaryData(dbPath);
    const systemActor = db.prepare("SELECT id,email,role,is_system_account FROM users WHERE email='system-root@daybreak.internal'").get();
    assert.deepEqual(systemActor, {
      id: systemActor.id,
      email: 'system-root@daybreak.internal',
      role: 'hr_admin',
      is_system_account: 1
    });
    const audit = db.prepare("SELECT actor_id,entity_id FROM audit_log WHERE action='user_created' AND entity_id=? ORDER BY id DESC LIMIT 1").get(createdId);
    assert.deepEqual(audit, { actor_id: systemActor.id, entity_id: createdId });
    db.close();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
