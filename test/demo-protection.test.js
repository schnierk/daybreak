'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');
const bcrypt = require('bcryptjs');
const { createDaybreakApp } = require('../lib/create-app');
const { DEFAULT_SOURCE_URL, sourceUrl } = require('../lib/project-info');

const ROOT_PASSWORD = 'SuperRoot!Demo2026xy';
const DEMO_PASSWORD = 'demo1234';
const projectRoot = path.resolve(__dirname, '..');

let directory;
let daybreak;
let server;
let baseUrl;

async function signIn(email, password = DEMO_PASSWORD) {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password })
  });
  assert.equal(response.status, 200, `${email}: ${await response.clone().text()}`);
  const cookie = response.headers.get('set-cookie').split(';', 1)[0];
  const { user } = await response.json();
  const call = async (method, url, body) => {
    const result = await fetch(`${baseUrl}${url}`, {
      method,
      headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: result.status, data: await result.json().catch(() => null) };
  };
  return { call, user };
}

const idOf = async (hr, email) => (await hr.call('GET', '/api/users')).data.users.find(user => user.email === email).id;
const primary = () => daybreak.platform.primaryTenant();
const runtime = () => daybreak.runtimeFor(primary());

before(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'daybreak-demo-'));
  daybreak = createDaybreakApp({
    env: {
      DAYBREAK_DB_PATH: path.join(directory, 'demo.db'),
      DAYBREAK_BACKUP_ROOT: path.join(directory, 'backups'),
      DAYBREAK_PRIMARY_DEMO: 'true',
      DAYBREAK_SUPERADMIN_PASSWORD_HASH: bcrypt.hashSync(ROOT_PASSWORD, 4),
      DAYBREAK_SOURCE_URL: 'https://example.org/mein-daybreak',
      SESSION_COOKIE_SECURE: 'false',
      SESSION_SECRET: 'nur-fuer-den-test'
    },
    projectRoot
  });
  await new Promise(resolve => {
    server = daybreak.app.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

after(async () => {
  await new Promise(resolve => server.close(resolve));
  daybreak.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

test('Die Login-Seite zeigt die Demo-Zugänge', async () => {
  const context = await (await fetch(`${baseUrl}/api/public/context`)).json();
  assert.deepEqual(context.demoLogins.map(login => login.email).sort(), ['david@loop.local', 'elena@loop.local', 'felix@loop.local', 'hanna@loop.local', 'lena@loop.local', 'maria@loop.local']);
});

test('Niemand kann das Passwort der Demo-Zugänge ändern oder zurücksetzen', async () => {
  const hr = await signIn('elena@loop.local');
  const own = await hr.call('POST', '/api/auth/password', { currentPassword: DEMO_PASSWORD, newPassword: 'NeuesPasswort!2026xy' });
  assert.equal(own.status, 403);
  assert.equal(own.data.code, 'demo_protected');
  const reset = await hr.call('POST', `/api/users/${await idOf(hr, 'lena@loop.local')}/password`, {});
  assert.equal(reset.status, 403);
  assert.equal(reset.data.code, 'demo_protected');
  // Die Anmeldung funktioniert weiter.
  await signIn('lena@loop.local');
  await signIn('elena@loop.local');
});

test('Demo-Zugänge lassen sich nicht sperren und nicht austreten lassen', async () => {
  const hr = await signIn('elena@loop.local');
  const lenaId = await idOf(hr, 'lena@loop.local');
  const locked = await hr.call('PATCH', `/api/users/${lenaId}/active`, { active: false });
  assert.equal(locked.status, 403);
  assert.equal(locked.data.code, 'demo_protected');
  const exit = await hr.call('POST', `/api/personnel/${lenaId}/exit`, { exitDate: '2020-01-01', reason: 'Test' });
  assert.equal(exit.status, 409);
  assert.match(exit.data.error, /öffentlichen Demo/);
  await signIn('lena@loop.local');
});

test('Andere Konten bleiben zum Ausprobieren frei', async () => {
  const hr = await signIn('elena@loop.local');
  const tomId = await idOf(hr, 'tom@loop.local');
  const locked = await hr.call('PATCH', `/api/users/${tomId}/active`, { active: false });
  assert.equal(locked.status, 200, JSON.stringify(locked.data));
  assert.equal((await hr.call('PATCH', `/api/users/${tomId}/active`, { active: true })).status, 200);
  const reset = await hr.call('POST', `/api/users/${tomId}/password`, {});
  assert.equal(reset.status, 200, JSON.stringify(reset.data));
  assert.ok(reset.data.temporaryPassword.length >= 12);
});

test('Name und Farbe der Demo ändert nur die Systemadministration', async () => {
  const hr = await signIn('elena@loop.local');
  const changed = await hr.call('PATCH', '/api/organization/settings', { name: 'Gehackt GmbH', primaryColor: '#000000' });
  assert.equal(changed.status, 403);
  assert.equal(changed.data.code, 'demo_protected');
  assert.notEqual(primary().name, 'Gehackt GmbH');
  const root = await signIn('root@root.de', ROOT_PASSWORD);
  const rootChange = await root.call('PATCH', '/api/organization/settings', { name: 'Demo AG' });
  assert.equal(rootChange.status, 200, JSON.stringify(rootChange.data));
  assert.equal(primary().name, 'Demo AG');
});

test('Module und Genehmigungen lassen sich ausprobieren und stehen stündlich wieder auf Anfang', async () => {
  const hr = await signIn('elena@loop.local');
  const before = (await hr.call('GET', '/api/organization/modules')).data.modules.filter(module => module.enabled).map(module => module.key);
  assert.equal((await hr.call('PATCH', '/api/organization/modules/feedback', { enabled: false })).status, 200);
  assert.equal((await hr.call('PUT', '/api/organization/approval-rules/absence.approval', { value: 'none' })).status, 200);
  assert.equal(daybreak.platform.isModuleEnabled(primary().id, 'feedback'), false);
  const ruleOf = async () => (await hr.call('GET', '/api/organization/approval-rules')).data.rules.find(rule => rule.key === 'absence.approval').value;
  assert.equal(await ruleOf(), 'none');

  runtime().resetDemoSettings();

  const after = (await hr.call('GET', '/api/organization/modules')).data.modules.filter(module => module.enabled).map(module => module.key);
  assert.deepEqual(after, before);
  assert.equal(await ruleOf(), 'manager');
});

test('Ohne Demo-Modus gilt nichts davon', async () => {
  const hr = await signIn('elena@loop.local');
  const root = await signIn('root@root.de', ROOT_PASSWORD);
  assert.equal((await root.call('PATCH', '/api/platform/tenants/default', { demoMode: false })).status, 200);
  try {
    assert.equal((await hr.call('PATCH', '/api/organization/settings', { name: 'Eigene GmbH' })).status, 200);
    assert.equal((await hr.call('PATCH', '/api/organization/modules/feedback', { enabled: false })).status, 200);
    runtime().resetDemoSettings();
    assert.equal(daybreak.platform.isModuleEnabled(primary().id, 'feedback'), false, 'Die eigene Entscheidung bleibt bestehen');
    assert.equal((await hr.call('PATCH', '/api/organization/modules/feedback', { enabled: true })).status, 200);
    const lenaId = await idOf(hr, 'lena@loop.local');
    assert.equal((await hr.call('PATCH', `/api/users/${lenaId}/active`, { active: false })).status, 200);
    assert.equal((await hr.call('PATCH', `/api/users/${lenaId}/active`, { active: true })).status, 200);
  } finally {
    await root.call('PATCH', '/api/platform/tenants/default', { demoMode: true });
  }
});

test('Der Link zum Quellcode ist überall erreichbar und nur mit gültiger Adresse änderbar', async () => {
  const context = await (await fetch(`${baseUrl}/api/public/context`)).json();
  assert.equal(context.sourceUrl, 'https://example.org/mein-daybreak');
  const hr = await signIn('lena@loop.local');
  assert.equal((await hr.call('GET', '/api/app/config')).data.sourceUrl, 'https://example.org/mein-daybreak');
  assert.equal(sourceUrl({}), DEFAULT_SOURCE_URL);
  assert.equal(sourceUrl({ DAYBREAK_SOURCE_URL: 'javascript:alert(1)' }), DEFAULT_SOURCE_URL);
  assert.equal(sourceUrl({ DAYBREAK_SOURCE_URL: 'https://x.example/"><script>' }), 'https://x.example/"><script>');
});

test('Beispieldaten für alle Konten gibt es nur auf ausdrücklichen Wunsch', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'daybreak-demo-alle-'));
  const start = extra => createDaybreakApp({
    env: { DAYBREAK_DB_PATH: path.join(folder, 'mix.db'), DAYBREAK_DATA_DIR: path.join(folder, 'data'), DAYBREAK_PRIMARY_DEMO: 'true', SESSION_SECRET: 'x', ...extra },
    projectRoot
  });
  const records = app => app.runtimeFor(app.platform.primaryTenant()).db.prepare('SELECT COUNT(*) count FROM personnel_records').get().count;
  try {
    const first = start({ DAYBREAK_PRIMARY_DEMO: 'false' });
    first.runtimeFor(first.platform.primaryTenant()).db.prepare("INSERT INTO users(name,email,password_hash,role) VALUES('Erfunden','erfunden@firma.example','x','hr_admin')").run();
    first.platform.updateTenant(first.platform.primaryTenant().id, { demoMode: true }, 'test');
    first.close();
    const second = start({});
    assert.equal(records(second), 0);
    second.close();
    const third = start({ DAYBREAK_DEMO_DATA_FOR_ALL_ACCOUNTS: 'true' });
    assert.ok(records(third) > 0);
    third.close();
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test('Der tägliche Reset legt die Demo neu an und nur die Demo', async t => {
  const resetDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'daybreak-reset-'));
  const app = createDaybreakApp({
    env: { DAYBREAK_DB_PATH: path.join(resetDirectory, 'demo.db'), DAYBREAK_PRIMARY_DEMO: 'true', SESSION_COOKIE_SECURE: 'false', SESSION_SECRET: 'nur-fuer-den-test' },
    projectRoot
  });
  t.after(() => {
    app.close();
    fs.rmSync(resetDirectory, { recursive: true, force: true });
  });
  const runtimeNow = () => app.runtimeFor(app.platform.primaryTenant());
  const nameOfTom = () => runtimeNow().db.prepare("SELECT name FROM users WHERE email='tom@loop.local'").get().name;
  const original = nameOfTom();
  runtimeNow().db.prepare("UPDATE users SET name='Von Besuchern geändert' WHERE email='tom@loop.local'").run();
  app.platform.setModuleEnabled(app.platform.primaryTenant().id, 'surveys', false, 'test');

  const hasAutomation = Boolean(runtimeNow().db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='automation_jobs'").get?.());
  if (hasAutomation) {
    const insert = runtimeNow().db.prepare("INSERT INTO automation_jobs(objective,status,requested_by) VALUES(?,?,?)");
    const kept = insert.run('Bleibt erhalten, auch nach dem Reset.', 'candidate_ready', 'root@root.de').lastInsertRowid;
    // Aufträge können auf eine Rückmeldung an Dayo verweisen. Die verschwindet mit den Beispieldaten.
    const feedbackColumns = runtimeNow().db.prepare('PRAGMA table_info(assistant_feedback)').all();
    const required = feedbackColumns.filter(column => column.notnull && !column.pk && column.dflt_value === null);
    const feedback = runtimeNow().db.prepare(`INSERT INTO assistant_feedback(${required.map(column => column.name).join(',')}) VALUES(${required.map(() => '?').join(',')})`)
      .run(...required.map(column => (/INT/i.test(column.type) ? 1 : 'x'))).lastInsertRowid;
    runtimeNow().db.prepare('UPDATE automation_jobs SET feedback_id=? WHERE id=?').run(feedback, kept);
    const running = insert.run('Läuft gerade noch und schreibt in die Datei.', 'running', 'root@root.de').lastInsertRowid;
    assert.deepEqual(app.demoReset.resetDemo(), { reset: false, reason: 'automation_running' }, 'Ein laufender Auftrag schreibt in dieselbe Datei');
    assert.equal(nameOfTom(), 'Von Besuchern geändert');
    runtimeNow().db.prepare("UPDATE automation_jobs SET status='failed' WHERE id=?").run(running);
  }

  assert.deepEqual(app.demoReset.resetDemo(), { reset: true });
  assert.equal(nameOfTom(), original, 'Die Beispieldaten sind neu');
  const states = app.platform.moduleStates(app.platform.primaryTenant().id);
  assert.equal(states.find(state => state.key === 'surveys').enabled, true, 'Auch die Modulschalter stehen auf Anfang');
  assert.ok(runtimeNow().db.prepare("SELECT COUNT(*) count FROM users WHERE email='elena@loop.local' AND active=1").get().count === 1);
  if (hasAutomation) {
    assert.equal(runtimeNow().db.prepare('SELECT COUNT(*) count FROM automation_jobs').get().count, 2, 'Aufträge bleiben');
    assert.ok(fs.existsSync(path.join(resetDirectory, 'demo.db-vor-reset')), 'Der letzte Stand liegt daneben');
  }
  // Ein zweiter Reset funktioniert genauso, auch mit erhaltenen Aufträgen.
  assert.deepEqual(app.demoReset.resetDemo(), { reset: true });
});

test('Ohne Demo-Modus löscht der Reset nichts', t => {
  const resetDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'daybreak-kein-reset-'));
  const app = createDaybreakApp({
    env: { DAYBREAK_DB_PATH: path.join(resetDirectory, 'firma.db'), DAYBREAK_DEMO_RESET_HOUR: '4', SESSION_COOKIE_SECURE: 'false', SESSION_SECRET: 'nur-fuer-den-test' },
    projectRoot
  });
  t.after(() => {
    app.close();
    fs.rmSync(resetDirectory, { recursive: true, force: true });
  });
  const db = () => app.runtimeFor(app.platform.primaryTenant()).db;
  db().prepare("INSERT INTO users(name,email,password_hash,role) VALUES('Echte Person','echt@firma.example','!','employee')").run();
  assert.deepEqual(app.demoReset.resetDemo(), { reset: false, reason: 'no_demo' });
  assert.equal(db().prepare("SELECT COUNT(*) count FROM users WHERE email='echt@firma.example'").get().count, 1);
});

test('Die Stunde des Resets wird streng gelesen, und er läuft nur einmal am Tag', () => {
  const { createDemoReset, demoResetHour } = require('../lib/demo-reset');
  assert.equal(demoResetHour({}), null);
  assert.equal(demoResetHour({ DAYBREAK_DEMO_RESET_HOUR: '' }), null);
  assert.equal(demoResetHour({ DAYBREAK_DEMO_RESET_HOUR: 'nachts' }), null);
  assert.equal(demoResetHour({ DAYBREAK_DEMO_RESET_HOUR: '24' }), null);
  assert.equal(demoResetHour({ DAYBREAK_DEMO_RESET_HOUR: '-1' }), null);
  assert.equal(demoResetHour({ DAYBREAK_DEMO_RESET_HOUR: '0' }), 0);
  assert.equal(demoResetHour({ DAYBREAK_DEMO_RESET_HOUR: '4' }), 4);

  let time = new Date(2030, 0, 15, 3, 59);
  const platform = { primaryTenant: () => ({ demo_mode: 0 }) };
  const resets = createDemoReset({ env: { DAYBREAK_DEMO_RESET_HOUR: '4' }, platform, now: () => time });
  assert.equal(resets.resetIfDue(), null, 'Noch nicht die Stunde');
  time = new Date(2030, 0, 15, 4, 1);
  assert.deepEqual(resets.resetIfDue(), { reset: false, reason: 'no_demo' });
  time = new Date(2030, 0, 15, 4, 6);
  assert.equal(resets.resetIfDue(), null, 'Heute schon gelaufen');
  time = new Date(2030, 0, 16, 4, 0);
  assert.deepEqual(resets.resetIfDue(), { reset: false, reason: 'no_demo' }, 'Am nächsten Tag wieder');
});
