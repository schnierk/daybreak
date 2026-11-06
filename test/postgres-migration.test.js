'use strict';

/**
 * Zieht eine echte SQLite-Installation nach PostgreSQL um und arbeitet danach mit ihr weiter.
 * Läuft nur, wenn eine Testdatenbank angegeben ist: DAYBREAK_TEST_DATABASE_URL=postgres://... npm test
 */

const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const bcrypt = require('bcryptjs');
const { bridgeFor } = require('../lib/postgres/bridge');

const testUrl = process.env.DAYBREAK_TEST_DATABASE_URL;
const projectRoot = path.resolve(__dirname, '..');
const ROOT_PASSWORD = 'SuperRoot!Umzug2026xy';
const hasPgDump = spawnSync('pg_dump', ['--version']).status === 0;

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(error => (error ? reject(error) : resolve(port)));
    });
  });
}

/** Startet Daybreak als eigenen Prozess, wahlweise mit SQLite oder PostgreSQL. */
// Scheitert ein Test mittendrin, darf kein Server weiterlaufen und den ganzen Testlauf aufhalten.
const runningServers = new Set();

async function startServer({ directory, databaseUrl = null, demo = true }) {
  const port = await freePort();
  const environment = { ...process.env };
  delete environment.DAYBREAK_TEST_DATABASE_URL;
  delete environment.DAYBREAK_DATABASE_URL;
  Object.assign(environment, {
    DAYBREAK_ENV_FILE: '/nonexistent',
    DAYBREAK_DB_PATH: path.join(directory, 'loop.db'),
    DAYBREAK_BACKUP_ROOT: path.join(directory, 'backups'),
    DAYBREAK_PRIMARY_DEMO: demo ? 'true' : 'false',
    DAYBREAK_SUPERADMIN_PASSWORD_HASH: bcrypt.hashSync(ROOT_PASSWORD, 4),
    NODE_ENV: 'test',
    SESSION_COOKIE_SECURE: 'false',
    SESSION_SECRET: 'nur-fuer-den-test',
    HOST: '127.0.0.1',
    PORT: String(port),
    ...(databaseUrl ? { DAYBREAK_DATABASE_URL: databaseUrl } : {})
  });
  const child = spawn(process.execPath, ['server.js'], { cwd: projectRoot, env: environment, stdio: ['ignore', 'ignore', 'pipe'] });
  runningServers.add(child);
  child.once('exit', () => runningServers.delete(child));
  let errors = '';
  child.stderr.on('data', chunk => {
    errors += chunk;
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  for (let attempt = 0; ; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Der Server wurde beendet: ${errors}`);
    if (attempt > 300) throw new Error(`Der Server wurde nicht erreichbar: ${errors}`);
    try {
      if ((await fetch(`${baseUrl}/api/public/context`)).ok) break;
    } catch {
      // Startet noch.
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const stop = () => new Promise(resolve => {
    child.once('exit', resolve);
    child.kill('SIGTERM');
  });
  return { baseUrl, stop };
}

async function signIn(baseUrl, email, password, tenant) {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password, ...(tenant ? { tenant } : {}) })
  });
  assert.equal(response.status, 200, await response.clone().text());
  const cookie = response.headers.get('set-cookie').split(';', 1)[0];
  return async (method, url, body) => {
    const result = await fetch(`${baseUrl}${url}`, {
      method,
      headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await result.text();
    let data = text;
    try {
      data = JSON.parse(text);
    } catch {
      // Bleibt Text.
    }
    return { status: result.status, data };
  };
}

function runScript(script, directory, databaseUrl, backupRoot = path.join(directory, 'backups')) {
  const environment = { ...process.env };
  delete environment.DAYBREAK_TEST_DATABASE_URL;
  Object.assign(environment, {
    DAYBREAK_ENV_FILE: '/nonexistent',
    DAYBREAK_DB_PATH: path.join(directory, 'loop.db'),
    DAYBREAK_BACKUP_ROOT: backupRoot,
    DAYBREAK_DATABASE_URL: databaseUrl
  });
  return spawnSync(process.execPath, [script], { cwd: projectRoot, env: environment, encoding: 'utf8' });
}

test('Umzug von SQLite nach PostgreSQL und Weiterarbeit', { skip: !testUrl, timeout: 180000 }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'daybreak-umzug-'));
  const databaseName = `umzug_${process.pid}_${Date.now()}`;
  const restoreName = `${databaseName}_restore`;
  const admin = bridgeFor(testUrl);
  const urlOf = name => {
    const url = new URL(testUrl);
    url.pathname = `/${name}`;
    return url.toString();
  };
  admin.call({ simple: true, text: `CREATE DATABASE ${databaseName}` });
  admin.call({ simple: true, text: `CREATE DATABASE ${restoreName}` });
  t.after(() => {
    for (const child of runningServers) child.kill('SIGKILL');
    admin.call({ simple: true, text: `DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)` });
    admin.call({ simple: true, text: `DROP DATABASE IF EXISTS ${restoreName} WITH (FORCE)` });
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const target = urlOf(databaseName);

  // 1. Eine SQLite-Installation mit Demo-Daten und einer zweiten Organisation.
  const first = await startServer({ directory });
  const root = await signIn(first.baseUrl, 'root@root.de', ROOT_PASSWORD);
  const created = await root('POST', '/api/platform/tenants', { slug: 'acme', name: 'Acme GmbH', adminName: 'Ada Admin', adminEmail: 'ada@acme.example', adminPassword: 'TemporaerAcme!2026' });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const hr = await signIn(first.baseUrl, 'elena@loop.local', 'demo1234');
  const usersBefore = (await hr('GET', '/api/users')).data.users;
  const goalsBefore = (await hr('GET', '/api/goals')).data;
  assert.ok(usersBefore.length > 3);
  await first.stop();
  const sqliteFile = path.join(directory, 'loop.db');
  const sqliteBytes = fs.readFileSync(sqliteFile);

  // 2. Umzug.
  const moved = runScript('scripts/migrate-to-postgres.js', directory, target);
  assert.equal(moved.status, 0, moved.stderr);
  assert.match(moved.stdout, /Umzug abgeschlossen: 2 Organisation/);
  assert.ok(fs.readFileSync(sqliteFile).equals(sqliteBytes), 'Die SQLite-Datei bleibt unverändert');

  // 3. Ein zweiter Lauf verändert nichts.
  const again = runScript('scripts/migrate-to-postgres.js', directory, target);
  assert.equal(again.status, 1);
  assert.match(again.stderr, /Es wurde nichts verändert/);

  // 4. Daybreak läuft auf PostgreSQL mit denselben Daten und denselben Passwörtern.
  const second = await startServer({ directory, databaseUrl: target });
  const hrAfter = await signIn(second.baseUrl, 'elena@loop.local', 'demo1234');
  assert.deepEqual((await hrAfter('GET', '/api/users')).data.users, usersBefore);
  assert.deepEqual((await hrAfter('GET', '/api/goals')).data, goalsBefore);
  const acme = await signIn(second.baseUrl, 'ada@acme.example', 'TemporaerAcme!2026', 'acme');
  assert.equal((await acme('GET', '/api/auth/me')).data.user.email, 'ada@acme.example');

  // 5. Neue Datensätze bekommen freie Nummern, die Organisationen bleiben getrennt.
  const added = await hrAfter('POST', '/api/users', { name: 'Neu Nach Umzug', email: 'neu@loop.local', password: 'TemporaerNeu!2026xy', role: 'employee', title: 'Test', managerId: usersBefore.find(user => user.role === 'manager').id });
  assert.ok([200, 201].includes(added.status), JSON.stringify(added.data));
  const usersAfter = (await hrAfter('GET', '/api/users')).data.users;
  assert.equal(usersAfter.length, usersBefore.length + 1);
  const newest = usersAfter.find(user => user.email === 'neu@loop.local');
  assert.ok(newest.id > Math.max(...usersBefore.map(user => user.id)));

  // 6. Der Betreiber sieht beide Organisationen und kann eine weitere anlegen.
  const rootAfter = await signIn(second.baseUrl, 'root@root.de', ROOT_PASSWORD);
  const tenants = (await rootAfter('GET', '/api/platform/tenants')).data.tenants;
  assert.deepEqual(tenants.map(tenant => tenant.slug).sort(), ['acme', 'default']);
  const third = await rootAfter('POST', '/api/platform/tenants', { slug: 'beta-ag', name: 'Beta AG', adminName: 'Bo Admin', adminEmail: 'bo@beta.example' });
  assert.equal(third.status, 201, JSON.stringify(third.data));

  // 7. Vergütungseinträge bleiben auch hier vor dem Überschreiben geschützt.
  const schemaNames = admin.call({ text: 'SELECT datname FROM pg_database WHERE datname=$1', params: [databaseName] }).rows;
  assert.equal(schemaNames.length, 1);
  await second.stop();

  const database = bridgeFor(target);
  const triggers = database.call({ text: "SELECT count(*) AS count FROM pg_trigger WHERE tgname='compensation_records_never_overwrite' AND NOT tgisinternal" }).rows[0].count;
  assert.ok(triggers >= 1, 'Der Schutz-Trigger ist angelegt');
  const sessions = database.call({ text: 'SELECT count(*) AS count FROM daybreak_control.app_sessions' }).rows[0].count;
  assert.ok(sessions >= 1, 'Neue Sitzungen werden gespeichert');

  // 8. Sicherung und Wiederherstellung einer Organisation.
  if (hasPgDump) {
    const backupRoot = path.join(directory, 'backup-postgres');
    const backup = runScript('scripts/backup-all.js', directory, target, backupRoot);
    assert.equal(backup.status, 0, backup.stderr);
    const folder = path.join(backupRoot, fs.readdirSync(backupRoot)[0]);
    const files = fs.readdirSync(folder).sort();
    assert.deepEqual(files, ['control.sql', 'tenant-acme.sql', 'tenant-beta-ag.sql', 'tenant-default.sql']);
    for (const file of files) assert.equal(fs.statSync(path.join(folder, file)).mode & 0o777, 0o600);
    assert.equal(fs.readFileSync(path.join(folder, 'tenant-acme.sql'), 'utf8').includes('elena@loop.local'), false, 'Keine fremden Daten in der Sicherung');

    const restore = spawnSync('psql', ['--dbname', urlOf(restoreName), '--set', 'ON_ERROR_STOP=1', '--quiet', '--file', path.join(folder, 'tenant-acme.sql')], { encoding: 'utf8' });
    assert.equal(restore.status, 0, restore.stderr);
    const restored = bridgeFor(urlOf(restoreName));
    assert.equal(restored.call({ text: "SELECT count(*) AS count FROM daybreak_t_acme.users WHERE email='ada@acme.example'" }).rows[0].count, 1);
    restored.close();
  }
  database.close();
});
