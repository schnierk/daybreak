'use strict';

/**
 * Konten, Rollen, Ziele und Check-ins im echten Mandantenbetrieb, mit den sechs Rollen der Demo.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const { createDaybreakApp } = require('../lib/create-app');
const { goalProgress, initializeCoreSchema, passwordProblem } = require('../lib/core-helpers');

const ROOT_PASSWORD = 'SuperRoot!Konten2026xy';
const DEMO_PASSWORD = 'demo1234';
const NEW_PASSWORD = 'NeuesPasswort!2026xy';
const projectRoot = path.resolve(__dirname, '..');

let directory;
let daybreak;
let server;
let baseUrl;

function callWith(cookie) {
  return async (method, url, body) => {
    const response = await fetch(`${baseUrl}${url}`, {
      method,
      headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: response.status, data: await response.json().catch(() => null) };
  };
}

async function signIn(email, password = DEMO_PASSWORD) {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password })
  });
  assert.equal(response.status, 200, `${email}: ${await response.clone().text()}`);
  const { user } = await response.json();
  const call = callWith(response.headers.get('set-cookie').split(';', 1)[0]);
  return Object.assign(call, { user });
}

const runtime = () => daybreak.runtimeFor(daybreak.platform.primaryTenant());
const idOf = email => runtime().db.prepare('SELECT id FROM users WHERE email=?').get(email).id;
const roleOf = email => runtime().db.prepare('SELECT role FROM users WHERE email=?').get(email).role;

/** Legt eine Person an und meldet sie mit eigenem Passwort an. */
async function createPerson(hr, { email, role = 'employee', name = 'Neue Person', managerId = null }) {
  const created = await hr('POST', '/api/users', { name, email, role, managerId });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  const first = await signIn(email, created.data.temporaryPassword);
  assert.equal((await first('POST', '/api/auth/password', { currentPassword: created.data.temporaryPassword, newPassword: NEW_PASSWORD })).status, 200);
  return { id: created.data.id, signIn: () => signIn(email, NEW_PASSWORD) };
}

before(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'daybreak-konten-'));
  daybreak = createDaybreakApp({
    env: {
      DAYBREAK_DB_PATH: path.join(directory, 'demo.db'),
      DAYBREAK_BACKUP_ROOT: path.join(directory, 'backups'),
      DAYBREAK_PRIMARY_DEMO: 'true',
      DAYBREAK_SUPERADMIN_PASSWORD_HASH: bcrypt.hashSync(ROOT_PASSWORD, 4),
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

test('Die Demo zeigt alle sechs Rollen', () => {
  assert.equal(roleOf('hanna@loop.local'), 'hr_staff');
  assert.equal(roleOf('felix@loop.local'), 'manager');
  const felix = idOf('felix@loop.local');
  const reports = runtime().db.prepare('SELECT email FROM users WHERE manager_id=? ORDER BY email').all(felix).map(row => row.email);
  assert.deepEqual(reports, ['julia@loop.local', 'tom@loop.local']);
});

test('Konten anlegen: Passwort wird erzeugt, HR-Rollen vergibt nur die HR-Administration', async () => {
  const elena = await signIn('elena@loop.local');
  const david = await signIn('david@loop.local');
  const hanna = await signIn('hanna@loop.local');
  const lena = await signIn('lena@loop.local');

  const generated = await elena('POST', '/api/users', { name: 'Erzeugt', email: 'erzeugt@loop.local', role: 'employee' });
  assert.equal(generated.status, 200);
  assert.match(generated.data.temporaryPassword, /^[A-Za-z0-9]{12,}$/, 'Nur Buchstaben und Ziffern, damit CSV-Listen sie nicht verfälschen');

  assert.equal((await lena('POST', '/api/users', { name: 'X', email: 'x@loop.local' })).status, 403);
  for (const role of ['hr_admin', 'hrbp', 'hr_staff']) {
    assert.equal((await david('POST', '/api/users', { name: 'X', email: `david-${role}@loop.local`, role })).status, 403, `HRBP legt ${role} nicht an`);
    assert.equal((await hanna('POST', '/api/users', { name: 'X', email: `hanna-${role}@loop.local`, role })).status, 403, `Sachbearbeitung legt ${role} nicht an`);
  }
  assert.equal((await hanna('POST', '/api/users', { name: 'Y', email: 'von-hanna@loop.local', role: 'employee' })).status, 200);
  for (const role of ['manager', 'director']) {
    assert.equal((await hanna('POST', '/api/users', { name: 'X', email: `hanna-${role}@loop.local`, role })).status, 403, `Sachbearbeitung legt ${role} nicht an`);
  }
  assert.equal((await elena('POST', '/api/users', { name: 'Z', email: 'hr-neu@loop.local', role: 'hrbp' })).status, 200);

  assert.equal((await elena('POST', '/api/users', { name: 'Z', email: 'hr-neu@loop.local' })).status, 409);
  assert.equal((await elena('POST', '/api/users', { name: 'Z', email: 'mgr@loop.local', managerId: 'abc' })).status, 400, 'Ungültige Führungskraft wird abgelehnt');
  assert.equal((await elena('POST', '/api/users', { name: 'Z', email: 'pw@loop.local', password: 'aaaaaaaaaaaaaa' })).status, 400, 'Zu einfaches Passwort');
});

test('Konto ändern: Name, E-Mail, Rolle, mit klaren Grenzen', async () => {
  const elena = await signIn('elena@loop.local');
  const david = await signIn('david@loop.local');
  const hanna = await signIn('hanna@loop.local');
  const person = await createPerson(elena, { email: 'heirat@loop.local', name: 'Vorher Name' });

  const renamed = await hanna('PATCH', `/api/users/${person.id}`, { name: 'Nachher Name', email: 'neu.heirat@loop.local' });
  assert.equal(renamed.status, 200, JSON.stringify(renamed.data));
  const row = runtime().db.prepare('SELECT name,email FROM users WHERE id=?').get(person.id);
  assert.deepEqual({ ...row }, { name: 'Nachher Name', email: 'neu.heirat@loop.local' });
  assert.ok(runtime().db.prepare("SELECT 1 FROM audit_log WHERE action='user_updated' AND entity_id=?").get(person.id), 'Steht im Protokoll');

  assert.equal((await hanna('PATCH', `/api/users/${person.id}`, { role: 'hrbp' })).status, 403);
  assert.equal((await hanna('PATCH', `/api/users/${person.id}`, { role: 'director' })).status, 403, 'Auch Führungsrollen nicht');
  assert.equal((await david('PATCH', `/api/users/${person.id}`, { role: 'hr_admin' })).status, 403);
  assert.equal((await david('PATCH', `/api/users/${person.id}`, { role: 'manager' })).status, 200, 'HRBP darf zur Führungskraft machen');
  assert.equal((await elena('PATCH', `/api/users/${person.id}`, { role: 'unsinn' })).status, 400);
  assert.equal((await elena('PATCH', `/api/users/${person.id}`, { email: 'kein-email' })).status, 400);
  assert.equal((await elena('PATCH', `/api/users/${person.id}`, { email: 'elena@loop.local' })).status, 409);

  // Die Sachbearbeitung betreut nur Konten ohne Führungs- oder HR-Aufgabe.
  assert.equal((await hanna('PATCH', `/api/users/${idOf('felix@loop.local')}`, { name: 'Anders' })).status, 403);
  assert.equal((await david('PATCH', `/api/users/${idOf('hanna@loop.local')}`, { name: 'Anders' })).status, 403);

  // Die Zugänge der Anmeldeseite bleiben in der Demo unverändert.
  assert.equal((await elena('PATCH', `/api/users/${idOf('lena@loop.local')}`, { email: 'weg@loop.local' })).data.code, 'demo_protected');
  assert.equal((await elena('PATCH', `/api/users/${idOf('elena@loop.local')}`, { role: 'employee' })).status, 403, 'Eigene Daten ändert eine andere HR-Person');
});

test('Passwort zurücksetzen und sperren: Niemand übernimmt fremde HR- oder Führungskonten', async () => {
  const elena = await signIn('elena@loop.local');
  const david = await signIn('david@loop.local');
  const hanna = await signIn('hanna@loop.local');
  const manager = await createPerson(elena, { email: 'chefin@loop.local', role: 'manager', name: 'Neue Chefin' });
  const colleague = await createPerson(elena, { email: 'kollege@loop.local', role: 'hrbp', name: 'HR Kollege' });
  const employee = await createPerson(elena, { email: 'einfach@loop.local', name: 'Einfache Person' });

  assert.equal((await david('POST', `/api/users/${colleague.id}/password`, {})).status, 403, 'HRBP nicht bei HR-Kolleg:innen');
  assert.equal((await hanna('POST', `/api/users/${manager.id}/password`, {})).status, 403, 'Sachbearbeitung nicht bei Führungskräften');
  assert.equal((await hanna('PATCH', `/api/users/${manager.id}/active`, { active: false })).status, 403);
  assert.equal((await david('POST', `/api/users/${david.user.id}/password`, {})).status, 400, 'Das eigene Passwort geht anders');

  const reset = await hanna('POST', `/api/users/${employee.id}/password`, {});
  assert.equal(reset.status, 200, JSON.stringify(reset.data));
  const notice = runtime().db.prepare("SELECT title FROM tasks WHERE user_id=? AND type='account_notice' AND done=0").get(employee.id);
  assert.match(notice.title, /Hanna Vogt hat dein Passwort zurückgesetzt/, 'Die Person erfährt davon');

  const toggled = await hanna('PATCH', `/api/users/${employee.id}/active`, { active: false });
  assert.equal(toggled.status, 200);
  assert.equal((await hanna('PATCH', `/api/users/${employee.id}/active`, { active: true })).status, 200);
});

test('HR ändert die eigenen Daten nicht und kommt an die Akte der Leitung nicht heran', async () => {
  const elena = await signIn('elena@loop.local');
  const david = await signIn('david@loop.local');
  const elenaId = idOf('elena@loop.local');
  assert.equal((await david('PATCH', `/api/users/${david.user.id}/manager`, { managerId: null })).status, 403);
  assert.equal((await david('PATCH', `/api/users/${elenaId}/manager`, { managerId: david.user.id })).status, 403);
  assert.equal((await david('GET', `/api/goals?userId=${elenaId}`)).status, 403);
  assert.equal((await david('POST', '/api/checkins', { employeeId: elenaId, period: '2026-11', summary: 'Heimlich', performance: 1, onTrack: 'off_track' })).status, 403);
  assert.equal((await elena('GET', `/api/goals?userId=${david.user.id}`)).status, 200);

  // Die Organisation kann das bewusst erlauben.
  const other = await createPerson(elena, { email: 'zweiter-bp@loop.local', role: 'hrbp', name: 'Zweiter Partner' });
  const partner = await other.signIn();
  assert.equal((await partner('PATCH', `/api/users/${other.id}`, { title: 'Partner' })).status, 403);
  assert.equal((await elena('PUT', '/api/organization/approval-rules/personnel.hr_self_edit', { value: 'allowed' })).status, 200);
  assert.equal((await partner('PATCH', `/api/users/${other.id}`, { title: 'Partner' })).status, 200);
  assert.equal((await elena('PUT', '/api/organization/approval-rules/personnel.hr_self_edit', { value: 'denied' })).status, 200);
});

test('Führungskraft zuordnen: Rolle passt, Kreise und Unsinn scheitern, Freigaben ziehen mit', async () => {
  const elena = await signIn('elena@loop.local');
  const team = await createPerson(elena, { email: 'wechsel@loop.local', name: 'Wechsel Person', managerId: idOf('felix@loop.local') });
  const member = await team.signIn();

  assert.equal((await elena('PATCH', `/api/users/${team.id}/manager`, { managerId: 'abc' })).status, 400);
  assert.equal((await elena('PATCH', `/api/users/${team.id}/manager`, { managerId: team.id })).status, 400);
  assert.equal((await elena('PATCH', `/api/users/${idOf('felix@loop.local')}/manager`, { managerId: team.id })).status, 400, 'Die Führungslinie liefe im Kreis');

  // Ein Ziel wartet bei der alten Führungskraft auf Freigabe.
  const goal = await member('POST', '/api/goals', { title: 'Wandert mit', dueDate: '2030-01-01', weight: 100 });
  assert.equal(goal.data.approvalStatus, 'pending_manager_approval');
  const openTask = () => runtime().db.prepare("SELECT user_id FROM tasks WHERE type='goal_approval' AND entity_id=? AND done=0").get(goal.data.id);
  assert.equal(openTask().user_id, idOf('felix@loop.local'));

  const lena = idOf('lena@loop.local');
  const blocked = await elena('PATCH', `/api/users/${team.id}/manager`, { managerId: lena });
  assert.equal(blocked.status, 409, 'Lena ist noch keine Führungskraft');
  assert.equal(blocked.data.code, 'manager_role_required');
  const hanna = await signIn('hanna@loop.local');
  const clerk = await hanna('PATCH', `/api/users/${team.id}/manager`, { managerId: lena, promoteManager: true });
  assert.equal(clerk.status, 403, 'Die Sachbearbeitung macht niemanden zur Führungskraft');
  assert.equal(roleOf('lena@loop.local'), 'employee');
  assert.equal((await elena('PATCH', `/api/users/${team.id}/manager`, { managerId: idOf('maria@loop.local') })).status, 200);
  assert.equal(openTask().user_id, idOf('maria@loop.local'), 'Die Freigabe zieht mit');

  const maria = await signIn('maria@loop.local');
  assert.equal((await maria('PATCH', `/api/goals/${goal.data.id}/review`, { action: 'approved' })).status, 200);
});

test('Wer zur Führungskraft wird, bekommt die passende Rolle', async () => {
  const elena = await signIn('elena@loop.local');
  const lead = await createPerson(elena, { email: 'wird-chef@loop.local', name: 'Wird Chef' });
  const person = await createPerson(elena, { email: 'neu-im-team@loop.local', name: 'Neu Im Team' });
  const promoted = await elena('PATCH', `/api/users/${person.id}/manager`, { managerId: lead.id, promoteManager: true });
  assert.equal(promoted.status, 200, JSON.stringify(promoted.data));
  assert.equal(roleOf('wird-chef@loop.local'), 'manager');
  const chef = await lead.signIn();
  assert.equal((await chef('GET', '/api/team')).status, 200);
});

test('Ziele: nur der passende Schritt ist möglich', async () => {
  const felix = await signIn('felix@loop.local');
  const tom = await signIn('tom@loop.local');
  const julia = await signIn('julia@loop.local');
  const tomId = idOf('tom@loop.local');

  // Die Führungskraft kann ihren eigenen Vorschlag nicht selbst genehmigen.
  const proposal = await felix('POST', '/api/goals', { userId: tomId, title: 'Vorschlag', dueDate: '2030-01-01', weight: 50 });
  assert.equal(proposal.data.approvalStatus, 'pending_employee_acceptance');
  assert.equal((await felix('PATCH', `/api/goals/${proposal.data.id}/review`, { action: 'approved' })).status, 409);
  assert.equal((await tom('PATCH', `/api/goals/${proposal.data.id}/employee-response`, { action: 'accepted' })).status, 200);

  // Inhaltliche Änderungen muss die Person neu annehmen.
  assert.equal((await felix('PATCH', `/api/goals/${proposal.data.id}`, { title: 'Geänderter Vorschlag' })).status, 200);
  const changed = runtime().db.prepare('SELECT approval_status FROM goals WHERE id=?').get(proposal.data.id);
  assert.equal(changed.approval_status, 'pending_employee_acceptance');
  // Fortschritt allein braucht keine neue Annahme.
  assert.equal((await tom('PATCH', `/api/goals/${proposal.data.id}/employee-response`, { action: 'accepted' })).status, 200);
  assert.equal((await felix('PATCH', `/api/goals/${proposal.data.id}`, { progress: 40 })).status, 200);
  assert.equal(runtime().db.prepare('SELECT approval_status FROM goals WHERE id=?').get(proposal.data.id).approval_status, 'approved');

  // Überarbeiten schließt nur die Aufgaben dieses Ziels, nicht fremde mit gleicher Nummer.
  const ownGoal = await tom('POST', '/api/goals', { title: 'Eigenes Ziel', dueDate: '2030-01-01', weight: 50 });
  assert.equal((await felix('PATCH', `/api/goals/${ownGoal.data.id}/review`, { action: 'changes_requested', comment: 'Bitte schärfen' })).status, 200);
  const foreign = runtime().db.prepare("INSERT INTO tasks(user_id,title,type,entity_id) VALUES(?,?,?,?)").run(idOf('julia@loop.local'), 'Fremde Aufgabe', 'learning_assignment', ownGoal.data.id).lastInsertRowid;
  assert.equal((await tom('PATCH', `/api/goals/${ownGoal.data.id}`, { title: 'Eigenes Ziel, geschärft', resubmit: true })).status, 200);
  assert.equal(runtime().db.prepare('SELECT done FROM tasks WHERE id=?').get(foreign).done, 0, 'Die fremde Aufgabe bleibt offen');
  assert.equal((await julia('GET', `/api/goals?userId=${tomId}`)).status, 403);
});

test('Zielerreichung: überall dieselbe Rechnung', async () => {
  assert.equal(goalProgress([]), null);
  assert.equal(goalProgress([{ progress: 50, weight: 100, approval_status: 'pending_manager_approval' }]), null);
  assert.equal(goalProgress([{ progress: 74, weight: 45, approval_status: 'approved' }, { progress: 86, weight: 25, approval_status: 'approved' }, { progress: 52, weight: 30, approval_status: 'approved' }, { progress: 100, weight: 100, approval_status: 'pending_manager_approval' }]), 70);

  const maria = await signIn('maria@loop.local');
  const lena = await signIn('lena@loop.local');
  const lenaOwn = (await lena('GET', '/api/dashboard')).data.metrics.goalProgress;
  const teamRow = (await maria('GET', '/api/team')).data.team.find(person => person.id === lena.user.id);
  const reportRow = (await maria('GET', '/api/reports/overview')).data.rows.find(row => row.name === 'Lena Schmitt');
  assert.equal(teamRow.progress, lenaOwn);
  assert.equal(reportRow.progress, lenaOwn);
  assert.equal(teamRow.direct, true);
  const tomRow = (await maria('GET', '/api/team')).data.team.find(person => person.name === 'Tom Köhler');
  assert.equal(tomRow.direct, false);
});

test('Check-ins: Führungskraft liest die Rückmeldung, Monat wird geprüft, Korrektur bis zur Bestätigung', async () => {
  const felix = await signIn('felix@loop.local');
  const tom = await signIn('tom@loop.local');
  const lena = await signIn('lena@loop.local');
  const tomId = idOf('tom@loop.local');
  const base = { employeeId: tomId, summary: 'Gutes Gespräch', performance: 4, onTrack: 'on_track' };
  for (const period of ['2026-13', '9999-99', 'November', '2026-00']) {
    assert.equal((await felix('POST', '/api/checkins', { ...base, period })).status, 400, period);
  }
  const created = await felix('POST', '/api/checkins', { ...base, period: '2026-11' });
  assert.equal(created.status, 200);
  const id = created.data.id;

  assert.equal((await felix('PATCH', `/api/checkins/${id}`, { ...base, period: '2026-11', summary: 'Korrigiert' })).status, 200);
  assert.equal((await tom('PATCH', `/api/checkins/${id}`, { ...base, period: '2026-11' })).status, 403);
  assert.equal((await tom('GET', `/api/checkins/${id}`)).data.canRespond, true);
  assert.equal((await lena('GET', `/api/checkins/${id}`)).status, 403);

  assert.equal((await tom('PATCH', `/api/checkins/${id}/feedback`, { comment: 'Passt', satisfaction: 0 })).status, 400);
  assert.equal((await tom('PATCH', `/api/checkins/${id}/feedback`, { comment: 'Passt', satisfaction: 5 })).status, 200);

  const seen = await felix('GET', `/api/checkins/${id}`);
  assert.equal(seen.data.checkin.employee_comment, 'Passt');
  assert.equal(seen.data.canEdit, false);
  assert.equal((await felix('PATCH', `/api/checkins/${id}`, { ...base, period: '2026-11' })).status, 409);

  const notice = runtime().db.prepare("SELECT id FROM tasks WHERE user_id=? AND type='checkin_feedback_notice' AND done=0").get(felix.user.id);
  assert.ok(notice, 'Die Führungskraft erfährt von der Bestätigung');
  assert.equal((await tom('POST', `/api/tasks/${notice.id}/done`)).status, 404, 'Fremde Aufgaben bleiben unberührt');
  assert.equal((await felix('POST', `/api/tasks/${notice.id}/done`)).status, 200);
  const workflowTask = runtime().db.prepare("INSERT INTO tasks(user_id,title,type) VALUES(?,?,?)").run(felix.user.id, 'Freigabe', 'goal_approval').lastInsertRowid;
  assert.equal((await felix('POST', `/api/tasks/${workflowTask}/done`)).status, 409, 'Vorgänge schließen sich selbst');
});

test('Führungswechsel: Ein Ziel mit Änderungswunsch zieht zur neuen Führungskraft um', async () => {
  const elena = await signIn('elena@loop.local');
  const alt = await createPerson(elena, { email: 'chef-alt@loop.local', name: 'Chef Alt', role: 'manager' });
  const neu = await createPerson(elena, { email: 'chef-neu@loop.local', name: 'Chef Neu', role: 'manager' });
  const member = await createPerson(elena, { email: 'wechselt-chef@loop.local', name: 'Wechselt Chef', managerId: alt.id });
  const [chefAlt, chefNeu, person] = await Promise.all([alt.signIn(), neu.signIn(), member.signIn()]);
  const openRevision = goalId => runtime().db.prepare("SELECT user_id FROM tasks WHERE type='goal_revision_manager' AND entity_id=? AND done=0").get(goalId);
  const proposeGoal = async title => (await chefAlt('POST', '/api/goals', { userId: member.id, title, dueDate: '2030-01-01', weight: 50 })).data.id;

  // Der Wunsch kommt vor dem Wechsel: Aufgabe und Recht wandern mit.
  const before = await proposeGoal('Wunsch vor dem Wechsel');
  assert.equal((await person('PATCH', `/api/goals/${before}/employee-response`, { action: 'changes_requested', comment: 'Bitte kleiner' })).status, 200);
  assert.equal(openRevision(before).user_id, alt.id);
  const after = await proposeGoal('Wunsch nach dem Wechsel');
  assert.equal((await elena('PATCH', `/api/users/${member.id}/manager`, { managerId: neu.id })).status, 200);
  assert.equal(openRevision(before).user_id, neu.id, 'Die neue Führungskraft übernimmt die Aufgabe');
  assert.equal((await chefAlt('GET', `/api/goals/${before}`)).status, 403);
  const revised = await chefNeu('PATCH', `/api/goals/${before}`, { title: 'Kleiner', resubmit: true });
  assert.equal(revised.status, 200);
  const stored = runtime().db.prepare('SELECT title,approval_status FROM goals WHERE id=?').get(before);
  assert.equal(stored.title, 'Kleiner');
  assert.equal(stored.approval_status, 'pending_employee_acceptance');
  assert.equal(openRevision(before), undefined);

  // Der Wunsch kommt nach dem Wechsel: Er geht gleich an die neue Führungskraft.
  assert.equal((await person('PATCH', `/api/goals/${after}/employee-response`, { action: 'changes_requested', comment: 'Anders bitte' })).status, 200);
  assert.equal(openRevision(after).user_id, neu.id);

  // Ohne Führungskraft überarbeitet die Person selbst, danach gilt das Ziel.
  assert.equal((await elena('PATCH', `/api/users/${member.id}/manager`, { managerId: null })).status, 200);
  assert.equal(openRevision(after), undefined);
  assert.equal(runtime().db.prepare('SELECT approval_status FROM goals WHERE id=?').get(after).approval_status, 'changes_requested_by_manager');
  assert.equal((await person('PATCH', `/api/goals/${after}`, { title: 'Selbst überarbeitet', resubmit: true })).status, 200);
  assert.equal(runtime().db.prepare('SELECT approval_status FROM goals WHERE id=?').get(after).approval_status, 'approved');
});

test('Ziele zurückziehen: vor der Freigabe die Beteiligten, danach nur Führungskraft oder HR', async () => {
  const elena = await signIn('elena@loop.local');
  const lead = await createPerson(elena, { email: 'ziele-chef@loop.local', name: 'Ziele Chef', role: 'manager' });
  const member = await createPerson(elena, { email: 'ziele-person@loop.local', name: 'Ziele Person', managerId: lead.id });
  const [chef, person, lena] = await Promise.all([lead.signIn(), member.signIn(), signIn('lena@loop.local')]);
  const goalExists = id => Boolean(runtime().db.prepare('SELECT id FROM goals WHERE id=?').get(id));
  const openTasks = id => runtime().db.prepare("SELECT COUNT(*) count FROM tasks WHERE entity_id=? AND type='goal_approval' AND done=0").get(id).count;

  const own = (await person('POST', '/api/goals', { title: 'Doch nicht', dueDate: '2030-01-01', weight: 10 })).data.id;
  assert.equal(openTasks(own), 1);
  assert.equal((await lena('DELETE', `/api/goals/${own}`)).status, 403, 'Fremde kommen nicht heran');
  assert.equal((await person('DELETE', `/api/goals/${own}`)).status, 200);
  assert.equal(goalExists(own), false);
  assert.equal(openTasks(own), 0, 'Die Freigabe-Aufgabe verschwindet mit');

  const proposal = (await chef('POST', '/api/goals', { userId: member.id, title: 'Vorschlag der Führung', dueDate: '2030-01-01', weight: 10 })).data.id;
  assert.equal((await person('DELETE', `/api/goals/${proposal}`)).status, 403, 'Einen Vorschlag beantwortet die Person');
  assert.equal((await chef('DELETE', `/api/goals/${proposal}`)).status, 200);

  const agreed = (await person('POST', '/api/goals', { title: 'Vereinbart', dueDate: '2030-01-01', weight: 10 })).data.id;
  assert.equal((await chef('PATCH', `/api/goals/${agreed}/review`, { action: 'approved' })).status, 200);
  assert.equal((await person('DELETE', `/api/goals/${agreed}`)).status, 403);
  assert.equal(goalExists(agreed), true);
  assert.equal((await chef('DELETE', `/api/goals/${agreed}`)).status, 200);
  assert.equal(goalExists(agreed), false);
});

test('Check-ins beim Führungswechsel: Rückmeldung geht an die neue Führungskraft, die alte liest nichts mehr', async () => {
  const elena = await signIn('elena@loop.local');
  const alt = await createPerson(elena, { email: 'ci-alt@loop.local', name: 'CI Alt', role: 'manager' });
  const neu = await createPerson(elena, { email: 'ci-neu@loop.local', name: 'CI Neu', role: 'manager' });
  const member = await createPerson(elena, { email: 'ci-person@loop.local', name: 'CI Person', managerId: alt.id });
  const [chefAlt, chefNeu, person] = await Promise.all([alt.signIn(), neu.signIn(), member.signIn()]);
  const base = { employeeId: member.id, summary: 'Gespräch', performance: 4, onTrack: 'on_track', period: '2026-10' };
  const { id } = (await chefAlt('POST', '/api/checkins', base)).data;
  assert.match(runtime().db.prepare("SELECT title FROM tasks WHERE type='checkin' AND entity_id=?").get(id).title, /Oktober 2026/);
  assert.equal((await elena('PATCH', `/api/users/${member.id}/manager`, { managerId: neu.id })).status, 200);
  assert.equal((await person('PATCH', `/api/checkins/${id}/feedback`, { comment: 'Vertraulicher Kommentar', satisfaction: 2 })).status, 200);

  const written = await chefAlt('GET', '/api/checkins?author=me');
  assert.equal(JSON.stringify(written.data).includes('Vertraulicher Kommentar'), false);
  assert.equal((await chefAlt('PATCH', `/api/checkins/${id}`, base)).status, 403);
  const notices = runtime().db.prepare("SELECT user_id FROM tasks WHERE type='checkin_feedback_notice' AND entity_id=?").all(id);
  assert.deepEqual(notices.map(notice => notice.user_id), [neu.id]);
  assert.equal((await chefNeu('GET', `/api/checkins/${id}`)).status, 200);
});

test('Check-ins: Der zuletzt erfasste im Monat zählt, Bestätigen geht nur einmal', async () => {
  const elena = await signIn('elena@loop.local');
  const lead = await createPerson(elena, { email: 'ci-monat-chef@loop.local', name: 'CI Monat Chef', role: 'manager' });
  const member = await createPerson(elena, { email: 'ci-monat@loop.local', name: 'CI Monat', managerId: lead.id });
  const [chef, person] = await Promise.all([lead.signIn(), member.signIn()]);
  const base = { employeeId: member.id, summary: 'Gespräch', onTrack: 'on_track', period: '2026-10' };
  const first = await chef('POST', '/api/checkins', { ...base, performance: 4 });
  assert.equal(first.data.sameMonth, false);
  const second = await chef('POST', '/api/checkins', { ...base, performance: 2 });
  assert.equal(second.data.sameMonth, true);
  assert.equal((await chef('GET', '/api/team')).data.team.find(entry => entry.id === member.id).performance, 2);
  assert.equal((await person('GET', '/api/dashboard')).data.metrics.performance, 2);

  assert.equal((await person('PATCH', `/api/checkins/${first.data.id}/feedback`, { comment: 'Gut', satisfaction: 5 })).status, 200);
  assert.equal((await person('GET', `/api/checkins/${first.data.id}`)).data.canRespond, false);
  assert.equal((await person('PATCH', `/api/checkins/${first.data.id}/feedback`, { comment: 'Nochmal', satisfaction: 1 })).status, 409);
  const notices = () => runtime().db.prepare("SELECT COUNT(*) count FROM tasks WHERE type='checkin_feedback_notice' AND entity_id=? AND done=0").get(first.data.id).count;
  assert.equal(notices(), 1, 'Kein zweiter Hinweis');

  // Nach einem Führungswechsel verschwindet der Hinweis, statt ins Leere zu führen.
  assert.equal((await elena('PATCH', `/api/users/${member.id}/manager`, { managerId: null })).status, 200);
  assert.equal(notices(), 0);
});

test('Ein Ziel aus einer Entwicklungsmaßnahme lässt sich entfernen, die Maßnahme bleibt', async () => {
  const elena = await signIn('elena@loop.local');
  const lead = await createPerson(elena, { email: 'massnahme-chef@loop.local', name: 'Maßnahme Chef', role: 'manager' });
  const member = await createPerson(elena, { email: 'massnahme@loop.local', name: 'Maßnahme Person', managerId: lead.id });
  const chef = await lead.signIn();
  const { id } = (await chef('POST', '/api/goals', { userId: member.id, title: 'Aus einer Maßnahme', dueDate: '2030-01-01', weight: 10, goalType: 'development' })).data;
  const db = runtime().db;
  const review = db.prepare('SELECT id,period_id,employee_id FROM talent_reviews LIMIT 1').get();
  const decision = db.prepare("INSERT INTO development_decisions(review_id,period_id,employee_id,decision_type,description,responsible_id,status,linked_goal_id,created_by) VALUES(?,?,?,?,?,?,?,?,?)")
    .run(review.id, review.period_id, review.employee_id, 'training', 'Maßnahme', lead.id, 'planned', id, lead.id).lastInsertRowid;
  assert.equal((await chef('DELETE', `/api/goals/${id}`)).status, 200);
  assert.equal(db.prepare('SELECT linked_goal_id FROM development_decisions WHERE id=?').get(decision).linked_goal_id, null);
});

test('Check-ins: kein Monat in der Zukunft, falsch erfasste lassen sich löschen', async () => {
  const felix = await signIn('felix@loop.local');
  const tom = await signIn('tom@loop.local');
  const tomId = idOf('tom@loop.local');
  const base = { employeeId: tomId, summary: 'Aus Versehen bei Tom', performance: 3, onTrack: 'on_track' };
  assert.equal((await felix('POST', '/api/checkins', { ...base, period: '2099-01' })).status, 400);
  const { id } = (await felix('POST', '/api/checkins', { ...base, period: '2026-09' })).data;
  assert.equal((await tom('DELETE', `/api/checkins/${id}`)).status, 403);
  assert.equal((await felix('DELETE', `/api/checkins/${id}`)).status, 200);
  assert.equal(runtime().db.prepare('SELECT id FROM checkins WHERE id=?').get(id), undefined);
  assert.equal(runtime().db.prepare("SELECT COUNT(*) count FROM tasks WHERE type='checkin' AND entity_id=? AND done=0").get(id).count, 0);

  const confirmed = (await felix('POST', '/api/checkins', { ...base, period: '2026-08' })).data.id;
  assert.equal((await tom('PATCH', `/api/checkins/${confirmed}/feedback`, { comment: 'Ok', satisfaction: 4 })).status, 200);
  assert.equal((await felix('DELETE', `/api/checkins/${confirmed}`)).status, 409);
});

test('Kompetenzen: Die Ebene über der direkten Führungskraft sieht deren Note nirgends', async () => {
  const felix = await signIn('felix@loop.local');
  const maria = await signIn('maria@loop.local');
  const elena = await signIn('elena@loop.local');
  const tomId = idOf('tom@loop.local');
  const competency = (await felix('GET', '/api/competencies')).data.items[0];
  const db = runtime().db;
  const position = db.prepare('SELECT id FROM position_profiles WHERE active=1 LIMIT 1').get().id;
  db.prepare('UPDATE users SET position_profile_id=? WHERE id=?').run(position, tomId);
  db.prepare('INSERT OR IGNORE INTO position_requirements(position_profile_id,competency_id,required_level,weight,active) VALUES(?,?,3,1,1)').run(position, competency.id);
  const rated = await felix('POST', '/api/talent/competencies/manager-assessment', { userId: tomId, competencyId: competency.id, rating: 5, comment: 'Sehr vertraulich' });
  assert.ok(rated.status < 300, JSON.stringify(rated.data));

  const fromManager = item => item.source === 'manager';
  const direct = (await felix('GET', `/api/talent/profile/${tomId}`)).data.profile;
  assert.ok(direct.skillGap.requirements.some(fromManager), 'Die direkte Führungskraft sieht ihre Note');
  assert.equal(direct.managerRatingsHidden, false);
  assert.ok((await elena('GET', `/api/talent/profile/${tomId}`)).data.profile.skillGap.requirements.some(fromManager), 'HR auch');

  const above = (await maria('GET', `/api/talent/profile/${tomId}`)).data.profile;
  assert.equal(above.managerRatingsHidden, true);
  assert.equal(above.skillGap.requirements.some(fromManager), false);
  assert.equal(above.comparisons.some(item => item.manager), false);
  assert.equal(JSON.stringify(above).includes('Sehr vertraulich'), false);
  const gap = (await maria('GET', `/api/talent/skill-gap/${tomId}`)).data.analysis;
  assert.equal(gap.requirements.some(fromManager), false);
});

test('Aufgaben ohne Frist zeigen keinen erfundenen Fälligkeitstag', () => {
  const felix = idOf('felix@loop.local');
  const rows = runtime().db.prepare("SELECT due_date FROM tasks WHERE user_id=? AND type='checkin_feedback_notice'").all(felix);
  assert.ok(rows.length > 0);
  assert.equal(rows[0].due_date, null);
});

test('Demo: Massenanlage hat eine Grenze', async () => {
  const elena = await signIn('elena@loop.local');
  const rows = Array.from({ length: 51 }, (unused, index) => ({ name: `Massen ${index}`, email: `massen${index}@loop.local`, role: 'employee' }));
  const tooMany = await elena('POST', '/api/users/import', { rows });
  assert.equal(tooMany.status, 403);
  assert.equal(tooMany.data.code, 'demo_protected');

  const db = runtime().db;
  const fill = db.prepare("INSERT INTO users(name,email,password_hash,role) VALUES('Füllung',?,'x','employee')");
  db.transaction(() => {
    for (let index = 0; index < 200; index += 1) fill.run(`fuellung${index}@loop.local`);
  })();
  const full = await elena('POST', '/api/users', { name: 'Zu viel', email: 'zu-viel@loop.local' });
  assert.equal(full.status, 403);
  assert.equal(full.data.code, 'demo_protected');
  assert.equal((await elena('POST', '/api/users/import', { rows: rows.slice(0, 2) })).status, 403);
  db.prepare("DELETE FROM users WHERE email LIKE 'fuellung%'").run();
});

test('Herkunftsprüfung: fremde Seiten und gefälschte Kopfzeilen scheitern', async () => {
  const headers = { 'content-type': 'application/json' };
  const body = JSON.stringify({ email: 'lena@loop.local', password: DEMO_PASSWORD });
  const login = (extra = {}) => fetch(`${baseUrl}/api/auth/login`, { method: 'POST', headers: { ...headers, ...extra }, body });
  assert.equal((await login({ origin: 'https://evil.example' })).status, 403);
  assert.equal((await login({ origin: 'https://evil.example', 'x-forwarded-host': 'evil.example' })).status, 403, 'Ohne Proxy-Einstellung zählt die Kopfzeile nicht');
  assert.equal((await login({ 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await login({ origin: baseUrl })).status, 200);
  assert.equal((await login({ 'sec-fetch-site': 'same-origin' })).status, 200);
});

test('NUL-Zeichen werden überall abgewiesen', async () => {
  assert.equal((await fetch(`${baseUrl}/api/public/context?org=%00`)).status, 400);
  const login = await fetch(`${baseUrl}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'a\u0000@b.de', password: 'x' }) });
  assert.equal(login.status, 400);
  const nested = await fetch(`${baseUrl}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ a: { b: ['x\u0000'] } }) });
  assert.equal(nested.status, 400);
  assert.equal((await fetch(`${baseUrl}/api/public/context?org=%E0%A4%A`)).status, 400, 'Kaputte Adresskodierung');
});

test('Die Sachbearbeitung trägt weder sich noch Kolleg:innen als Führungskraft ein', async () => {
  const elena = await signIn('elena@loop.local');
  const hanna = await signIn('hanna@loop.local');
  const person = await createPerson(elena, { email: 'zuordnung-test@loop.local', name: 'Zuordnung Test' });
  const colleague = await createPerson(elena, { email: 'hr-kollegin@loop.local', name: 'HR Kollegin', role: 'hr_staff' });
  for (const managerId of [idOf('hanna@loop.local'), colleague.id]) {
    assert.equal((await hanna('PATCH', `/api/users/${person.id}/manager`, { managerId })).status, 403);
    assert.equal((await hanna('POST', '/api/users', { name: 'Neu', email: 'bei-hanna@loop.local', role: 'employee', managerId })).status, 403);
  }
  const preview = await hanna('POST', '/api/users/import', { dryRun: true, rows: [{ name: 'Import', email: 'import-hanna@loop.local', role: 'Mitarbeiter:in', position: '', managerEmail: 'hanna@loop.local' }] });
  assert.equal(preview.data.summary.invalid, 1, JSON.stringify(preview.data));
  assert.equal(runtime().db.prepare('SELECT manager_id FROM users WHERE id=?').get(person.id).manager_id, null);
  // Eine vorhandene Führungskraft trägt sie wie bisher ein. Die HR-Administration darf auch HR-Personen eintragen.
  assert.equal((await hanna('PATCH', `/api/users/${person.id}/manager`, { managerId: idOf('felix@loop.local') })).status, 200);
  assert.equal((await elena('PATCH', `/api/users/${person.id}/manager`, { managerId: colleague.id })).status, 200);
});

test('Neue Person: Wer führen soll, bekommt erst nach Rückfrage die Rolle', async () => {
  const elena = await signIn('elena@loop.local');
  const hanna = await signIn('hanna@loop.local');
  const lead = await createPerson(elena, { email: 'kuenftige-leitung@loop.local', name: 'Künftige Leitung' });
  const body = { name: 'Mit Leitung', email: 'mit-leitung@loop.local', role: 'employee', managerId: lead.id };
  const asked = await elena('POST', '/api/users', body);
  assert.equal(asked.status, 409);
  assert.equal(asked.data.code, 'manager_role_required');
  assert.equal(runtime().db.prepare('SELECT COUNT(*) count FROM users WHERE email=?').get(body.email).count, 0);
  assert.equal((await hanna('POST', '/api/users', { ...body, promoteManager: true })).status, 403, 'Die Sachbearbeitung vergibt keine Führungsrolle');
  assert.equal(roleOf('kuenftige-leitung@loop.local'), 'employee');
  assert.equal((await elena('POST', '/api/users', { ...body, promoteManager: true })).status, 200);
  assert.equal(roleOf('kuenftige-leitung@loop.local'), 'manager');
  // Im Import genauso: Die Führungskraft in der Datei braucht die passende Rolle.
  const preview = await elena('POST', '/api/users/import', { dryRun: true, rows: [
    { name: 'Eins', email: 'import-eins@loop.local', role: 'Mitarbeiter:in', position: '', managerEmail: 'import-zwei@loop.local' },
    { name: 'Zwei', email: 'import-zwei@loop.local', role: 'Mitarbeiter:in', position: '', managerEmail: '' },
    { name: 'Drei', email: 'import-drei@loop.local', role: 'Mitarbeiter:in', position: '', managerEmail: 'lena@loop.local' }
  ] });
  assert.equal(preview.data.summary.invalid, 2, JSON.stringify(preview.data));
});

test('Eine neue Position ab einem künftigen Datum wird abgelehnt, statt sofort zu gelten', async () => {
  const elena = await signIn('elena@loop.local');
  const position = runtime().db.prepare('SELECT id FROM position_profiles WHERE active=1 LIMIT 1').get();
  const created = await elena('POST', '/api/users', { name: 'Künftig', email: 'kuenftige-position@loop.local', role: 'employee', positionProfileId: position.id, positionEffectiveDate: '2099-01-01' });
  assert.equal(created.status, 400);
});

test('Die Führungsrolle bleibt, solange jemand geführt wird', async () => {
  const elena = await signIn('elena@loop.local');
  const lead = await createPerson(elena, { email: 'leitung-bleibt@loop.local', name: 'Leitung Bleibt', role: 'manager' });
  const member = await createPerson(elena, { email: 'wird-gefuehrt@loop.local', name: 'Wird Geführt', managerId: lead.id });
  const refused = await elena('PATCH', `/api/users/${lead.id}`, { role: 'employee' });
  assert.equal(refused.status, 409);
  assert.equal(refused.data.code, 'still_leading');
  assert.equal(roleOf('leitung-bleibt@loop.local'), 'manager');
  assert.equal((await elena('PATCH', `/api/users/${member.id}/manager`, { managerId: null })).status, 200);
  assert.equal((await elena('PATCH', `/api/users/${lead.id}`, { role: 'employee' })).status, 200);
});

test('Sperren nennt, wie viele Personen noch geführt werden', async () => {
  const elena = await signIn('elena@loop.local');
  const lead = await createPerson(elena, { email: 'wird-gesperrt@loop.local', name: 'Wird Gesperrt', role: 'manager' });
  await createPerson(elena, { email: 'bleibt-haengen@loop.local', name: 'Bleibt Hängen', managerId: lead.id });
  const locked = await elena('PATCH', `/api/users/${lead.id}/active`, { active: false });
  assert.equal(locked.data.directReports, 1);
  assert.equal((await elena('PATCH', `/api/users/${lead.id}/active`, { active: true })).data.directReports, 0);
});

test('Neue E-Mail oder neuer Name: Die Person erfährt es. Reservierte E-Mails sind tabu', async () => {
  const elena = await signIn('elena@loop.local');
  const person = await createPerson(elena, { email: 'wird-umbenannt@loop.local', name: 'Wird Umbenannt' });
  const notices = () => runtime().db.prepare("SELECT title FROM tasks WHERE user_id=? AND type='account_notice' AND done=0 ORDER BY id").all(person.id).map(task => task.title);
  assert.equal((await elena('PATCH', `/api/users/${person.id}`, { title: 'Nur Bezeichnung' })).status, 200);
  assert.deepEqual(notices(), [], 'Eine neue Bezeichnung braucht keinen Hinweis');
  assert.equal((await elena('PATCH', `/api/users/${person.id}`, { name: 'Neuer Name' })).status, 200);
  assert.match(notices()[0], /Neuer Name/);
  assert.equal((await elena('PATCH', `/api/users/${person.id}`, { email: 'neu-umbenannt@loop.local' })).status, 200);
  assert.match(notices()[1], /neu-umbenannt@loop\.local/);
  for (const email of ['root@root.de', 'system-root@daybreak.internal']) {
    assert.equal((await elena('POST', '/api/users', { name: 'Tabu', email, role: 'employee' })).status, 400);
    assert.equal((await elena('PATCH', `/api/users/${person.id}`, { email })).status, 400);
  }
});

test('Passwörter: zu einfache werden abgelehnt', async () => {
  assert.ok(passwordProblem('kurz'));
  assert.ok(passwordProblem('111111111111'));
  assert.ok(passwordProblem('abababababab'));
  assert.ok(passwordProblem('passwort1234'));
  assert.ok(passwordProblem('Passwort2026!'));
  assert.ok(passwordProblem('123456789012'));
  assert.ok(passwordProblem('Daybreak2026'));
  assert.equal(passwordProblem(NEW_PASSWORD), null);
  const elena = await signIn('elena@loop.local');
  const person = await createPerson(elena, { email: 'einfach-pw@loop.local' });
  const session = await person.signIn();
  assert.equal((await session('POST', '/api/auth/password', { currentPassword: NEW_PASSWORD, newPassword: '111111111111' })).status, 400);
});

test('Alte Verweise ins Leere und eigene Trigger verhindern den Umbau nicht', { skip: Boolean(process.env.DAYBREAK_TEST_DATABASE_URL) }, () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = OFF');
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('employee','manager','director','hr_admin','hrbp')), title TEXT, manager_id INTEGER REFERENCES users(id), is_system_account INTEGER DEFAULT 0);
    CREATE TABLE goals (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), title TEXT NOT NULL);
    CREATE TABLE zaehler (id INTEGER PRIMARY KEY, anzahl INTEGER);
    INSERT INTO users(id,name,email,password_hash,role) VALUES (1,'Alt','alt@x.de','h','hr_admin');
    INSERT INTO goals(user_id,title) VALUES (99,'Zeigt seit Langem ins Leere');
    CREATE VIEW personen AS SELECT id,name FROM users;
    CREATE TRIGGER mitzaehlen AFTER INSERT ON goals BEGIN UPDATE users SET name=name WHERE id=NEW.user_id; END;
  `);
  db.pragma('foreign_keys = ON');
  initializeCoreSchema(db);
  db.prepare("UPDATE users SET role='hr_staff' WHERE id=1").run();
  assert.equal(db.prepare('SELECT name FROM personen').get().name, 'Alt', 'Die eigene Sicht funktioniert weiter');
  assert.equal(db.prepare("SELECT COUNT(*) count FROM goals").get().count, 1);
  assert.equal(db.pragma('legacy_alter_table', { simple: true }), 0);
  db.close();
});

test('Ältere Datenbanken lernen die neue Rolle, ohne dass Daten verloren gehen', { skip: Boolean(process.env.DAYBREAK_TEST_DATABASE_URL) }, () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('employee','manager','director','hr_admin','hrbp')), title TEXT, manager_id INTEGER REFERENCES users(id), created_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE INDEX idx_users_manager ON users(manager_id);
    CREATE TABLE goals (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), title TEXT NOT NULL);
    INSERT INTO users(id,name,email,password_hash,role) VALUES (1,'Alt','alt@x.de','h','hr_admin'), (2,'Team','team@x.de','h','employee');
    UPDATE users SET manager_id=1 WHERE id=2;
    INSERT INTO goals(user_id,title) VALUES (2,'Bleibt');
  `);
  assert.throws(() => db.prepare("UPDATE users SET role='hr_staff' WHERE id=2").run(), /CHECK/);
  initializeCoreSchema(db);
  db.prepare("UPDATE users SET role='hr_staff' WHERE id=2").run();
  assert.throws(() => db.prepare("UPDATE users SET role='unsinn' WHERE id=2").run(), /CHECK/);
  assert.equal(db.prepare('SELECT manager_id FROM users WHERE id=2').get().manager_id, 1);
  assert.equal(db.prepare('SELECT title FROM goals').get().title, 'Bleibt');
  assert.throws(() => db.prepare("INSERT INTO goals(user_id,title) VALUES (99,'Ins Leere')").run(), /FOREIGN KEY/, 'Verweise wirken weiter');
  assert.throws(() => db.prepare('DELETE FROM users WHERE id=1').run(), /FOREIGN KEY/);
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_users_manager'").get(), 'Index bleibt');
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
  // Ein zweiter Start ändert nichts mehr.
  initializeCoreSchema(db);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM users').get().count, 2);
  db.close();
});

test('Der HR Business Partner ändert die Führungskraft von HR-Konten nicht', async () => {
  const david = await signIn('david@loop.local');
  const hannaId = idOf('hanna@loop.local');
  const davidId = idOf('david@loop.local');
  const accounts = (await david('GET', '/api/users')).data.users;
  assert.equal(accounts.find(person => person.id === hannaId).canAssign, false);
  assert.equal(accounts.find(person => person.email === 'lena@loop.local').canAssign, true);
  assert.equal((await david('PATCH', `/api/users/${hannaId}/manager`, { managerId: davidId })).status, 403);
  assert.notEqual(runtime().db.prepare('SELECT manager_id FROM users WHERE id=?').get(hannaId).manager_id, davidId);
});

test('Greift HR ein, erfährt es die direkte Führungskraft', async () => {
  const david = await signIn('david@loop.local');
  const felixId = idOf('felix@loop.local');
  const julia = idOf('julia@loop.local');
  const notices = type => runtime().db.prepare('SELECT title FROM tasks WHERE user_id=? AND type=? AND done=0').all(felixId, type).map(task => task.title);
  const checkin = await david('POST', '/api/checkins', { employeeId: julia, period: '2026-07', summary: 'Von HR erfasst', performance: 3, onTrack: 'on_track' });
  assert.equal(checkin.status, 200, JSON.stringify(checkin.data));
  assert.ok(notices('checkin_feedback_notice').some(title => title.includes('Julia') && title.includes('Juli 2026')));
  const goal = await david('POST', '/api/goals', { userId: julia, title: 'Von HR angelegt', dueDate: '2030-01-01', weight: 10 });
  assert.equal(goal.status, 200, JSON.stringify(goal.data));
  assert.ok(notices('goal_decision_notice').some(title => title.includes('Von HR angelegt')));
  assert.equal((await david('PATCH', `/api/goals/${goal.data.id}`, { progress: 3 })).status, 200);
  assert.ok(notices('goal_decision_notice').some(title => title.includes('geändert')));
});

test('Import kennt jede Rollenbezeichnung, die Daybreak selbst ausgibt', async () => {
  const elena = await signIn('elena@loop.local');
  const labels = ['Mitarbeiter:in', 'Führungskraft', 'Bereichsleitung', 'HR-Sachbearbeitung', 'HR Business Partner', 'HR-Administration'];
  const rows = labels.map((role, index) => ({ name: `Rolle ${index}`, email: `rolle-${index}@loop.local`, role, position: '', managerEmail: '' }));
  const preview = await elena('POST', '/api/users/import', { dryRun: true, rows });
  assert.equal(preview.data.summary.invalid, 0, JSON.stringify(preview.data.rows.map(row => row.errors)));
});
