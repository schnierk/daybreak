const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { before, after, test } = require('node:test');
const vm = require('node:vm');
const express = require('express');
const { createModuleHarness } = require('../lib/testing/module-harness');
const { openTestDatabase } = require('../lib/testing/test-database');
const { createFeedbackModule, selfWording } = require('../routes/feedback');

let db;
let server;
let baseUrl;
let questionnaireId;
let cycleId;
let participantId;
let ratingQuestionId;
let textQuestionId;

const cleanText = (value, max = 4000) => typeof value === 'string' ? value.replace(/[<>]/g, '').trim().slice(0, max) : '';
const validDate = value => !value || /^\d{4}-\d{2}-\d{2}$/.test(value);

function setup() {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const id = Number(req.get('x-test-user'));
    if (id) req.session = { user: { id } };
    next();
  });
  const current = req => db.prepare('SELECT id,name,email,role,title,manager_id FROM users WHERE id=?').get(req.session.user.id);
  const isHr = actor => ['hr_admin', 'hrbp'].includes(actor.role);
  const canViewEmployee = (actor, employeeId) => {
    if (isHr(actor) || actor.id === Number(employeeId)) return true;
    let person = db.prepare('SELECT manager_id FROM users WHERE id=?').get(employeeId);
    while (person?.manager_id) {
      if (person.manager_id === actor.id) return true;
      person = db.prepare('SELECT manager_id FROM users WHERE id=?').get(person.manager_id);
    }
    return false;
  };
  const canEditEmployee = (actor, employeeId) => isHr(actor) || db.prepare('SELECT manager_id FROM users WHERE id=?').get(employeeId)?.manager_id === actor.id;
  const auth = (req, res, next) => req.session?.user ? next() : res.status(401).json({ error: 'Nicht angemeldet' });
  const log = (actor, action, entity, entityId, oldValues = null, newValues = null) => db.prepare('INSERT INTO audit_log(actor_id,action,entity,entity_id,old_values,new_values) VALUES(?,?,?,?,?,?)').run(actor || null, action, entity, entityId || null, oldValues ? JSON.stringify(oldValues) : null, newValues ? JSON.stringify(newValues) : null);
  const createTask = (userId, title, type, entityId) => db.prepare('INSERT INTO tasks(user_id,title,type,entity_id,done) VALUES(?,?,?,?,0)').run(userId, title, type, entityId);
  const feedback = createFeedbackModule({ db, auth, current, isHr, canViewEmployee, canEditEmployee, cleanText, validDate, log, createTask });
  feedback.initialize();
  app.use('/api', feedback.router);
  return app;
}

async function request(userId, path, { method = 'GET', body } = {}) {
  const response = await fetch(baseUrl + path, { method, headers: { 'x-test-user': userId ? String(userId) : '', 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, data: await response.json() };
}

function answers(value, text = 'Konkretes und konstruktives Entwicklungsfeedback.') {
  return [{ questionId: ratingQuestionId, numericValue: value }, { questionId: textQuestionId, textValue: text }];
}

before(async () => {
  db = openTestDatabase();
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, role TEXT NOT NULL, title TEXT, manager_id INTEGER REFERENCES users(id));
    CREATE TABLE goals (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), title TEXT NOT NULL, description TEXT, weight INTEGER DEFAULT 100, progress INTEGER DEFAULT 0, status TEXT DEFAULT 'on_track', due_date TEXT, created_by INTEGER REFERENCES users(id), approval_status TEXT DEFAULT 'approved', goal_type TEXT DEFAULT 'business');
    CREATE TABLE competencies (id INTEGER PRIMARY KEY, name TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE goal_competencies (goal_id INTEGER NOT NULL REFERENCES goals(id), competency_id INTEGER NOT NULL REFERENCES competencies(id), created_by INTEGER REFERENCES users(id), PRIMARY KEY(goal_id, competency_id));
    CREATE TABLE tasks (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, title TEXT NOT NULL, type TEXT NOT NULL, entity_id INTEGER, done INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE audit_log (id INTEGER PRIMARY KEY, actor_id INTEGER, action TEXT NOT NULL, entity TEXT, entity_id INTEGER, old_values TEXT, new_values TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
  `);
  const add = db.prepare('INSERT INTO users(id,name,email,password_hash,role,title,manager_id) VALUES(?,?,?,?,?,?,?)');
  add.run(1, 'HR Admin', 'hr@example.test', 'x', 'hr_admin', 'HR', null);
  add.run(2, 'Führungskraft', 'manager@example.test', 'x', 'manager', 'Leitung', 1);
  add.run(3, 'Feedback-Empfängerin', 'employee@example.test', 'x', 'employee', 'Designer', 2);
  add.run(4, 'Peer Eins', 'peer1@example.test', 'x', 'employee', 'Designer', 2);
  add.run(5, 'Peer Zwei', 'peer2@example.test', 'x', 'employee', 'Designer', 2);
  add.run(6, 'Peer Drei', 'peer3@example.test', 'x', 'employee', 'Designer', 2);
  add.run(7, 'Fremde Person', 'other@example.test', 'x', 'employee', 'Analystin', 1);
  db.prepare('INSERT INTO competencies(id,name,active) VALUES(?,?,1)').run(1, 'Zusammenarbeit');
  const app = setup();
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server?.close();
  db?.close();
});

test('Fragebogen und Zyklus sind HR-exklusiv, validiert und versionierbar', async () => {
  assert.equal((await request(null, '/api/feedback/meta')).status, 401);
  assert.equal((await request(2, '/api/feedback/questionnaires')).status, 403);
  assert.equal((await request(2, '/api/feedback/questionnaires', { method: 'POST', body: { name: 'Unzulässig' } })).status, 403);
  const questionnaire = await request(1, '/api/feedback/questionnaires', { method: 'POST', body: { name: 'Testfragebogen', description: 'Entwicklungsorientiert' } });
  assert.equal(questionnaire.status, 201);
  questionnaireId = questionnaire.data.id;
  const section = await request(1, `/api/feedback/questionnaires/${questionnaireId}/sections`, { method: 'POST', body: { title: 'Zusammenarbeit', displayOrder: 1 } });
  assert.equal(section.status, 201);
  const ratingQuestion = await request(1, `/api/feedback/questionnaires/sections/${section.data.id}/questions`, { method: 'POST', body: { questionText: 'Die Person arbeitet konstruktiv mit anderen zusammen.', questionType: 'rating', required: true, displayOrder: 1, competencyId: 1 } });
  const textQuestion = await request(1, `/api/feedback/questionnaires/sections/${section.data.id}/questions`, { method: 'POST', body: { questionText: 'Was sollte die Person beibehalten?', questionType: 'text', required: true, displayOrder: 2 } });
  assert.equal(ratingQuestion.status, 201);
  assert.equal(textQuestion.status, 201);
  ratingQuestionId = ratingQuestion.data.id;
  textQuestionId = textQuestion.data.id;
  assert.equal((await request(1, '/api/feedback/cycles', { method: 'POST', body: { name: 'Ungültig', questionnaireId, startDate: '2099-12-31', endDate: '2099-01-01', nominationDeadline: '2099-03-01', feedbackDeadline: '2099-04-01' } })).status, 400);
  const cycle = await request(1, '/api/feedback/cycles', { method: 'POST', body: { name: '360° Testzyklus', description: 'Sicherer Ablauf', questionnaireId, startDate: '2099-01-01', endDate: '2099-12-31', nominationDeadline: '2099-03-01', feedbackDeadline: '2099-06-01' } });
  assert.equal(cycle.status, 201);
  cycleId = cycle.data.id;
  assert.deepEqual((await request(2, '/api/feedback/cycles')).data.items, []);
  assert.equal((await request(2, `/api/feedback/cycles/${cycleId}`)).status, 403);
  assert.equal((await request(2, '/api/feedback/cycles', { method: 'POST', body: { name: 'Unzulässig' } })).status, 403);
  assert.equal((await request(1, `/api/feedback/questions/${ratingQuestionId}`, { method: 'PATCH', body: { questionText: 'Nicht erlaubt nach Verwendung' } })).status, 409);
  const version = await request(1, `/api/feedback/questionnaires/${questionnaireId}/version`, { method: 'POST', body: {} });
  assert.equal(version.status, 201);
  assert.equal(version.data.version, 2);
});

test('Teilnahme, sichere Gruppenzuordnung und Nominierungsprüfung funktionieren', async () => {
  assert.equal((await request(1, `/api/feedback/cycles/${cycleId}/status`, { method: 'PATCH', body: { status: 'open' } })).status, 409);
  const participant = await request(1, `/api/feedback/cycles/${cycleId}/participants`, { method: 'POST', body: { employeeId: 3 } });
  assert.equal(participant.status, 201);
  participantId = participant.data.id;
  assert.deepEqual((await request(2, '/api/feedback/cycles')).data.items.map(item => item.id), [cycleId]);
  assert.equal((await request(7, `/api/feedback/cycles/${cycleId}`)).status, 403);
  assert.equal((await request(1, `/api/feedback/cycles/${cycleId}/status`, { method: 'PATCH', body: { status: 'nomination' } })).status, 200);
  const proposed = [];
  for (const giverId of [4, 5, 6]) {
    const response = await request(3, `/api/feedback/participants/${participantId}/nominations`, { method: 'POST', body: { giverId, feedbackGroup: 'manager' } });
    assert.equal(response.status, 201, JSON.stringify(response.data));
    assert.equal(response.data.feedbackGroup, 'peer');
    proposed.push(response.data.id);
  }
  assert.equal((await request(7, `/api/feedback/participants/${participantId}/nominations`, { method: 'POST', body: { giverId: 7 } })).status, 403);
  assert.equal((await request(2, `/api/feedback/nominations/${proposed[0]}`, { method: 'PATCH', body: { status: 'rejected' } })).status, 400);
  for (const nominationId of proposed) assert.equal((await request(2, `/api/feedback/nominations/${nominationId}`, { method: 'PATCH', body: { status: 'approved' } })).status, 200);
  assert.equal((await request(3, `/api/feedback/participants/${participantId}/nominations`, { method: 'POST', body: { giverId: 4 } })).status, 409);
  assert.equal((await request(1, `/api/feedback/cycles/${cycleId}/status`, { method: 'PATCH', body: { status: 'open' } })).status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM feedback_invitations WHERE participant_id=?').get(participantId).count, 5);
});

test('Feedback-Nominierungen stellen Mitarbeitenden ein geeignetes Personenverzeichnis bereit', async () => {
  const candidates = await request(3, '/api/feedback/nominations/candidates');
  assert.equal(candidates.status, 200);
  assert.equal(candidates.data.users.some(user => user.id === 3), false);
  assert.equal(candidates.data.users.some(user => user.id === 4 && user.name === 'Peer Eins'), true);
  assert.equal(candidates.data.users.some(user => user.id === 2 && user.name === 'Führungskraft'), true);
});

test('HR kann eine geöffnete Feedbackrunde kontrolliert zur Nominierung zurücksetzen', async () => {
  const preservedInvitation = db.prepare("SELECT id,status FROM feedback_invitations WHERE participant_id=? AND giver_id=4").get(participantId);
  assert.equal((await request(2, `/api/feedback/cycles/${cycleId}/status`, { method: 'PATCH', body: { status: 'nomination' } })).status, 403);
  assert.equal((await request(1, `/api/feedback/cycles/${cycleId}/status`, { method: 'PATCH', body: { status: 'nomination' } })).status, 200);
  assert.equal(db.prepare('SELECT status FROM feedback_cycles WHERE id=?').get(cycleId).status, 'nomination');
  assert.equal(db.prepare('SELECT status FROM feedback_invitations WHERE id=?').get(preservedInvitation.id).status, preservedInvitation.status);
  assert.equal(db.prepare("SELECT done FROM tasks WHERE type='feedback_submit' AND entity_id=? ORDER BY id DESC LIMIT 1").get(preservedInvitation.id).done, 1);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM feedback_history WHERE cycle_id=? AND action='feedback_cycle_reset_to_nomination'").get(cycleId).count, 1);
  const added = await request(1, `/api/feedback/cycles/${cycleId}/participants`, { method: 'POST', body: { employeeId: 7 } });
  assert.equal(added.status, 201);
  assert.equal((await request(1, `/api/feedback/cycles/${cycleId}/status`, { method: 'PATCH', body: { status: 'open' } })).status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM feedback_invitations WHERE participant_id=?').get(participantId).count, 5);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM feedback_invitations WHERE participant_id=?').get(added.data.id).count, 2);
  assert.equal(db.prepare("SELECT done FROM tasks WHERE type='feedback_submit' AND entity_id=? ORDER BY id DESC LIMIT 1").get(preservedInvitation.id).done, 0);
});

test('Feedback-Entwürfe, finale Abgabe und IDOR-Schutz sind serverseitig geprüft', async () => {
  const peerInvitation = db.prepare("SELECT id FROM feedback_invitations WHERE participant_id=? AND giver_id=4").get(participantId).id;
  assert.equal((await request(5, `/api/feedback/invitations/${peerInvitation}`)).status, 403);
  assert.equal((await request(4, `/api/feedback/invitations/${peerInvitation}/responses`, { method: 'PUT', body: { answers: [{ questionId: ratingQuestionId, numericValue: 6 }] } })).status, 400);
  assert.equal((await request(4, `/api/feedback/invitations/${peerInvitation}/responses`, { method: 'PUT', body: { answers: [{ questionId: ratingQuestionId, numericValue: 4 }] } })).status, 200);
  assert.equal((await request(4, `/api/feedback/invitations/${peerInvitation}/submit`, { method: 'POST', body: { answers: [{ questionId: ratingQuestionId, numericValue: 4 }] } })).status, 400);
  const submittedPeer = await request(4, `/api/feedback/invitations/${peerInvitation}/submit`, { method: 'POST', body: { answers: answers(4, '<script>bad()</script> Konkrete Stärke') } });
  assert.equal(submittedPeer.status, 200, JSON.stringify(submittedPeer.data));
  assert.equal((await request(4, `/api/feedback/invitations/${peerInvitation}/responses`, { method: 'PUT', body: { answers: answers(5) } })).status, 409);
  assert.equal((await request(4, `/api/feedback/invitations/${peerInvitation}/reopen`, { method: 'POST' })).status, 403);
  assert.equal((await request(1, `/api/feedback/invitations/${peerInvitation}/reopen`, { method: 'POST' })).status, 200);
  assert.equal((await request(4, `/api/feedback/invitations/${peerInvitation}/submit`, { method: 'POST', body: { answers: answers(4, 'Konkrete Stärke') } })).status, 200);
});

test('Anonyme Ergebnisse, Freigabe und Entwicklungsziel bleiben geschützt', async () => {
  for (const [giverId, value] of [[5, 5], [6, 3], [2, 4], [3, 4]]) {
    const invitation = db.prepare('SELECT id FROM feedback_invitations WHERE participant_id=? AND giver_id=?').get(participantId, giverId).id;
    assert.equal((await request(giverId, `/api/feedback/invitations/${invitation}/submit`, { method: 'POST', body: { answers: answers(value, `Konkrete Rückmeldung ${giverId}`) } })).status, 200);
  }
  assert.equal((await request(1, `/api/feedback/cycles/${cycleId}/status`, { method: 'PATCH', body: { status: 'evaluation' } })).status, 200);
  assert.equal((await request(3, `/api/feedback/results/${participantId}`)).status, 403);
  const calculated = await request(1, `/api/feedback/results/${participantId}/calculate`, { method: 'POST' });
  assert.equal(calculated.status, 200);
  const peer = calculated.data.result.questions.find(question => question.id === ratingQuestionId).groups.find(group => group.group === 'peer');
  assert.deepEqual({ count: peer.responseCount, average: peer.average }, { count: 3, average: 4 });
  assert.equal(JSON.stringify(calculated.data.result).includes('Peer Eins'), false);
  assert.equal(JSON.stringify(calculated.data.result).includes('<script>'), false);
  assert.equal((await request(1, `/api/feedback/results/${participantId}/status`, { method: 'PATCH', body: { status: 'released_for_employee' } })).status, 409);
  assert.equal((await request(1, `/api/feedback/results/${participantId}/status`, { method: 'PATCH', body: { status: 'reviewed' } })).status, 200);
  assert.equal((await request(1, `/api/feedback/results/${participantId}/status`, { method: 'PATCH', body: { status: 'released_for_manager' } })).status, 200);
  assert.equal((await request(2, `/api/feedback/results/${participantId}`)).status, 200);
  assert.equal((await request(1, `/api/feedback/results/${participantId}/status`, { method: 'PATCH', body: { status: 'released_for_employee' } })).status, 200);
  assert.equal((await request(3, `/api/feedback/results/${participantId}`)).status, 200);
  const action = await request(2, `/api/feedback/participants/${participantId}/development-actions`, { method: 'POST', body: { actionType: 'development_goal', description: 'Die strategische Zusammenarbeit in bereichsübergreifenden Projekten gezielt weiterentwickeln.', competencyId: 1, targetDate: '2099-12-31', createGoal: true, goalTitle: 'Zusammenarbeit strategisch ausbauen' } });
  assert.equal(action.status, 201);
  assert.equal(db.prepare("SELECT goal_type FROM goals WHERE id=?").get(action.data.goalId).goal_type, 'development');
  assert.ok(db.prepare("SELECT COUNT(*) count FROM audit_log WHERE action='feedback_submitted'").get().count >= 5);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM audit_log WHERE action='feedback_submitted' AND new_values LIKE '%Konkrete Rückmeldung%'").get().count, 0);
});

// ------------------------------------------------------------------ Abläufe mit der gemeinsamen Testumgebung

const dayFromToday = days => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
const TIMESTAMP = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;

async function openHarness(t, options) {
  const h = await createModuleHarness(createFeedbackModule, options);
  t.after(() => h.close());
  return h;
}

const idOf = (h, person) => h.people[person]?.id ?? person;

async function expectOk(promise, status = 200) {
  const response = await promise;
  assert.equal(response.status, status, JSON.stringify(response.data));
  return response.data;
}

function addPerson(h, name, email, role = 'employee', managerId = null) {
  const { id } = h.deps.createUserAccount({ name, email, role, managerId, actor: { id: 1 } });
  h.db.prepare('UPDATE users SET must_change_password=0 WHERE id=?').run(id);
  return id;
}

async function createQuestionnaire(h, name = 'Bogen') {
  const { id: questionnaireId } = await expectOk(h.api('hr', 'POST', '/api/feedback/questionnaires', { name }), 201);
  const { id: sectionId } = await expectOk(h.api('hr', 'POST', `/api/feedback/questionnaires/${questionnaireId}/sections`, { title: 'Thema' }), 201);
  const { id: ratingId } = await expectOk(h.api('hr', 'POST', `/api/feedback/questionnaires/sections/${sectionId}/questions`, { questionText: 'Die Person hört zu.', questionType: 'rating', required: true }), 201);
  const { id: textId } = await expectOk(h.api('hr', 'POST', `/api/feedback/questionnaires/sections/${sectionId}/questions`, { questionText: 'Was soll bleiben?', questionType: 'text', required: false }), 201);
  return { questionnaireId, sectionId, ratingId, textId };
}

/** Bringt eine Runde für eine Person bis zur gewünschten Phase. HR bestätigt die Vorschläge. */
async function startRound(h, { employee = 'anna', givers = ['ben', 'clara', 'director'], phase = 'open', name = 'Runde' } = {}) {
  const questionnaire = await createQuestionnaire(h, `Bogen ${name}`);
  const { id: cycleId } = await expectOk(h.api('hr', 'POST', '/api/feedback/cycles', {
    name,
    questionnaireId: questionnaire.questionnaireId,
    startDate: dayFromToday(0),
    endDate: dayFromToday(40),
    nominationDeadline: dayFromToday(10),
    feedbackDeadline: dayFromToday(20)
  }), 201);
  const { id: participantId } = await expectOk(h.api('hr', 'POST', `/api/feedback/cycles/${cycleId}/participants`, { employeeId: idOf(h, employee) }), 201);
  const round = { ...questionnaire, cycleId, participantId, employee, nominationDeadline: dayFromToday(10), feedbackDeadline: dayFromToday(20) };
  if (phase === 'draft') return round;
  await setPhase(h, round, 'nomination');
  for (const giver of givers) {
    const { id } = await expectOk(h.api(employee, 'POST', `/api/feedback/participants/${participantId}/nominations`, { giverId: idOf(h, giver) }), 201);
    await expectOk(h.api('hr', 'PATCH', `/api/feedback/nominations/${id}`, { status: 'approved' }));
  }
  if (phase === 'open') await setPhase(h, round, 'open');
  return round;
}

const setPhase = (h, round, status) => expectOk(h.api('hr', 'PATCH', `/api/feedback/cycles/${round.cycleId}/status`, { status }));
const invitationOf = (h, round, giver) => h.db.prepare('SELECT id FROM feedback_invitations WHERE participant_id=? AND giver_id=?').get(round.participantId, idOf(h, giver)).id;
const openTasks = (h, person, type) => h.db.prepare('SELECT * FROM tasks WHERE user_id=? AND type=? AND done=0 ORDER BY id').all(idOf(h, person), type);

function submitAnswers(h, round, giver, value, comment) {
  return expectOk(h.api(giver, 'POST', `/api/feedback/invitations/${invitationOf(h, round, giver)}/submit`, {
    answers: [{ questionId: round.ratingId, numericValue: value }, { questionId: round.textId, textValue: comment }]
  }));
}

async function answerAll(h, round, answers) {
  for (const [giver, value, comment] of answers) await submitAnswers(h, round, giver, value, comment);
}

/** Alle antworten, die Runde geht in die Auswertung, der Bericht wird berechnet und bis zum Schritt freigegeben. */
async function finishRound(h, round, { upTo = 'released_for_employee', answers = null } = {}) {
  await answerAll(h, round, answers || [
    ['anna', 4, 'Ich möchte klarer werden.'],
    ['manager', 4, 'Anna erklärt gut.'],
    ['ben', 5, 'Anna hilft sofort.'],
    ['clara', 3, 'Anna hört gut zu.'],
    ['director', 4, 'Anna denkt mit.']
  ]);
  await setPhase(h, round, 'evaluation');
  await expectOk(h.api('hr', 'POST', `/api/feedback/results/${round.participantId}/calculate`));
  for (const status of ['reviewed', 'released_for_manager', 'released_for_employee', 'closed']) {
    await expectOk(h.api('hr', 'PATCH', `/api/feedback/results/${round.participantId}/status`, { status }));
    if (status === upTo) break;
  }
}

const reportOf = async (h, person, round) => (await expectOk(h.api(person, 'GET', `/api/feedback/results/${round.participantId}`))).result;

test('B2: Note und „nicht beurteilbar“ schließen sich aus, eine aufgehobene Note bleibt nicht als Entwurf liegen', async t => {
  const h = await openHarness(t);
  const round = await startRound(h);
  const invitation = invitationOf(h, round, 'ben');
  const save = entry => h.api('ben', 'PUT', `/api/feedback/invitations/${invitation}/responses`, { answers: [{ questionId: round.ratingId, ...entry }] });
  const saved = () => h.db.prepare('SELECT numeric_value,not_applicable FROM feedback_responses WHERE invitation_id=? AND question_id=?').get(invitation, round.ratingId);

  await expectOk(save({ numericValue: 4, notApplicable: false }));
  assert.deepEqual({ ...saved() }, { numeric_value: 4, not_applicable: 0 });
  await expectOk(save({ numericValue: null, notApplicable: true }));
  assert.deepEqual({ ...saved() }, { numeric_value: null, not_applicable: 1 });
  assert.equal((await save({ numericValue: 5, notApplicable: true })).status, 400);
  assert.equal((await save({ numericValue: 6 })).status, 400);
  assert.equal((await save({ numericValue: 0 })).status, 400);

  await expectOk(save({ numericValue: null, notApplicable: false }));
  assert.equal(saved(), undefined);
  const form = await expectOk(h.api('ben', 'GET', `/api/feedback/invitations/${invitation}`));
  assert.equal(form.sections[0].questions[0].response, null);

  // Ohne Note darf die Pflichtfrage nicht mehr als beantwortet gelten.
  const submitted = await h.api('ben', 'POST', `/api/feedback/invitations/${invitation}/submit`, { answers: [{ questionId: round.ratingId, numericValue: null, notApplicable: false }] });
  assert.equal(submitted.status, 400);
});

test('B2: Früher gespeicherte Entwürfe zählen bei der Abgabe mit und bleiben sonst unsichtbar', async t => {
  const h = await openHarness(t);
  const round = await startRound(h);
  const invitation = invitationOf(h, round, 'ben');
  await expectOk(h.api('ben', 'PUT', `/api/feedback/invitations/${invitation}/responses`, { answers: [{ questionId: round.ratingId, numericValue: 2 }] }));
  await expectOk(h.api('ben', 'POST', `/api/feedback/invitations/${invitation}/submit`, { answers: [{ questionId: round.textId, textValue: 'Nur noch der Text.' }] }));
  const rows = h.db.prepare('SELECT draft FROM feedback_responses WHERE invitation_id=?').all(invitation);
  assert.equal(rows.length, 2);
  assert.ok(rows.every(row => row.draft === 0));
});

test('B2: Das unsichtbare Auswahlfeld bedeckt nur seine Note, und beide Richtungen heben sich auf', () => {
  const css = readFileSync(path.join(__dirname, '../public/feedback.css'), 'utf8');
  const js = readFileSync(path.join(__dirname, '../public/feedback.js'), 'utf8');
  assert.match(css, /\.fb-score\s*\{[^}]*position:\s*relative/);
  assert.match(css, /\.fb-score input\s*\{[^}]*inset:\s*0[^}]*width:\s*100%/);
  assert.match(css, /\.fb-score\s*\{[^}]*width:\s*44px[^}]*height:\s*44px/);
  assert.match(js, /group\.querySelector\('input\[type=checkbox\]'\)\.checked = false/);
  assert.match(js, /querySelectorAll\('input\[type=radio\]'\)\.forEach\(radio => \{\s*radio\.checked = false/);
});

test('M2/B15/A24: Empfänger:in und Führungskraft sehen keine Namen und Zeiten zu Abgaben, HR schon', async t => {
  const h = await openHarness(t);
  const round = await startRound(h);
  await submitAnswers(h, round, 'ben', 5, 'Gut.');
  await expectOk(h.api('clara', 'POST', `/api/feedback/invitations/${invitationOf(h, round, 'clara')}/decline`));

  for (const person of ['anna', 'manager']) {
    const history = await expectOk(h.api(person, 'GET', `/api/feedback/history/${round.participantId}`));
    assert.deepEqual(history.items, []);
    assert.deepEqual(history.progress.groups.find(group => group.group === 'peer'), { group: 'peer', invited: 3, submitted: 1 });
    assert.doesNotMatch(JSON.stringify(history), /Ben Berg|Clara Cordes|actor_name/);

    const list = await expectOk(h.api(person, 'GET', `/api/feedback/participants/${round.participantId}/nominations`));
    assert.doesNotMatch(JSON.stringify(list), TIMESTAMP);
    for (const nomination of list.nominations) {
      assert.equal(nomination.status, 'approved');
      for (const hidden of ['giver_id', 'created_at', 'updated_at', 'confirmed_at']) assert.equal(hidden in nomination, false, hidden);
    }
    assert.equal('feedback_completed' in list.participant, false);
    assert.equal('updated_at' in list.participant, false);

    const cycle = await expectOk(h.api(person, 'GET', `/api/feedback/cycles/${round.cycleId}`));
    assert.doesNotMatch(JSON.stringify(cycle.cycle.participants), TIMESTAMP);
    const dashboard = await expectOk(h.api(person, 'GET', '/api/feedback/dashboard'));
    assert.doesNotMatch(JSON.stringify([dashboard.ownCycles, dashboard.teamCycles]), TIMESTAMP);
  }

  const hrHistory = await expectOk(h.api('hr', 'GET', `/api/feedback/history/${round.participantId}`));
  const submittedEntry = hrHistory.items.find(item => item.action === 'feedback_submitted');
  assert.equal(submittedEntry.actor_name, 'Ben Berg');
  assert.match(submittedEntry.created_at, TIMESTAMP);
  const hrList = await expectOk(h.api('hr', 'GET', `/api/feedback/participants/${round.participantId}/nominations`));
  assert.equal(hrList.nominations.find(item => item.giver_name === 'Ben Berg').status, 'submitted');
  assert.equal(hrList.nominations.find(item => item.giver_name === 'Clara Cordes').status, 'declined');
  assert.deepEqual(hrList.progress.groups.find(group => group.group === 'peer'), { group: 'peer', invited: 3, submitted: 1, declined: 1 });

  assert.equal((await h.api('ben', 'GET', `/api/feedback/history/${round.participantId}`)).status, 403);
  assert.equal((await h.api('ben', 'GET', `/api/feedback/participants/${round.participantId}/nominations`)).status, 403);
});

test('M2: HR, die selbst Feedback bekommt, sieht bei sich keine Namen und gibt sich nichts selbst frei', async t => {
  const h = await openHarness(t);
  const round = await startRound(h, { employee: 'bp', givers: ['ben', 'clara', 'anna'] });
  await answerAll(h, round, [['ben', 5, 'Gut.'], ['clara', 4, 'Gut.'], ['anna', 3, 'Gut.'], ['bp', 3, 'Ich.']]);

  const history = await expectOk(h.api('bp', 'GET', `/api/feedback/history/${round.participantId}`));
  assert.deepEqual(history.items, []);
  const list = await expectOk(h.api('bp', 'GET', `/api/feedback/participants/${round.participantId}/nominations`));
  assert.ok(list.nominations.every(item => item.status === 'approved'));
  assert.doesNotMatch(JSON.stringify(list), TIMESTAMP);

  await setPhase(h, round, 'evaluation');
  assert.equal((await h.api('bp', 'POST', `/api/feedback/results/${round.participantId}/calculate`)).status, 403);
  await expectOk(h.api('hr', 'POST', `/api/feedback/results/${round.participantId}/calculate`));
  assert.equal((await h.api('bp', 'GET', `/api/feedback/results/${round.participantId}`)).status, 403);
  assert.equal((await h.api('bp', 'PATCH', `/api/feedback/results/${round.participantId}/status`, { status: 'reviewed' })).status, 403);
});

test('M2: Erlaubt die Organisation HR die eigenen Vorgänge, bleibt der Weg offen, die Namen bleiben trotzdem verborgen', async t => {
  const h = await openHarness(t);
  h.deps.setApprovalRule('personnel.hr_self_edit', 'allowed', { id: 1 });
  const round = await startRound(h, { employee: 'bp', givers: ['ben', 'clara', 'anna'] });
  await answerAll(h, round, [['ben', 5, 'Gut.'], ['clara', 4, 'Gut.'], ['anna', 3, 'Gut.'], ['bp', 3, 'Ich.']]);
  await setPhase(h, round, 'evaluation');
  assert.equal((await h.api('bp', 'GET', `/api/feedback/results/${round.participantId}`)).status, 403);
  await expectOk(h.api('bp', 'POST', `/api/feedback/results/${round.participantId}/calculate`));
  const report = await expectOk(h.api('bp', 'GET', `/api/feedback/results/${round.participantId}`));
  assert.equal(report.permissions.nextStatus, 'reviewed');
  await expectOk(h.api('bp', 'PATCH', `/api/feedback/results/${round.participantId}/status`, { status: 'reviewed' }));
  assert.deepEqual((await expectOk(h.api('bp', 'GET', `/api/feedback/history/${round.participantId}`))).items, []);
  const list = await expectOk(h.api('bp', 'GET', `/api/feedback/participants/${round.participantId}/nominations`));
  assert.ok(list.nominations.every(item => item.status === 'approved' && !('created_at' in item)));
  assert.equal(list.permissions.viewHistory, false);
});

test('Anonymität: Kleine Gruppen lassen sich nicht aus Differenzen der Zahlen ausrechnen', async t => {
  const h = await openHarness(t);
  const round = await startRound(h, { phase: 'nomination' });
  // Eine einzelne weitere Person: Jede Zahl zu ihr wäre eine Aussage über genau diese Person.
  const outside = addPerson(h, 'Olga Außen', 'olga@test.local');
  const { id } = await expectOk(h.api('hr', 'POST', `/api/feedback/participants/${round.participantId}/nominations`, { giverId: outside, feedbackGroup: 'stakeholder' }), 201);
  await expectOk(h.api('hr', 'PATCH', `/api/feedback/nominations/${id}`, { status: 'approved' }));
  await setPhase(h, round, 'open');

  const seenBy = async person => ({
    list: (await expectOk(h.api(person, 'GET', `/api/feedback/participants/${round.participantId}/nominations`))).progress,
    row: (({ invitations, submitted }) => ({ invitations, submitted }))((await expectOk(h.api(person, 'GET', `/api/feedback/cycles/${round.cycleId}`))).cycle.participants[0]),
    metrics: (await expectOk(h.api(person, 'GET', `/api/feedback/cycles/${round.cycleId}/progress`))).metrics,
    history: (await expectOk(h.api(person, 'GET', `/api/feedback/history/${round.participantId}`))).progress
  });

  const before = await seenBy('anna');
  assert.deepEqual(before.list.groups.find(group => group.group === 'anonymous_combined'), { group: 'anonymous_combined', invited: 1, submitted: null });
  assert.equal(before.list.groups.some(group => group.group === 'stakeholder'), false);
  // Olga antwortet: Für Empfängerin und Führungskraft darf sich keine einzige Zahl ändern.
  await submitAnswers(h, round, outside, 2, 'Von außen.');
  assert.deepEqual(await seenBy('anna'), before);
  assert.deepEqual(await seenBy('manager'), before);
  await expectOk(h.api('hr', 'GET', `/api/feedback/cycles/${round.cycleId}`));
  const hrProgress = (await expectOk(h.api('hr', 'GET', `/api/feedback/participants/${round.participantId}/nominations`))).progress;
  assert.deepEqual(hrProgress.groups.find(group => group.group === 'stakeholder'), { group: 'stakeholder', invited: 1, submitted: 1, declined: 0 });

  const progressForAnna = await expectOk(h.api('anna', 'GET', `/api/feedback/cycles/${round.cycleId}/progress`));
  assert.equal('feedbackCompleted' in progressForAnna.participants[0], false);
  assert.equal(progressForAnna.metrics.overdue, 0);
});

test('Anonymität: Im Bericht fehlt alles, woraus sich einzelne Antworten ableiten lassen', async t => {
  const h = await openHarness(t);
  const round = await startRound(h);
  await finishRound(h, round);
  const report = await reportOf(h, 'anna', round);
  for (const question of report.questions) {
    for (const group of question.groups) {
      for (const hidden of ['median', 'values', 'rows']) assert.equal(hidden in group, false, hidden);
    }
  }
  assert.doesNotMatch(JSON.stringify(report), /giver_id|Ben Berg|Clara Cordes|Dora Direktor/);
  assert.equal('declined' in report.responseRate, false);
  assert.ok('declined' in (await reportOf(h, 'hr', round)).responseRate);
});

test('Anonymität: Wer selbst in der Gruppe antwortet, sieht sie erst, wenn genug andere geantwortet haben', async t => {
  const h = await openHarness(t);
  const round = await startRound(h, { givers: ['hr', 'ben', 'clara'] });
  await answerAll(h, round, [['anna', 4, 'Selbst.'], ['manager', 4, 'Chef.'], ['hr', 1, 'Von HR.'], ['ben', 5, 'Von Ben.'], ['clara', 5, 'Von Clara.']]);
  await setPhase(h, round, 'evaluation');
  await expectOk(h.api('bp', 'POST', `/api/feedback/results/${round.participantId}/calculate`));
  await expectOk(h.api('bp', 'PATCH', `/api/feedback/results/${round.participantId}/status`, { status: 'reviewed' }));
  await expectOk(h.api('bp', 'PATCH', `/api/feedback/results/${round.participantId}/status`, { status: 'released_for_manager' }));

  const peerGroup = report => report.questions.find(question => question.id === round.ratingId).groups.find(group => group.group === 'peer');
  // Für Elena-als-Geberin blieben nur zwei fremde Antworten: Die eigene ließe sich herausrechnen.
  assert.equal(peerGroup(await reportOf(h, 'hr', round)), undefined);
  assert.equal((await reportOf(h, 'hr', round)).comments.some(comment => comment.group === 'peer'), false);
  assert.equal(peerGroup(await reportOf(h, 'bp', round)).responseCount, 3);
  assert.equal(peerGroup(await reportOf(h, 'manager', round)).responseCount, 3);
});

test('Anonymität: Solange Antworten eingehen, gibt es auch für HR keinen Bericht zum Vergleichen', async t => {
  const h = await openHarness(t);
  const round = await startRound(h);
  await answerAll(h, round, [['ben', 5, 'Eins.'], ['clara', 3, 'Zwei.'], ['director', 4, 'Drei.']]);
  assert.equal((await h.api('hr', 'GET', `/api/feedback/results/${round.participantId}`)).status, 409);
  assert.equal((await h.api('hr', 'POST', `/api/feedback/results/${round.participantId}/calculate`)).status, 409);
  const list = await expectOk(h.api('hr', 'GET', `/api/feedback/participants/${round.participantId}/nominations`));
  assert.equal(list.permissions.readResult, false);
  assert.equal(list.permissions.calculateResult, false);
});

test('M3/A20/B13: Eine abgelaufene Frist hat eine eigene Meldung, und HR kann sie verlängern', async t => {
  const h = await openHarness(t);
  const round = await startRound(h);
  const invitation = invitationOf(h, round, 'ben');
  h.db.prepare('UPDATE feedback_cycles SET start_date=?,nomination_deadline=?,feedback_deadline=? WHERE id=?').run(dayFromToday(-30), dayFromToday(-20), dayFromToday(-1), round.cycleId);

  const opened = await h.api('ben', 'GET', `/api/feedback/invitations/${invitation}`);
  assert.equal(opened.status, 409);
  assert.match(opened.data.error, /Frist.*abgelaufen/);
  assert.doesNotMatch(opened.data.error, /pausiert|Vorschläge/);
  const answer = { answers: [{ questionId: round.ratingId, numericValue: 4 }] };
  for (const [method, url, body] of [['PUT', 'responses', answer], ['POST', 'submit', answer], ['POST', 'decline', undefined]]) {
    const response = await h.api('ben', method, `/api/feedback/invitations/${invitation}/${url}`, body);
    assert.equal(response.status, 409);
    assert.match(response.data.error, /Frist.*abgelaufen/);
  }

  const extend = (person, body) => h.api(person, 'PATCH', `/api/feedback/cycles/${round.cycleId}/deadlines`, body);
  const newDeadline = dayFromToday(50);
  assert.equal((await extend('anna', { feedbackDeadline: newDeadline })).status, 403);
  assert.equal((await extend('manager', { feedbackDeadline: newDeadline })).status, 403);
  assert.equal((await extend('hr', { feedbackDeadline: 'kein Datum' })).status, 400);
  assert.equal((await extend('hr', { feedbackDeadline: dayFromToday(-5) })).status, 400);
  assert.equal((await extend('hr', {})).status, 400);
  const extended = await expectOk(extend('bp', { feedbackDeadline: newDeadline }));
  assert.equal(extended.feedbackDeadline, newDeadline);
  assert.equal(extended.endDate, newDeadline);
  assert.deepEqual(openTasks(h, 'ben', 'feedback_submit').map(task => task.due_date), [newDeadline]);
  assert.equal(h.db.prepare("SELECT COUNT(*) count FROM feedback_history WHERE cycle_id=? AND action='feedback_cycle_deadline_extended'").get(round.cycleId).count, 1);

  await expectOk(h.api('ben', 'GET', `/api/feedback/invitations/${invitation}`));
  await submitAnswers(h, round, 'ben', 5, 'Jetzt geht es wieder.');

  await setPhase(h, round, 'evaluation');
  assert.equal((await extend('hr', { feedbackDeadline: dayFromToday(60) })).status, 409);
});

test('M3: Die Nominierungsphase meldet weiter „ruht“, und eine tote Phase lässt sich nicht starten', async t => {
  const h = await openHarness(t);
  const round = await startRound(h);
  const invitation = invitationOf(h, round, 'ben');
  await setPhase(h, round, 'nomination');
  const paused = await h.api('ben', 'GET', `/api/feedback/invitations/${invitation}`);
  assert.equal(paused.status, 409);
  assert.match(paused.data.error, /ruht/);

  h.db.prepare('UPDATE feedback_cycles SET start_date=?,nomination_deadline=?,feedback_deadline=? WHERE id=?').run(dayFromToday(-30), dayFromToday(-20), dayFromToday(-1), round.cycleId);
  const proposal = await h.api('anna', 'POST', `/api/feedback/participants/${round.participantId}/nominations`, { giverId: idOf(h, 'bp') });
  assert.equal(proposal.status, 403);
  assert.match(proposal.data.error, /Frist.*abgelaufen/);
  const started = await h.api('hr', 'PATCH', `/api/feedback/cycles/${round.cycleId}/status`, { status: 'open' });
  assert.equal(started.status, 409);
  assert.match(started.data.error, /abgelaufen/);
  await expectOk(h.api('hr', 'PATCH', `/api/feedback/cycles/${round.cycleId}/deadlines`, { nominationDeadline: dayFromToday(1), feedbackDeadline: dayFromToday(30) }));
  await setPhase(h, round, 'open');
  await expectOk(h.api('ben', 'GET', `/api/feedback/invitations/${invitation}`));
});

test('M3: Beispieldaten leben relativ zum heutigen Tag und werden auch später wieder benutzbar', async t => {
  const h = await openHarness(t);
  addPerson(h, 'Carl Kollege', 'carl@test.local', 'employee', idOf(h, 'manager'));
  addPerson(h, 'Dina Kollegin', 'dina@test.local', 'employee', idOf(h, 'manager'));
  h.instance.seed();

  const running = h.db.prepare("SELECT * FROM feedback_cycles WHERE status='open'").get();
  assert.ok(running.feedback_deadline >= dayFromToday(30), running.feedback_deadline);
  assert.ok(running.nomination_deadline < dayFromToday(0));
  assert.ok(running.name.endsWith(dayFromToday(0).slice(0, 4)));
  const invitation = h.db.prepare("SELECT i.id,i.giver_id FROM feedback_invitations i JOIN feedback_cycle_participants p ON p.id=i.participant_id WHERE p.cycle_id=? AND i.feedback_group='peer' ORDER BY i.id LIMIT 1").get(running.id);
  await expectOk(h.api(invitation.giver_id, 'GET', `/api/feedback/invitations/${invitation.id}`));
  const submitTasks = h.db.prepare("SELECT due_date FROM tasks WHERE type='feedback_submit' AND done=0").all();
  assert.ok(submitTasks.length >= 5);
  assert.ok(submitTasks.every(task => task.due_date === running.feedback_deadline));

  // Der abgeschlossene Beispielzyklus hat keine leeren Teilnahmen und einen Bericht mit Kommentaren.
  const finished = h.db.prepare("SELECT * FROM feedback_cycles WHERE status='completed'").get();
  const finishedParticipants = h.db.prepare('SELECT id,(SELECT COUNT(*) FROM feedback_invitations i WHERE i.participant_id=p.id) invitations FROM feedback_cycle_participants p WHERE p.cycle_id=?').all(finished.id);
  assert.equal(finishedParticipants.length, 1);
  assert.equal(finishedParticipants[0].invitations, 5);
  const report = await reportOf(h, 'hr', { participantId: finishedParticipants[0].id });
  assert.ok(report.comments.filter(comment => comment.group === 'peer').length >= 3);
  assert.equal(new Set(report.comparisons.map(item => item.external)).size > 1, true);

  // Eine lange laufende Demo: Die Frist ist abgelaufen, beim nächsten Start lebt sie wieder.
  const cycleCount = h.db.prepare('SELECT COUNT(*) count FROM feedback_cycles').get().count;
  h.db.prepare('UPDATE feedback_cycles SET feedback_deadline=? WHERE id=?').run(dayFromToday(-1), running.id);
  h.instance.seed();
  assert.equal(h.db.prepare('SELECT COUNT(*) count FROM feedback_cycles').get().count, cycleCount);
  const revived = h.db.prepare('SELECT feedback_deadline FROM feedback_cycles WHERE id=?').get(running.id);
  assert.ok(revived.feedback_deadline >= dayFromToday(30));
  assert.ok(h.db.prepare("SELECT due_date FROM tasks WHERE type='feedback_submit' AND done=0").all().every(task => task.due_date === revived.feedback_deadline));
});

test('A6/M4/B11: Kommentare erscheinen ab der Schwelle, darunter nicht, und die Anzahl stimmt', async t => {
  const h = await openHarness(t);
  const round = await startRound(h);
  await finishRound(h, round, { answers: [
    ['anna', 4, 'Selbst.'],
    ['manager', 4, 'Chef.'],
    ['ben', 5, 'Kommentar von Ben.'],
    ['clara', 3, 'Kommentar von Clara.'],
    ['director', 4, 'Kommentar von Dora.']
  ] });
  const report = await reportOf(h, 'anna', round);
  const peerComments = report.comments.filter(comment => comment.group === 'peer');
  assert.deepEqual(peerComments.map(comment => comment.text).sort(), ['Kommentar von Ben.', 'Kommentar von Clara.', 'Kommentar von Dora.']);
  assert.ok(peerComments.every(comment => comment.anonymous === true));
  assert.deepEqual(Object.keys(peerComments[0]).sort(), ['anonymous', 'group', 'question', 'questionId', 'text']);
  const textGroups = report.questions.find(question => question.id === round.textId).groups;
  assert.equal(textGroups.find(group => group.group === 'peer').responseCount, 3);
  assert.equal(textGroups.find(group => group.group === 'peer').average, null);
  assert.deepEqual(report.comments.filter(comment => !comment.anonymous).map(comment => comment.group), ['self', 'manager']);

  const peerSection = report.sections[0].groups.find(group => group.group === 'peer');
  assert.equal(peerSection.questionCount, 1);
  assert.equal(peerSection.average, 4);
  assert.equal(report.sections[0].title, 'Thema');
});

test('A6/M4: Unter der Schwelle bleiben Kommentare verborgen, auch wenn die Noten sichtbar sind', async t => {
  const h = await openHarness(t);
  const round = await startRound(h);
  await finishRound(h, round, { answers: [
    ['anna', 4, 'Selbst.'],
    ['manager', 4, 'Chef.'],
    ['ben', 5, 'Kommentar von Ben.'],
    ['clara', 3, 'Kommentar von Clara.'],
    ['director', 4, '']
  ] });
  const report = await reportOf(h, 'hr', round);
  assert.equal(report.comments.some(comment => comment.anonymous), false);
  assert.equal(report.questions.find(question => question.id === round.ratingId).groups.find(group => group.group === 'peer').responseCount, 3);
});

test('A6/M4: Kleine Gruppen erscheinen nur zusammen und ohne Gruppenname', async t => {
  const h = await openHarness(t);
  const round = await startRound(h, { givers: ['ben', 'clara'] , phase: 'nomination' });
  const outside = addPerson(h, 'Olga Außen', 'olga@test.local');
  const { id } = await expectOk(h.api('hr', 'POST', `/api/feedback/participants/${round.participantId}/nominations`, { giverId: outside, feedbackGroup: 'stakeholder' }), 201);
  await expectOk(h.api('hr', 'PATCH', `/api/feedback/nominations/${id}`, { status: 'approved' }));
  await setPhase(h, round, 'open');
  await finishRound(h, round, { answers: [['ben', 5, 'Von Ben.'], ['clara', 4, 'Von Clara.'], [outside, 3, 'Von Olga.']] });
  const report = await reportOf(h, 'anna', round);
  assert.deepEqual([...new Set(report.comments.map(comment => comment.group))], ['anonymous_combined']);
  assert.equal(report.comments.length, 3);
  const groups = report.questions.find(question => question.id === round.ratingId).groups;
  assert.deepEqual(groups.map(group => [group.group, group.responseCount, group.average]), [['anonymous_combined', 3, 4]]);
});

test('A6: Die Reihenfolge der Kommentare hängt nur am Text, nicht an Person oder Abgabezeit', async t => {
  const comments = ['Kommentar A', 'Kommentar B', 'Kommentar C', 'Kommentar D', 'Kommentar E', 'Kommentar F'];
  const orderWhen = async (shift, reversed) => {
    const h = await openHarness(t);
    const others = ['carl', 'dina', 'emil'].map(name => addPerson(h, name, `${name}@test.local`));
    const givers = ['ben', 'clara', 'director', ...others];
    const round = await startRound(h, { givers });
    const peers = givers.map((giver, index) => [giver, 4, comments[(index + shift) % comments.length]]);
    await finishRound(h, round, { answers: [['anna', 4, 'Selbst.'], ['manager', 4, 'Chef.'], ...(reversed ? peers.reverse() : peers)] });
    return (await reportOf(h, 'anna', round)).comments.filter(comment => comment.anonymous).map(comment => comment.text);
  };
  const baseline = await orderWhen(0, false);
  assert.equal(baseline.length, 6);
  assert.deepEqual(await orderWhen(0, true), baseline, 'Die Abgabefolge darf keine Rolle spielen.');
  assert.deepEqual(await orderWhen(1, false), baseline, 'Wer welchen Text schrieb, darf keine Rolle spielen.');
});

test('A6/M4: Die Oberfläche zeigt die Fragenzahl statt „undefined Antworten“', () => {
  const js = readFileSync(path.join(__dirname, '../public/feedback.js'), 'utf8');
  assert.doesNotMatch(js, /responseCount/);
  assert.match(js, /group\.questionCount, 'Frage', 'Fragen'/);
});

test('A6/B10: HR findet den Bericht in jedem Stand wieder, die Führungskraft ab ihrer Freigabe', async t => {
  const h = await openHarness(t);
  const round = await startRound(h);
  const readable = async person => (await h.api(person, 'GET', `/api/feedback/results/${round.participantId}`)).status;
  const permissionsOf = async person => (await expectOk(h.api(person, 'GET', `/api/feedback/participants/${round.participantId}/nominations`))).permissions;

  await answerAll(h, round, [['anna', 4, 'A.'], ['manager', 4, 'B.'], ['ben', 5, 'C.'], ['clara', 3, 'D.'], ['director', 4, 'E.']]);
  await setPhase(h, round, 'evaluation');
  assert.equal((await permissionsOf('hr')).calculateResult, true);
  assert.equal((await h.api('hr', 'GET', `/api/feedback/cycles/${round.cycleId}`)).data.cycle.participants[0].permissions.calculateResult, true);
  await expectOk(h.api('hr', 'POST', `/api/feedback/results/${round.participantId}/calculate`));

  const expected = [
    [null, 403, 403],
    ['reviewed', 403, 403],
    ['released_for_manager', 200, 403],
    ['released_for_employee', 200, 200],
    ['closed', 200, 200]
  ];
  for (const [status, manager, employee] of expected) {
    if (status) await expectOk(h.api('hr', 'PATCH', `/api/feedback/results/${round.participantId}/status`, { status }));
    assert.equal(await readable('hr'), 200, `HR bei ${status}`);
    assert.equal((await permissionsOf('hr')).readResult, true);
    assert.equal(await readable('manager'), manager, `Führungskraft bei ${status}`);
    assert.equal((await permissionsOf('manager')).readResult, manager === 200);
    assert.equal(await readable('anna'), employee, `Person bei ${status}`);
    assert.equal(await readable('ben'), 403);
    assert.equal(await readable('director'), 403);
  }
});

test('A6/B10: Die Freigabekette hat Knöpfe, und die Führungskraft schließt das Ergebnisgespräch ab', async t => {
  const h = await openHarness(t);
  const round = await startRound(h);
  await finishRound(h, round, { upTo: 'released_for_manager' });
  const hrView = await expectOk(h.api('hr', 'GET', `/api/feedback/results/${round.participantId}`));
  assert.equal(hrView.permissions.nextStatus, 'released_for_employee');
  assert.equal(hrView.permissions.completeMeeting, false);
  assert.equal(hrView.status.status, 'released_for_manager');
  assert.equal('updated_by' in hrView.status, false);
  const managerView = await expectOk(h.api('manager', 'GET', `/api/feedback/results/${round.participantId}`));
  assert.equal(managerView.permissions.nextStatus, null);
  assert.equal(managerView.permissions.completeMeeting, true);
  assert.equal(managerView.permissions.develop, true);
  assert.ok(managerView.result.calculation.calculatedAt);

  const tasks = openTasks(h, 'manager', 'feedback_result_meeting');
  assert.equal(tasks.length, 1);
  assert.match(tasks[0].title, /Ergebnisgespräch mit Anna Ahrens vorbereiten/);
  assert.equal(tasks[0].entity_id, round.participantId);
  assert.equal((await h.api('anna', 'POST', `/api/feedback/results/${round.participantId}/meeting`)).status, 403);
  assert.equal((await h.api('hr', 'POST', `/api/feedback/results/${round.participantId}/meeting`)).status, 403);
  await expectOk(h.api('manager', 'POST', `/api/feedback/results/${round.participantId}/meeting`));
  assert.equal(openTasks(h, 'manager', 'feedback_result_meeting').length, 0);
  assert.equal((await h.api('manager', 'POST', `/api/feedback/results/${round.participantId}/meeting`)).status, 409);
  const afterwards = await expectOk(h.api('manager', 'GET', `/api/feedback/results/${round.participantId}`));
  assert.equal(afterwards.permissions.completeMeeting, false);
  assert.ok(afterwards.status.meeting_completed_at);
});

test('B27: Neue Fragen und Abschnitte landen am Ende, und unbenutzte Fragen lassen sich ändern und löschen', async t => {
  const h = await openHarness(t);
  const { id: questionnaireId } = await expectOk(h.api('hr', 'POST', '/api/feedback/questionnaires', { name: 'Neu' }), 201);
  const { id: sectionA } = await expectOk(h.api('hr', 'POST', `/api/feedback/questionnaires/${questionnaireId}/sections`, { title: 'A' }), 201);
  const { id: sectionB } = await expectOk(h.api('hr', 'POST', `/api/feedback/questionnaires/${questionnaireId}/sections`, { title: 'B', displayOrder: '' }), 201);
  const orderOf = id => h.db.prepare('SELECT display_order FROM feedback_questionnaire_sections WHERE id=?').get(id).display_order;
  assert.deepEqual([orderOf(sectionA), orderOf(sectionB)], [1, 2]);

  const addQuestion = (questionText, body = {}) => h.api('hr', 'POST', `/api/feedback/questionnaires/sections/${sectionA}/questions`, { questionText, questionType: 'rating', required: true, ...body });
  const first = await expectOk(addQuestion('Erste Frage'), 201);
  const second = await expectOk(addQuestion('Zweite Frage'), 201);
  assert.deepEqual([first.displayOrder, second.displayOrder], [1, 2]);
  const taken = await addQuestion('Dritte Frage', { displayOrder: 1 });
  assert.equal(taken.status, 409);
  assert.match(taken.data.error, /Platz 1 .*nächste freie Platz ist 3/);

  await expectOk(h.api('hr', 'PATCH', `/api/feedback/questions/${first.id}`, { questionText: 'Geänderte Frage', questionType: 'text', required: false, helpText: 'Hilfe' }));
  const changed = h.db.prepare('SELECT * FROM feedback_questions WHERE id=?').get(first.id);
  assert.deepEqual([changed.question_text, changed.question_type, changed.required, changed.help_text], ['Geänderte Frage', 'text', 0, 'Hilfe']);
  assert.equal((await h.api('hr', 'PATCH', `/api/feedback/questions/${first.id}`, { questionType: 'multiple_choice' })).status, 400);
  assert.equal((await h.api('hr', 'PATCH', `/api/feedback/questions/${first.id}`, { questionText: '' })).status, 400);

  const questionOrder = () => h.db.prepare('SELECT id FROM feedback_questions WHERE section_id=? ORDER BY display_order').all(sectionA).map(row => row.id);
  assert.deepEqual(questionOrder(), [first.id, second.id]);
  await expectOk(h.api('hr', 'POST', `/api/feedback/questions/${second.id}/move`, { direction: 'up' }));
  assert.deepEqual(questionOrder(), [second.id, first.id]);
  assert.equal((await expectOk(h.api('hr', 'POST', `/api/feedback/questions/${second.id}/move`, { direction: 'up' }))).moved, false);
  assert.equal((await h.api('hr', 'POST', `/api/feedback/questions/${second.id}/move`, { direction: 'seitwärts' })).status, 400);
  await expectOk(h.api('hr', 'POST', `/api/feedback/questionnaires/sections/${sectionB}/move`, { direction: 'up' }));
  assert.ok(orderOf(sectionB) < orderOf(sectionA));

  await expectOk(h.api('hr', 'PATCH', `/api/feedback/questionnaires/sections/${sectionB}`, { title: 'B neu' }));
  await expectOk(h.api('hr', 'PATCH', `/api/feedback/questionnaires/${questionnaireId}`, { name: 'Neu geändert', active: false }));
  assert.equal(h.db.prepare('SELECT active FROM feedback_questionnaires WHERE id=?').get(questionnaireId).active, 0);
  await expectOk(h.api('hr', 'PATCH', `/api/feedback/questionnaires/${questionnaireId}`, { active: true }));

  await expectOk(h.api('hr', 'DELETE', `/api/feedback/questions/${first.id}`));
  assert.deepEqual(questionOrder(), [second.id]);
  await expectOk(h.api('hr', 'DELETE', `/api/feedback/questionnaires/sections/${sectionB}`));

  for (const person of ['anna', 'manager']) {
    assert.equal((await h.api(person, 'PATCH', `/api/feedback/questions/${second.id}`, { questionText: 'Nein' })).status, 403);
    assert.equal((await h.api(person, 'DELETE', `/api/feedback/questions/${second.id}`)).status, 403);
    assert.equal((await h.api(person, 'POST', `/api/feedback/questions/${second.id}/move`, { direction: 'up' })).status, 403);
    assert.equal((await h.api(person, 'DELETE', `/api/feedback/questionnaires/sections/${sectionA}`)).status, 403);
  }

  // Sobald eine Runde den Bogen verwendet, bleibt er unverändert.
  await expectOk(h.api('hr', 'POST', '/api/feedback/cycles', { name: 'Runde', questionnaireId, startDate: dayFromToday(0), endDate: dayFromToday(30), nominationDeadline: dayFromToday(5), feedbackDeadline: dayFromToday(20) }), 201);
  assert.equal((await h.api('hr', 'PATCH', `/api/feedback/questions/${second.id}`, { questionText: 'Nein' })).status, 409);
  assert.equal((await h.api('hr', 'DELETE', `/api/feedback/questions/${second.id}`)).status, 409);
  assert.equal((await h.api('hr', 'POST', `/api/feedback/questions/${second.id}/move`, { direction: 'down' })).status, 409);
  assert.equal((await h.api('hr', 'PATCH', `/api/feedback/questionnaires/sections/${sectionA}`, { title: 'Nein' })).status, 409);
  assert.equal((await h.api('hr', 'DELETE', `/api/feedback/questionnaires/sections/${sectionA}`)).status, 409);
  assert.equal((await h.api('hr', 'PATCH', `/api/feedback/questionnaires/${questionnaireId}`, { name: 'Nein' })).status, 409);
});

test('B27: Der Fragebogen zeigt keine rohen Werte mehr', () => {
  const js = readFileSync(path.join(__dirname, '../public/feedback.js'), 'utf8');
  assert.doesNotMatch(js, /esc\(question\.question_type\)/);
  assert.match(js, /rating: 'Bewertung \(1–5\)', text: 'Freitext'/);
});

test('B18/A12: Aufgaben der Vorschlagsphase haben Namen und echte Fristen und schließen sich', async t => {
  const h = await openHarness(t);
  const round = await startRound(h, { phase: 'draft' });
  assert.equal(openTasks(h, 'anna', 'feedback_nominate').length, 0, 'Im Entwurf kann die Person noch nichts tun.');
  await setPhase(h, round, 'nomination');
  const [nominate] = openTasks(h, 'anna', 'feedback_nominate');
  assert.match(nominate.title, /Personen für dein 360° Feedback „Runde“ vorschlagen/);
  assert.equal(nominate.due_date, round.nominationDeadline);
  assert.equal(nominate.entity_id, round.participantId);

  const { id: nominationId } = await expectOk(h.api('anna', 'POST', `/api/feedback/participants/${round.participantId}/nominations`, { giverId: idOf(h, 'ben') }), 201);
  const [review] = openTasks(h, 'manager', 'feedback_nomination_review');
  assert.match(review.title, /Ben Berg .*Anna Ahrens/);
  assert.equal(review.due_date, round.nominationDeadline);
  assert.deepEqual(await expectOk(h.api('manager', 'GET', `/api/feedback/task-target?type=feedback_nomination_review&id=${nominationId}`)), { participantId: round.participantId });
  assert.equal((await h.api('ben', 'GET', `/api/feedback/task-target?type=feedback_nomination_review&id=${nominationId}`)).status, 404);
  assert.equal((await h.api('manager', 'GET', '/api/feedback/task-target?type=constructor&id=1')).status, 404);

  await expectOk(h.api('manager', 'PATCH', `/api/feedback/nominations/${nominationId}`, { status: 'rejected', rejectionReason: 'Arbeitet nicht mit Anna.' }));
  assert.equal(openTasks(h, 'manager', 'feedback_nomination_review').length, 0);
  const [notice] = openTasks(h, 'anna', 'feedback_nomination_rejected_notice');
  assert.match(notice.title, /Ben Berg/);

  await expectOk(h.api('anna', 'POST', `/api/feedback/participants/${round.participantId}/nominations/complete`));
  assert.equal(openTasks(h, 'anna', 'feedback_nominate').length, 0);
  assert.equal((await h.api('ben', 'POST', `/api/feedback/participants/${round.participantId}/nominations/complete`)).status, 403);
  const again = await expectOk(h.api('anna', 'GET', `/api/feedback/participants/${round.participantId}/nominations`));
  assert.equal(again.permissions.finishNominating, false);
  assert.equal(again.participant.nomination_completed, 1);

  // Wer nichts abschließt: Die Aufgabe endet spätestens, wenn das Feedback beginnt.
  const otherRound = await startRound(h, { employee: 'ben', givers: [], phase: 'nomination', name: 'Andere' });
  assert.equal(openTasks(h, 'ben', 'feedback_nominate').length, 1);
  await setPhase(h, otherRound, 'open');
  assert.equal(openTasks(h, 'ben', 'feedback_nominate').length, 0);
});

test('B18/M10: Feedback- und Berichtsaufgaben schließen sich am Ende des Vorgangs', async t => {
  const h = await openHarness(t);
  const round = await startRound(h);
  const [submitTask] = openTasks(h, 'ben', 'feedback_submit');
  assert.match(submitTask.title, /360° Feedback für Anna Ahrens abgeben/);
  assert.equal(submitTask.due_date, round.feedbackDeadline);
  assert.match(openTasks(h, 'anna', 'feedback_submit')[0].title, /Selbsteinschätzung/);

  // Clara antwortet nie: Nach Beginn der Auswertung darf ihre Aufgabe nicht offen bleiben.
  await answerAll(h, round, [['anna', 4, 'A.'], ['manager', 4, 'B.'], ['ben', 5, 'C.'], ['director', 4, 'D.']]);
  assert.equal(openTasks(h, 'ben', 'feedback_submit').length, 0);
  assert.equal(openTasks(h, 'clara', 'feedback_submit').length, 1);
  await setPhase(h, round, 'evaluation');
  assert.equal(openTasks(h, 'clara', 'feedback_submit').length, 0);

  await expectOk(h.api('bp', 'POST', `/api/feedback/results/${round.participantId}/calculate`));
  const [reviewTask] = openTasks(h, 'bp', 'feedback_result_review');
  assert.match(reviewTask.title, /Anna Ahrens/);
  assert.equal(reviewTask.due_date, null);
  await expectOk(h.api('hr', 'PATCH', `/api/feedback/results/${round.participantId}/status`, { status: 'reviewed' }));
  assert.equal(openTasks(h, 'bp', 'feedback_result_review').length, 0, 'Auch wenn eine andere HR-Person prüft.');

  await expectOk(h.api('hr', 'PATCH', `/api/feedback/results/${round.participantId}/status`, { status: 'released_for_manager' }));
  await expectOk(h.api('hr', 'PATCH', `/api/feedback/results/${round.participantId}/status`, { status: 'released_for_employee' }));
  const [resultTask] = openTasks(h, 'anna', 'feedback_result');
  assert.match(resultTask.title, /Bericht aus „Runde“/);
  assert.equal(resultTask.due_date, null);
  await expectOk(h.api('hr', 'GET', `/api/feedback/results/${round.participantId}`));
  assert.equal(openTasks(h, 'anna', 'feedback_result').length, 1, 'HR-Lesen schließt die Aufgabe der Person nicht.');
  await expectOk(h.api('anna', 'GET', `/api/feedback/results/${round.participantId}`));
  assert.equal(openTasks(h, 'anna', 'feedback_result').length, 0);

  // Maßnahmen sind Hinweise, die mit dem Lesen des Berichts erledigt sind.
  await expectOk(h.api('manager', 'POST', `/api/feedback/participants/${round.participantId}/development-actions`, { actionType: 'coaching', description: 'Zwei Gespräche mit einer erfahrenen Kollegin.' }), 201);
  const [notice] = openTasks(h, 'anna', 'feedback_development_action_notice');
  assert.match(notice.title, /Malte Manager/);
  assert.equal(notice.entity_id, round.participantId);
  await expectOk(h.api('anna', 'GET', `/api/feedback/results/${round.participantId}`));
  assert.equal(openTasks(h, 'anna', 'feedback_development_action_notice').length, 0);

  // Der Abschluss des Berichts beendet auch die Gesprächsaufgabe.
  assert.equal(openTasks(h, 'manager', 'feedback_result_meeting').length, 1);
  await expectOk(h.api('hr', 'PATCH', `/api/feedback/results/${round.participantId}/status`, { status: 'closed' }));
  assert.equal(openTasks(h, 'manager', 'feedback_result_meeting').length, 0);
});

test('B18: Ältere Maßnahmen-Aufgaben haben einen Knopf und schließen sich beim Lesen', async t => {
  const h = await openHarness(t);
  const round = await startRound(h);
  await finishRound(h, round);
  await expectOk(h.api('manager', 'POST', `/api/feedback/participants/${round.participantId}/development-actions`, { actionType: 'coaching', description: 'Zwei Gespräche mit einer erfahrenen Kollegin.' }), 201);
  const actionId = h.db.prepare('SELECT id FROM feedback_development_actions WHERE participant_id=?').get(round.participantId).id;
  h.deps.createTask(idOf(h, 'anna'), 'Entwicklungsmaßnahmen aus dem 360° Feedback ansehen', 'feedback_development_action', actionId);
  assert.deepEqual(await expectOk(h.api('anna', 'GET', `/api/feedback/task-target?type=feedback_development_action&id=${actionId}`)), { participantId: round.participantId });
  await expectOk(h.api('anna', 'GET', `/api/feedback/results/${round.participantId}`));
  assert.equal(openTasks(h, 'anna', 'feedback_development_action').length, 0);
});

test('B18: Das Archivieren beendet alle Aufgaben der Runde', async t => {
  const h = await openHarness(t);
  const round = await startRound(h);
  await answerAll(h, round, [['anna', 4, 'A.'], ['manager', 4, 'B.'], ['ben', 5, 'C.'], ['clara', 5, 'D.'], ['director', 4, 'E.']]);
  await setPhase(h, round, 'evaluation');
  await expectOk(h.api('hr', 'POST', `/api/feedback/results/${round.participantId}/calculate`));
  await expectOk(h.api('hr', 'PATCH', `/api/feedback/results/${round.participantId}/status`, { status: 'reviewed' }));
  await expectOk(h.api('hr', 'PATCH', `/api/feedback/results/${round.participantId}/status`, { status: 'released_for_manager' }));
  await setPhase(h, round, 'archived');
  assert.equal(h.db.prepare("SELECT COUNT(*) count FROM tasks WHERE done=0 AND type LIKE 'feedback_%' AND type NOT LIKE '%_notice'").get().count, 0);
});

test('B18: Die Oberfläche gibt jeder Aufgabe einen Knopf, und jeder Knopf hat eine Wirkung', () => {
  const js = readFileSync(path.join(__dirname, '../public/feedback.js'), 'utf8');
  for (const type of ['feedback_nominate', 'feedback_nomination_review', 'feedback_submit', 'feedback_result_review', 'feedback_result_meeting', 'feedback_result', 'feedback_development_action_notice', 'feedback_nomination_rejected_notice', 'feedback_development_action']) {
    assert.ok(js.includes(`case '${type}':`), type);
  }
  assert.match(js, /window\.loop\.registerTaskAction\(/);
  assert.doesNotMatch(js, /onclick="/);
  const used = new Set([...js.matchAll(/button\((?:[^,()]|\([^)]*\)|`[^`]*`|'[^']*')+?,\s*'([a-z-]+)'/g), ...js.matchAll(/moveButton\('([a-z-]+)'/g)].map(match => match[1]));
  assert.ok(used.size > 20, `gefunden: ${used.size}`);
  const known = js.slice(js.indexOf('const actions = {'), js.indexOf('function bindFeedback'));
  for (const action of used) assert.ok(known.includes(`'${action}':`) || known.includes(`${action}:`), action);
});

test('B3: Bericht und Gesprächsaufgabe wechseln mit der Führungskraft, die alte verliert den Zugriff', async t => {
  const h = await openHarness(t);
  const round = await startRound(h);
  await finishRound(h, round, { upTo: 'released_for_employee' });
  assert.equal(openTasks(h, 'manager', 'feedback_result_meeting').length, 1);

  assert.equal(h.deps.changeManager(idOf(h, 'anna'), idOf(h, 'director')), true);

  assert.equal(openTasks(h, 'manager', 'feedback_result_meeting').length, 0);
  assert.equal(openTasks(h, 'director', 'feedback_result_meeting').length, 1);
  assert.equal(h.db.prepare('SELECT manager_id FROM feedback_cycle_participants WHERE id=?').get(round.participantId).manager_id, idOf(h, 'director'));

  assert.equal((await h.api('manager', 'GET', `/api/feedback/results/${round.participantId}`)).status, 403);
  assert.equal((await h.api('manager', 'GET', `/api/feedback/participants/${round.participantId}/nominations`)).status, 403);
  assert.equal((await h.api('manager', 'POST', `/api/feedback/results/${round.participantId}/meeting`)).status, 403);
  assert.equal((await h.api('manager', 'POST', `/api/feedback/participants/${round.participantId}/development-actions`, { actionType: 'coaching', description: 'Darf ich nicht mehr festhalten.' })).status, 403);
  assert.deepEqual((await expectOk(h.api('manager', 'GET', '/api/feedback/dashboard'))).teamCycles, []);

  const view = await expectOk(h.api('director', 'GET', `/api/feedback/results/${round.participantId}`));
  assert.equal(view.result.participant.managerName, 'Dora Direktor');
  assert.equal(view.permissions.completeMeeting, true);
  assert.equal((await expectOk(h.api('director', 'GET', '/api/feedback/dashboard'))).teamCycles.length, 1);
  await expectOk(h.api('director', 'POST', `/api/feedback/results/${round.participantId}/meeting`));
  assert.equal(openTasks(h, 'director', 'feedback_result_meeting').length, 0);
  assert.equal(h.db.prepare("SELECT COUNT(*) count FROM feedback_history WHERE participant_id=? AND action='feedback_manager_changed'").get(round.participantId).count, 1);
});

test('B3: Die neue Führungskraft bekommt keine Gesprächsaufgabe zu alten Berichten, nur wenn sie niemand hatte', async t => {
  const h = await openHarness(t);
  const round = await startRound(h);
  await finishRound(h, round, { upTo: 'released_for_manager' });
  await expectOk(h.api('manager', 'POST', `/api/feedback/results/${round.participantId}/meeting`));
  h.deps.changeManager(idOf(h, 'anna'), idOf(h, 'director'));
  assert.equal(openTasks(h, 'director', 'feedback_result_meeting').length, 0, 'Das Gespräch ist schon vorbereitet.');

  // Ein alter Bericht ohne offene Aufgabe, zum Beispiel aus der Zeit vor dieser Aufgabe: Daraus entsteht nichts Neues.
  const oldRound = await startRound(h, { employee: 'ben', givers: ['anna', 'clara', 'director'], name: 'Alt' });
  await finishRound(h, oldRound, { upTo: 'released_for_employee', answers: [['ben', 4, 'Selbst.'], ['anna', 5, 'Eins.'], ['clara', 3, 'Zwei.'], ['director', 4, 'Drei.']] });
  h.db.prepare("UPDATE tasks SET done=1 WHERE type='feedback_result_meeting' AND entity_id=?").run(oldRound.participantId);
  h.deps.changeManager(idOf(h, 'ben'), idOf(h, 'bp'));
  assert.equal(openTasks(h, 'bp', 'feedback_result_meeting').length, 0);

  const noManager = addPerson(h, 'Olga Ohne', 'olga@test.local');
  const orphanRound = await startRound(h, { employee: noManager, name: 'Ohne' });
  await finishRound(h, orphanRound, { upTo: 'released_for_manager', answers: [[noManager, 4, 'Selbst.'], ['ben', 5, 'Eins.'], ['clara', 3, 'Zwei.'], ['director', 4, 'Drei.']] });
  assert.equal(h.db.prepare("SELECT COUNT(*) count FROM tasks WHERE type='feedback_result_meeting' AND entity_id=?").get(orphanRound.participantId).count, 0);
  h.deps.changeManager(noManager, idOf(h, 'manager'));
  assert.equal(openTasks(h, 'manager', 'feedback_result_meeting').length, 1);
});

test('B3: Offene Prüfaufgaben und unberührte Anfragen ziehen mit, begonnene Antworten bleiben', async t => {
  const h = await openHarness(t);
  const round = await startRound(h, { phase: 'nomination', givers: [] });
  const proposal = await expectOk(h.api('anna', 'POST', `/api/feedback/participants/${round.participantId}/nominations`, { giverId: idOf(h, 'ben') }), 201);
  assert.equal(openTasks(h, 'manager', 'feedback_nomination_review').length, 1);

  h.deps.changeManager(idOf(h, 'anna'), idOf(h, 'director'));
  assert.equal(openTasks(h, 'manager', 'feedback_nomination_review').length, 0);
  assert.equal(openTasks(h, 'director', 'feedback_nomination_review').length, 1);
  assert.equal((await h.api('manager', 'PATCH', `/api/feedback/nominations/${proposal.id}`, { status: 'approved' })).status, 403);
  await expectOk(h.api('director', 'PATCH', `/api/feedback/nominations/${proposal.id}`, { status: 'approved' }));
  const managerRequests = () => h.db.prepare("SELECT giver_id,status FROM feedback_nominations WHERE participant_id=? AND feedback_group='manager' ORDER BY id").all(round.participantId).map(row => ({ ...row }));
  assert.deepEqual(managerRequests(), [{ giver_id: idOf(h, 'director'), status: 'approved' }]);

  await setPhase(h, round, 'open');
  assert.equal(openTasks(h, 'director', 'feedback_submit').length, 1);
  assert.equal(openTasks(h, 'manager', 'feedback_submit').length, 0);

  // Noch nicht begonnen: Die Anfrage geht weiter. Begonnen: Der Entwurf gehört der Person, die ihn schrieb.
  h.deps.changeManager(idOf(h, 'anna'), idOf(h, 'bp'));
  assert.equal(openTasks(h, 'director', 'feedback_submit').length, 0);
  const [moved] = openTasks(h, 'bp', 'feedback_submit');
  await expectOk(h.api('bp', 'PUT', `/api/feedback/invitations/${moved.entity_id}/responses`, { answers: [{ questionId: round.ratingId, numericValue: 3 }] }));
  h.deps.changeManager(idOf(h, 'anna'), idOf(h, 'manager'));
  assert.equal(openTasks(h, 'bp', 'feedback_submit').length, 1);
  assert.equal(openTasks(h, 'manager', 'feedback_submit').length, 0);
  assert.equal(h.db.prepare('SELECT giver_id FROM feedback_invitations WHERE id=?').get(moved.entity_id).giver_id, idOf(h, 'bp'));
});

test('B3: Wer vorher Kolleg:in war, liegt danach nicht doppelt in der Runde', async t => {
  const h = await openHarness(t);
  const round = await startRound(h);
  assert.equal(openTasks(h, 'director', 'feedback_submit').length, 1);
  h.deps.changeManager(idOf(h, 'anna'), idOf(h, 'director'));
  const requests = h.db.prepare('SELECT feedback_group,status,rejection_reason FROM feedback_nominations WHERE participant_id=? AND giver_id=? ORDER BY id').all(round.participantId, idOf(h, 'director'));
  assert.equal(requests.filter(item => !['rejected', 'declined'].includes(item.status)).length, 1);
  assert.equal(requests.find(item => item.feedback_group === 'peer').status, 'rejected');
  assert.equal(openTasks(h, 'director', 'feedback_submit').length, 1);
});

test('B3: Ohne neue Führungskraft entscheidet HR, und alte Wechsel werden beim Start nachgeholt', async t => {
  const h = await openHarness(t);
  const round = await startRound(h, { phase: 'nomination', givers: [] });
  await expectOk(h.api('anna', 'POST', `/api/feedback/participants/${round.participantId}/nominations`, { giverId: idOf(h, 'ben') }), 201);
  h.deps.changeManager(idOf(h, 'anna'), null);
  assert.equal(openTasks(h, 'hr', 'feedback_nomination_review').length, 1);
  assert.equal(openTasks(h, 'manager', 'feedback_nomination_review').length, 0);
  assert.equal(h.db.prepare("SELECT status FROM feedback_nominations WHERE participant_id=? AND feedback_group='manager'").get(round.participantId).status, 'rejected');
  // Ohne Führungskraft gibt es trotzdem jemanden, der einen neuen Vorschlag sieht.
  await expectOk(h.api('anna', 'POST', `/api/feedback/participants/${round.participantId}/nominations`, { giverId: idOf(h, 'clara') }), 201);
  assert.equal(openTasks(h, 'hr', 'feedback_nomination_review').length, 2);

  // Ein Wechsel, von dem das Modul nichts mitbekam, zum Beispiel aus einer Zeit vor dieser Anmeldung.
  h.db.prepare('UPDATE users SET manager_id=? WHERE id=?').run(idOf(h, 'director'), idOf(h, 'anna'));
  assert.equal((await expectOk(h.api('director', 'GET', `/api/feedback/participants/${round.participantId}/nominations`))).permissions.decideNominations, true, 'Rechte stimmen sofort.');
  h.instance.initialize();
  assert.equal(openTasks(h, 'hr', 'feedback_nomination_review').length, 0);
  assert.equal(openTasks(h, 'director', 'feedback_nomination_review').length, 2);
  assert.equal(h.db.prepare('SELECT manager_id FROM feedback_cycle_participants WHERE id=?').get(round.participantId).manager_id, idOf(h, 'director'));
  h.instance.initialize();
  assert.equal(h.db.prepare("SELECT COUNT(*) count FROM feedback_history WHERE participant_id=? AND action='feedback_manager_changed'").get(round.participantId).count, 2);
});

test('P13: Datenbankfehler erreichen den Browser nie, verständliche Meldungen schon', async t => {
  const h = await openHarness(t);
  const round = await startRound(h);
  await finishRound(h, round, { upTo: 'released_for_manager' });
  const otherRound = await startRound(h, { employee: 'ben', givers: [], name: 'Zweite' });
  const invitation = invitationOf(h, otherRound, 'ben');
  const calls = () => [
    h.api('ben', 'PUT', `/api/feedback/invitations/${invitation}/responses`, { answers: [{ questionId: otherRound.ratingId, numericValue: 3 }] }),
    h.api('ben', 'POST', `/api/feedback/invitations/${invitation}/submit`, { answers: [{ questionId: otherRound.ratingId, numericValue: 3 }] }),
    h.api('hr', 'PATCH', `/api/feedback/results/${round.participantId}/status`, { status: 'released_for_employee' }),
    h.api('manager', 'POST', `/api/feedback/participants/${round.participantId}/development-actions`, { actionType: 'coaching', description: 'Zwei Gespräche mit einer Kollegin.' })
  ];

  t.mock.method(console, 'error', () => {});
  const secret = 'SQLITE_ERROR: no such column geheime_spalte in SELECT * FROM users';
  const failing = t.mock.method(h.db, 'transaction', () => () => { throw new Error(secret); });
  for (const call of calls()) {
    const response = await call;
    assert.equal(response.status, 500);
    assert.doesNotMatch(JSON.stringify(response.data), /SQLITE|geheime_spalte|SELECT/);
    assert.match(response.data.error, /nicht geklappt/);
  }
  failing.mock.restore();

  const invalid = await h.api('ben', 'PUT', `/api/feedback/invitations/${invitation}/responses`, { answers: [{ questionId: otherRound.ratingId, numericValue: 9 }] });
  assert.equal(invalid.status, 400);
  assert.match(invalid.data.error, /zwischen 1 und 5/);
  const wrongStep = await h.api('hr', 'PATCH', `/api/feedback/results/${round.participantId}/status`, { status: 'closed' });
  assert.equal(wrongStep.status, 409);
  const noGoalTitle = await h.api('manager', 'POST', `/api/feedback/participants/${round.participantId}/development-actions`, { actionType: 'coaching', description: 'Zwei Gespräche mit einer Kollegin.', createGoal: true });
  assert.equal(noGoalTitle.status, 400);
  assert.match(noGoalTitle.data.error, /Entwicklungsziel/);
});

test('hr_staff ist hier eine normale Person und bekommt keine HR-Rechte', async t => {
  const h = await openHarness(t);
  const staff = addPerson(h, 'Sach Bearbeiter', 'sb@test.local', 'hr_staff', idOf(h, 'hr'));
  const round = await startRound(h);
  await answerAll(h, round, [['ben', 5, 'Eins.']]);

  const forbidden = [
    ['GET', '/api/feedback/questionnaires'],
    ['POST', '/api/feedback/questionnaires', { name: 'Nein' }],
    ['POST', '/api/feedback/cycles', { name: 'Nein' }],
    ['PATCH', `/api/feedback/cycles/${round.cycleId}/status`, { status: 'evaluation' }],
    ['PATCH', `/api/feedback/cycles/${round.cycleId}/deadlines`, { feedbackDeadline: dayFromToday(30) }],
    ['POST', `/api/feedback/cycles/${round.cycleId}/participants`, { employeeId: idOf(h, 'clara') }],
    ['GET', `/api/feedback/history/${round.participantId}`],
    ['GET', `/api/feedback/participants/${round.participantId}/nominations`],
    ['GET', `/api/feedback/results/${round.participantId}`],
    ['POST', `/api/feedback/results/${round.participantId}/calculate`],
    ['PATCH', `/api/feedback/results/${round.participantId}/status`, { status: 'reviewed' }],
    ['GET', `/api/feedback/cycles/${round.cycleId}`],
    ['GET', `/api/feedback/cycles/${round.cycleId}/progress`],
    ['POST', `/api/feedback/invitations/${invitationOf(h, round, 'clara')}/reopen`]
  ];
  for (const [method, url, body] of forbidden) {
    assert.equal((await h.api(staff, method, url, body)).status, 403, `${method} ${url}`);
  }
  assert.deepEqual((await expectOk(h.api(staff, 'GET', '/api/feedback/cycles'))).items, []);
  assert.equal((await h.api(staff, 'GET', '/api/feedback/nominations/candidates')).status, 403);

  // Wie jede andere Person kann die Sachbearbeitung selbst Feedback bekommen.
  const ownRound = await startRound(h, { employee: staff, givers: ['ben', 'clara', 'anna'], name: 'Eigene' });
  const candidates = await expectOk(h.api(staff, 'GET', '/api/feedback/nominations/candidates'));
  assert.equal(candidates.users.every(user => !('role' in user)), true);
  const list = await expectOk(h.api(staff, 'GET', `/api/feedback/participants/${ownRound.participantId}/nominations`));
  assert.ok(list.nominations.every(item => !('created_at' in item)));
  assert.equal(list.permissions.viewHistory, false);
});

test('hrbp kommt nicht an Daten der HR-Leitung, die Führungslinie über eine andere HR-Leitung', async t => {
  const h = await openHarness(t);
  const secondAdmin = addPerson(h, 'Zweite Leitung', 'zweite@test.local', 'hr_admin');
  const questionnaire = await createQuestionnaire(h, 'Bogen Leitung');
  const { id: cycleId } = await expectOk(h.api(secondAdmin, 'POST', '/api/feedback/cycles', { name: 'Leitung', questionnaireId: questionnaire.questionnaireId, startDate: dayFromToday(0), endDate: dayFromToday(40), nominationDeadline: dayFromToday(10), feedbackDeadline: dayFromToday(20) }), 201);
  assert.equal((await h.api('bp', 'POST', `/api/feedback/cycles/${cycleId}/participants`, { employeeId: idOf(h, 'hr') })).status, 403);
  assert.equal((await h.api('hr', 'POST', `/api/feedback/cycles/${cycleId}/participants`, { employeeId: idOf(h, 'hr') })).status, 403, 'Niemand nimmt sich selbst auf.');
  const { id: participantId } = await expectOk(h.api(secondAdmin, 'POST', `/api/feedback/cycles/${cycleId}/participants`, { employeeId: idOf(h, 'hr') }), 201);

  assert.deepEqual((await expectOk(h.api('bp', 'GET', `/api/feedback/cycles/${cycleId}`))).cycle.participants, []);
  assert.equal((await h.api('bp', 'GET', `/api/feedback/participants/${participantId}/nominations`)).status, 403);
  assert.equal((await h.api('bp', 'GET', `/api/feedback/history/${participantId}`)).status, 403);
  assert.equal((await h.api('bp', 'GET', `/api/feedback/results/${participantId}`)).status, 403);
  assert.equal((await h.api('bp', 'POST', `/api/feedback/participants/${participantId}/nominations`, { giverId: idOf(h, 'anna') })).status, 403);
  await expectOk(h.api(secondAdmin, 'GET', `/api/feedback/participants/${participantId}/nominations`));
});

test('Mein Team folgt der Führungskraft, nicht der Rolle, und HR sieht dort nur das eigene Team', async t => {
  const h = await openHarness(t);
  const round = await startRound(h);
  const lead = addPerson(h, 'Lea Leitung', 'lea@test.local', 'employee');
  const staffed = addPerson(h, 'Tim Team', 'tim@test.local', 'employee', lead);
  const leadRound = await startRound(h, { employee: staffed, givers: [], name: 'Tim' });
  const teamOf = async person => (await expectOk(h.api(person, 'GET', '/api/feedback/dashboard'))).teamCycles.map(item => item.id);
  assert.deepEqual(await teamOf(lead), [leadRound.participantId]);
  assert.deepEqual(await teamOf('manager'), [round.participantId]);
  assert.deepEqual(await teamOf('hr'), []);
  assert.equal((await expectOk(h.api('hr', 'GET', '/api/feedback/dashboard'))).hrCycles.length, 2);
  assert.deepEqual((await expectOk(h.api('manager', 'GET', '/api/feedback/dashboard'))).hrCycles, []);
});

test('Vorschlagsliste nennt keine Rollen und lässt die Person selbst und Vorgeschlagene weg', async t => {
  const h = await openHarness(t);
  const round = await startRound(h, { phase: 'nomination', givers: ['ben'] });
  const forAnna = await expectOk(h.api('anna', 'GET', `/api/feedback/nominations/candidates?participantId=${round.participantId}`));
  const ids = forAnna.users.map(user => user.id);
  assert.equal(forAnna.users.every(user => !('role' in user)), true);
  assert.equal(ids.includes(idOf(h, 'anna')), false);
  assert.equal(ids.includes(idOf(h, 'ben')), false);
  assert.equal(ids.includes(idOf(h, 'manager')), false);
  assert.equal(ids.includes(idOf(h, 'clara')), true);
  const forManager = await expectOk(h.api('manager', 'GET', `/api/feedback/nominations/candidates?participantId=${round.participantId}`));
  assert.equal(forManager.users.map(user => user.id).includes(idOf(h, 'anna')), false);
  // Wer nirgends beteiligt ist, braucht das Personenverzeichnis nicht.
  assert.equal((await h.api('clara', 'GET', `/api/feedback/nominations/candidates?participantId=${round.participantId}`)).status, 403);
  // Wer anderswo beteiligt ist, erfährt über die fremde Teilnahme nicht, wer schon vorgeschlagen ist.
  await startRound(h, { employee: 'clara', givers: [], phase: 'nomination', name: 'Clara' });
  const forClara = await expectOk(h.api('clara', 'GET', `/api/feedback/nominations/candidates?participantId=${round.participantId}`));
  assert.equal(forClara.users.map(user => user.id).includes(idOf(h, 'ben')), true);
  assert.equal((await expectOk(h.api('hr', 'GET', '/api/feedback/nominations/candidates'))).users.every(user => 'role' in user), true);
});

test('Sprache: Die Oberfläche nutzt die vereinbarten einfachen Begriffe', () => {
  const js = readFileSync(path.join(__dirname, '../public/feedback.js'), 'utf8');
  for (const word of ['Stakeholder<', "'Stakeholder", 'Direct-Report', 'Zyklus', 'Zyklen', 'Fremdbild', 'Rücklauf', 'serverseitig', 'Nominier', 'Vorgesetzte', 'Performance', 'Workflow', 'Dashboard<', 'undefined']) {
    assert.equal(js.includes(word), false, word);
  }
  assert.match(js, /So funktioniert 360° Feedback/);
  assert.match(js, /ui\.date\(/);
  assert.match(js, /ui\.plural\(/);
  assert.match(js, /ui\.number\(/);
});

// ------------------------------------------------------------------ Selbsteinschätzung in der Du-Form

test('Du-Form: Alle Beispielfragen lauten in der Selbsteinschätzung richtig', () => {
  const expected = [
    ['Die Person arbeitet konstruktiv und zuverlässig mit anderen zusammen.', 'Du arbeitest konstruktiv und zuverlässig mit anderen zusammen.'],
    ['Die Person holt unterschiedliche Sichtweisen ein.', 'Du holst unterschiedliche Sichtweisen ein.'],
    ['Die Person holt unterschiedliche Perspektiven ein.', 'Du holst unterschiedliche Perspektiven ein.'],
    ['Die Person teilt Wissen aktiv.', 'Du teilst Wissen aktiv.'],
    ['Die Person geht respektvoll mit Feedback um.', 'Du gehst respektvoll mit Feedback um.'],
    ['Die Person kommuniziert klar und verständlich.', 'Du kommunizierst klar und verständlich.'],
    ['Die Person kommuniziert klar und adressatengerecht.', 'Du kommunizierst klar und adressatengerecht.'],
    ['Die Person macht Entscheidungen nachvollziehbar.', 'Du machst Entscheidungen nachvollziehbar.'],
    ['Die Person spricht schwierige Themen konstruktiv an.', 'Du sprichst schwierige Themen konstruktiv an.'],
    ['Die Person hört aktiv zu.', 'Du hörst aktiv zu.'],
    ['Die Person setzt Prioritäten wirksam um.', 'Du setzt Prioritäten wirksam um.'],
    ['Die Person liefert verlässliche Ergebnisse.', 'Du lieferst verlässliche Ergebnisse.'],
    ['Die Person übernimmt Verantwortung für die eigene Wirkung.', 'Du übernimmst Verantwortung für deine eigene Wirkung.'],
    ['Die Person übernimmt Verantwortung für Wirkung.', 'Du übernimmst Verantwortung für Wirkung.'],
    ['Die Person verbessert Abläufe kontinuierlich.', 'Du verbesserst Abläufe kontinuierlich.'],
    ['Die Person lernt aus Erfahrungen.', 'Du lernst aus Erfahrungen.'],
    ['Die Person entwickelt neue Fähigkeiten gezielt weiter.', 'Du entwickelst neue Fähigkeiten gezielt weiter.'],
    ['Die Person fragt aktiv nach Feedback.', 'Du fragst aktiv nach Feedback.'],
    ['Die Person überträgt Erkenntnisse in die Praxis.', 'Du überträgst Erkenntnisse in die Praxis.'],
    ['Die Person geht umsichtig mit Mitteln um.', 'Du gehst umsichtig mit Mitteln um.'],
    ['Die Person geht umsichtig mit Ressourcen um.', 'Du gehst umsichtig mit Ressourcen um.'],
    ['Die Person handelt kundenorientiert.', 'Du handelst kundenorientiert.'],
    ['Die Person fördert eine vertrauensvolle Zusammenarbeit.', 'Du förderst eine vertrauensvolle Zusammenarbeit.'],
    ['Was sollte die Person beim Thema „Zusammenarbeit“ unbedingt beibehalten?', 'Was solltest du beim Thema „Zusammenarbeit“ unbedingt beibehalten?'],
    ['Was sollte die Person im Bereich „Wirkung“ unbedingt beibehalten?', 'Was solltest du im Bereich „Wirkung“ unbedingt beibehalten?']
  ];
  for (const [text, wording] of expected) assert.equal(selfWording(text), wording);
});

test('Du-Form: Auch Sonderfälle stimmen, und Unsicheres bleibt lieber, wie es ist', () => {
  const converted = [
    ['Die Person ist offen für Kritik.', 'Du bist offen für Kritik.'],
    ['Die Person hat immer ein offenes Ohr.', 'Du hast immer ein offenes Ohr.'],
    ['Die Person wird von anderen um Rat gefragt.', 'Du wirst von anderen um Rat gefragt.'],
    ['Die Person kann gut erklären.', 'Du kannst gut erklären.'],
    ['Die Person weiß, was sie tut.', null],
    ['Die Person weiß Bescheid.', 'Du weißt Bescheid.'],
    ['Die Person muss selten nachfragen.', 'Du musst selten nachfragen.'],
    ['Die Person heißt neue Kolleg:innen willkommen.', 'Du heißt neue Kolleg:innen willkommen.'],
    ['Die Person achtet auf den eigenen Ton.', 'Du achtest auf deinen eigenen Ton.'],
    ['Die Person findet Lösungen.', 'Du findest Lösungen.'],
    ['Die Person hilft anderen gern.', 'Du hilfst anderen gern.'],
    ['Welche Stärken hat die Person?', 'Welche Stärken hast du?'],
    ['Wie geht die Person mit Kritik um?', 'Wie gehst du mit Kritik um?'],
    ['Inwieweit hört die Person zu?', 'Inwieweit hörst du zu?']
  ];
  for (const [text, wording] of converted) assert.equal(selfWording(text), wording, text);
  const unsure = [
    'Die Person setzt sich für andere ein.',
    'Die Person nimmt Kolleg:innen und ihre Ideen ernst.',
    'Die Person hilft, wenn sie gefragt wird.',
    'Die Person und das Team arbeiten gut zusammen.',
    'Die Person selbst entscheidet viel.',
    'Die Person im Team ist beliebt.',
    'Ich schätze die Person.',
    'Woran erkennt man die Person?',
    'Die Person hört zu. Die Person fragt nach.',
    'Ich weiß, was von mir erwartet wird.'
  ];
  for (const text of unsure) assert.equal(selfWording(text), null, text);
});

test('Du-Form: Nur die eigene Einschätzung und der eigene Bericht sprechen an, für alle anderen bleibt alles', async t => {
  const h = await openHarness(t);
  const questionnaire = await createQuestionnaire(h, 'Bogen Du');
  const { id: awkwardId } = await expectOk(h.api('hr', 'POST', `/api/feedback/questionnaires/sections/${questionnaire.sectionId}/questions`, { questionText: 'Die Person setzt sich für andere ein.', questionType: 'rating', required: false }), 201);
  const { id: cycleId } = await expectOk(h.api('hr', 'POST', '/api/feedback/cycles', { name: 'Du', questionnaireId: questionnaire.questionnaireId, startDate: dayFromToday(0), endDate: dayFromToday(40), nominationDeadline: dayFromToday(10), feedbackDeadline: dayFromToday(20) }), 201);
  const { id: participantId } = await expectOk(h.api('hr', 'POST', `/api/feedback/cycles/${cycleId}/participants`, { employeeId: idOf(h, 'anna') }), 201);
  const round = { ...questionnaire, cycleId, participantId, employee: 'anna' };
  await setPhase(h, round, 'nomination');
  for (const giver of ['ben', 'clara', 'director']) {
    const { id } = await expectOk(h.api('anna', 'POST', `/api/feedback/participants/${participantId}/nominations`, { giverId: idOf(h, giver) }), 201);
    await expectOk(h.api('hr', 'PATCH', `/api/feedback/nominations/${id}`, { status: 'approved' }));
  }
  await setPhase(h, round, 'open');

  const textsOf = form => form.sections.flatMap(section => section.questions.map(question => [question.id, question.question_text]));
  const selfForm = await expectOk(h.api('anna', 'GET', `/api/feedback/invitations/${invitationOf(h, round, 'anna')}`));
  assert.deepEqual(new Map(textsOf(selfForm)).get(questionnaire.ratingId), 'Du hörst zu.');
  assert.deepEqual(new Map(textsOf(selfForm)).get(awkwardId), 'Die Person setzt sich für andere ein.');
  assert.equal(selfForm.invitation.selfWordingIncomplete, true, 'Dann erklärt die Seite, wer gemeint ist');
  for (const giver of ['ben', 'manager']) {
    const form = await expectOk(h.api(giver, 'GET', `/api/feedback/invitations/${invitationOf(h, round, giver)}`));
    assert.equal(new Map(textsOf(form)).get(questionnaire.ratingId), 'Die Person hört zu.');
    assert.equal(form.invitation.selfWordingIncomplete, false);
  }
  assert.equal(h.db.prepare('SELECT question_text FROM feedback_questions WHERE id=?').get(questionnaire.ratingId).question_text, 'Die Person hört zu.', 'Gespeichert bleibt die Frage für alle anderen');
  const editor = await expectOk(h.api('hr', 'GET', `/api/feedback/questionnaires/${questionnaire.questionnaireId}`));
  assert.deepEqual(editor.questionnaire.sections[0].questions.map(question => question.self_question_text), ['Du hörst zu.', null, null]);

  await finishRound(h, round);
  const own = await reportOf(h, 'anna', round);
  assert.equal(own.comparisons[0].question, 'Du hörst zu.');
  assert.equal(own.questions.find(question => question.id === questionnaire.ratingId).question, 'Du hörst zu.');
  assert.equal(own.comments[0].question, 'Was soll bleiben?');
  const forManager = await reportOf(h, 'manager', round);
  assert.equal(forManager.comparisons[0].question, 'Die Person hört zu.');
  assert.equal((await reportOf(h, 'hr', round)).comparisons[0].question, 'Die Person hört zu.');
});

test('B3: Der Verlauf nennt, wer die Führungskraft gewechselt hat', async t => {
  const h = await openHarness(t);
  const round = await startRound(h);
  h.deps.changeManager(idOf(h, 'anna'), idOf(h, 'director'), idOf(h, 'bp'));
  const history = await expectOk(h.api('hr', 'GET', `/api/feedback/history/${round.participantId}`));
  assert.equal(history.items.find(item => item.action === 'feedback_manager_changed').actor_name, 'Boris Partner');
});

// ------------------------------------------------------------------ Oberfläche ohne Browser

/** Führt public/feedback.js ohne Browser aus. Die Globals sind das, was app.js sonst bereitstellt. */
function loadFeedbackPage({ role = 'hr_admin', confirmAnswer = true, apiResult = null } = {}) {
  const page = { confirms: [], calls: [], pushed: [], listeners: {}, address: null, form: null, hash: '#/feedbackInvitation/12', appHtml: '', syncs: 0, standardRendered: 0 };
  const loop = {
    api: async url => {
      page.calls.push(url);
      if (apiResult) return apiResult(url);
      throw Object.assign(new Error('Kein Zugriff'), { status: 403 });
    },
    ui: { esc: value => String(value ?? ''), toast: () => {}, empty: text => text, stat: () => '', date: value => value, plural: (count, one, many) => `${count} ${count === 1 ? one : many}`, number: value => String(value), modal: () => {}, closeModal: () => {} },
    me: { id: 5, role },
    navigate: target => {
      sandbox.view = target;
      return sandbox.render();
    },
    registerAddress: handlers => { page.address = handlers; },
    registerTaskAction: () => {}
  };
  const listen = target => (type, listener) => { page.listeners[`${target}:${type}`] = listener; };
  const appElement = { set innerHTML(value) { page.appHtml = value; }, get innerHTML() { return page.appHtml; } };
  const sandbox = {
    window: { loop, scrollY: 300, scrollTo: () => {}, addEventListener: listen('window'), confirm: text => { page.confirms.push(text); return confirmAnswer; } },
    document: {
      addEventListener: listen('document'),
      querySelectorAll: () => [],
      querySelector: selector => {
        if (selector === '#app') return appElement;
        if (selector === '#fbResponseForm[data-unsaved]') return page.form?.dataset.unsaved ? page.form : null;
        return null;
      }
    },
    history: { pushState: (state, title, address) => page.pushed.push([state, address]) },
    get location() { return { hash: page.hash }; },
    bind: () => {},
    render: async () => { page.standardRendered += 1; },
    shell: content => content,
    hasTeamAccess: () => true,
    syncAddress: () => { page.syncs += 1; },
    restoringAddress: false,
    view: 'feedbackDashboard',
    me: loop.me,
    setTimeout: () => {},
    Number, String, Object, Array, Set, Map, JSON, encodeURIComponent, Math, Boolean, Promise, Error, Date, RegExp
  };
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(path.join(__dirname, '../public/feedback.js'), 'utf8'), sandbox);
  page.sandbox = sandbox;
  page.loop = loop;
  return page;
}

test('Adresse: Detailseiten tragen die Nummer und laden direkt nach dem Neuladen die richtigen Daten', async () => {
  const expected = {
    feedbackCycleDetail: '/api/feedback/cycles/12',
    feedbackParticipant: '/api/feedback/participants/12/nominations',
    feedbackQuestionnaire: '/api/feedback/questionnaires/12',
    feedbackInvitation: '/api/feedback/invitations/12',
    feedbackResult: '/api/feedback/results/12'
  };
  const js = readFileSync(path.join(__dirname, '../public/feedback.js'), 'utf8');
  assert.doesNotMatch(js, /sessionStorage/, 'Die Nummer gehört in die Adresse, sonst hilft sie im neuen Reiter nicht');
  for (const [view, url] of Object.entries(expected)) {
    const page = loadFeedbackPage();
    assert.deepEqual(Object.keys(page.address).sort(), Object.keys(expected).sort());
    assert.equal(page.address[view].get(), null, 'Nach dem Laden steht nichts im Speicher');
    page.address[view].set(12);
    assert.equal(page.address[view].get(), 12);
    page.sandbox.view = view;
    await page.sandbox.render();
    assert.equal(page.calls[0], url, view);
  }
});

test('Adresse: Eine fremde Nummer führt beim Öffnen über die Adresse zur Übersicht, ohne Daten zu zeigen', async () => {
  const page = loadFeedbackPage({ role: 'employee' });
  page.address.feedbackResult.set(99);
  page.sandbox.view = 'feedbackResult';
  page.sandbox.restoringAddress = true;
  await page.sandbox.render();
  assert.equal(page.calls[0], '/api/feedback/results/99');
  assert.equal(page.sandbox.view, 'feedbackDashboard');
  assert.equal(page.calls[1], '/api/feedback/dashboard');
  assert.equal(page.sandbox.restoringAddress, false);
});

test('Adresse: HR-Seiten laden für andere gar nicht erst Daten', async () => {
  for (const view of ['feedbackCycles', 'feedbackCycleDetail', 'feedbackQuestionnaires', 'feedbackQuestionnaire']) {
    const page = loadFeedbackPage({ role: 'employee' });
    if (page.address[view]) page.address[view].set(1);
    page.sandbox.view = view;
    await page.sandbox.render();
    assert.deepEqual(page.calls, [], view);
    assert.match(page.appHtml, /Nur HR/, view);
  }
});

test('Verlassen: Wer ungespeicherte Eingaben hat, wird gefragt und kann bleiben', async () => {
  const page = loadFeedbackPage({ confirmAnswer: false });
  page.address.feedbackInvitation.set(12);
  page.form = { dataset: { invitationId: '12' } };

  // Ohne Eingabe kein Hinweis, die Seite wechselt einfach.
  await page.loop.navigate('dashboard');
  assert.deepEqual([page.confirms.length, page.standardRendered], [0, 1]);

  // Knöpfe und Sprünge von außen wie bei Dayo: Die Ansicht ist schon gewechselt, das Formular bleibt.
  page.form.dataset.unsaved = '1';
  page.standardRendered = 0;
  await page.loop.navigate('dashboard');
  assert.equal(page.confirms.length, 1);
  assert.equal(page.standardRendered, 0, 'Das Formular wird nicht neu aufgebaut');
  assert.equal(page.sandbox.view, 'feedbackInvitation');
  assert.equal(page.form.dataset.unsaved, '1');
  assert.deepEqual(page.pushed, [], 'Die Adresse stand noch richtig');

  // Abmelden, Neu laden und Schließen.
  const click = element => ({ target: { closest: () => element }, prevented: 0, preventDefault() { this.prevented += 1; }, stopPropagation() {} });
  let event = click({});
  page.listeners['document:click'](event);
  assert.deepEqual([page.confirms.length, event.prevented], [2, 1]);
  event = click(null);
  page.listeners['document:click'](event);
  assert.deepEqual([page.confirms.length, event.prevented], [2, 0], 'Andere Klicks gehen das nichts an');
  const unload = { prevented: 0, preventDefault() { this.prevented += 1; } };
  page.listeners['window:beforeunload'](unload);
  assert.equal(unload.prevented, 1);

  // Zurück im Browser: Die Anwendung hat schon gewechselt. Ansicht, Nummer und Adresse kommen zurück.
  page.hash = '#/feedbackInvitation/13';
  page.sandbox.view = 'feedbackInvitation';
  page.address.feedbackInvitation.set(13);
  await page.sandbox.render();
  assert.equal(page.calls.length, 0, 'Es wird nichts neu geladen');
  assert.equal(page.address.feedbackInvitation.get(), 12);
  assert.equal(page.pushed[0][1], '#/feedbackInvitation/12');
  assert.deepEqual({ view: page.pushed[0][0].view, item: page.pushed[0][0].item }, { view: 'feedbackInvitation', item: 12 });

  const leaving = loadFeedbackPage({ confirmAnswer: true });
  leaving.form = { dataset: { invitationId: '12', unsaved: '1' } };
  await leaving.loop.navigate('dashboard');
  assert.equal(leaving.standardRendered, 1);
  assert.equal(leaving.form.dataset.unsaved, undefined);
  await leaving.loop.navigate('goals');
  assert.equal(leaving.confirms.length, 1, 'Nur einmal gefragt');
});

test('Verlassen: Nach dem Speichern, Absenden und Ablehnen ist nichts mehr offen', () => {
  const js = readFileSync(path.join(__dirname, '../public/feedback.js'), 'utf8');
  for (const [step, pattern] of [
    ['Absenden', /\/submit`, 'POST'[^\n]*\n\s*delete form\.dataset\.unsaved;/],
    ['Ablehnen', /\/decline`, 'POST'\);\n\s*delete document\.querySelector\('#fbResponseForm'\)\?\.dataset\.unsaved;/],
    ['Entwurf', /\/responses`, 'PUT'[^\n]*\n\s*delete form\.dataset\.unsaved;/]
  ]) assert.match(js, pattern, step);
  assert.match(js, /const noteChange = group => \{[^}]*form\.dataset\.unsaved = '1';/);
  assert.equal((js.match(/noteChange\(/g) || []).length, 4, 'Note, Leertaste, „nicht beurteilbar“ und Text');
});
