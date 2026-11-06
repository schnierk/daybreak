'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { after, before, test } = require('node:test');
const { createModuleHarness } = require('../lib/testing/module-harness');
const { createOnboardingModule, startJourney } = require('../routes/onboarding');

const DAY_IN_MS = 24 * 60 * 60 * 1000;
const daysFromNow = days => new Date(Date.now() + days * DAY_IN_MS).toISOString().slice(0, 10);
const addDays = (isoDate, days) => new Date(Date.parse(`${isoDate}T00:00:00Z`) + days * DAY_IN_MS).toISOString().slice(0, 10);
const germanDate = isoDate => isoDate.split('-').reverse().join('.');

// Relativ zu heute: Ein festes Datum läge irgendwann in der Vergangenheit.
const KEY_DATE = daysFromNow(30);

let h;

async function ok(promise, expectedStatus = 200) {
  const response = await promise;
  assert.equal(response.status, expectedStatus, JSON.stringify(response.data));
  return response.data;
}

/** Vorlage mit genau drei Aufgaben: je eine für Person, Führungskraft und HR. */
async function createThreeStepTemplate(name, kind = 'onboarding') {
  const { id } = await ok(h.api('hr', 'POST', '/api/onboarding/templates', {
    name,
    kind,
    tasks: [
      { title: `${name}: Person`, description: 'Text für die Person', assigneeType: 'person', offsetDays: 0 },
      { title: `${name}: Führung`, description: 'Vertraulicher Text für die Führung', assigneeType: 'manager', offsetDays: -3 },
      { title: `${name}: HR`, description: 'Vertraulicher Text für HR', assigneeType: 'hr', offsetDays: 5 }
    ]
  }));
  return id;
}

async function startFor(person, templateId, starter = 'hr') {
  const userId = h.people[person].id;
  const started = await ok(h.api(starter, 'POST', '/api/onboarding/journeys', { userId, templateId, keyDate: KEY_DATE }));
  return started.id;
}

const taskRows = journeyTaskId => h.db.prepare("SELECT * FROM tasks WHERE type='onboarding_task' AND entity_id=?").all(journeyTaskId);
const journeyTaskRows = journeyId => h.db.prepare('SELECT * FROM onboarding_journey_tasks WHERE journey_id=? ORDER BY id').all(journeyId);

/** Beendet alle Abläufe einer Person, damit Tests einander nicht in die Quere kommen. */
function resetJourneys(person) {
  h.db.prepare("UPDATE onboarding_journeys SET status='cancelled' WHERE user_id=? AND status='active'").run(h.people[person].id);
}

before(async () => {
  h = await createModuleHarness(createOnboardingModule);
});

after(() => h.close());

test('Ohne Anmeldung gibt es keinen Zugriff', async () => {
  for (const [method, url] of [
    ['GET', '/api/onboarding/mine'],
    ['GET', '/api/onboarding/journeys'],
    ['GET', '/api/onboarding/journeys/1'],
    ['POST', '/api/onboarding/journeys'],
    ['GET', '/api/onboarding/templates'],
    ['POST', '/api/onboarding/tasks/1/complete']
  ]) {
    const response = await h.api(null, method, url, method === 'POST' ? {} : undefined);
    assert.equal(response.status, 401, `${method} ${url}`);
  }
});

test('Neutrale Standardvorlagen entstehen genau einmal', async () => {
  h.instance.initialize();
  h.instance.initialize();
  const { templates } = await ok(h.api('hr', 'GET', '/api/onboarding/templates'));
  const byKind = kind => templates.filter(template => template.kind === kind);
  assert.equal(byKind('onboarding').length, 1);
  assert.equal(byKind('offboarding').length, 1);
  assert.ok(byKind('onboarding')[0].tasks.length >= 3);
  assert.ok(byKind('offboarding')[0].tasks.some(task => task.offsetDays < 0), 'Austritt hat Aufgaben vor dem Stichtag');
  for (const template of templates) {
    for (const task of template.tasks) assert.ok(['person', 'manager', 'hr'].includes(task.assigneeType));
  }
  const accounts = h.db.prepare('SELECT COUNT(*) AS count FROM users').get().count;
  assert.equal(accounts, Object.keys(h.people).length, 'initialize legt keine Personen an');
});

test('Nur HR pflegt Vorlagen, Mitarbeitende sehen sie gar nicht', async () => {
  const body = { name: 'Fremd', kind: 'onboarding', tasks: [] };
  assert.equal((await h.api('anna', 'POST', '/api/onboarding/templates', body)).status, 403);
  assert.equal((await h.api('manager', 'POST', '/api/onboarding/templates', body)).status, 403);
  assert.equal((await h.api('anna', 'GET', '/api/onboarding/templates')).status, 403);
  await ok(h.api('manager', 'GET', '/api/onboarding/templates'));

  const templateId = await createThreeStepTemplate('Rechte');
  assert.equal((await h.api('manager', 'PATCH', `/api/onboarding/templates/${templateId}`, { name: 'x' })).status, 403);
  assert.equal((await h.api('manager', 'POST', `/api/onboarding/templates/${templateId}/tasks`, { title: 'x', assigneeType: 'hr' })).status, 403);
  const { template } = await ok(h.api('hr', 'GET', `/api/onboarding/templates/${templateId}`));
  const taskId = template.tasks[0].id;
  assert.equal((await h.api('manager', 'PATCH', `/api/onboarding/template-tasks/${taskId}`, { title: 'x' })).status, 403);
  assert.equal((await h.api('anna', 'DELETE', `/api/onboarding/template-tasks/${taskId}`)).status, 403);
  await ok(h.api('hr', 'PATCH', `/api/onboarding/templates/${templateId}`, { active: false }));
});

test('Ungültige Vorlagen und Aufgaben werden abgelehnt', async () => {
  assert.equal((await h.api('hr', 'POST', '/api/onboarding/templates', { name: '', kind: 'onboarding' })).status, 400);
  assert.equal((await h.api('hr', 'POST', '/api/onboarding/templates', { name: 'x', kind: 'urlaub' })).status, 400);
  assert.equal((await h.api('hr', 'POST', '/api/onboarding/templates', { name: 'x', kind: 'onboarding', tasks: 'nein' })).status, 400);
  const { id } = await ok(h.api('hr', 'POST', '/api/onboarding/templates', { name: 'Prüfung', kind: 'onboarding' }));
  const add = body => h.api('hr', 'POST', `/api/onboarding/templates/${id}/tasks`, body);
  assert.equal((await add({ title: '', assigneeType: 'hr' })).status, 400);
  assert.equal((await add({ title: 'x', assigneeType: 'chef' })).status, 400);
  assert.equal((await add({ title: 'x', assigneeType: 'hr', offsetDays: 'bald' })).status, 400);
  assert.equal((await add({ title: 'x', assigneeType: 'hr', offsetDays: 99999 })).status, 400);
  await ok(add({ title: 'Vorher <b>prüfen</b>', assigneeType: 'hr', offsetDays: -30 }));
  const { template } = await ok(h.api('hr', 'GET', `/api/onboarding/templates/${id}`));
  assert.equal(template.tasks[0].offsetDays, -30);
  assert.ok(!template.tasks[0].title.includes('<'), 'spitze Klammern werden entfernt');
  assert.equal((await h.api('hr', 'GET', '/api/onboarding/templates/999999')).status, 404);
  assert.equal((await h.api('hr', 'PATCH', '/api/onboarding/template-tasks/999999', { title: 'x' })).status, 404);
  assert.equal((await h.api('hr', 'GET', '/api/onboarding/templates?kind=boese')).status, 400);
});

test('Starten dürfen HR und die direkte Führungskraft, sonst niemand', async () => {
  const templateId = await createThreeStepTemplate('Start');
  const body = person => ({ userId: h.people[person].id, templateId, keyDate: KEY_DATE });
  assert.equal((await h.api('anna', 'POST', '/api/onboarding/journeys', body('ben'))).status, 403, 'Kollegin');
  assert.equal((await h.api('anna', 'POST', '/api/onboarding/journeys', body('anna'))).status, 403, 'eigener Ablauf');
  assert.equal((await h.api('director', 'POST', '/api/onboarding/journeys', body('anna'))).status, 403, 'nicht direkte Führung');
  assert.equal((await h.api('manager', 'POST', '/api/onboarding/journeys', body('clara'))).status, 403, 'fremdes Team');
  assert.equal((await h.api('manager', 'POST', '/api/onboarding/journeys', { ...body('anna'), userId: 999999 })).status, 403, 'unbekannt ohne HR-Recht');

  const managerStart = await ok(h.api('manager', 'POST', '/api/onboarding/journeys', body('anna')));
  assert.ok(managerStart.id);
  const duplicate = await h.api('hr', 'POST', '/api/onboarding/journeys', body('anna'));
  assert.equal(duplicate.status, 409, 'nur ein laufender Ablauf je Art');
  await ok(h.api('hr', 'POST', '/api/onboarding/journeys', body('clara')));
  resetJourneys('anna');
  resetJourneys('clara');
});

test('Ungültige Starts werden abgelehnt', async () => {
  const templateId = await createThreeStepTemplate('Ungültig');
  const start = body => h.api('hr', 'POST', '/api/onboarding/journeys', { userId: h.people.ben.id, templateId, keyDate: KEY_DATE, ...body });
  assert.equal((await start({ keyDate: 'morgen' })).status, 400);
  assert.equal((await start({ keyDate: '2026-02-31' })).status, 400, 'den 31. Februar gibt es nicht');
  assert.equal((await start({ keyDate: ['2026-12-01'] })).status, 400);
  assert.equal((await start({ keyDate: undefined })).status, 400);
  assert.equal((await start({ templateId: 999999 })).status, 400);
  assert.equal((await start({ templateId: undefined })).status, 400);
  assert.equal((await start({ userId: 999999 })).status, 404);
  assert.equal((await start({ userId: 'x' })).status, 404);

  const empty = await ok(h.api('hr', 'POST', '/api/onboarding/templates', { name: 'Leer', kind: 'onboarding' }));
  assert.equal((await start({ templateId: empty.id })).status, 400, 'Vorlage ohne Aufgaben');
  await ok(h.api('hr', 'PATCH', `/api/onboarding/templates/${templateId}`, { active: false }));
  assert.equal((await start({})).status, 400, 'abgeschaltete Vorlage');
});

test('Der Ablauf kopiert die Vorlage: spätere Änderungen wirken nicht zurück', async () => {
  const templateId = await createThreeStepTemplate('Kopie');
  const journeyId = await startFor('ben', templateId);
  const before = journeyTaskRows(journeyId).map(task => ({ title: task.title, due: task.due_date, type: task.assignee_type }));
  assert.equal(before.length, 3);
  assert.deepEqual(before.map(task => task.due).sort(), [addDays(KEY_DATE, -3), KEY_DATE, addDays(KEY_DATE, 5)], 'Fälligkeit aus Stichtag und Abstand, auch negativ');

  const { template } = await ok(h.api('hr', 'GET', `/api/onboarding/templates/${templateId}`));
  const [firstTask, secondTask] = template.tasks;
  await ok(h.api('hr', 'PATCH', `/api/onboarding/template-tasks/${firstTask.id}`, { title: 'Neu benannt', offsetDays: 50 }));
  await ok(h.api('hr', 'DELETE', `/api/onboarding/template-tasks/${secondTask.id}`));
  await ok(h.api('hr', 'POST', `/api/onboarding/templates/${templateId}/tasks`, { title: 'Ganz neu', assigneeType: 'hr' }));
  await ok(h.api('hr', 'PATCH', `/api/onboarding/templates/${templateId}`, { name: 'Umbenannt', active: false }));

  const after = journeyTaskRows(journeyId).map(task => ({ title: task.title, due: task.due_date, type: task.assignee_type }));
  assert.deepEqual(after, before);
  const { journey } = await ok(h.api('hr', 'GET', `/api/onboarding/journeys/${journeyId}`));
  assert.equal(journey.templateName, 'Kopie', 'Name der Vorlage bleibt der beim Start');
  resetJourneys('ben');
});

test('Aufgaben gehen über createTask an die Zuständigen', async () => {
  const templateId = await createThreeStepTemplate('Verteilung');
  const journeyId = await startFor('anna', templateId);
  const [person, manager, hr] = ['person', 'manager', 'hr'].map(type => journeyTaskRows(journeyId).find(task => task.assignee_type === type));

  assert.deepEqual(taskRows(person.id).map(row => row.user_id), [h.people.anna.id]);
  assert.deepEqual(taskRows(manager.id).map(row => row.user_id), [h.people.manager.id]);
  assert.deepEqual(taskRows(hr.id).map(row => row.user_id), [h.people.hr.id], 'HR-Aufgaben gehen an hr_admin');
  assert.ok(taskRows(person.id).every(row => row.type === 'onboarding_task'));
  assert.equal(taskRows(person.id)[0].due_date, KEY_DATE, 'die Aufgabe trägt die echte Frist');
  assert.equal(taskRows(manager.id)[0].due_date, addDays(KEY_DATE, -3));
  assert.ok(!taskRows(person.id)[0].title.includes('fällig'), 'die Übersicht nennt die Frist selbst');
  assert.ok(taskRows(manager.id)[0].title.includes('Anna Ahrens'), 'Führungskraft sieht, um wen es geht');
  resetJourneys('anna');
});

test('Ohne Führungskraft gehen Manager-Aufgaben an alle hr_admin', async () => {
  h.db.prepare("INSERT INTO users(id,name,email,password_hash,role) VALUES(50,'Zweite Admin','admin2@test.local','!TEST!','hr_admin')").run();
  h.db.prepare("INSERT INTO users(id,name,email,password_hash,role,active) VALUES(51,'Gesperrte Admin','admin3@test.local','!TEST!','hr_admin',0)").run();
  const templateId = await createThreeStepTemplate('Ohne Führung');
  const journeyId = await startFor('director', templateId);
  const managerTask = journeyTaskRows(journeyId).find(task => task.assignee_type === 'manager');
  assert.equal(managerTask.assignee_id, null);
  assert.deepEqual(taskRows(managerTask.id).map(row => row.user_id).sort(), [h.people.hr.id, 50].sort(), 'nur aktive hr_admin');
  assert.ok(!taskRows(managerTask.id).some(row => row.user_id === h.people.bp.id), 'hrbp bekommt die Aufgabe nicht zugewiesen');

  assert.equal((await h.api('director', 'POST', `/api/onboarding/tasks/${managerTask.id}/complete`)).status, 403, 'die Person selbst nicht');
  await ok(h.api('bp', 'POST', `/api/onboarding/tasks/${managerTask.id}/complete`));
  assert.ok(taskRows(managerTask.id).every(row => row.done === 1), 'alle Dashboard-Einträge sind geschlossen');
  h.db.prepare('DELETE FROM tasks WHERE user_id IN (50,51)').run();
  h.db.prepare('DELETE FROM users WHERE id IN (50,51)').run();
  resetJourneys('director');
});

test('Eine gesperrte Führungskraft zählt als keine Führungskraft', async () => {
  h.db.prepare("UPDATE users SET active=0 WHERE id=?").run(h.people.manager.id);
  const templateId = await createThreeStepTemplate('Gesperrt');
  const journeyId = await startFor('ben', templateId);
  const managerTask = journeyTaskRows(journeyId).find(task => task.assignee_type === 'manager');
  assert.equal(managerTask.assignee_id, null);
  assert.deepEqual(taskRows(managerTask.id).map(row => row.user_id), [h.people.hr.id]);
  h.db.prepare("UPDATE users SET active=1 WHERE id=?").run(h.people.manager.id);
  resetJourneys('ben');
});

test('Erledigen dürfen nur die zuständige Person und HR', async () => {
  const templateId = await createThreeStepTemplate('Erledigen');
  const journeyId = await startFor('anna', templateId);
  const [personTask, managerTask, hrTask] = ['person', 'manager', 'hr'].map(type => journeyTaskRows(journeyId).find(task => task.assignee_type === type));
  const complete = (who, task) => h.api(who, 'POST', `/api/onboarding/tasks/${task.id}/complete`);

  for (const who of ['ben', 'clara', 'manager', 'director']) {
    assert.equal((await complete(who, personTask)).status, 403, `${who} darf die Aufgabe der Person nicht erledigen`);
  }
  for (const who of ['anna', 'ben', 'director']) {
    assert.equal((await complete(who, managerTask)).status, 403, `${who} darf die Aufgabe der Führung nicht erledigen`);
  }
  for (const who of ['anna', 'manager', 'director']) {
    assert.equal((await complete(who, hrTask)).status, 403, `${who} darf die HR-Aufgabe nicht erledigen`);
  }
  assert.equal((await h.api('anna', 'POST', '/api/onboarding/tasks/999999/complete')).status, 404);
  assert.equal((await h.api('anna', 'POST', '/api/onboarding/tasks/abc/complete')).status, 404);

  await ok(complete('anna', personTask));
  await ok(complete('manager', managerTask));
  await ok(complete('bp', hrTask));
  assert.equal((await complete('anna', personTask)).status, 409, 'nicht zweimal');
});

test('Fortschritt in Prozent und Abschluss des Ablaufs', async () => {
  const templateId = await createThreeStepTemplate('Prozent');
  const journeyId = await startFor('ben', templateId);
  const tasks = journeyTaskRows(journeyId);
  const percent = async () => (await ok(h.api('hr', 'GET', `/api/onboarding/journeys/${journeyId}`))).journey.progress;

  assert.deepEqual(await percent(), { done: 0, total: 3, percent: 0 });
  const first = await ok(h.api('hr', 'POST', `/api/onboarding/tasks/${tasks[0].id}/complete`));
  assert.equal(first.progress.percent, 33);
  assert.equal(first.journeyStatus, 'active');
  const second = await ok(h.api('hr', 'POST', `/api/onboarding/tasks/${tasks[1].id}/complete`));
  assert.equal(second.progress.percent, 67);
  const list = await ok(h.api('hr', 'GET', `/api/onboarding/journeys?userId=${h.people.ben.id}`));
  assert.equal(list.journeys.find(item => item.id === journeyId).progress.percent, 67, 'die Liste rechnet genauso');
  const third = await ok(h.api('hr', 'POST', `/api/onboarding/tasks/${tasks[2].id}/complete`));
  assert.equal(third.progress.percent, 100);
  assert.equal(third.journeyStatus, 'completed');

  const { journey } = await ok(h.api('hr', 'GET', `/api/onboarding/journeys/${journeyId}`));
  assert.equal(journey.status, 'completed');
  assert.ok(journey.completedAt);
  assert.ok(journey.tasks.every(task => task.done && !task.canComplete));
  const open = h.db.prepare(`
    SELECT COUNT(*) AS count FROM tasks t JOIN onboarding_journey_tasks j ON j.id=t.entity_id
    WHERE t.type='onboarding_task' AND j.journey_id=? AND t.done=0
  `).get(journeyId).count;
  assert.equal(open, 0, 'keine offene Aufgabe bleibt auf dem Dashboard');
  await ok(h.api('hr', 'POST', '/api/onboarding/journeys', { userId: h.people.ben.id, templateId, keyDate: KEY_DATE }));
  resetJourneys('ben');
});

test('Aufgabenzahl je Vorlage ist begrenzt und Runden täuscht keinen Abschluss vor', async () => {
  const tooMany = Array.from({ length: 101 }, (_, index) => ({ title: `Schritt ${index}`, assigneeType: 'hr' }));
  assert.equal((await h.api('hr', 'POST', '/api/onboarding/templates', { name: 'Zu viele', kind: 'onboarding', tasks: tooMany })).status, 400);

  const hundred = tooMany.slice(0, 100);
  const { id: templateId } = await ok(h.api('hr', 'POST', '/api/onboarding/templates', { name: 'Hundert', kind: 'onboarding', tasks: hundred }));
  assert.equal((await h.api('hr', 'POST', `/api/onboarding/templates/${templateId}/tasks`, { title: 'Eine zu viel', assigneeType: 'hr' })).status, 400);
  const journeyId = await startFor('clara', templateId);
  const rows = journeyTaskRows(journeyId);
  h.db.prepare('UPDATE onboarding_journey_tasks SET done_at=? WHERE journey_id=? AND id<>?').run('2026-01-01T00:00:00.000Z', journeyId, rows[0].id);
  const { journey } = await ok(h.api('hr', 'GET', `/api/onboarding/journeys/${journeyId}`));
  assert.equal(journey.progress.done, 99);
  assert.equal(journey.progress.percent, 99);
  resetJourneys('clara');
});

test('Sichten: Person, Führungslinie und HR sehen jeweils das Richtige', async () => {
  const templateId = await createThreeStepTemplate('Sichten');
  const journeyId = await startFor('anna', templateId);
  const url = `/api/onboarding/journeys/${journeyId}`;

  const own = (await ok(h.api('anna', 'GET', url))).journey;
  assert.equal(own.viewer, 'person');
  assert.equal(own.tasks.length, 1, 'die Person sieht nur eigene Aufgaben');
  assert.equal(own.tasks[0].title, 'Sichten: Person');
  assert.deepEqual(own.otherTasks, { total: 2, done: 0 });
  const ownText = JSON.stringify(own);
  assert.ok(!ownText.includes('Vertraulicher Text'), 'keine Beschreibung fremder Aufgaben');
  assert.ok(!ownText.includes('Sichten: HR'), 'kein Titel fremder Aufgaben');
  assert.ok(!('cancelReason' in own) && !('startedAt' in own), 'keine Verwaltungsfelder');
  assert.equal(own.progress.total, 3, 'der Fortschritt zählt trotzdem alles');

  const mine = await ok(h.api('anna', 'GET', '/api/onboarding/mine'));
  const mineEntry = mine.journeys.find(item => item.id === journeyId);
  assert.equal(mineEntry.tasks.length, 1);
  assert.ok(!JSON.stringify(mineEntry).includes('Vertraulicher Text'));

  for (const who of ['manager', 'director', 'hr', 'bp']) {
    const view = (await ok(h.api(who, 'GET', url))).journey;
    assert.equal(view.viewer, 'full', who);
    assert.equal(view.tasks.length, 3, who);
  }
  for (const who of ['ben', 'clara']) {
    assert.equal((await h.api(who, 'GET', url)).status, 403, who);
  }
  assert.equal((await h.api('hr', 'GET', '/api/onboarding/journeys/999999')).status, 404);
  assert.equal((await h.api('hr', 'GET', '/api/onboarding/journeys/abc')).status, 404);

  const managerList = await ok(h.api('manager', 'GET', '/api/onboarding/journeys'));
  assert.ok(managerList.journeys.some(item => item.id === journeyId));
  const directorList = await ok(h.api('director', 'GET', '/api/onboarding/journeys'));
  assert.ok(directorList.journeys.some(item => item.id === journeyId), 'die ganze Führungslinie');
  const hrList = await ok(h.api('bp', 'GET', '/api/onboarding/journeys?status=active&kind=onboarding'));
  assert.ok(hrList.journeys.some(item => item.id === journeyId));

  assert.equal((await h.api('anna', 'GET', '/api/onboarding/journeys')).status, 403, 'Mitarbeitende haben keine Gesamtliste');
  assert.equal((await h.api('ben', 'GET', `/api/onboarding/journeys?userId=${h.people.anna.id}`)).status, 403, 'fremde Person');
  assert.equal((await h.api('clara', 'GET', '/api/onboarding/meta')).status, 403);
  assert.equal((await h.api('hr', 'GET', '/api/onboarding/journeys?status=boese')).status, 400);
  assert.equal((await h.api('hr', 'GET', '/api/onboarding/journeys?kind=boese')).status, 400);
  assert.equal((await h.api('hr', 'GET', '/api/onboarding/journeys?userId=abc')).status, 400);

  const annaTask = journeyTaskRows(journeyId).find(task => task.assignee_type === 'person');
  assert.deepEqual(await ok(h.api('anna', 'GET', `/api/onboarding/tasks/${annaTask.id}`)), { journeyId, own: true });
  assert.equal((await h.api('ben', 'GET', `/api/onboarding/tasks/${annaTask.id}`)).status, 403);
  resetJourneys('anna');
});

test('Die Personenauswahl beim Start passt zur Rolle', async () => {
  const hrMeta = await ok(h.api('hr', 'GET', '/api/onboarding/meta'));
  assert.equal(hrMeta.people.length, Object.keys(h.people).length - 1, 'alle außer der eigenen Person');
  assert.ok(!hrMeta.people.some(person => person.id === h.people.hr.id));
  assert.equal(hrMeta.canManageTemplates, true);
  const managerMeta = await ok(h.api('manager', 'GET', '/api/onboarding/meta'));
  assert.deepEqual(managerMeta.people.map(person => person.name).sort(), ['Anna Ahrens', 'Ben Berg']);
  assert.equal(managerMeta.canManageTemplates, false);
  assert.ok(managerMeta.templates.every(template => template.tasks.length > 0), 'leere Vorlagen stehen nicht zur Wahl');
  assert.ok(managerMeta.templates.every(template => template.kind === 'onboarding'), 'Austritte startet nur HR');
  assert.ok(hrMeta.templates.some(template => template.kind === 'offboarding'));
});

test('Nur HR bricht einen Ablauf ab, offene Aufgaben schließen sich', async () => {
  const templateId = await createThreeStepTemplate('Abbruch');
  const journeyId = await startFor('anna', templateId);
  const cancelUrl = `/api/onboarding/journeys/${journeyId}/cancel`;
  for (const who of ['anna', 'manager', 'director']) {
    assert.equal((await h.api(who, 'POST', cancelUrl, {})).status, 403, who);
  }
  await ok(h.api('hr', 'POST', cancelUrl, { reason: 'Eintritt abgesagt' }));
  const open = journeyTaskRows(journeyId).flatMap(task => taskRows(task.id)).filter(row => row.done === 0);
  assert.equal(open.length, 0);
  const personTask = journeyTaskRows(journeyId).find(task => task.assignee_type === 'person');
  assert.equal((await h.api('anna', 'POST', `/api/onboarding/tasks/${personTask.id}/complete`)).status, 409);
  assert.equal((await h.api('hr', 'POST', cancelUrl, {})).status, 409, 'nicht zweimal');
  const mine = await ok(h.api('anna', 'GET', '/api/onboarding/mine'));
  assert.ok(!mine.journeys.some(item => item.id === journeyId), 'abgebrochene Abläufe erscheinen nicht unter „Mein Einstieg“');
});

test('Der Austritt läuft unabhängig vom Einstieg', async () => {
  const onboardingId = await createThreeStepTemplate('Parallel Ein');
  const offboardingId = await createThreeStepTemplate('Parallel Aus', 'offboarding');
  await startFor('clara', onboardingId);
  const journeyId = await startFor('clara', offboardingId);
  const { journey } = await ok(h.api('clara', 'GET', `/api/onboarding/journeys/${journeyId}`));
  assert.equal(journey.kind, 'offboarding');
  resetJourneys('clara');
});

test('startJourney arbeitet zustandslos mit Standardvorlage und meldet Fehler verständlich', () => {
  const { createTask, log } = h.deps;
  const started = startJourney(h.db, { personId: h.people.ben.id, kind: 'offboarding', keyDate: '2027-01-15', createTask, log });
  assert.ok(started.id);
  assert.equal(started.kind, 'offboarding');
  assert.ok(started.taskCount > 0);
  assert.throws(
    () => startJourney(h.db, { personId: h.people.ben.id, kind: 'offboarding', keyDate: '2027-01-15', createTask, log }),
    error => error.status === 409
  );
  assert.throws(
    () => startJourney(h.db, { personId: 999999, keyDate: '2027-01-15', createTask, log }),
    error => error.status === 404
  );
  resetJourneys('ben');
});

test('Die Systemadministration wird wie HR behandelt', async () => {
  const SYSTEM_ID = 99;
  const sysHarness = await createModuleHarness(createOnboardingModule, {
    extra: {
      current(req) {
        const id = Number(req.get('x-test-user'));
        if (id === SYSTEM_ID) return { id: SYSTEM_ID, name: 'Systemadministration', email: 'root@test.local', role: 'super_admin', title: null, manager_id: null };
        return id ? sysHarness.db.prepare('SELECT id,name,email,role,title,manager_id FROM users WHERE id=? AND is_system_account=0 AND active=1').get(id) || null : null;
      },
      auth: (req, res, next) => (req.get('x-test-user') ? next() : res.status(401).json({ error: 'Nicht angemeldet' }))
    }
  });
  try {
    sysHarness.db.prepare("INSERT INTO users(id,name,email,password_hash,role,is_system_account) VALUES(?,'Systemadministration','system-root@test.local','!','hr_admin',1)").run(SYSTEM_ID);
    const { templates } = await ok(sysHarness.api(SYSTEM_ID, 'GET', '/api/onboarding/templates'));
    const templateId = templates.find(template => template.kind === 'onboarding').id;
    const { id } = await ok(sysHarness.api(SYSTEM_ID, 'POST', '/api/onboarding/journeys', { userId: sysHarness.people.ben.id, templateId, keyDate: KEY_DATE }));
    const { journey } = await ok(sysHarness.api(SYSTEM_ID, 'GET', `/api/onboarding/journeys/${id}`));
    assert.equal(journey.viewer, 'full');
    await ok(sysHarness.api(SYSTEM_ID, 'POST', `/api/onboarding/tasks/${journey.tasks[0].id}/complete`));
    await ok(sysHarness.api(SYSTEM_ID, 'POST', `/api/onboarding/journeys/${id}/cancel`, {}));
    const { people } = await ok(sysHarness.api(SYSTEM_ID, 'GET', '/api/onboarding/meta'));
    assert.ok(!people.some(person => person.id === SYSTEM_ID), 'das technische Konto steht in keiner Auswahl');
    assert.equal((await sysHarness.api(SYSTEM_ID, 'POST', '/api/onboarding/journeys', { userId: SYSTEM_ID, templateId, keyDate: KEY_DATE })).status, 404);
    assert.ok(!sysHarness.db.prepare('SELECT id FROM tasks WHERE user_id=?').get(SYSTEM_ID), 'es bekommt keine Aufgaben');
  } finally {
    await sysHarness.close();
  }
});

/** Legt eine HR-Sachbearbeitung an, wie sie auch über die Oberfläche entsteht. */
function createStaff(harness = h, email = `sb${harness.db.prepare('SELECT COUNT(*) AS count FROM users').get().count}@test.local`) {
  const { id } = harness.deps.createUserAccount({ name: 'Sach Bearbeiter', email, role: 'hr_staff', actor: { id: 1 } });
  harness.db.prepare('UPDATE users SET must_change_password=0 WHERE id=?').run(id);
  return id;
}

test('A8: Einen Austritt startet nur HR, die Führungskraft auch nicht beim eigenen Team', async () => {
  const offboardingId = await createThreeStepTemplate('Nur HR', 'offboarding');
  const body = person => ({ userId: h.people[person].id, templateId: offboardingId, keyDate: KEY_DATE });
  const denied = await h.api('manager', 'POST', '/api/onboarding/journeys', body('anna'));
  assert.equal(denied.status, 403, 'direkte Führungskraft');
  assert.match(denied.data.error, /nur HR/);
  assert.equal((await h.api('director', 'POST', '/api/onboarding/journeys', body('clara'))).status, 403, 'Bereichsleitung beim eigenen Team');
  assert.equal(h.db.prepare("SELECT COUNT(*) AS count FROM onboarding_journeys WHERE kind='offboarding' AND status='active' AND user_id=?").get(h.people.anna.id).count, 0);
  assert.equal(h.db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE user_id=? AND done=0 AND title LIKE 'Austritt%'").get(h.people.anna.id).count, 0, 'bei der Person steht nichts');

  const { templates } = await ok(h.api('manager', 'GET', '/api/onboarding/templates'));
  assert.ok(templates.every(template => template.kind === 'onboarding'), 'Austrittsvorlagen bleiben HR vorbehalten');
  assert.equal((await h.api('manager', 'GET', `/api/onboarding/templates/${offboardingId}`)).status, 403);

  const started = await ok(h.api('hr', 'POST', '/api/onboarding/journeys', body('anna')));
  assert.equal(started.kind, 'offboarding');
  assert.equal((await h.api('manager', 'POST', `/api/onboarding/journeys/${started.id}/cancel`, {})).status, 403, 'abbrechen darf dann HR');
  await ok(h.api('hr', 'POST', `/api/onboarding/journeys/${started.id}/cancel`, { reason: 'Bleibt doch' }));
  assert.equal(h.db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE user_id=? AND done=0 AND title LIKE 'Austritt%'").get(h.people.anna.id).count, 0, 'die Aufgaben sind wieder weg');
});

test('A8: Wer als Führungskraft einen Einstieg gestartet hat, kann ihn zurücknehmen', async () => {
  const templateId = await createThreeStepTemplate('Zurücknehmen');
  const started = await ok(h.api('manager', 'POST', '/api/onboarding/journeys', { userId: h.people.ben.id, templateId, keyDate: KEY_DATE }));
  const { journey } = await ok(h.api('manager', 'GET', `/api/onboarding/journeys/${started.id}`));
  assert.equal(journey.canCancel, true);
  assert.equal((await ok(h.api('director', 'GET', `/api/onboarding/journeys/${started.id}`))).journey.canCancel, false, 'die Führungslinie darüber nicht');
  assert.equal((await h.api('director', 'POST', `/api/onboarding/journeys/${started.id}/cancel`, {})).status, 403);
  assert.equal((await h.api('ben', 'POST', `/api/onboarding/journeys/${started.id}/cancel`, {})).status, 403, 'die Person selbst nicht');
  await ok(h.api('manager', 'POST', `/api/onboarding/journeys/${started.id}/cancel`, {}));
  assert.equal((await h.api('manager', 'POST', `/api/onboarding/journeys/${started.id}/cancel`, {})).status, 409);

  const byHr = await ok(h.api('hr', 'POST', '/api/onboarding/journeys', { userId: h.people.ben.id, templateId, keyDate: KEY_DATE }));
  assert.equal((await ok(h.api('manager', 'GET', `/api/onboarding/journeys/${byHr.id}`))).journey.canCancel, false, 'einen Ablauf von HR bricht nur HR ab');
  assert.equal((await h.api('manager', 'POST', `/api/onboarding/journeys/${byHr.id}/cancel`, {})).status, 403);
  resetJourneys('ben');
});

test('B34: Ein Datum in der Vergangenheit muss bestätigt werden, ein Datum weit in der Zukunft nicht möglich', async () => {
  const templateId = await createThreeStepTemplate('Datum');
  const start = body => h.api('hr', 'POST', '/api/onboarding/journeys', { userId: h.people.clara.id, templateId, ...body });
  const past = daysFromNow(-3);
  const unconfirmed = await start({ keyDate: past });
  assert.equal(unconfirmed.status, 409);
  assert.equal(unconfirmed.data.code, 'past_key_date');
  assert.ok(unconfirmed.data.error.includes(germanDate(past)), 'die Meldung nennt das Datum');
  assert.equal(h.db.prepare("SELECT COUNT(*) AS count FROM onboarding_journeys WHERE user_id=? AND status='active'").get(h.people.clara.id).count, 0);
  assert.equal((await start({ keyDate: past, confirmPastDate: 'ja' })).status, 409, 'nur ein echtes true zählt');
  assert.equal((await start({ keyDate: daysFromNow(800) })).status, 400, 'zu weit in der Zukunft');
  await ok(start({ keyDate: past, confirmPastDate: true }));
  resetJourneys('clara');

  const offboardingId = await createThreeStepTemplate('Datum Aus', 'offboarding');
  assert.equal((await start({ templateId: offboardingId, keyDate: past })).status, 409, 'genauso beim Austritt');
  await ok(start({ templateId: offboardingId, keyDate: daysFromNow(1) }));
  resetJourneys('clara');
});

test('Die HR-Sachbearbeitung verwaltet Abläufe von Personen ohne HR-Rolle, aber keine Vorlagen', async () => {
  const staff = createStaff();
  const colleague = createStaff();
  const templateId = await createThreeStepTemplate('Sachbearbeitung');
  const offboardingId = await createThreeStepTemplate('Sachbearbeitung Aus', 'offboarding');

  const meta = await ok(h.api(staff, 'GET', '/api/onboarding/meta'));
  const names = meta.people.map(person => person.id);
  assert.ok(names.includes(h.people.anna.id) && names.includes(h.people.manager.id) && names.includes(h.people.director.id));
  for (const hidden of [h.people.hr.id, h.people.bp.id, staff, colleague]) assert.ok(!names.includes(hidden), `keine HR-Rolle: ${hidden}`);
  assert.equal(meta.canManageTemplates, false);
  assert.ok(meta.templates.some(template => template.kind === 'offboarding'), 'die Sachbearbeitung startet auch Austritte');

  const start = (userId, template = templateId) => h.api(staff, 'POST', '/api/onboarding/journeys', { userId, templateId: template, keyDate: KEY_DATE });
  assert.equal((await start(h.people.hr.id)).status, 403, 'HR-Leitung');
  assert.equal((await start(h.people.bp.id)).status, 403, 'HR Business Partner');
  assert.equal((await start(colleague)).status, 403, 'Kollegin');
  assert.equal((await start(staff)).status, 403, 'nicht sich selbst');

  const started = await ok(start(h.people.anna.id, offboardingId));
  const { journey } = await ok(h.api(staff, 'GET', `/api/onboarding/journeys/${started.id}`));
  assert.equal(journey.viewer, 'full');
  assert.equal(journey.canCancel, true);
  assert.ok(journey.tasks.every(task => task.canComplete), 'alle Aufgaben lassen sich erledigen');
  const hrTask = journey.tasks.find(task => task.assigneeType === 'hr');
  assert.ok(taskRows(hrTask.id).some(row => row.user_id === staff), 'wer den Ablauf startet, sieht die HR-Aufgaben');
  assert.ok(taskRows(hrTask.id).some(row => row.user_id === h.people.hr.id), 'die HR-Administration weiterhin auch');
  await ok(h.api(staff, 'POST', `/api/onboarding/tasks/${hrTask.id}/complete`));
  assert.ok(taskRows(hrTask.id).every(row => row.done === 1));
  const list = await ok(h.api(staff, 'GET', '/api/onboarding/journeys?status=active'));
  assert.ok(list.journeys.some(item => item.id === started.id));
  await ok(h.api(staff, 'POST', `/api/onboarding/journeys/${started.id}/cancel`, { reason: 'Falsch gestartet' }));

  const hrJourney = await ok(h.api('hr', 'POST', '/api/onboarding/journeys', { userId: h.people.bp.id, templateId, keyDate: KEY_DATE }));
  assert.equal((await h.api(staff, 'GET', `/api/onboarding/journeys/${hrJourney.id}`)).status, 403, 'Abläufe von HR-Rollen bleiben verborgen');
  assert.equal((await h.api(staff, 'POST', `/api/onboarding/journeys/${hrJourney.id}/cancel`, {})).status, 403);
  assert.equal((await h.api(staff, 'GET', `/api/onboarding/journeys?userId=${h.people.bp.id}`)).status, 403);
  const staffList = await ok(h.api(staff, 'GET', '/api/onboarding/journeys'));
  assert.ok(!staffList.journeys.some(item => item.id === hrJourney.id));
  const bpTask = journeyTaskRows(hrJourney.id).find(task => task.assignee_type === 'hr');
  assert.equal((await h.api(staff, 'POST', `/api/onboarding/tasks/${bpTask.id}/complete`)).status, 403);
  await ok(h.api('hr', 'POST', `/api/onboarding/journeys/${hrJourney.id}/cancel`, {}));

  const template = { name: 'Nicht erlaubt', kind: 'onboarding', tasks: [] };
  assert.equal((await h.api(staff, 'POST', '/api/onboarding/templates', template)).status, 403);
  assert.equal((await h.api(staff, 'PATCH', `/api/onboarding/templates/${templateId}`, { name: 'x' })).status, 403);
  assert.equal((await h.api(staff, 'POST', `/api/onboarding/templates/${templateId}/tasks`, { title: 'x', assigneeType: 'hr' })).status, 403);
  const { template: stored } = await ok(h.api('hr', 'GET', `/api/onboarding/templates/${templateId}`));
  assert.equal((await h.api(staff, 'PATCH', `/api/onboarding/template-tasks/${stored.tasks[0].id}`, { title: 'x' })).status, 403);
  assert.equal((await h.api(staff, 'DELETE', `/api/onboarding/template-tasks/${stored.tasks[0].id}`)).status, 403);
  resetJourneys('anna');
});

test('HR verwaltet den eigenen Ablauf nicht und sieht dort nur die eigenen Aufgaben', async () => {
  const templateId = await createThreeStepTemplate('Eigener Ablauf');
  const own = await h.api('hr', 'POST', '/api/onboarding/journeys', { userId: h.people.hr.id, templateId, keyDate: KEY_DATE });
  assert.equal(own.status, 403);
  assert.match(own.data.error, /andere HR-Person/);

  const { id } = await ok(h.api('bp', 'POST', '/api/onboarding/journeys', { userId: h.people.director.id, templateId, keyDate: KEY_DATE }));
  assert.ok(id);
  resetJourneys('director');

  const byColleague = h.deps.createUserAccount({ name: 'Zweite Leitung', email: 'leitung2@test.local', role: 'hr_admin', actor: { id: 1 } }).id;
  const started = await ok(h.api(byColleague, 'POST', '/api/onboarding/journeys', { userId: h.people.hr.id, templateId, keyDate: KEY_DATE }));
  const { journey } = await ok(h.api('hr', 'GET', `/api/onboarding/journeys/${started.id}`));
  assert.equal(journey.viewer, 'person', 'auch HR bekommt beim eigenen Ablauf die Sicht der Person');
  assert.ok(!JSON.stringify(journey).includes('Vertraulicher Text'));
  assert.equal(journey.canCancel, false);
  assert.equal((await h.api('hr', 'POST', `/api/onboarding/journeys/${started.id}/cancel`, {})).status, 403);
  const hrTask = journeyTaskRows(started.id).find(task => task.assignee_type === 'hr');
  assert.equal((await h.api('hr', 'POST', `/api/onboarding/tasks/${hrTask.id}/complete`)).status, 403, 'eigene HR-Aufgaben erledigt jemand anderes');
  assert.ok(!taskRows(hrTask.id).some(row => row.user_id === h.people.hr.id), 'die Aufgabe geht an die andere HR-Leitung');
  const list = await ok(h.api('hr', 'GET', '/api/onboarding/journeys?status=active'));
  assert.ok(!list.journeys.some(item => item.id === started.id), 'der eigene Ablauf steht nicht in der Arbeitsliste');

  assert.equal((await h.api('bp', 'GET', `/api/onboarding/journeys/${started.id}`)).status, 403, 'der HR Business Partner sieht Abläufe der HR-Leitung nicht');
  assert.equal((await h.api('bp', 'POST', `/api/onboarding/tasks/${hrTask.id}/complete`)).status, 403);
  assert.equal((await h.api('bp', 'POST', `/api/onboarding/journeys/${started.id}/cancel`, {})).status, 403);
  assert.ok(!(await ok(h.api('bp', 'GET', '/api/onboarding/meta'))).people.some(person => person.id === h.people.hr.id));
  await ok(h.api(byColleague, 'POST', `/api/onboarding/journeys/${started.id}/cancel`, {}));
  h.db.prepare('UPDATE users SET active=0 WHERE id=?').run(byColleague);
});

test('Wechsel der Führungskraft: offene Aufgaben ziehen mit, erledigte bleiben', async () => {
  const templateId = await ok(h.api('hr', 'POST', '/api/onboarding/templates', {
    name: 'Wechsel',
    kind: 'onboarding',
    tasks: [
      { title: 'Noch offen', assigneeType: 'manager', offsetDays: 1 },
      { title: 'Schon erledigt', assigneeType: 'manager', offsetDays: 2 },
      { title: 'Für HR', assigneeType: 'hr', offsetDays: 3 }
    ]
  })).then(template => template.id);
  const started = await ok(h.api('hr', 'POST', '/api/onboarding/journeys', { userId: h.people.ben.id, templateId, keyDate: KEY_DATE }));
  const rows = journeyTaskRows(started.id);
  const open = rows.find(task => task.title === 'Noch offen');
  const done = rows.find(task => task.title === 'Schon erledigt');
  const hrTask = rows.find(task => task.title === 'Für HR');
  await ok(h.api('manager', 'POST', `/api/onboarding/tasks/${done.id}/complete`));

  assert.equal(h.deps.changeManager(h.people.ben.id, h.people.director.id), true);
  assert.equal(journeyTaskRows(started.id).find(task => task.id === open.id).assignee_id, h.people.director.id);
  assert.equal(journeyTaskRows(started.id).find(task => task.id === done.id).done_by, h.people.manager.id, 'erledigt bleibt erledigt');
  const openRows = taskRows(open.id).filter(row => row.done === 0);
  assert.deepEqual(openRows.map(row => row.user_id), [h.people.director.id], 'die neue Führungskraft hat die Aufgabe');
  assert.equal(openRows[0].due_date, addDays(KEY_DATE, 1), 'mit derselben Frist');
  assert.ok(openRows[0].title.includes('Ben Berg'));
  assert.deepEqual(taskRows(hrTask.id).filter(row => row.done === 0).map(row => row.user_id), [h.people.hr.id], 'HR-Aufgaben bleiben, wo sie sind');
  await ok(h.api('director', 'POST', `/api/onboarding/tasks/${open.id}/complete`));
  assert.equal((await h.api('manager', 'POST', `/api/onboarding/tasks/${hrTask.id}/complete`)).status, 403);

  const second = await ok(h.api('hr', 'POST', '/api/onboarding/journeys', { userId: h.people.clara.id, templateId, keyDate: KEY_DATE }));
  const claraOpen = journeyTaskRows(second.id).find(task => task.title === 'Noch offen');
  h.deps.changeManager(h.people.clara.id, null);
  assert.equal(journeyTaskRows(second.id).find(task => task.id === claraOpen.id).assignee_id, null);
  assert.deepEqual(taskRows(claraOpen.id).filter(row => row.done === 0).map(row => row.user_id), [h.people.hr.id], 'ohne Führungskraft übernimmt HR');

  h.deps.changeManager(h.people.ben.id, h.people.manager.id);
  h.deps.changeManager(h.people.clara.id, h.people.director.id);
  resetJourneys('ben');
  resetJourneys('clara');
});

test('Das Protokoll hält den Start fest', () => {
  const entry = h.db.prepare("SELECT * FROM audit_log WHERE action='onboarding_journey_started' ORDER BY id DESC LIMIT 1").get();
  assert.ok(entry);
  assert.equal(entry.entity, 'onboarding_journeys');
  assert.ok(entry.new_values.includes('taskCount'));
});

test('Hilfeartikel haben die vorgeschriebene Form', () => {
  assert.ok(h.instance.helpArticles.length >= 2);
  for (const article of h.instance.helpArticles) {
    assert.ok(article.id && article.title && article.answer);
    assert.ok(Array.isArray(article.roles) && article.roles.length);
    assert.ok(Array.isArray(article.views) && article.views.length);
    assert.ok(Array.isArray(article.keywords) && article.keywords.length);
    assert.ok(Array.isArray(article.steps) && Array.isArray(article.actions));
  }
});

test('Beispieldaten: mehrfach aufrufbar, keine neuen Konten, ohne Personen passiert nichts', async () => {
  const seeded = await createModuleHarness(createOnboardingModule);
  try {
    const before = seeded.db.prepare('SELECT COUNT(*) AS count FROM users').get().count;
    seeded.instance.seedDemo();
    const journeys = seeded.db.prepare('SELECT COUNT(*) AS count FROM onboarding_journeys').get().count;
    assert.ok(journeys >= 1);
    const startedOnce = seeded.db.prepare('SELECT COUNT(*) AS count FROM tasks').get().count;
    seeded.instance.seedDemo();
    assert.equal(seeded.db.prepare('SELECT COUNT(*) AS count FROM onboarding_journeys').get().count, journeys);
    assert.equal(seeded.db.prepare('SELECT COUNT(*) AS count FROM tasks').get().count, startedOnce);
    assert.equal(seeded.db.prepare('SELECT COUNT(*) AS count FROM users').get().count, before, 'keine neuen Konten');

    seeded.db.prepare('DELETE FROM tasks').run();
    seeded.db.prepare('DELETE FROM onboarding_journey_tasks').run();
    seeded.db.prepare('DELETE FROM onboarding_journeys').run();
    seeded.db.prepare("UPDATE users SET active=0").run();
    seeded.instance.seedDemo();
    assert.equal(seeded.db.prepare('SELECT COUNT(*) AS count FROM onboarding_journeys').get().count, 0, 'ohne aktive Personen passiert nichts');
  } finally {
    await seeded.close();
  }
});

// --- Oberfläche: der echte Browser-Code läuft gegen den echten Server, nur das DOM ist nachgebildet ---

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' };
const escapeHtml = value => String(value ?? '').replace(/[&<>'"]/g, char => HTML_ESCAPES[char]);
const unescapeHtml = value => value.replace(/&(amp|lt|gt|#39|quot);/g, entity => Object.entries(HTML_ESCAPES).find(([, code]) => code === entity)[0]);
const camelCase = name => name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());

function parseActionButtons(html) {
  const buttons = [];
  for (const [tag] of html.matchAll(/<button\b[^>]*>/g)) {
    if (!tag.includes('data-onboarding-action')) continue;
    const dataset = {};
    for (const [, name, value] of tag.matchAll(/data-([a-z-]+)="([^"]*)"/g)) dataset[camelCase(name)] = unescapeHtml(value);
    buttons.push({ dataset, onclick: null });
  }
  return buttons;
}

function openInterface(harness, person) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'onboarding.js'), 'utf8');
  const me = harness.db.prepare('SELECT id,name,role FROM users WHERE id=?').get(harness.people[person]?.id ?? person);
  const modals = [];
  const toasts = [];
  const navigations = [];
  let buttons = [];
  let definition = null;
  const loop = {
    me,
    view: 'dashboard',
    ui: {
      esc: escapeHtml,
      toast: (text, type) => toasts.push({ text, type }),
      closeModal: () => {},
      modal: config => modals.push(config),
      header: (title, subtitle = '', actions = '') => `<header class="top"><div><h1>${escapeHtml(title)}</h1><p>${escapeHtml(subtitle)}</p></div><div>${actions}</div></header>`,
      stat: (label, value, sub = '') => `<article class="card stat"><small>${escapeHtml(label)}</small><strong>${escapeHtml(value)}</strong><span>${escapeHtml(sub)}</span></article>`,
      empty: message => `<p class="muted">${escapeHtml(message)}</p>`
    },
    async api(url, options = {}) {
      const response = await harness.api(person, options.method || 'GET', url, options.body ? JSON.parse(options.body) : undefined);
      if (response.status >= 400) {
        const error = new Error(response.data?.error || 'Fehler');
        error.code = response.data?.code;
        throw error;
      }
      return response.data;
    },
    navigate(next) {
      navigations.push(next);
      loop.view = next;
    },
    isModuleEnabled: () => true,
    registerModule(item) {
      definition = item;
    }
  };
  const document = {
    querySelectorAll: selector => (selector === '[data-onboarding-action]' ? buttons : []),
    querySelector: () => null
  };
  const confirmations = [];
  const answers = { confirm: true };
  const confirm = message => {
    confirmations.push(message);
    return answers.confirm;
  };
  vm.runInNewContext(source, { window: { loop }, document, URLSearchParams, confirm, console });
  function render(markup) {
    buttons = parseActionButtons(markup);
    definition.bind();
    return markup;
  }
  return {
    definition,
    loop,
    modals,
    toasts,
    navigations,
    confirmations,
    answers,
    render,
    async open(view) {
      loop.view = view;
      return render(await definition.pages[view]());
    },
    async click(action, data = {}) {
      const button = buttons.find(item => item.dataset.onboardingAction === action
        && Object.entries(data).every(([key, value]) => item.dataset[key] === String(value)));
      assert.ok(button, `Knopf „${action}“ fehlt in der Ansicht`);
      const shown = toasts.length;
      await button.onclick();
      const failure = toasts.slice(shown).find(toast => toast.type === 'error');
      assert.ok(!failure, failure?.text);
    },
    async submit(values = {}) {
      const modal = modals.at(-1);
      for (const key of Object.keys(values)) assert.ok(modal.body.includes(`name="${key}"`), `Feld ${key} fehlt im Formular „${modal.title}“`);
      return modal.onSubmit(values, {});
    }
  };
}

test('Oberfläche: „Mein Einstieg“ erscheint nur, wenn ein Ablauf existiert', async () => {
  const fresh = await createModuleHarness(createOnboardingModule);
  try {
    const anna = openInterface(fresh, 'anna');
    const hasEntry = () => anna.definition.nav(anna.loop.me).some(item => item.group === 'myWork' && item.label === 'Mein Einstieg');
    assert.equal(hasEntry(), false, 'vor der Antwort des Servers kein Eintrag');
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(hasEntry(), false, 'ohne Ablauf kein Eintrag');
    assert.deepEqual(anna.navigations, [], 'und kein unnötiges Neuzeichnen');
    assert.ok((await anna.open('onboardingMine')).includes('kein Ablauf'));

    const { id: templateId } = await ok(fresh.api('hr', 'GET', '/api/onboarding/templates')).then(({ templates }) => templates.find(item => item.kind === 'onboarding'));
    await ok(fresh.api('hr', 'POST', '/api/onboarding/journeys', { userId: fresh.people.anna.id, templateId, keyDate: KEY_DATE }));

    const second = openInterface(fresh, 'anna');
    second.definition.nav(second.loop.me);
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.deepEqual(second.navigations, ['dashboard'], 'die Übersicht zeichnet sich einmal neu');
    assert.ok(second.definition.nav(second.loop.me).some(item => item.group === 'myWork' && item.label === 'Mein Einstieg'));
    second.definition.nav(second.loop.me);
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.deepEqual(second.navigations, ['dashboard'], 'keine Endlosschleife');

    const elsewhere = openInterface(fresh, 'anna');
    elsewhere.loop.view = 'goals';
    elsewhere.definition.nav(elsewhere.loop.me);
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.deepEqual(elsewhere.navigations, [], 'andere Seiten werden nicht unterbrochen');

    const manager = openInterface(fresh, 'manager');
    assert.deepEqual(Array.from(manager.definition.nav(manager.loop.me), item => `${item.group}:${item.label}`), ['hr:Ein- und Austritte']);
    assert.equal(manager.definition.tabs('onboardingHome', manager.loop.me).length, 0, 'keine Vorlagen-Reiter für Führungskräfte');
    const hr = openInterface(fresh, 'hr');
    assert.deepEqual(Array.from(hr.definition.tabs('onboardingHome', hr.loop.me), tab => tab.label), ['Abläufe', 'Vorlagen']);
    assert.equal(hr.definition.tabs('dashboard', hr.loop.me).length, 0);
  } finally {
    await fresh.close();
  }
});

test('Oberfläche: Der ganze Ablauf funktioniert mit den echten Formularen und Knöpfen', async () => {
  const fresh = await createModuleHarness(createOnboardingModule);
  try {
    const hr = openInterface(fresh, 'hr');
    const manager = openInterface(fresh, 'manager');
    const anna = openInterface(fresh, 'anna');

    await hr.open('onboardingTemplates');
    await hr.click('new-template');
    await hr.submit({ name: 'Oberflächenvorlage', kind: 'onboarding', description: 'Für den Test' });
    assert.equal(hr.loop.view, 'onboardingTemplate');
    let page = await hr.open('onboardingTemplate');
    assert.ok(page.includes('noch keine Aufgaben'));
    const add = async values => {
      await hr.click('new-template-task');
      await hr.submit(values);
      page = await hr.open('onboardingTemplate');
    };
    await add({ title: 'Deine Aufgabe', description: 'Text für die Person', assigneeType: 'person', offsetDays: '0' });
    await add({ title: 'Aufgabe der Führung', description: 'Vertraulich für die Führung', assigneeType: 'manager', offsetDays: '-3' });
    await add({ title: 'Wird entfernt', description: '', assigneeType: 'hr', offsetDays: '1' });
    assert.ok(page.includes('3 Tage vorher') && page.includes('1 Tag danach') && page.includes('Am ersten Arbeitstag'));
    assert.ok(!page.includes('Stichtag'), 'ein Wort, das niemand braucht');
    const removable = fresh.db.prepare("SELECT id FROM onboarding_template_tasks WHERE title='Wird entfernt'").get().id;
    await hr.click('delete-template-task', { id: removable });
    page = await hr.open('onboardingTemplate');
    const editable = fresh.db.prepare("SELECT id FROM onboarding_template_tasks WHERE title='Deine Aufgabe'").get().id;
    await hr.click('edit-template-task', { id: editable });
    await hr.submit({ title: 'Deine erste Aufgabe', description: 'Text für die Person', assigneeType: 'person', offsetDays: '0' });
    const templateId = fresh.db.prepare("SELECT id FROM onboarding_templates WHERE name='Oberflächenvorlage'").get().id;

    await manager.open('onboardingHome');
    await manager.click('start-journey');
    assert.ok(!manager.modals.at(-1).body.includes('Clara'), 'die Führungskraft wählt nur aus dem eigenen Team');
    await manager.submit({ userId: String(fresh.people.anna.id), templateId: String(templateId), keyDate: KEY_DATE });
    assert.equal(manager.loop.view, 'onboardingJourney');
    page = await manager.open('onboardingJourney');
    assert.ok(page.includes('Einstieg: Anna Ahrens') && page.includes('Vertraulich für die Führung'));
    assert.ok(page.includes('Malte Manager'), 'die Zuständigkeit steht dabei');
    assert.ok(page.includes('Ablauf abbrechen'), 'wer ihn gestartet hat, kann ihn zurücknehmen');
    assert.ok(page.includes('Erster Arbeitstag') && !page.includes('Stichtag'));
    assert.ok(!page.includes('trägt keinen Austritt'), 'der Hinweis gehört zum Austritt');

    const annaTask = fresh.db.prepare("SELECT * FROM tasks WHERE type='onboarding_task' AND user_id=?").get(fresh.people.anna.id);
    anna.render(anna.definition.taskAction(annaTask));
    await anna.click('open-task');
    assert.equal(anna.loop.view, 'onboardingJourney');
    page = await anna.open('onboardingJourney');
    assert.ok(page.includes('Mein Einstieg') && page.includes('Deine erste Aufgabe'));
    assert.ok(!page.includes('Vertraulich') && !page.includes('Aufgabe der Führung'));
    assert.ok(page.includes('um 1 Aufgabe'));
    await anna.click('complete');
    page = await anna.open('onboardingMine');
    assert.ok(page.includes('50 %') && page.includes('Erledigt'));
    assert.ok(anna.toasts.at(-1).text.includes('erledigt'));

    page = await manager.open('onboardingJourney');
    await manager.click('complete');
    assert.ok(manager.toasts.at(-1).text.includes('abgeschlossen'));
    page = await manager.open('onboardingHome');
    assert.ok(!page.includes('Anna Ahrens'), 'der Filter zeigt zuerst laufende Abläufe');

    const journeyId = fresh.db.prepare('SELECT id FROM onboarding_journeys').get().id;
    hr.render(`<button data-onboarding-action="open-journey" data-id="${journeyId}">x</button>`);
    await hr.click('open-journey');
    page = await hr.open('onboardingJourney');
    assert.ok(page.includes('Abgeschlossen') && page.includes('100 %'));

    const offboarding = fresh.db.prepare("SELECT id FROM onboarding_templates WHERE kind='offboarding'").get().id;
    const { id: runningId } = await ok(fresh.api('hr', 'POST', '/api/onboarding/journeys', { userId: fresh.people.ben.id, templateId: offboarding, keyDate: KEY_DATE }));
    hr.render(`<button data-onboarding-action="open-journey" data-id="${runningId}">x</button>`);
    await hr.click('open-journey');
    await hr.open('onboardingJourney');
    await hr.click('cancel-journey');
    await hr.submit({ reason: 'Doch geblieben' });
    page = await hr.open('onboardingJourney');
    assert.ok(page.includes('Abgebrochen') && page.includes('Doch geblieben'));
  } finally {
    await fresh.close();
  }
});

test('Oberfläche: Fremde Eingaben können kein HTML und keine Attribute einschleusen', async () => {
  const fresh = await createModuleHarness(createOnboardingModule);
  try {
    const attack = 'Mal" autofocus onfocus="alert(1)';
    const { id: templateId } = await ok(fresh.api('hr', 'POST', '/api/onboarding/templates', {
      name: attack,
      kind: 'onboarding',
      description: attack,
      tasks: [{ title: attack, description: attack, assigneeType: 'manager' }]
    }));
    fresh.db.prepare('UPDATE users SET name=? WHERE id=?').run(attack, fresh.people.ben.id);
    const { id: journeyId } = await ok(fresh.api('hr', 'POST', '/api/onboarding/journeys', { userId: fresh.people.ben.id, templateId, keyDate: KEY_DATE }));
    const hr = openInterface(fresh, 'hr');
    const pages = [await hr.open('onboardingHome'), await hr.open('onboardingTemplates')];
    hr.render(`<button data-onboarding-action="open-journey" data-id="${journeyId}">x</button>`);
    await hr.click('open-journey');
    pages.push(await hr.open('onboardingJourney'));
    hr.render(`<button data-onboarding-action="open-template" data-id="${templateId}">x</button>`);
    await hr.click('open-template');
    pages.push(await hr.open('onboardingTemplate'));
    for (const page of pages) {
      assert.ok(!/onfocus="alert/.test(page), 'nichts bricht aus einem Attribut aus');
      assert.ok(page.includes('Mal&quot; autofocus'), 'der Text erscheint maskiert');
    }
    const dashboardTitle = fresh.db.prepare("SELECT title FROM tasks WHERE type='onboarding_task' LIMIT 1").get().title;
    assert.ok(!dashboardTitle.includes('<'), 'die Übersicht gibt Aufgabentitel ungefiltert aus');
  } finally {
    await fresh.close();
  }
});

test('Oberfläche: „Ablauf starten“ wählt nichts vor und bietet der Führungskraft keinen Austritt an', async () => {
  const fresh = await createModuleHarness(createOnboardingModule);
  try {
    const manager = openInterface(fresh, 'manager');
    await manager.open('onboardingHome');
    await manager.click('start-journey');
    const body = manager.modals.at(-1).body;
    assert.ok(body.includes('<select name="userId" required><option value="">Bitte wählen</option>'), 'keine Person vorgewählt');
    assert.ok(body.includes('<select name="templateId" required><option value="">Bitte wählen</option>'), 'keine Vorlage vorgewählt');
    assert.ok(/<input name="keyDate" type="date" required>/.test(body), 'kein Datum vorgewählt');
    assert.ok(!body.includes(' selected'), 'nichts ist markiert');
    assert.ok(!body.includes('label="Austritt"'), 'keine Austrittsvorlage zur Wahl');
    assert.ok(body.includes('label="Einstieg"'));
    assert.ok(!body.includes('Stichtag'));
  } finally {
    await fresh.close();
  }
});

test('Oberfläche: Austritt mit Rückfrage und klarem Hinweis, was er nicht auslöst, und Abbruch', async () => {
  const fresh = await createModuleHarness(createOnboardingModule);
  try {
    const staff = createStaff(fresh, 'sachbearbeitung@test.local');
    const hr = openInterface(fresh, staff);
    const offboarding = fresh.db.prepare("SELECT id FROM onboarding_templates WHERE kind='offboarding'").get().id;
    assert.deepEqual(Array.from(hr.definition.nav(hr.loop.me), item => `${item.group}:${item.label}`), ['hr:Ein- und Austritte'], 'die Sachbearbeitung erreicht die Abläufe');
    assert.equal(hr.definition.tabs('onboardingHome', hr.loop.me).length, 0, 'aber keinen Reiter „Vorlagen“');

    await hr.open('onboardingHome');
    await hr.click('start-journey');
    assert.ok(hr.modals.at(-1).body.includes('trägt keinen Austritt in die Personalakte ein und sperrt kein Konto'));

    hr.answers.confirm = false;
    const values = { userId: String(fresh.people.anna.id), templateId: String(offboarding), keyDate: KEY_DATE };
    assert.equal(await hr.submit(values), true, 'nach dem Nein bleibt der Dialog offen');
    assert.equal(fresh.db.prepare('SELECT COUNT(*) AS count FROM onboarding_journeys').get().count, 0, 'es wurde nichts gestartet');
    assert.ok(hr.confirmations.at(-1).includes('Anna Ahrens') && hr.confirmations.at(-1).includes(germanDate(KEY_DATE)), 'die Rückfrage nennt Person und Datum');
    assert.ok(hr.confirmations.at(-1).includes('sieht ihre Aufgaben sofort'));

    hr.answers.confirm = true;
    await hr.submit(values);
    assert.equal(hr.loop.view, 'onboardingJourney');
    let page = await hr.open('onboardingJourney');
    assert.ok(page.includes('Austritt: Anna Ahrens') && page.includes('Letzter Arbeitstag'));
    assert.ok(page.includes('trägt keinen Austritt in die Personalakte ein'), 'der Hinweis steht auch am Ablauf');

    const anna = openInterface(fresh, 'anna');
    const annaTask = fresh.db.prepare("SELECT * FROM tasks WHERE type='onboarding_task' AND user_id=? AND done=0").get(fresh.people.anna.id);
    anna.render(anna.definition.taskAction(annaTask));
    await anna.click('open-task');
    page = await anna.open('onboardingJourney');
    assert.ok(page.includes('Mein Austritt'));
    assert.ok(!page.includes('trägt keinen Austritt'), 'der Hinweis richtet sich an HR');

    await hr.click('cancel-journey');
    await hr.submit({ reason: 'Falsche Person' });
    page = await hr.open('onboardingJourney');
    assert.ok(page.includes('Abgebrochen') && page.includes('Falsche Person'));
    assert.ok(page.includes('Entfallen') && !page.includes('>Offen<'), 'offene Aufgaben eines abgebrochenen Ablaufs sind nicht mehr offen');
    assert.ok(!page.includes('trägt keinen Austritt'), 'der Hinweis ist nach dem Abbruch gegenstandslos');
    assert.equal(fresh.db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE type='onboarding_task' AND done=0").get().count, 0, 'alle Aufgaben sind geschlossen');
    assert.ok(!(await anna.open('onboardingMine')).includes('Arbeitsmittel'), 'bei der Person steht nichts mehr');
  } finally {
    await fresh.close();
  }
});

test('Oberfläche: Vorlagen bleiben für die Sachbearbeitung und Führungskräfte auch über die Adresse zu', async () => {
  const fresh = await createModuleHarness(createOnboardingModule);
  try {
    const staff = createStaff(fresh, 'adresse@test.local');
    for (const who of [staff, 'manager']) {
      const view = openInterface(fresh, who);
      for (const route of ['onboardingTemplates', 'onboardingTemplate']) {
        const page = await view.open(route);
        assert.ok(!page.includes('data-onboarding-action'), `${route}: keine Knöpfe ohne Wirkung`);
        assert.ok(page.includes('data-view="onboardingHome"'), `${route}: ein Weg zurück`);
      }
    }
    const hr = openInterface(fresh, 'hr');
    assert.ok((await hr.open('onboardingTemplates')).includes('new-template'));
    assert.ok((await hr.open('onboardingTemplate')).includes('data-view="onboardingTemplates"'), 'ohne Auswahl ein Weg zurück');
  } finally {
    await fresh.close();
  }
});

test('Oberfläche: Ein Datum in der Vergangenheit braucht eine Bestätigung', async () => {
  const fresh = await createModuleHarness(createOnboardingModule);
  try {
    const hr = openInterface(fresh, 'hr');
    const onboarding = fresh.db.prepare("SELECT id FROM onboarding_templates WHERE kind='onboarding'").get().id;
    const past = daysFromNow(-5);
    await hr.open('onboardingHome');
    await hr.click('start-journey');
    hr.answers.confirm = false;
    await assert.rejects(hr.submit({ userId: String(fresh.people.ben.id), templateId: String(onboarding), keyDate: past }), /Vergangenheit/);
    assert.equal(fresh.db.prepare('SELECT COUNT(*) AS count FROM onboarding_journeys').get().count, 0);
    assert.ok(hr.confirmations.at(-1).includes(germanDate(past)));

    hr.answers.confirm = true;
    await hr.submit({ userId: String(fresh.people.ben.id), templateId: String(onboarding), keyDate: past });
    assert.equal(fresh.db.prepare('SELECT key_date FROM onboarding_journeys').get().key_date, past);
  } finally {
    await fresh.close();
  }
});

test('Oberfläche: Regeln aus dem Modul-Vertrag werden eingehalten', () => {
  for (const file of ['public/onboarding.js', 'routes/onboarding.js']) {
    const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    assert.ok(!/workday/i.test(source), `${file}: der Name erscheint nirgends`);
    assert.ok(!/onclick="/.test(source), `${file}: kein onclick im HTML`);
    assert.ok(!/INSERT OR (IGNORE|REPLACE)|strftime|julianday|\bdatetime\(|GROUP_CONCAT/i.test(source), `${file}: SQL bleibt standardnah`);
  }
});
