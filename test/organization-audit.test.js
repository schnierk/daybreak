'use strict';

/**
 * Protokoll und offene Vorgänge in der Administration.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');
const { createDaybreakApp } = require('../lib/create-app');

const DEMO_PASSWORD = 'demo1234';

let directory;
let daybreak;
let server;
let baseUrl;

async function signIn(email) {
  const response = await fetch(`${baseUrl}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: DEMO_PASSWORD }) });
  assert.equal(response.status, 200);
  const cookie = response.headers.get('set-cookie').split(';', 1)[0];
  return async (method, url, body) => {
    const result = await fetch(`${baseUrl}${url}`, { method, headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await result.text();
    let data = text;
    try {
      data = JSON.parse(text);
    } catch {
      // Bleibt Text, zum Beispiel bei CSV.
    }
    return { status: result.status, data, headers: result.headers };
  };
}

before(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'daybreak-protokoll-'));
  daybreak = createDaybreakApp({
    env: { DAYBREAK_DB_PATH: path.join(directory, 'demo.db'), DAYBREAK_PRIMARY_DEMO: 'true', SESSION_COOKIE_SECURE: 'false', SESSION_SECRET: 'nur-fuer-den-test' },
    projectRoot: path.resolve(__dirname, '..')
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

test('Das Protokoll ist lesbar, filterbar und nur für die HR-Administration', async () => {
  const elena = await signIn('elena@loop.local');
  const lena = await signIn('lena@loop.local');
  const david = await signIn('david@loop.local');
  await elena('PUT', '/api/organization/approval-rules/absence.approval', { value: 'hr' });
  await elena('PUT', '/api/organization/approval-rules/absence.approval', { value: 'manager' });

  assert.equal((await lena('GET', '/api/organization/audit')).status, 403);
  assert.equal((await david('GET', '/api/organization/audit')).status, 403);
  assert.equal((await david('GET', '/api/organization/audit.csv')).status, 403);

  const all = await elena('GET', '/api/organization/audit');
  assert.equal(all.status, 200);
  const entry = all.data.entries.find(item => item.action === 'approval_rule_changed');
  assert.equal(entry.label, 'Genehmigungsregel geändert');
  assert.equal(entry.actor_name, 'Elena Hoffmann');

  const filtered = await elena('GET', '/api/organization/audit?action=approval_rule_changed');
  assert.ok(filtered.data.entries.length >= 2);
  assert.ok(filtered.data.entries.every(item => item.action === 'approval_rule_changed'));

  const older = await elena('GET', `/api/organization/audit?before=${filtered.data.entries[0].id}&action=approval_rule_changed`);
  assert.ok(older.data.entries.every(item => item.id < filtered.data.entries[0].id));
  assert.equal((await elena('GET', "/api/organization/audit?action=' OR 1=1 --")).data.entries.length, 0);

  const csv = await elena('GET', '/api/organization/audit.csv');
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  assert.match(csv.data, /Genehmigungsregel geändert/);
});

test('CSV im Protokoll schützt vor Formeln', async () => {
  const elena = await signIn('elena@loop.local');
  const db = daybreak.runtimeFor(daybreak.platform.primaryTenant()).db;
  db.prepare('INSERT INTO audit_log(action,entity,new_values) VALUES(?,?,?)').run('test_eintrag', '=HYPERLINK("x")', '@boese');
  const csv = await elena('GET', '/api/organization/audit.csv');
  assert.match(csv.data, /"'=HYPERLINK\(""x""\)"/);
  assert.match(csv.data, /"'@boese"/);
});

test('Offene Vorgänge zeigen Aufgaben, aber nie die Teilnahme an Befragungen', async () => {
  const elena = await signIn('elena@loop.local');
  const lena = await signIn('lena@loop.local');
  assert.equal((await lena('GET', '/api/organization/open-tasks')).status, 403);
  const db = daybreak.runtimeFor(daybreak.platform.primaryTenant()).db;
  const lenaId = db.prepare("SELECT id FROM users WHERE email='lena@loop.local'").get().id;
  db.prepare("INSERT INTO tasks(user_id,title,type,due_date) VALUES(?,?,?,?)").run(lenaId, 'Sichtbare Aufgabe', 'goal_approval', '2020-01-01');
  db.prepare("INSERT INTO tasks(user_id,title,type) VALUES(?,?,?)").run(lenaId, 'Befragung ausfüllen', 'surveys_participate');
  db.prepare("INSERT INTO tasks(user_id,title,type) VALUES(?,?,?)").run(lenaId, 'Nur ein Hinweis', 'account_notice');
  const { tasks } = (await elena('GET', '/api/organization/open-tasks')).data;
  assert.ok(tasks.some(task => task.title === 'Sichtbare Aufgabe' && task.person_name === 'Lena Schmitt'));
  assert.equal(tasks.some(task => task.title === 'Befragung ausfüllen'), false);
  assert.equal(tasks.some(task => task.type?.startsWith('surveys_')), false);
  assert.equal(tasks.some(task => task.title === 'Nur ein Hinweis'), false);

  // Vorgänge bei gesperrten Konten sind die, die sonst niemand mehr bemerkt. Sie stehen vorn.
  const lockedId = db.prepare("INSERT INTO users(name,email,password_hash,role,active) VALUES('Gesperrt Person','gesperrt-vorgang@loop.local','!','manager',0)").run().lastInsertRowid;
  db.prepare("INSERT INTO tasks(user_id,title,type) VALUES(?,?,?)").run(lockedId, 'Liegt beim gesperrten Konto', 'goal_approval');
  const withLocked = (await elena('GET', '/api/organization/open-tasks')).data.tasks;
  assert.equal(withLocked[0].title, 'Liegt beim gesperrten Konto');
  assert.equal(withLocked[0].person_active, 0);
});

test('Jede Änderung hat im Protokoll eine deutsche Bezeichnung', () => {
  const { actionLabel } = require('../routes/organization');
  const names = new Set();
  for (const folder of ['routes', 'lib']) {
    for (const file of fs.readdirSync(path.resolve(__dirname, '..', folder)).filter(name => name.endsWith('.js'))) {
      const source = fs.readFileSync(path.resolve(__dirname, '..', folder, file), 'utf8');
      for (const match of source.matchAll(/\b(?:log|audit|auditUpdate)\(\s*[^,'"`]+,\s*'([a-z_]+)'/g)) names.add(match[1]);
      for (const match of source.matchAll(/\bhistory\(\s*[^,]+,\s*'[a-z_]+',\s*[^,]+,\s*'([a-z_]+)'/g)) names.add(`talent_review_${match[1]}`);
    }
  }
  assert.ok(names.size > 100, 'Die Suche findet die Einträge');
  assert.deepEqual([...names].filter(name => !name.endsWith('_') && actionLabel(name) === name.replace(/_/g, ' ')), []);
});

test('Das Protokoll nennt lesbar, wer betroffen ist und was sich geändert hat', async () => {
  const elena = await signIn('elena@loop.local');
  const db = daybreak.runtimeFor(daybreak.platform.primaryTenant()).db;
  const idOf = email => db.prepare('SELECT id FROM users WHERE email=?').get(email).id;
  const felixName = db.prepare("SELECT name FROM users WHERE email='felix@loop.local'").get().name;
  assert.equal((await elena('PATCH', `/api/users/${idOf('lena@loop.local')}/manager`, { managerId: idOf('maria@loop.local') })).status, 200);
  assert.equal((await elena('PATCH', `/api/users/${idOf('lena@loop.local')}/manager`, { managerId: idOf('felix@loop.local') })).status, 200);
  assert.equal((await elena('PUT', '/api/organization/approval-rules/goals.approval', { value: 'none' })).status, 200);
  assert.equal((await elena('PUT', '/api/organization/approval-rules/goals.approval', { value: 'manager' })).status, 200);
  const { entries } = (await elena('GET', '/api/organization/audit')).data;
  const assigned = entries.find(entry => entry.action === 'manager_assigned');
  assert.equal(assigned.subject, 'Lena Schmitt');
  assert.equal(assigned.detail, `Führungskraft: Maria Keller → ${felixName}`);
  const rule = entries.find(entry => entry.action === 'approval_rule_changed');
  assert.equal(rule.subject, 'Genehmigungsregel');
  assert.match(rule.detail, /Regel: Ziele/);
  assert.match(rule.detail, /Einstellung: .*Nein, Ziele gelten sofort/);
  // Die Datei zeigt deutsche Ortszeit und dieselben Angaben.
  const csv = (await elena('GET', '/api/organization/audit.csv')).data;
  assert.match(csv.split('\r\n')[0], /Betrifft/);
  assert.match(csv.split('\r\n')[1], /^\S*"\d{2}\.\d{2}\.\d{2}, \d{2}:\d{2}:\d{2}"/);
});

test('Private Entwürfe stehen weder in der Datenauskunft noch im Protokoll', async () => {
  const elena = await signIn('elena@loop.local');
  const db = daybreak.runtimeFor(daybreak.platform.primaryTenant()).db;
  const review = db.prepare("SELECT r.id,r.employee_id FROM talent_reviews r WHERE r.self_status<>'employee_submitted' ORDER BY r.id LIMIT 1").get();
  assert.ok(review, 'Die Demo hat eine offene Einschätzung');
  db.prepare("UPDATE talent_reviews SET self_status='employee_draft',self_performance_reason='GEHEIMER ENTWURF' WHERE id=?").run(review.id);
  db.prepare('INSERT INTO audit_log(action,entity,new_values) VALUES(?,?,?)').run('self_draft_saved', 'talent_reviews', '{"text":"GEHEIMER ENTWURF"}');

  const exported = await elena('GET', `/api/personnel/${review.employee_id}/data-export`);
  assert.equal(exported.status, 200);
  assert.equal(JSON.stringify(exported.data).includes('GEHEIMER ENTWURF'), false, 'Datenauskunft');
  assert.ok(exported.data.tables.talent_reviews.length > 0, 'Die Einschätzung selbst steht darin');
  assert.equal((await elena('GET', '/api/organization/audit')).data.entries.some(entry => JSON.stringify(entry).includes('GEHEIMER ENTWURF')), false, 'Protokoll');
  assert.equal((await elena('GET', '/api/organization/audit.csv')).data.includes('GEHEIMER ENTWURF'), false, 'CSV');

  // Nach der Abgabe gehört die Selbsteinschätzung zu den Daten der Person.
  db.prepare("UPDATE talent_reviews SET self_status='employee_submitted' WHERE id=?").run(review.id);
  assert.equal(JSON.stringify((await elena('GET', `/api/personnel/${review.employee_id}/data-export`)).data).includes('GEHEIMER ENTWURF'), true);
});
