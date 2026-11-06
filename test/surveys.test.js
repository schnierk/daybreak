'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { after, before, test } = require('node:test');
const vm = require('node:vm');
const express = require('express');
const { createModuleHarness } = require('../lib/testing/module-harness');
const { createPersonnelModule } = require('../routes/personnel');
const { createSurveysModule } = require('../routes/surveys');

let h;
let nextUserId = 100;

before(async () => {
  h = await createModuleHarness(createSurveysModule);
});
after(() => h.close());

function shiftDays(days) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** Legt eine zusätzliche Person direkt an, damit sich größere Gruppen prüfen lassen. */
function addPerson(harness, { name = 'Zusatzperson', role = 'employee', manager = null } = {}) {
  nextUserId += 1;
  harness.db.prepare("INSERT INTO users(id, name, email, password_hash, role, manager_id) VALUES(?, ?, ?, '!TEST!', ?, ?)")
    .run(nextUserId, `${name} ${nextUserId}`, `person${nextUserId}@test.local`, role, manager);
  return nextUserId;
}

const addTeam = (harness, manager, size) => Array.from({ length: size }, () => addPerson(harness, { manager }));

/** Nimmt Anna, Ben und Clara aus der Zielgruppe, damit nur die im Test angelegten Bereiche zählen. */
const removeExampleEmployees = harness => harness.db.prepare('UPDATE users SET active=0 WHERE id IN (5, 6, 7)').run();

async function createDraft(harness, overrides = {}, questions = [{ text: 'Skala', type: 'scale' }]) {
  const created = await harness.api('hr', 'POST', '/api/surveys', { title: 'Testbefragung', useTemplates: false, anonymityThreshold: 3, ...overrides });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  const questionIds = [];
  for (const question of questions) {
    const added = await harness.api('hr', 'POST', `/api/surveys/${created.data.id}/questions`, question);
    assert.equal(added.status, 200, JSON.stringify(added.data));
    questionIds.push(added.data.id);
  }
  return { id: created.data.id, questionIds };
}

async function openDraft(harness, id) {
  const opened = await harness.api('hr', 'POST', `/api/surveys/${id}/open`, {});
  assert.equal(opened.status, 200, JSON.stringify(opened.data));
}

async function createOpen(harness, overrides, questions) {
  const survey = await createDraft(harness, overrides, questions);
  await openDraft(harness, survey.id);
  return survey;
}

const submit = (harness, person, id, answers) => harness.api(person, 'POST', `/api/surveys/${id}/responses`, { answers });

async function submitOk(harness, person, id, answers) {
  const response = await submit(harness, person, id, answers);
  assert.equal(response.status, 200, JSON.stringify(response.data));
}

const close = async (harness, id) => assert.equal((await harness.api('hr', 'POST', `/api/surveys/${id}/close`, {})).status, 200);

/** Eigene kleine Organisation mit getrennten Bereichen, weil die Beispielorganisation dafür zu klein ist. */
async function freshHarness(options) {
  return createModuleHarness(createSurveysModule, options);
}

const withHarness = (options, run) => async () => {
  const harness = await freshHarness(options);
  try {
    await run(harness);
  } finally {
    await harness.close();
  }
};

test('Ohne Anmeldung gibt es nichts (401)', async () => {
  const calls = [
    ['GET', '/api/surveys'],
    ['GET', '/api/surveys/open'],
    ['GET', '/api/surveys/templates'],
    ['POST', '/api/surveys', {}],
    ['GET', '/api/surveys/1'],
    ['PATCH', '/api/surveys/1', {}],
    ['DELETE', '/api/surveys/1'],
    ['POST', '/api/surveys/1/open', {}],
    ['POST', '/api/surveys/1/close', {}],
    ['POST', '/api/surveys/1/questions', {}],
    ['GET', '/api/surveys/1/form'],
    ['POST', '/api/surveys/1/responses', {}],
    ['GET', '/api/surveys/1/results']
  ];
  for (const [method, url, body] of calls) {
    assert.equal((await h.api(null, method, url, body)).status, 401, `${method} ${url}`);
  }
});

test('Tabelle der Antworten: keine Spalte mit Personen- oder Zeitbezug, kein Fremdschlüssel auf Personen', () => {
  const columns = h.db.prepare('PRAGMA table_info(surveys_answers)').all().map(column => column.name);
  assert.deepEqual(columns.sort(), ['group_key', 'line_path', 'question_id', 'response_id', 'survey_id', 'text_value', 'value']);
  for (const column of columns) {
    assert.doesNotMatch(column, /user|person|employee|actor|manager|name|mail|time|date|created|updated|submitted|_at$/i, column);
  }
  const foreignTables = h.db.prepare('PRAGMA foreign_key_list(surveys_answers)').all().map(key => key.table);
  assert.ok(!foreignTables.includes('users'));
  assert.ok(foreignTables.includes('surveys_surveys'));
  assert.ok(foreignTables.includes('surveys_questions'));
});

test('Tabelle der Teilnahme: nur Befragung, Person und abgegeben, ohne Zeitpunkt', () => {
  const columns = h.db.prepare('PRAGMA table_info(surveys_participation)').all().map(column => column.name);
  assert.deepEqual(columns.sort(), ['submitted', 'survey_id', 'user_id']);
});

test('Antworten und Teilnahme sind WITHOUT ROWID, ohne zeitlich ablesbare Reihenfolge', withHarness({}, async harness => {
  // PostgreSQL kennt keine ROWID. Was dort gilt, steht in docs/POSTGRESQL.md.
  if (harness.db.dialect !== 'postgres') {
    for (const table of ['surveys_answers', 'surveys_participation']) {
      const { sql } = harness.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table);
      assert.match(sql, /WITHOUT ROWID/i, table);
      assert.throws(() => harness.db.prepare(`SELECT rowid FROM ${table}`).all(), /no such column/i, table);
    }
  }
  const primaryKey = harness.db.prepare('PRAGMA table_info(surveys_answers)').all().filter(column => column.pk > 0).map(column => column.name);
  assert.ok(primaryKey.includes('response_id'));

  const { id, questionIds: [questionId] } = await createOpen(harness);
  for (const person of ['anna', 'ben', 'clara', 'manager', 'director', 'hr', 'bp']) {
    await submitOk(harness, person, id, [{ questionId, value: 4 }]);
  }
  const stored = harness.db.prepare('SELECT response_id FROM surveys_answers WHERE survey_id=?').all(id).map(row => row.response_id);
  assert.equal(new Set(stored).size, 7);
  for (const responseId of stored) {
    assert.match(responseId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, 'Zufällig (Version 4), keine Zeit im Wert');
  }
  assert.deepEqual(stored, [...stored].sort(), 'Gespeichert in der Reihenfolge des Zufallswerts');
  if (harness.db.dialect === 'postgres') {
    const stamps = table => harness.db.prepare(`SELECT DISTINCT xmin::text AS stamp FROM ${table} WHERE survey_id=?`).all(id).map(row => row.stamp);
    assert.equal(stamps('surveys_answers').length, 1, 'Antworten lassen sich nicht einzelnen Abgaben zuordnen');
    assert.equal(stamps('surveys_participation').length, 1, 'Die Teilnahme lässt sich keiner einzelnen Abgabe zuordnen');
    const taskStamps = harness.db.prepare("SELECT DISTINCT xmin::text AS stamp FROM tasks WHERE type='surveys_participate' AND entity_id=?").all(id);
    assert.equal(taskStamps.length, 1, 'Auch die Aufgaben verraten keine Reihenfolge');
    const participants = harness.db.prepare('SELECT user_id FROM surveys_participation WHERE survey_id=?').all(id).map(row => row.user_id);
    assert.deepEqual(participants, [...participants].sort((a, b) => a - b), 'Die Teilnahme verrät keine Reihenfolge');
  }
}));

test('Hauptablauf: anlegen, Fragen pflegen, öffnen, abgeben, schließen', withHarness({}, async harness => {
  const created = await harness.api('hr', 'POST', '/api/surveys', { title: 'Hauptablauf', intro: 'Willkommen', useTemplates: false, anonymityThreshold: 3 });
  assert.equal(created.status, 200);
  assert.equal(created.data.survey.status, 'draft');
  const id = created.data.id;
  assert.equal((await harness.api('hr', 'POST', `/api/surveys/${id}/open`, {})).status, 400, 'Ohne Fragen lässt sie sich nicht öffnen');

  const scale = await harness.api('hr', 'POST', `/api/surveys/${id}/questions`, { text: 'Skala', type: 'scale', topic: 'Führung' });
  const recommend = await harness.api('bp', 'POST', `/api/surveys/${id}/questions`, { text: 'Empfehlung', type: 'nps' });
  const freeText = await harness.api('hr', 'POST', `/api/surveys/${id}/questions`, { text: 'Was noch?', type: 'text' });
  assert.equal(scale.data.question.topic, 'Führung');
  assert.equal(scale.data.question.min, 1);
  assert.equal(recommend.data.question.max, 10);

  assert.equal((await harness.api('anna', 'GET', '/api/surveys/open')).data.items.length, 0, 'Ein Entwurf ist nicht sichtbar');
  await openDraft(harness, id);
  assert.equal((await harness.api('hr', 'POST', `/api/surveys/${id}/open`, {})).status, 409);

  const invited = await harness.api('anna', 'GET', '/api/surveys/open');
  assert.deepEqual(invited.data.items.map(item => [item.id, item.submitted]), [[id, false]]);
  const form = await harness.api('anna', 'GET', `/api/surveys/${id}/form`);
  assert.equal(form.status, 200);
  assert.deepEqual(form.data.questions.map(question => question.type), ['scale', 'nps', 'text']);
  assert.equal(form.data.survey.anonymityThreshold, 3);

  const task = () => harness.db.prepare("SELECT * FROM tasks WHERE type='surveys_participate' AND entity_id=? AND user_id=5").get(id);
  assert.equal(task().done, 0);
  const answer = await submit(harness, 'anna', id, [
    { questionId: scale.data.id, value: 4 },
    { questionId: recommend.data.id, value: 10 },
    { questionId: freeText.data.id, text: 'Mehr Austausch' }
  ]);
  assert.equal(answer.status, 200);
  assert.deepEqual(answer.data, { ok: true }, 'Die Zufallsnummer der Abgabe verlässt den Server nicht');
  assert.equal(task().done, 1);
  assert.equal(harness.db.prepare("SELECT done FROM tasks WHERE type='surveys_participate' AND entity_id=? AND user_id=6").get(id).done, 0, 'Nur die eigene Aufgabe ist erledigt');
  assert.equal(harness.db.prepare('SELECT submitted FROM surveys_participation WHERE survey_id=? AND user_id=5').get(id).submitted, 1);

  const afterSubmit = await harness.api('anna', 'GET', `/api/surveys/${id}/form`);
  assert.equal(afterSubmit.data.submitted, true);
  assert.deepEqual(afterSubmit.data.questions, []);
  assert.equal((await harness.api('anna', 'GET', '/api/surveys/open')).data.items[0].submitted, true);

  await close(harness, id);
  assert.equal(harness.db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE type='surveys_participate' AND entity_id=? AND done=0").get(id).count, 0, 'Schließen erledigt alle Restaufgaben');
  assert.equal((await harness.api('anna', 'GET', '/api/surveys/open')).data.items.length, 0);
  assert.equal((await harness.api('ben', 'GET', `/api/surveys/${id}/form`)).status, 409);
  assert.equal((await harness.api('hr', 'POST', `/api/surveys/${id}/close`, {})).status, 409);
}));

test('Nur HR verwaltet Befragungen', withHarness({}, async harness => {
  const { id, questionIds: [questionId] } = await createDraft(harness);
  const calls = [
    ['POST', '/api/surveys', { title: 'Nein' }],
    ['GET', `/api/surveys/${id}`],
    ['GET', '/api/surveys/templates'],
    ['PATCH', `/api/surveys/${id}`, { title: 'Nein' }],
    ['DELETE', `/api/surveys/${id}`],
    ['POST', `/api/surveys/${id}/questions`, { text: 'Nein', type: 'scale' }],
    ['PATCH', `/api/surveys/${id}/questions/${questionId}`, { text: 'Nein' }],
    ['DELETE', `/api/surveys/${id}/questions/${questionId}`],
    ['POST', `/api/surveys/${id}/open`, {}],
    ['POST', `/api/surveys/${id}/close`, {}]
  ];
  for (const person of ['anna', 'manager', 'director']) {
    for (const [method, url, body] of calls) {
      assert.equal((await harness.api(person, method, url, body)).status, 403, `${person}: ${method} ${url}`);
    }
  }
  assert.equal((await harness.api('anna', 'GET', '/api/surveys')).status, 403);
  const forManager = await harness.api('manager', 'GET', '/api/surveys');
  assert.ok(!forManager.data.items.some(item => item.id === id), 'Führungskräfte sehen keine Entwürfe');
}));

test('Ungültige Eingaben beim Verwalten werden abgelehnt', withHarness({}, async harness => {
  const invalid = [
    {},
    { title: '   ' },
    { title: 'Datum', startsAt: '2026-02-30' },
    { title: 'Datum', endsAt: ['2030-01-01'] },
    { title: 'Reihenfolge', startsAt: '2030-02-02', endsAt: '2030-02-01' },
    { title: 'Zielgruppe', audience: 'manche' },
    { title: 'Rollen', audience: 'roles' },
    { title: 'Rollen', audience: 'roles', audienceRoles: ['super_admin'] },
    { title: 'Rollen', audience: 'roles', audienceRoles: 'employee' }
  ];
  for (const body of invalid) {
    assert.equal((await harness.api('hr', 'POST', '/api/surveys', body)).status, 400, JSON.stringify(body));
  }
  const { id, questionIds: [questionId] } = await createDraft(harness);
  for (const body of [{}, { text: 'Art fehlt' }, { text: '', type: 'scale' }, { text: 'Unbekannt', type: 'multiple' }]) {
    assert.equal((await harness.api('hr', 'POST', `/api/surveys/${id}/questions`, body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await harness.api('hr', 'GET', '/api/surveys/999999')).status, 404);
  assert.equal((await harness.api('hr', 'GET', '/api/surveys/abc')).status, 404);
  assert.equal((await harness.api('hr', 'POST', '/api/surveys/999999/open', {})).status, 404);
  assert.equal((await harness.api('hr', 'PATCH', `/api/surveys/${id}/questions/999999`, { text: 'x' })).status, 404);

  const other = await createDraft(harness);
  const foreignQuestion = await harness.api('hr', 'DELETE', `/api/surveys/${other.id}/questions/${questionId}`);
  assert.equal(foreignQuestion.status, 404, 'Eine Frage gehört nur zu ihrer Befragung');
}));

test('Neutrale Standardfragen stehen als Vorlage bereit und werden nicht doppelt angelegt', withHarness({}, async harness => {
  harness.instance.initialize();
  harness.instance.initialize();
  const templates = await harness.api('hr', 'GET', '/api/surveys/templates');
  assert.equal(templates.status, 200);
  assert.ok(templates.data.templates.length >= 5);
  assert.equal(new Set(templates.data.templates.map(template => template.text)).size, templates.data.templates.length);
  const types = templates.data.templates.map(template => template.type);
  for (const type of ['scale', 'nps', 'text']) assert.ok(types.includes(type), type);

  const withTemplates = await harness.api('hr', 'POST', '/api/surveys', { title: 'Mit Vorlage' });
  assert.equal(withTemplates.data.questions.length, templates.data.templates.length);
  const withoutTemplates = await harness.api('hr', 'POST', '/api/surveys', { title: 'Ohne Vorlage', useTemplates: false });
  assert.equal(withoutTemplates.data.questions.length, 0);
}));

test('Fragen sind nur im Entwurf änderbar, Entwürfe lassen sich löschen', withHarness({}, async harness => {
  const { id, questionIds: [questionId, removable] } = await createDraft(harness, {}, [{ text: 'Eins', type: 'scale' }, { text: 'Zwei', type: 'text' }]);
  const changed = await harness.api('hr', 'PATCH', `/api/surveys/${id}/questions/${questionId}`, { text: 'Eins neu', topic: 'Thema' });
  assert.equal(changed.data.question.text, 'Eins neu');
  assert.equal(changed.data.question.type, 'scale');
  assert.equal((await harness.api('hr', 'DELETE', `/api/surveys/${id}/questions/${removable}`)).status, 200);

  await openDraft(harness, id);
  assert.equal((await harness.api('hr', 'POST', `/api/surveys/${id}/questions`, { text: 'Neu', type: 'scale' })).status, 409);
  assert.equal((await harness.api('hr', 'PATCH', `/api/surveys/${id}/questions/${questionId}`, { text: 'Später' })).status, 409);
  assert.equal((await harness.api('hr', 'DELETE', `/api/surveys/${id}/questions/${questionId}`)).status, 409);
  assert.equal((await harness.api('hr', 'DELETE', `/api/surveys/${id}`)).status, 409);
  assert.equal((await harness.api('hr', 'PATCH', `/api/surveys/${id}`, { title: 'Später' })).status, 409);

  const draft = await createDraft(harness);
  assert.equal((await harness.api('hr', 'DELETE', `/api/surveys/${draft.id}`)).status, 200);
  assert.equal((await harness.api('hr', 'GET', `/api/surveys/${draft.id}`)).status, 404);
}));

test('Schwelle: Voreinstellung 5, Minimum 3 erzwungen, nach dem Öffnen nicht senkbar', withHarness({}, async harness => {
  const standard = await harness.api('hr', 'POST', '/api/surveys', { title: 'Standard', useTemplates: false });
  assert.equal(standard.data.survey.anonymityThreshold, 5);

  for (const value of [2, 0, -1, 1, 2.5, 'zwei', '', null, true, [5]]) {
    const response = await harness.api('hr', 'POST', '/api/surveys', { title: 'Zu niedrig', anonymityThreshold: value });
    assert.equal(response.status, 400, JSON.stringify(value));
  }
  assert.throws(() => harness.db.prepare('UPDATE surveys_surveys SET anonymity_threshold=2').run(), /CHECK/i, 'Auch die Datenbank lehnt es ab');

  const { id } = await createDraft(harness, { anonymityThreshold: 4 });
  const atMinimum = await harness.api('hr', 'PATCH', `/api/surveys/${id}`, { anonymityThreshold: 3 });
  assert.equal(atMinimum.data.survey.anonymityThreshold, 3, 'Im Entwurf geht das bis zum Minimum');
  assert.equal((await harness.api('hr', 'PATCH', `/api/surveys/${id}`, { anonymityThreshold: 2 })).status, 400);

  await harness.api('hr', 'PATCH', `/api/surveys/${id}`, { anonymityThreshold: 5 });
  await openDraft(harness, id);
  const lower = await harness.api('hr', 'PATCH', `/api/surveys/${id}`, { anonymityThreshold: 4 });
  assert.equal(lower.status, 400);
  assert.equal(harness.db.prepare('SELECT anonymity_threshold FROM surveys_surveys WHERE id=?').get(id).anonymity_threshold, 5);
  assert.equal((await harness.api('hr', 'PATCH', `/api/surveys/${id}`, { anonymityThreshold: 2 })).status, 400);

  const higher = await harness.api('hr', 'PATCH', `/api/surveys/${id}`, { anonymityThreshold: 6 });
  assert.equal(higher.data.survey.anonymityThreshold, 6, 'Erhöhen bleibt möglich');
  assert.equal(higher.data.survey.invitedCount, 7);
  assert.equal((await harness.api('hr', 'PATCH', `/api/surveys/${id}`, { title: 'Neu' })).status, 409);

  await close(harness, id);
  assert.equal((await harness.api('hr', 'PATCH', `/api/surveys/${id}`, { anonymityThreshold: 9 })).status, 409);
}));

test('Öffnen: Teilnehmende festgeschrieben, Zielgruppe nie kleiner als die Schwelle', withHarness({}, async harness => {
  const tooSmall = await createDraft(harness, { anonymityThreshold: 5, audience: 'roles', audienceRoles: ['employee'] });
  const refused = await harness.api('hr', 'POST', `/api/surveys/${tooSmall.id}/open`, {});
  assert.equal(refused.status, 400, 'Drei Beschäftigte reichen für eine Schwelle von fünf nicht');
  assert.equal(harness.db.prepare('SELECT status FROM surveys_surveys WHERE id=?').get(tooSmall.id).status, 'draft');

  const future = await createDraft(harness, { startsAt: shiftDays(3) });
  assert.equal((await harness.api('hr', 'POST', `/api/surveys/${future.id}/open`, {})).status, 400);
  const past = await createDraft(harness, { endsAt: shiftDays(-3) });
  assert.equal((await harness.api('hr', 'POST', `/api/surveys/${past.id}/open`, {})).status, 400);

  const { id, questionIds: [questionId] } = await createOpen(harness, { audience: 'roles', audienceRoles: ['employee'] });
  const participants = () => harness.db.prepare('SELECT user_id FROM surveys_participation WHERE survey_id=? ORDER BY user_id').all(id).map(row => row.user_id);
  assert.deepEqual(participants(), [5, 6, 7]);
  const tasks = harness.db.prepare("SELECT user_id, entity_id FROM tasks WHERE type='surveys_participate' AND entity_id=? ORDER BY user_id").all(id);
  assert.deepEqual(tasks.map(task => task.user_id), [5, 6, 7]);

  const newcomer = addPerson(harness);
  assert.deepEqual(participants(), [5, 6, 7], 'Wer später dazukommt, ist nicht eingeladen');
  assert.equal((await submit(harness, newcomer, id, [{ questionId, value: 3 }])).status, 404);

  const audit = harness.db.prepare("SELECT * FROM audit_log WHERE action='survey_opened' AND entity_id=?").get(id);
  assert.deepEqual(JSON.parse(audit.new_values), { status: 'open', invitedCount: 3 }, 'Das Protokoll nennt nur die Zahl');
  assert.equal(audit.actor_id, 1);

  const locked = await createDraft(harness);
  harness.db.prepare('UPDATE users SET active=0 WHERE id=7').run();
  harness.db.prepare('UPDATE users SET is_system_account=1 WHERE id=6').run();
  await openDraft(harness, locked.id);
  const invited = harness.db.prepare('SELECT user_id FROM surveys_participation WHERE survey_id=?').all(locked.id).map(row => row.user_id);
  assert.ok(!invited.includes(7) && !invited.includes(6), 'Gesperrte Konten und Systemkonten sind nicht dabei');
}));

test('Abgabe: nicht Eingeladene und Entwürfe wie unbekannt, zweite Abgabe 409', withHarness({}, async harness => {
  const draft = await createDraft(harness);
  const onDraft = await submit(harness, 'anna', draft.id, [{ questionId: draft.questionIds[0], value: 3 }]);
  assert.equal(onDraft.status, 404);
  assert.equal((await harness.api('anna', 'GET', `/api/surveys/${draft.id}/form`)).status, 404);
  assert.equal(harness.db.prepare('SELECT COUNT(*) AS count FROM surveys_answers WHERE survey_id=?').get(draft.id).count, 0);

  const { id, questionIds: [questionId] } = await createOpen(harness, { audience: 'roles', audienceRoles: ['employee'] });
  for (const person of ['manager', 'hr', 'director']) {
    assert.equal((await submit(harness, person, id, [{ questionId, value: 3 }])).status, 404, person);
    assert.equal((await harness.api(person, 'GET', `/api/surveys/${id}/form`)).status, 404, person);
  }
  await submitOk(harness, 'anna', id, [{ questionId, value: 3 }]);
  const second = await submit(harness, 'anna', id, [{ questionId, value: 5 }]);
  assert.equal(second.status, 409);
  const stored = harness.db.prepare('SELECT value FROM surveys_answers WHERE survey_id=?').all(id);
  assert.deepEqual(stored, [{ value: 3 }], 'Die erste Abgabe bleibt unverändert, es entsteht keine zweite');

  assert.equal((await submit(harness, 'anna', 999999, [])).status, 404);
  await close(harness, id);
  assert.equal((await submit(harness, 'ben', id, [{ questionId, value: 3 }])).status, 409, 'Geschlossen');
}));

test('Abgabe: Antworten werden vollständig geprüft', withHarness({}, async harness => {
  const { id, questionIds: [scale, recommend, freeText] } = await createOpen(harness, {}, [
    { text: 'Skala', type: 'scale' },
    { text: 'Empfehlung', type: 'nps' },
    { text: 'Freitext', type: 'text' }
  ]);
  const other = await createOpen(harness, {}, [{ text: 'Andere', type: 'scale' }]);
  const valid = [{ questionId: scale, value: 3 }, { questionId: recommend, value: 7 }];
  const invalid = [
    undefined,
    'alles gut',
    [],
    [{ questionId: scale, value: 3 }],
    [{ questionId: scale, value: 0 }, valid[1]],
    [{ questionId: scale, value: 6 }, valid[1]],
    [{ questionId: scale, value: 2.5 }, valid[1]],
    [{ questionId: scale, value: '' }, valid[1]],
    [{ questionId: scale, value: [3] }, valid[1]],
    [valid[0], { questionId: recommend, value: 11 }],
    [valid[0], { questionId: recommend, value: -1 }],
    [valid[0], { questionId: recommend }],
    [...valid, valid[0]],
    [...valid, { questionId: other.questionIds[0], value: 3 }],
    [...valid, { questionId: 999999, value: 3 }],
    [null, ...valid],
    [...valid, 7]
  ];
  for (const answers of invalid) {
    const response = await submit(harness, 'anna', id, answers);
    assert.equal(response.status, 400, JSON.stringify(answers));
  }
  assert.equal(harness.db.prepare('SELECT submitted FROM surveys_participation WHERE survey_id=? AND user_id=5').get(id).submitted, 0, 'Nach ungültigen Versuchen ist noch nichts abgegeben');
  assert.equal(harness.db.prepare('SELECT COUNT(*) AS count FROM surveys_answers WHERE survey_id=?').get(id).count, 0);

  await submitOk(harness, 'anna', id, [{ questionId: recommend, value: '0' }, { questionId: scale, value: 1 }, { questionId: freeText, text: '   ' }]);
  const rows = harness.db.prepare('SELECT question_id, value, text_value FROM surveys_answers WHERE survey_id=?').all(id);
  assert.equal(rows.length, 2, 'Ein leerer Freitext wird nicht gespeichert');
  assert.equal(rows.find(row => row.question_id === recommend).value, 0, 'Null ist ein gültiger Wert');

  await submitOk(harness, 'ben', id, [...valid, { questionId: freeText, text: `<b>Fett</b> ${'x'.repeat(3000)}` }]);
  const text = harness.db.prepare('SELECT text_value FROM surveys_answers WHERE survey_id=? AND text_value IS NOT NULL').get(id).text_value;
  assert.ok(text.length <= 2000);
  assert.doesNotMatch(text, /[<>]/);

  const textOnly = await createOpen(harness, {}, [{ text: 'Nur Freitext', type: 'text' }]);
  assert.equal((await submit(harness, 'anna', textOnly.id, [{ questionId: textOnly.questionIds[0], text: '' }])).status, 400, 'Eine leere Abgabe zählt nicht als Teilnahme');
  assert.equal((await submit(harness, 'anna', textOnly.id, [])).status, 400);
}));

test('Teilnahme und Antworten stehen in einer Transaktion: scheitert das Schreiben, bleibt nichts zurück', withHarness({}, async harness => {
  const { id, questionIds: [questionId] } = await createOpen(harness);
  const isPostgres = harness.db.dialect === 'postgres';
  if (isPostgres) {
    harness.db.execRaw(`
      CREATE FUNCTION block_answers() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'Schreibfehler'; END; $$ LANGUAGE plpgsql;
      CREATE TRIGGER block_answers BEFORE INSERT ON surveys_answers FOR EACH ROW EXECUTE FUNCTION block_answers();
    `);
  } else {
    harness.db.exec(`
      CREATE TRIGGER block_answers BEFORE INSERT ON surveys_answers
      BEGIN SELECT RAISE(ABORT, 'Schreibfehler'); END
    `);
  }
  const failed = await submit(harness, 'anna', id, [{ questionId, value: 3 }]);
  assert.equal(failed.status, 500);
  assert.equal(harness.db.prepare('SELECT submitted FROM surveys_participation WHERE survey_id=? AND user_id=5').get(id).submitted, 0);
  assert.equal(harness.db.prepare("SELECT done FROM tasks WHERE type='surveys_participate' AND entity_id=? AND user_id=5").get(id).done, 0);
  if (isPostgres) harness.db.execRaw('DROP TRIGGER block_answers ON surveys_answers');
  else harness.db.exec('DROP TRIGGER block_answers');
  await submitOk(harness, 'anna', id, [{ questionId, value: 3 }]);
}));

test('Kein Protokolleintrag und keine Aufgabe je Antwort verknüpft Person, Inhalt oder Zeitpunkt', withHarness({}, async harness => {
  const { id, questionIds: [scale, freeText] } = await createOpen(harness, {}, [{ text: 'Skala', type: 'scale' }, { text: 'Text', type: 'text' }]);
  const auditBefore = harness.db.prepare('SELECT COUNT(*) AS count FROM audit_log').get().count;
  const tasksBefore = harness.db.prepare('SELECT COUNT(*) AS count FROM tasks').get().count;

  for (const person of ['anna', 'ben', 'clara', 'hr']) {
    await submitOk(harness, person, id, [{ questionId: scale, value: 2 }, { questionId: freeText, text: 'GEHEIMER-INHALT' }]);
  }
  await harness.api('anna', 'GET', `/api/surveys/${id}/form`);
  await harness.api('hr', 'GET', `/api/surveys/${id}/results`);

  assert.equal(harness.db.prepare('SELECT COUNT(*) AS count FROM audit_log').get().count, auditBefore, 'Die Abgabe erzeugt keinen Eintrag');
  assert.equal(harness.db.prepare('SELECT COUNT(*) AS count FROM tasks').get().count, tasksBefore, 'Die Abgabe erzeugt keine Aufgabe');
  const allAudit = JSON.stringify(harness.db.prepare('SELECT * FROM audit_log').all());
  assert.doesNotMatch(allAudit, /GEHEIMER-INHALT|response_id|surveys_answers|surveys_participation/);
  const actors = harness.db.prepare("SELECT DISTINCT actor_id FROM audit_log WHERE action LIKE 'survey%'").all().map(row => row.actor_id);
  assert.deepEqual(actors, [1], 'Nur HR-Handlungen stehen im Protokoll');

  const entities = harness.db.prepare("SELECT DISTINCT entity_id FROM tasks WHERE type='surveys_participate'").all().map(row => row.entity_id);
  assert.deepEqual(entities, [id], 'Aufgaben verweisen auf die Befragung, nicht auf eine Antwort');
  const taskColumns = harness.db.prepare('PRAGMA table_info(tasks)').all().map(column => column.name);
  assert.ok(!taskColumns.some(column => /done_at|completed_at|updated_at/.test(column)), 'Aufgaben haben keinen Zeitstempel fürs Erledigen');
}));

test('Vergleichsgruppe: oberste Führungskraft, nie die Person selbst', withHarness({ isModuleEnabled: () => false }, async harness => {
  const { id, questionIds: [questionId] } = await createOpen(harness);
  for (const person of ['anna', 'clara', 'manager', 'hr']) {
    await submitOk(harness, person, id, [{ questionId, value: 4 }]);
  }
  const keys = harness.db.prepare('SELECT group_key FROM surveys_answers WHERE survey_id=?').all(id).map(row => row.group_key).sort();
  assert.deepEqual(keys, ['lead:3', 'lead:3', 'lead:3', 'no-lead'], 'Wer keine Führungskraft hat, kommt in eine neutrale Gruppe');
  for (const key of keys) {
    for (const personId of [1, 5, 7, 4]) assert.notEqual(key, String(personId));
  }
}));

test('Vergleichsgruppe: Organisationseinheit aus der Personalakte, wenn das Modul an ist', withHarness({}, async harness => {
  const personnel = createPersonnelModule(harness.deps);
  personnel.initialize();
  const now = new Date().toISOString();
  const addUnit = name => Number(harness.db.prepare("INSERT INTO personnel_org_units(type, name, created_at) VALUES('department', ?, ?)").run(name, now).lastInsertRowid);
  const assignUnit = (userId, unitId) => harness.db.prepare('INSERT INTO personnel_records(user_id, org_unit_id, created_at, updated_at) VALUES(?, ?, ?, ?)').run(userId, unitId, now, now);
  const sales = addUnit('Vertrieb');
  const service = addUnit('Service');
  [4, 5, 6, 7].forEach(userId => assignUnit(userId, sales));
  [1, 2, 3].forEach(userId => assignUnit(userId, service));

  const { id, questionIds: [questionId] } = await createOpen(harness);
  await submitOk(harness, 'anna', id, [{ questionId, value: 4 }]);
  await submitOk(harness, 'hr', id, [{ questionId, value: 4 }]);
  const keys = harness.db.prepare('SELECT DISTINCT group_key FROM surveys_answers WHERE survey_id=?').all(id).map(row => row.group_key).sort();
  assert.deepEqual(keys, [`unit:${sales}`, `unit:${service}`].sort());

  await close(harness, id);
  for (const person of ['manager', 'ben', 'clara']) {
    const closedSurvey = await createOpen(harness);
    await submitOk(harness, person, closedSurvey.id, [{ questionId: closedSurvey.questionIds[0], value: 4 }]);
    assert.equal(harness.db.prepare('SELECT group_key FROM surveys_answers WHERE survey_id=?').get(closedSurvey.id).group_key, `unit:${sales}`, person);
  }
}));

test('Vergleichsgruppe: Eine Einheit mit nur einer Person verrät sie nicht und fällt in die Sammelgruppe', withHarness({}, async harness => {
  createPersonnelModule(harness.deps).initialize();
  const now = new Date().toISOString();
  const addUnit = name => Number(harness.db.prepare("INSERT INTO personnel_org_units(type, name, created_at) VALUES('department', ?, ?)").run(name, now).lastInsertRowid);
  const assignUnit = (userId, unitId) => harness.db.prepare('INSERT INTO personnel_records(user_id, org_unit_id, created_at, updated_at) VALUES(?, ?, ?, ?)').run(userId, unitId, now, now);
  const large = addUnit('Grosse Einheit');
  const tiny = addUnit('Kleine Einheit');
  const service = addUnit('Service');
  [4, 5, 6].forEach(userId => assignUnit(userId, large));
  [1, 2, 3].forEach(userId => assignUnit(userId, service));
  assignUnit(7, tiny);

  const { id, questionIds: [questionId] } = await createOpen(harness);
  await submitOk(harness, 'clara', id, [{ questionId, value: 1 }]);
  await submitOk(harness, 'anna', id, [{ questionId, value: 4 }]);
  await submitOk(harness, 'hr', id, [{ questionId, value: 4 }]);
  const stored = harness.db.prepare('SELECT value, group_key FROM surveys_answers WHERE survey_id=?').all(id);
  const keyOf = value => stored.filter(row => row.value === value).map(row => row.group_key);
  assert.deepEqual(keyOf(1), ['rest'], 'Clara ist allein in ihrer Einheit');
  assert.ok(!stored.some(row => row.group_key === `unit:${tiny}`));
  const merged = [`unit:${large}`, `unit:${service}`].filter(key => !stored.some(row => row.group_key === key));
  assert.equal(merged.length, 1, 'Eine Sammelgruppe aus einer Person verriete sie ebenso: die kleinste weitere Einheit geht mit darin auf');
}));

test('Vergleichsgruppe: Personalakte wird ignoriert, wenn das Modul aus ist oder die Tabelle fehlt', async () => {
  const off = await freshHarness({ isModuleEnabled: key => key !== 'personnel' });
  try {
    createPersonnelModule(off.deps).initialize();
    const now = new Date().toISOString();
    const unit = Number(off.db.prepare("INSERT INTO personnel_org_units(type, name, created_at) VALUES('department', 'Einheit', ?)").run(now).lastInsertRowid);
    [5, 6, 7].forEach(userId => off.db.prepare('INSERT INTO personnel_records(user_id, org_unit_id, created_at, updated_at) VALUES(?, ?, ?, ?)').run(userId, unit, now, now));
    const { id, questionIds: [questionId] } = await createOpen(off);
    await submitOk(off, 'anna', id, [{ questionId, value: 4 }]);
    assert.equal(off.db.prepare('SELECT group_key FROM surveys_answers WHERE survey_id=?').get(id).group_key, 'lead:3');
  } finally {
    await off.close();
  }

  const missing = await freshHarness({ isModuleEnabled: () => true });
  try {
    const { id, questionIds: [questionId] } = await createOpen(missing);
    await submitOk(missing, 'anna', id, [{ questionId, value: 4 }]);
    assert.equal(missing.db.prepare('SELECT group_key FROM surveys_answers WHERE survey_id=?').get(id).group_key, 'lead:3');
  } finally {
    await missing.close();
  }
});

test('Datenbank: Gruppen und Linien unter der Schwelle werden gar nicht erst gespeichert', withHarness({}, async harness => {
  // Ein Bereich mit einer Person würde sie beim Lesen der Datenbank verraten.
  const loneLead = addPerson(harness, { role: 'director' });
  const [loner] = addTeam(harness, loneLead, 1);
  const smallTeamLead = addPerson(harness, { role: 'manager', manager: 3 });
  const smallTeam = addTeam(harness, smallTeamLead, 2);
  const { id, questionIds: [questionId] } = await createOpen(harness, { anonymityThreshold: 5 });

  await submitOk(harness, loner, id, [{ questionId, value: 1 }]);
  await submitOk(harness, smallTeam[0], id, [{ questionId, value: 2 }]);
  const stored = harness.db.prepare('SELECT value, group_key, line_path FROM surveys_answers WHERE survey_id=?').all(id);
  const lonerRow = stored.find(row => row.value === 1);
  assert.equal(lonerRow.group_key, 'rest', 'Der kleine Bereich geht in der Sammelgruppe auf');
  assert.equal(lonerRow.line_path, '/', 'Auch die Linie von nur zwei Personen wird nicht gespeichert');
  const teamRow = stored.find(row => row.value === 2);
  assert.equal(teamRow.group_key, 'lead:3');
  assert.equal(teamRow.line_path, '/3/', 'Das kleine Team unter smallTeamLead bleibt verborgen, nur die große Linie zählt');
  assert.ok(!stored.some(row => row.line_path.includes(`/${smallTeamLead}/`)));
  assert.ok(!stored.some(row => row.line_path.includes(`/${loner}/`) || row.line_path.includes(`/${smallTeam[0]}/`)), 'Die eigene ID steht nie allein für eine Person');
}));

test('Unter der Schwelle: keine Zahl und keine Freitexte, auch nicht für HR', withHarness({}, async harness => {
  const { id, questionIds: [scale, freeText] } = await createOpen(harness, { anonymityThreshold: 3 }, [{ text: 'Skala', type: 'scale' }, { text: 'Text', type: 'text' }]);
  const answer = text => [{ questionId: scale, value: 5 }, { questionId: freeText, text }];
  await submitOk(harness, 'anna', id, answer('GEHEIM-EINS'));
  await submitOk(harness, 'ben', id, answer('GEHEIM-ZWEI'));

  for (const person of ['hr', 'bp', 'director', 'manager']) {
    const running = await harness.api(person, 'GET', `/api/surveys/${id}/results`);
    assert.equal(running.status, 200);
    assert.deepEqual(running.data.overall, { insufficient: true, message: 'Zu wenige Antworten' }, person);
    assert.doesNotMatch(JSON.stringify(running.data), /GEHEIM/);
  }
  await close(harness, id);
  const closed = await harness.api('hr', 'GET', `/api/surveys/${id}/results`);
  assert.deepEqual(closed.data.overall, { insufficient: true, message: 'Zu wenige Antworten' });
  assert.deepEqual(closed.data.groups, []);
  assert.doesNotMatch(JSON.stringify(closed.data), /GEHEIM|"answerCount"|"average"/);
}));

test('Ab der Schwelle: Werte und Freitexte in zufälliger Reihenfolge ohne Metadaten', withHarness({}, async harness => {
  const { id, questionIds: [scale, freeText] } = await createOpen(harness, { anonymityThreshold: 3 }, [{ text: 'Skala', type: 'scale', topic: 'Führung' }, { text: 'Text', type: 'text' }]);
  const people = ['anna', 'ben', 'clara', 'manager'];
  for (const [index, person] of people.entries()) {
    await submitOk(harness, person, id, [{ questionId: scale, value: index + 2 }, { questionId: freeText, text: `Beitrag ${person}` }]);
  }
  await close(harness, id);
  const seenOrders = new Set();
  for (let call = 0; call < 30; call += 1) {
    const { data } = await harness.api('hr', 'GET', `/api/surveys/${id}/results`);
    assert.equal(data.overall.answerCount, 4);
    const text = data.overall.questions.find(question => question.type === 'text');
    assert.ok(text.texts.every(item => typeof item === 'string'), 'Nur der Text, keine Metadaten');
    seenOrders.add(text.texts.join('|'));
    assert.doesNotMatch(JSON.stringify(data), /response_id|responseId|user_id|userId|[0-9a-f]{8}-[0-9a-f]{4}-4/);
  }
  assert.ok(seenOrders.size > 1, 'Die Reihenfolge wechselt');

  const { data } = await harness.api('hr', 'GET', `/api/surveys/${id}/results`);
  const summary = data.overall.questions.find(question => question.type === 'scale');
  assert.equal(summary.average, 3.5);
  assert.equal(summary.favorablePercent, 50);
  assert.equal(summary.neutralPercent, 25);
  assert.equal(summary.unfavorablePercent, 25);
  assert.equal(summary.topic, 'Führung');
  assert.deepEqual(data.overall.participation, { invited: 7, responded: 4, ratePercent: 57 });
}));

test('Für Einzelantworten gibt es keine Schnittstelle', withHarness({}, async harness => {
  const { id, questionIds: [questionId] } = await createOpen(harness);
  for (const person of ['anna', 'ben', 'clara']) await submitOk(harness, person, id, [{ questionId, value: 4 }]);
  for (const url of [`/api/surveys/${id}/responses`, `/api/surveys/${id}/answers`, `/api/surveys/${id}/participation`, `/api/surveys/${id}/participants`]) {
    assert.equal((await harness.api('hr', 'GET', url)).status, 404, url);
  }
  const details = await harness.api('hr', 'GET', `/api/surveys/${id}`);
  assert.doesNotMatch(JSON.stringify(details.data), /submitted|responded|answers/, 'Auch die Verwaltungssicht nennt keine Abgaben');
  const listed = await harness.api('hr', 'GET', '/api/surveys');
  assert.doesNotMatch(JSON.stringify(listed.data), /submitted|responded/);
}));

test('Die eigene Antwort zählt für die Schwelle nicht mit', withHarness({}, async harness => {
  const { id, questionIds: [questionId] } = await createOpen(harness, { anonymityThreshold: 3 });
  for (const person of ['hr', 'anna', 'ben']) await submitOk(harness, person, id, [{ questionId, value: 4 }]);
  await close(harness, id);
  assert.equal((await harness.api('hr', 'GET', `/api/surveys/${id}/results`)).data.overall.insufficient, true, 'hr könnte sonst aus drei Antworten zwei fremde errechnen');
  assert.equal((await harness.api('bp', 'GET', `/api/surveys/${id}/results`)).data.overall.answerCount, 3, 'Wer nicht teilgenommen hat, sieht die Werte ab der Schwelle');
}));

test('Differenzangriff: Aus Gesamtwert minus sichtbarer Gruppen lässt sich keine kleine Gruppe errechnen', withHarness({}, async harness => {
  removeExampleEmployees(harness);
  const leads = ['Nord', 'Ost', 'Sued'].map(name => addPerson(harness, { name, role: 'director' }));
  const [north, east, south] = leads.map(lead => addTeam(harness, lead, 5));
  const { id, questionIds: [scale, freeText] } = await createOpen(harness, { anonymityThreshold: 5, audience: 'roles', audienceRoles: ['employee'] }, [{ text: 'Skala', type: 'scale' }, { text: 'Text', type: 'text' }]);
  const answer = (value, text) => [{ questionId: scale, value }, { questionId: freeText, text }];

  for (const person of north) await submitOk(harness, person, id, answer(5, 'Nord-Text'));
  for (const person of east) await submitOk(harness, person, id, answer(4, 'Ost-Text'));
  await submitOk(harness, south[0], id, answer(1, 'EINZELNE-STIMME'));
  await close(harness, id);

  const { data } = await harness.api('hr', 'GET', `/api/surveys/${id}/results`);
  assert.equal(data.overall.answerCount, 11, 'Der Gesamtwert ist sichtbar');
  const shown = data.groups.filter(group => !group.insufficient);
  const hidden = data.groups.filter(group => group.insufficient);
  const named = shown.filter(group => !group.label.startsWith('Weitere'));
  const rest = shown.find(group => group.label.startsWith('Weitere'));

  assert.equal(named.length, 1, 'Eine von zwei großen Gruppen wird mit verdeckt');
  assert.equal(named[0].answerCount, 5);
  assert.equal(rest.answerCount, 6, 'Die kleine Gruppe steckt zusammengefasst in mindestens Schwelle Antworten');
  assert.equal(named[0].answerCount + rest.answerCount, data.overall.answerCount, 'Keine Antwort bleibt als Differenz übrig');
  assert.equal(hidden.length, 2);
  for (const group of hidden) {
    assert.deepEqual(Object.keys(group).sort(), ['insufficient', 'label', 'message']);
    assert.equal(group.message, 'Zu wenige Antworten');
  }
  assert.ok(data.groups.some(group => group.label.includes('Sued') && group.insufficient));
  // Auch der Freitext der einzelnen Person erscheint nur innerhalb der Sammelgruppe, nie unter ihrem Bereich.
  assert.ok(!named[0].questions.find(question => question.type === 'text').texts.includes('EINZELNE-STIMME'));
  assert.ok(rest.questions.find(question => question.type === 'text').texts.includes('EINZELNE-STIMME'));
}));

test('Differenzangriff: bleibt nur eine einzige Gruppe sichtbar, verschwindet auch sie', withHarness({}, async harness => {
  removeExampleEmployees(harness);
  const [big, small] = ['Gross', 'Klein'].map(name => addPerson(harness, { name, role: 'director' }));
  const bigTeam = addTeam(harness, big, 6);
  const smallTeam = addTeam(harness, small, 5);
  const { id, questionIds: [scale] } = await createOpen(harness, { anonymityThreshold: 5, audience: 'roles', audienceRoles: ['employee'] });
  for (const person of bigTeam) await submitOk(harness, person, id, [{ questionId: scale, value: 5 }]);
  await submitOk(harness, smallTeam[0], id, [{ questionId: scale, value: 1 }]);
  await close(harness, id);
  const { data } = await harness.api('hr', 'GET', `/api/surveys/${id}/results`);
  const shown = data.groups.filter(group => !group.insufficient);
  assert.equal(shown.length, 1);
  assert.ok(shown[0].label.startsWith('Weitere'));
  assert.equal(shown[0].answerCount, 7);
  const hidden = data.groups.filter(group => group.insufficient);
  assert.equal(hidden.length, 2, 'Beide Bereiche stehen nur noch als "zu wenige Antworten" da');
  assert.ok(hidden.every(group => group.answerCount === undefined && group.questions === undefined));
}));

test('Mit genug Antworten überall gibt es einen vollständigen Vergleich samt Teilnahmequote', withHarness({}, async harness => {
  removeExampleEmployees(harness);
  const [north, east] = ['Nord', 'Ost'].map(name => addPerson(harness, { name, role: 'director' }));
  const northTeam = addTeam(harness, north, 6);
  const eastTeam = addTeam(harness, east, 5);
  const { id, questionIds: [scale, freeText] } = await createOpen(harness, { anonymityThreshold: 5, audience: 'roles', audienceRoles: ['employee'] }, [{ text: 'Skala', type: 'scale' }, { text: 'Text', type: 'text' }]);
  for (const person of northTeam.slice(0, 5)) await submitOk(harness, person, id, [{ questionId: scale, value: 5 }, { questionId: freeText, text: 'Aus Nord' }]);
  for (const person of eastTeam) await submitOk(harness, person, id, [{ questionId: scale, value: 3 }, { questionId: freeText, text: 'Aus Ost' }]);
  await close(harness, id);

  const { data } = await harness.api('hr', 'GET', `/api/surveys/${id}/results`);
  assert.equal(data.groups.length, 2);
  const northGroup = data.groups.find(group => group.label.includes('Nord'));
  const eastGroup = data.groups.find(group => group.label.includes('Ost'));
  assert.equal(northGroup.questions[0].average, 5);
  assert.equal(eastGroup.questions[0].average, 3);
  assert.deepEqual(northGroup.participation, { invited: 6, responded: 5, ratePercent: 83 });
  assert.deepEqual(eastGroup.participation, { invited: 5, responded: 5, ratePercent: 100 });
  assert.deepEqual(northGroup.questions[1].texts, Array(5).fill('Aus Nord'));
  assert.deepEqual(eastGroup.questions[1].texts, Array(5).fill('Aus Ost'));
}));

test('Nach dem Schließen enthält die Datenbank keine feinere Gruppierung als die Auswertung', withHarness({}, async harness => {
  removeExampleEmployees(harness);
  const leads = ['Nord', 'Ost', 'Sued'].map(name => addPerson(harness, { name, role: 'director' }));
  const teams = leads.map(lead => addTeam(harness, lead, 5));
  const { id, questionIds: [scale] } = await createOpen(harness, { anonymityThreshold: 5, audience: 'roles', audienceRoles: ['employee'] });
  for (const person of teams[0]) await submitOk(harness, person, id, [{ questionId: scale, value: 5 }]);
  for (const person of teams[1]) await submitOk(harness, person, id, [{ questionId: scale, value: 4 }]);
  await submitOk(harness, teams[2][0], id, [{ questionId: scale, value: 1 }]);
  const lonely = () => harness.db.prepare('SELECT group_key, line_path FROM surveys_answers WHERE survey_id=? AND value=1').get(id);
  assert.equal(lonely().group_key, `lead:${leads[2]}`, 'Vor dem Schließen steht dort noch der Bereich');

  const before = await harness.api('hr', 'GET', `/api/surveys/${id}/results`);
  assert.equal(before.data.running, true);
  await close(harness, id);

  assert.equal(lonely().group_key, 'rest');
  assert.equal(lonely().line_path, '/');
  const combinations = new Map();
  for (const row of harness.db.prepare('SELECT DISTINCT response_id, group_key, line_path FROM surveys_answers WHERE survey_id=?').all(id)) {
    const key = `${row.group_key}|${row.line_path}`;
    combinations.set(key, (combinations.get(key) || 0) + 1);
  }
  for (const [key, count] of combinations) assert.ok(count >= 5, `${key}: ${count}`);
  assert.equal(harness.db.prepare('SELECT COUNT(*) AS count FROM surveys_interim_results WHERE survey_id=?').get(id).count, 0, 'Zwischenstände werden gelöscht');

  const again = await harness.api('hr', 'GET', `/api/surveys/${id}/results`);
  assert.equal(again.data.overall.answerCount, 11);
}));

test('Laufende Befragung: Der Zwischenstand ändert sich nur in Schritten, nicht nach jeder Abgabe', withHarness({}, async harness => {
  const team = addTeam(harness, 3, 8);
  const { id, questionIds: [scale, freeText] } = await createOpen(harness, { anonymityThreshold: 3, audience: 'roles', audienceRoles: ['employee'] }, [{ text: 'Skala', type: 'scale' }, { text: 'Text', type: 'text' }]);
  const results = async () => (await harness.api('hr', 'GET', `/api/surveys/${id}/results`)).data;
  const answer = (value, text) => [{ questionId: scale, value }, { questionId: freeText, text }];

  await submitOk(harness, team[0], id, answer(5, 'erste'));
  await submitOk(harness, team[1], id, answer(5, 'zweite'));
  assert.equal((await results()).overall.insufficient, true);

  await submitOk(harness, team[2], id, answer(5, 'dritte'));
  const first = await results();
  assert.equal(first.running, true);
  assert.equal(first.overall.answerCount, 3);
  assert.equal(first.overall.questions[0].average, 5);
  assert.equal(first.overall.questions[1].texts.length, 3);
  assert.deepEqual(first.groups, [], 'Der Vergleich nach Bereichen wartet, bis die Befragung geschlossen ist');

  // Die vierte Person antwortet: Wäre der Wert sofort sichtbar, ließe sich ihre Antwort errechnen.
  await submitOk(harness, team[3], id, answer(1, 'SOFORT-ERKENNBAR'));
  const second = await results();
  assert.equal(second.overall.answerCount, 3);
  assert.equal(second.overall.questions[0].average, 5);
  assert.doesNotMatch(JSON.stringify(second), /SOFORT-ERKENNBAR/);
  assert.equal(second.overall.participation.responded, 4, 'Die Teilnahmequote darf mitlaufen, sie verrät keinen Inhalt');

  await submitOk(harness, team[4], id, answer(1, 'fünfte'));
  assert.equal((await results()).overall.answerCount, 3);
  await submitOk(harness, team[5], id, answer(1, 'sechste'));
  const third = await results();
  assert.equal(third.overall.answerCount, 6, 'Nach drei weiteren Antworten gibt es einen neuen Stand');
  assert.equal(third.overall.questions[0].average, 3);

  await submitOk(harness, team[6], id, answer(3, 'siebte'));
  await close(harness, id);
  const closed = await results();
  assert.equal(closed.running, false);
  assert.equal(closed.overall.answerCount, 7, 'Nach dem Schließen zählen alle Antworten');
}));

test('Eine erhöhte Schwelle gilt auch für schon gebildete Zwischenstände', withHarness({}, async harness => {
  const { id, questionIds: [scale] } = await createOpen(harness, { anonymityThreshold: 3 });
  for (const person of ['anna', 'ben', 'clara']) await submitOk(harness, person, id, [{ questionId: scale, value: 5 }]);
  assert.equal((await harness.api('hr', 'GET', `/api/surveys/${id}/results`)).data.overall.answerCount, 3);
  await harness.api('hr', 'PATCH', `/api/surveys/${id}`, { anonymityThreshold: 5 });
  assert.equal((await harness.api('bp', 'GET', `/api/surveys/${id}/results`)).data.overall.insufficient, true);
  for (const person of ['manager', 'director']) await submitOk(harness, person, id, [{ questionId: scale, value: 1 }]);
  const atNewThreshold = await harness.api('bp', 'GET', `/api/surveys/${id}/results`);
  assert.equal(atNewThreshold.data.overall.answerCount, 5, 'Der alte Stand mit drei Antworten erscheint nicht mehr');
}));

test('Weiterempfehlungswert: Anteil 9 bis 10 minus Anteil 0 bis 6', withHarness({}, async harness => {
  const scoreFor = async values => {
    const { id, questionIds: [questionId] } = await createOpen(harness, { anonymityThreshold: 3 }, [{ text: 'Empfehlung', type: 'nps' }]);
    const people = ['anna', 'ben', 'clara', 'manager', 'director', 'hr', 'bp'];
    for (const [index, value] of values.entries()) await submitOk(harness, people[index], id, [{ questionId, value }]);
    await close(harness, id);
    const { data } = await harness.api('bp', 'GET', `/api/surveys/${id}/results`);
    return data.overall.questions[0];
  };
  const mixed = await scoreFor([10, 9, 8, 7, 6, 0]);
  assert.equal(mixed.recommendationScore, 0, 'Zwei von sechs dafür, zwei von sechs dagegen');
  assert.equal(mixed.promotersPercent, 33);
  assert.equal(mixed.passivesPercent, 33);
  assert.equal(mixed.detractorsPercent, 33);
  assert.equal((await scoreFor([10, 10, 9, 8, 3])).recommendationScore, 40);
  assert.equal((await scoreFor([9, 9, 9])).recommendationScore, 100);
  assert.equal((await scoreFor([6, 3, 0])).recommendationScore, -100);
  assert.equal((await scoreFor([7, 8, 7])).recommendationScore, 0, 'Die Werte 7 und 8 zählen nicht mit');
  assert.equal((await scoreFor([10, 6, 6, 8])).recommendationScore, -25);
}));

test('Führungskräfte sehen nur ihre Führungslinie, Mitarbeitende gar keine Auswertung', withHarness({}, async harness => {
  const firstLead = addPerson(harness, { name: 'Erste', role: 'manager', manager: 3 });
  const secondLead = addPerson(harness, { name: 'Zweite', role: 'manager', manager: 3 });
  const firstTeam = addTeam(harness, firstLead, 4);
  const secondTeam = addTeam(harness, secondLead, 4);
  const { id, questionIds: [scale, freeText] } = await createOpen(harness, { anonymityThreshold: 3 }, [{ text: 'Skala', type: 'scale' }, { text: 'Text', type: 'text' }]);
  for (const person of firstTeam) await submitOk(harness, person, id, [{ questionId: scale, value: 5 }, { questionId: freeText, text: 'AUS-ERSTER-LINIE' }]);
  for (const person of secondTeam) await submitOk(harness, person, id, [{ questionId: scale, value: 1 }, { questionId: freeText, text: 'AUS-ZWEITER-LINIE' }]);
  await close(harness, id);

  const first = await harness.api(firstLead, 'GET', `/api/surveys/${id}/results`);
  assert.equal(first.status, 200);
  assert.equal(first.data.scope, 'line');
  assert.equal(first.data.overall.answerCount, 4);
  assert.equal(first.data.overall.questions[0].average, 5);
  assert.match(JSON.stringify(first.data), /AUS-ERSTER-LINIE/);
  assert.doesNotMatch(JSON.stringify(first.data), /AUS-ZWEITER-LINIE/);
  assert.deepEqual(first.data.groups, [], 'Kein Vergleich mit anderen Bereichen');
  assert.deepEqual(first.data.overall.participation, { invited: 5, responded: 4, ratePercent: 80 }, 'Die Linie umfasst die Führungskraft und ihr Team');

  const second = await harness.api(secondLead, 'GET', `/api/surveys/${id}/results`);
  assert.equal(second.data.overall.questions[0].average, 1);
  assert.doesNotMatch(JSON.stringify(second.data), /AUS-ERSTER-LINIE/);

  const top = await harness.api('director', 'GET', `/api/surveys/${id}/results`);
  assert.equal(top.data.overall.answerCount, 8, 'Die Linie darüber umfasst beide Teams');
  assert.equal(top.data.overall.questions[0].average, 3);

  const noLine = await harness.api('manager', 'GET', `/api/surveys/${id}/results`);
  assert.deepEqual(noLine.data.overall, { insufficient: true, message: 'Zu wenige Antworten' }, 'Ohne eigene Antworten in der Linie keine Zahl');

  for (const person of ['anna', 'ben', 'clara', firstTeam[0]]) {
    assert.equal((await harness.api(person, 'GET', `/api/surveys/${id}/results`)).status, 403, `Mitarbeitende: ${person}`);
  }
  for (const url of [`/api/surveys/${id}/results?userId=5`, `/api/surveys/${id}/results?line=${secondLead}`, `/api/surveys/${id}/results?scope=organization`]) {
    const attempt = await harness.api(firstLead, 'GET', url);
    assert.equal(attempt.data.overall.answerCount, 4, 'Parameter weiten den Bereich nicht aus');
    assert.doesNotMatch(JSON.stringify(attempt.data), /AUS-ZWEITER-LINIE/);
  }
}));

test('Führungskräfte sehen laufende Befragungen ebenfalls nur in Schritten', withHarness({}, async harness => {
  const lead = addPerson(harness, { role: 'manager', manager: 3 });
  const team = addTeam(harness, lead, 6);
  const others = addTeam(harness, 3, 3);
  const { id, questionIds: [scale] } = await createOpen(harness, { anonymityThreshold: 3 });
  for (const person of [...team.slice(0, 3), ...others]) await submitOk(harness, person, id, [{ questionId: scale, value: 5 }]);
  const before = await harness.api(lead, 'GET', `/api/surveys/${id}/results`);
  assert.equal(before.data.running, true);
  assert.equal(before.data.overall.answerCount, 3);
  await submitOk(harness, team[3], id, [{ questionId: scale, value: 1 }]);
  const after = await harness.api(lead, 'GET', `/api/surveys/${id}/results`);
  assert.equal(after.data.overall.answerCount, 3);
  assert.equal(after.data.overall.questions[0].average, 5);
  assert.equal(after.data.overall.participation.responded, 4);
}));

test('Differenzangriff über Führungslinien: Linie darüber minus Linie darunter ergibt keine einzelne Person', withHarness({}, async harness => {
  // director führt manager mit Anna und Ben sowie Clara. Director minus manager wäre genau Clara.
  const { id, questionIds: [scale] } = await createOpen(harness, { anonymityThreshold: 3 });
  for (const person of ['hr', 'bp', 'director', 'manager', 'anna', 'ben', 'clara']) {
    await submitOk(harness, person, id, [{ questionId: scale, value: person === 'clara' ? 1 : 5 }]);
  }
  await close(harness, id);
  const top = await harness.api('director', 'GET', `/api/surveys/${id}/results`);
  assert.equal(top.data.overall.answerCount, 4, 'Der Bereich des director bleibt sichtbar');
  const lower = await harness.api('manager', 'GET', `/api/surveys/${id}/results`);
  assert.deepEqual(lower.data.overall, { insufficient: true, message: 'Zu wenige Antworten' }, 'Sonst ergäbe die Differenz genau Clara');
}));

test('Differenzangriff über die Gesamtsumme: Wer fast alle führt, sieht keine Linie, wenn nur wenige fehlen', withHarness({}, async harness => {
  const lead = addPerson(harness, { role: 'director' });
  const team = addTeam(harness, lead, 6);
  const { id, questionIds: [scale] } = await createOpen(harness, { anonymityThreshold: 3 });
  for (const person of team) await submitOk(harness, person, id, [{ questionId: scale, value: 5 }]);
  await submitOk(harness, 'anna', id, [{ questionId: scale, value: 1 }]);
  await close(harness, id);
  const organization = await harness.api('hr', 'GET', `/api/surveys/${id}/results`);
  assert.equal(organization.data.overall.answerCount, 7);
  const line = await harness.api(lead, 'GET', `/api/surveys/${id}/results`);
  assert.equal(line.data.overall.insufficient, true, 'Gesamtwert minus Linie wäre genau eine Person');
}));

test('Differenzangriff zwischen Einheit und Linie: Auch Überschneidungen legen keine kleine Gruppe frei', withHarness({}, async harness => {
  createPersonnelModule(harness.deps).initialize();
  const now = new Date().toISOString();
  const addUnit = name => Number(harness.db.prepare("INSERT INTO personnel_org_units(type, name, created_at) VALUES('department', ?, ?)").run(name, now).lastInsertRowid);
  const assignUnit = (userId, unitId) => harness.db.prepare('INSERT INTO personnel_records(user_id, org_unit_id, created_at, updated_at) VALUES(?, ?, ?, ?)').run(userId, unitId, now, now);
  const unit = addUnit('Einheit');
  const otherUnit = addUnit('Andere Einheit');
  const lead = addPerson(harness, { role: 'manager' });
  const team = addTeam(harness, lead, 5);
  [lead, ...team.slice(0, 4)].forEach(userId => assignUnit(userId, unit));
  // Eine Person der Linie arbeitet in einer anderen Einheit: Einheit und Linie unterscheiden sich um genau sie.
  assignUnit(team[4], otherUnit);
  const others = addTeam(harness, 3, 4);
  others.forEach(userId => assignUnit(userId, otherUnit));

  const { id, questionIds: [scale] } = await createOpen(harness, { anonymityThreshold: 3, audience: 'roles', audienceRoles: ['employee', 'manager'] });
  for (const person of team) await submitOk(harness, person, id, [{ questionId: scale, value: 5 }]);
  for (const person of others) await submitOk(harness, person, id, [{ questionId: scale, value: 2 }]);
  const stored = harness.db.prepare('SELECT group_key, line_path FROM surveys_answers WHERE survey_id=?').all(id);
  assert.ok(!stored.some(row => row.group_key === `unit:${otherUnit}` && row.line_path.includes(`/${lead}/`)), 'Die einzelne Person der anderen Einheit wird nicht über ihre Linie erkennbar');
  await close(harness, id);

  const combinations = new Map();
  for (const row of harness.db.prepare('SELECT group_key, line_path FROM surveys_answers WHERE survey_id=?').all(id)) {
    const key = `${row.group_key}|${row.line_path}`;
    combinations.set(key, (combinations.get(key) || 0) + 1);
  }
  for (const [key, count] of combinations) assert.ok(count >= 3, `${key}: ${count}`);

  const organization = await harness.api('hr', 'GET', `/api/surveys/${id}/results`);
  const unitGroup = organization.data.groups.find(group => group.label === 'Einheit');
  assert.equal(unitGroup.answerCount, 4);
  const line = await harness.api(lead, 'GET', `/api/surveys/${id}/results`);
  assert.equal(line.data.overall.answerCount, 4, 'Die Linie zählt nur, wer auch über die Einheit nicht erkennbar wird');
}));

test('Enddatum: Keine Abgabe nach dem Ende, die Wartung schließt idempotent', withHarness({}, async harness => {
  const { id, questionIds: [questionId] } = await createOpen(harness, { endsAt: shiftDays(1) });
  harness.db.prepare('UPDATE surveys_surveys SET ends_at=? WHERE id=?').run(shiftDays(-1), id);

  assert.equal((await submit(harness, 'anna', id, [{ questionId, value: 3 }])).status, 409, 'Auch bevor die Wartung lief');
  assert.equal((await harness.api('anna', 'GET', `/api/surveys/${id}/form`)).status, 409);
  assert.equal((await harness.api('anna', 'GET', '/api/surveys/open')).data.items.length, 0);

  assert.deepEqual(harness.instance.maintenance(), { closed: 1 });
  assert.equal(harness.db.prepare('SELECT status FROM surveys_surveys WHERE id=?').get(id).status, 'closed');
  assert.equal(harness.db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE type='surveys_participate' AND entity_id=? AND done=0").get(id).count, 0);
  const auditCount = harness.db.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE action='survey_closed'").get().count;
  assert.deepEqual(harness.instance.maintenance(), { closed: 0 });
  assert.equal(harness.db.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE action='survey_closed'").get().count, auditCount);

  const running = await createOpen(harness, { endsAt: shiftDays(1) });
  const stillGoing = await harness.api('hr', 'PATCH', `/api/surveys/${running.id}`, { endsAt: shiftDays(10) });
  assert.equal(stillGoing.data.survey.endsAt, shiftDays(10));
  assert.equal((await harness.api('hr', 'PATCH', `/api/surveys/${running.id}`, { endsAt: shiftDays(-1) })).status, 400);
  assert.equal((await harness.api('hr', 'PATCH', `/api/surveys/${running.id}`, { endsAt: '2026-02-31' })).status, 400);
  assert.deepEqual(harness.instance.maintenance(), { closed: 0 }, 'Laufende Befragungen bleiben offen');
}));

test('Auswertung nur für laufende und geschlossene Befragungen', withHarness({}, async harness => {
  const { id } = await createDraft(harness);
  assert.equal((await harness.api('hr', 'GET', `/api/surveys/${id}/results`)).status, 409);
  assert.equal((await harness.api('manager', 'GET', `/api/surveys/${id}/results`)).status, 404, 'Führungskräfte erfahren nichts über Entwürfe');
  assert.equal((await harness.api('hr', 'GET', '/api/surveys/999999/results')).status, 404);
}));

test('Hilfeartikel haben die vom Assistenten erwartete Form', () => {
  assert.ok(h.instance.helpArticles.length > 0);
  for (const article of h.instance.helpArticles) {
    assert.ok(article.id.startsWith('surveys-'));
    assert.ok(article.title && article.answer);
    for (const key of ['roles', 'views', 'keywords', 'steps', 'actions']) assert.ok(Array.isArray(article[key]), key);
    assert.ok(article.keywords.every(keyword => keyword === keyword.toLowerCase()));
  }
});

test('Beispieldaten: mehrfach aufrufbar, ohne neue Konten und ohne Einzelantworten unter der Schwelle', withHarness({}, async harness => {
  const usersBefore = harness.db.prepare('SELECT COUNT(*) AS count FROM users').get().count;
  harness.instance.seedDemo();
  const surveys = harness.db.prepare('SELECT id, status, anonymity_threshold FROM surveys_surveys').all();
  assert.equal(surveys.length, 2);
  for (const survey of surveys) {
    const responses = harness.db.prepare('SELECT COUNT(DISTINCT response_id) AS count FROM surveys_answers WHERE survey_id=?').get(survey.id).count;
    assert.ok(responses === 0 || responses >= survey.anonymity_threshold, `Befragung ${survey.id}: ${responses} Antworten`);
  }
  const before = harness.db.prepare('SELECT COUNT(*) AS count FROM surveys_answers').get().count;
  harness.instance.seedDemo();
  assert.equal(harness.db.prepare('SELECT COUNT(*) AS count FROM surveys_surveys').get().count, 2);
  assert.equal(harness.db.prepare('SELECT COUNT(*) AS count FROM surveys_answers').get().count, before);
  assert.equal(harness.db.prepare('SELECT COUNT(*) AS count FROM users').get().count, usersBefore);

  const closed = surveys.find(survey => survey.status === 'closed');
  const results = await harness.api('hr', 'GET', `/api/surveys/${closed.id}/results`);
  assert.equal(results.data.overall.insufficient, false);
  assert.equal(results.data.overall.answerCount, 7, 'Die Demo zeigt eine echte Auswertung über der Schwelle');
  const openSurveyId = surveys.find(survey => survey.status === 'open').id;
  assert.equal((await harness.api('anna', 'GET', `/api/surveys/${openSurveyId}/form`)).status, 200, 'Die offene Demo-Befragung lässt sich ausfüllen');
}));

test('Beispieldaten: Fehlen Personen, passiert nichts', withHarness({}, async harness => {
  harness.db.prepare('UPDATE users SET active=0 WHERE id > 3').run();
  harness.instance.seedDemo();
  assert.equal(harness.db.prepare('SELECT COUNT(*) AS count FROM surveys_surveys').get().count, 0);
}));

test('Die Systemadministration wird wie HR behandelt, ist aber nicht eingeladen', async () => {
  const systemId = 900;
  let database = null;
  const current = req => {
    const id = Number(req.get('x-test-user'));
    if (id === systemId) return { id: systemId, name: 'Systemadministration', email: 'root@test.local', role: 'super_admin', manager_id: null };
    return id ? database.prepare('SELECT id,name,email,role,title,manager_id FROM users WHERE id=? AND is_system_account=0 AND active=1').get(id) || null : null;
  };
  const harness = await freshHarness({ extra: { current, auth: (req, res, next) => (current(req) ? next() : res.status(401).json({ error: 'Nicht angemeldet' })) } });
  database = harness.db;
  try {
    harness.db.prepare("INSERT INTO users(id, name, email, password_hash, role, is_system_account) VALUES(?, 'Systemadministration', 'system@test.local', '!ENV!', 'hr_admin', 1)").run(systemId);
    const created = await harness.api(systemId, 'POST', '/api/surveys', { title: 'Vom Support', useTemplates: false, anonymityThreshold: 3 });
    assert.equal(created.status, 200);
    const question = await harness.api(systemId, 'POST', `/api/surveys/${created.data.id}/questions`, { text: 'Skala', type: 'scale' });
    const opened = await harness.api(systemId, 'POST', `/api/surveys/${created.data.id}/open`, {});
    assert.equal(opened.data.survey.invitedCount, 7, 'Das technische Konto wird nicht eingeladen');
    assert.equal((await submit(harness, systemId, created.data.id, [{ questionId: question.data.id, value: 3 }])).status, 404);
    for (const person of ['anna', 'ben', 'clara']) await submitOk(harness, person, created.data.id, [{ questionId: question.data.id, value: 3 }]);
    const results = await harness.api(systemId, 'GET', `/api/surveys/${created.data.id}/results`);
    assert.equal(results.data.scope, 'organization');
    assert.equal(results.data.overall.answerCount, 3);
  } finally {
    await harness.close();
  }
});

test('Modul läuft auch, wenn alle anderen Module aus sind', withHarness({ isModuleEnabled: () => false }, async harness => {
  const { id, questionIds: [questionId] } = await createOpen(harness);
  for (const person of ['anna', 'ben', 'clara']) await submitOk(harness, person, id, [{ questionId, value: 4 }]);
  await close(harness, id);
  assert.equal((await harness.api('bp', 'GET', `/api/surveys/${id}/results`)).data.overall.answerCount, 3);
}));

const participationTasks = (harness, id) => harness.db.prepare("SELECT * FROM tasks WHERE type='surveys_participate' AND entity_id=? ORDER BY id").all(id);

test('Aufgaben: Sie nennen die Befragung und tragen ihr Ende als Frist, ohne Ende gibt es keine', withHarness({}, async harness => {
  const endsAt = shiftDays(10);
  const withEnd = await createOpen(harness, { title: 'Puls', endsAt });
  const tasks = participationTasks(harness, withEnd.id);
  assert.equal(tasks.length, 7);
  assert.ok(tasks.every(task => task.due_date === endsAt), 'Die Frist ist das Ende der Befragung');
  assert.match(tasks[0].title, /Puls/);
  assert.match(tasks[0].title, new RegExp(endsAt.split('-').reverse().join('\\.')), 'Deutsches Datum im Titel');

  const noEnd = await createOpen(harness, { title: 'Offen' });
  assert.ok(participationTasks(harness, noEnd.id).every(task => task.due_date === null), 'Kein Anlegetag als Frist');
}));

test('Aufgaben: Ein neues Ende gilt auch für die Aufgaben, bei allen gleich', withHarness({}, async harness => {
  const { id, questionIds: [questionId] } = await createOpen(harness, { title: 'Puls', endsAt: shiftDays(10) });
  await submitOk(harness, 'anna', id, [{ questionId, value: 4 }]);
  const newEnd = shiftDays(20);
  assert.equal((await harness.api('hr', 'PATCH', `/api/surveys/${id}`, { endsAt: newEnd })).status, 200);
  const tasks = participationTasks(harness, id);
  assert.ok(tasks.every(task => task.due_date === newEnd), 'Auch die erledigten, sonst verrieten sie, wer schon abgegeben hat');
  assert.ok(tasks.every(task => task.title.includes(newEnd.split('-').reverse().join('.'))));
  assert.equal(tasks.filter(task => task.done === 1).length, 1);

  assert.equal((await harness.api('hr', 'PATCH', `/api/surveys/${id}`, { endsAt: null })).status, 200);
  assert.ok(participationTasks(harness, id).every(task => task.due_date === null && !/\(bis/.test(task.title)));
}));

test('Aufgaben: Sie schließen sich mit der Abgabe und mit dem Ende der Befragung', withHarness({}, async harness => {
  const { id, questionIds: [questionId] } = await createOpen(harness);
  await submitOk(harness, 'anna', id, [{ questionId, value: 4 }]);
  const openOf = () => participationTasks(harness, id).filter(task => !task.done).map(task => task.user_id);
  assert.equal(openOf().includes(5), false);
  assert.equal(openOf().length, 6);
  await close(harness, id);
  assert.deepEqual(openOf(), []);
}));

test('Die HR-Sachbearbeitung nimmt teil wie alle, verwaltet und sieht aber nichts', withHarness({}, async harness => {
  const staff = harness.deps.createUserAccount({ name: 'Sach Bearbeiter', email: 'sb@test.local', role: 'hr_staff', actor: { id: 1 } }).id;
  const byRole = await createDraft(harness, { audience: 'roles', audienceRoles: ['hr_staff', 'employee'] });
  await openDraft(harness, byRole.id);
  assert.equal(harness.db.prepare('SELECT COUNT(*) AS count FROM surveys_participation WHERE survey_id=? AND user_id=?').get(byRole.id, staff).count, 1, 'Als Zielgruppe wählbar');

  assert.equal((await harness.api(staff, 'GET', '/api/surveys/open')).data.items.length, 1);
  assert.equal((await harness.api(staff, 'GET', `/api/surveys/${byRole.id}/form`)).status, 200);
  await submitOk(harness, staff, byRole.id, [{ questionId: byRole.questionIds[0], value: 4 }]);

  const denied = [
    ['GET', '/api/surveys'],
    ['GET', '/api/surveys/templates'],
    ['POST', '/api/surveys', { title: 'Neu' }],
    ['GET', `/api/surveys/${byRole.id}`],
    ['PATCH', `/api/surveys/${byRole.id}`, { endsAt: shiftDays(3) }],
    ['POST', `/api/surveys/${byRole.id}/close`, {}],
    ['GET', `/api/surveys/${byRole.id}/results`]
  ];
  for (const [method, url, body] of denied) {
    assert.equal((await harness.api(staff, method, url, body)).status, 403, `${method} ${url}`);
  }
}));

test('hideSubmissionOrder: Aufgabennummern, Frist und Titel bleiben erhalten', withHarness({}, async harness => {
  const endsAt = shiftDays(10);
  const { id, questionIds: [scale, freeText] } = await createOpen(harness, { endsAt }, [{ text: 'Skala', type: 'scale' }, { text: 'Text', type: 'text' }]);
  const other = await createOpen(harness, { title: 'Andere' });
  const before = participationTasks(harness, id).map(({ id: taskId, user_id: userId, title, due_date: due, created_at: created }) => ({ taskId, userId, title, due, created }));
  const untouched = participationTasks(harness, other.id);
  for (const person of ['anna', 'ben', 'clara']) await submitOk(harness, person, id, [{ questionId: scale, value: 4 }, { questionId: freeText, text: `Text von ${person}` }]);
  const after = participationTasks(harness, id);
  assert.deepEqual(after.map(({ id: taskId, user_id: userId, title, due_date: due, created_at: created }) => ({ taskId, userId, title, due, created })), before);
  assert.deepEqual(after.filter(task => task.done).map(task => task.user_id).sort((a, b) => a - b), [5, 6, 7]);
  assert.deepEqual(participationTasks(harness, other.id), untouched, 'Andere Befragungen bleiben unberührt');
  // Eine zweite Abgabe ändert nichts und bricht nichts.
  assert.equal((await submit(harness, 'anna', id, [{ questionId: scale, value: 1 }])).status, 409);
  assert.equal(harness.db.prepare('SELECT COUNT(*) AS count FROM surveys_answers WHERE survey_id=?').get(id).count, 6);
  // Neue Aufgaben bekommen danach weiter eigene Nummern.
  harness.deps.createTask(5, 'Später', 'goal_approval', 1);
  assert.ok(harness.db.prepare("SELECT id FROM tasks WHERE title='Später'").get().id > Math.max(...after.map(task => task.id)));
  await close(harness, id);
  assert.equal(harness.db.prepare('SELECT COUNT(*) AS count FROM surveys_answers WHERE survey_id=?').get(id).count, 6, 'Auch das Schließen verliert nichts');
  assert.deepEqual(participationTasks(harness, id).map(task => task.id), before.map(task => task.taskId));
}));

test('hideSubmissionOrder: Schlägt das Umschreiben fehl, ist nichts halb gespeichert', withHarness({}, async harness => {
  if (harness.db.dialect !== 'postgres') return;
  const { id, questionIds: [questionId] } = await createOpen(harness);
  harness.db.execRaw(`
    CREATE FUNCTION fail_on_task_insert() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'Testfehler'; END; $$ LANGUAGE plpgsql;
    CREATE TRIGGER fail_on_task_insert BEFORE INSERT ON tasks FOR EACH ROW EXECUTE FUNCTION fail_on_task_insert();
  `);
  const failed = await submit(harness, 'anna', id, [{ questionId, value: 4 }]);
  assert.equal(failed.status, 500);
  assert.equal(harness.db.prepare('SELECT submitted FROM surveys_participation WHERE survey_id=? AND user_id=5').get(id).submitted, 0, 'Die Abgabe zählt nicht');
  assert.equal(harness.db.prepare('SELECT COUNT(*) AS count FROM surveys_answers WHERE survey_id=?').get(id).count, 0, 'Keine Antwort bleibt liegen');
  assert.equal(participationTasks(harness, id).length, 7, 'Keine Aufgabe geht verloren');
  assert.equal(participationTasks(harness, id).filter(task => task.done).length, 0);
  harness.db.execRaw('DROP TRIGGER fail_on_task_insert ON tasks; DROP FUNCTION fail_on_task_insert()');
  await submitOk(harness, 'anna', id, [{ questionId, value: 4 }]);
  assert.equal(harness.db.prepare('SELECT COUNT(*) AS count FROM surveys_answers WHERE survey_id=?').get(id).count, 1, 'Die Person kann es einfach noch einmal versuchen');
}));

test('Oberfläche: Der Anonymitätstext stimmt mit der Datenauskunft überein', withHarness({}, async harness => {
  const script = fs.readFileSync(path.join(__dirname, '..', 'public', 'surveys.js'), 'utf8');
  assert.equal(script.includes('Darin steht, ob die Person abgegeben hat'), false, 'Das stimmte nie');
  assert.match(script, /Darin steht weder, ob du abgegeben hast, noch, was du geantwortet hast/);

  // Der Beleg: Die echte Datenauskunft nennt weder Teilnahme noch Aufgabe.
  const personnel = createPersonnelModule(harness.deps);
  personnel.initialize();
  const { id, questionIds: [questionId] } = await createOpen(harness, { title: 'Geheime Befragung' });
  await submitOk(harness, 'anna', id, [{ questionId, value: 4 }]);
  const app = express();
  app.use('/api', personnel.router);
  const server = await new Promise(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  try {
    const { port } = server.address();
    for (const suffix of ['', '/readable']) {
      const response = await fetch(`http://127.0.0.1:${port}/api/personnel/5/data-export${suffix}`, { headers: { 'x-test-user': '1' } });
      assert.equal(response.status, 200);
      const text = await response.text();
      assert.equal(text.includes('Geheime Befragung'), false, 'Die Aufgabe zur Befragung steht nicht darin');
      assert.equal(text.includes('surveys_participa'), false, 'Die Teilnahme steht nicht darin');
      assert.equal(text.includes('surveys_answers'), false);
      assert.match(text, /anonymen Befragungen/);
    }
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}));

test('Oberfläche: Am Handy läuft nichts über den Rand und die Knöpfe bleiben sichtbar', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'surveys.css'), 'utf8');
  const script = fs.readFileSync(path.join(__dirname, '..', 'public', 'surveys.js'), 'utf8');
  assert.match(css, /\.surveys-stack \{[^}]*grid-template-columns: minmax\(0, 1fr\)/, 'Sonst weitet die breite Tabelle die ganze Seite');
  assert.match(css, /@media \(max-width: 700px\)[^]*\.surveys-table thead \{ display: none; \}/);
  assert.equal((script.match(/<table class="table">/g) || []).length, 0);
  assert.equal(script.includes('Deine Führungslinie'), false, 'Verständliche Sprache');
  assert.match(script, /Fachleute nennen das Anonymitätsschwelle/, 'Der Fachbegriff ist einmal erklärt');
});

test('Hilfe: Die Sachbearbeitung findet die Teilnahme, nicht die Verwaltung', () => {
  const forStaff = h.instance.helpArticles.filter(article => article.roles.includes('hr_staff')).map(article => article.id);
  assert.deepEqual(forStaff, ['surveys-participate']);
});

// --------------------------------------------------------------- Nummer in der Adresse

test('Anonymität: Eine Nummer in der Adresse verrät nicht, ob es dazu etwas gibt', withHarness({}, async harness => {
  addPerson(harness, { role: 'manager' });
  const draft = await createDraft(harness, { title: 'Geheimer Entwurf' });
  const forOthers = await createOpen(harness, { title: 'Nur für Führung', audience: 'roles', audienceRoles: ['manager', 'director'] });
  const closedForOthers = await createOpen(harness, { title: 'Alte Runde für Führung', audience: 'roles', audienceRoles: ['manager', 'director', 'hr_admin'] });
  await close(harness, closedForOthers.id);
  const unknownId = 987654;
  const answers = { answers: [{ questionId: 1, value: 3 }] };
  const seenBy = async (person, method, suffix, body) => {
    const seen = [];
    for (const id of [unknownId, draft.id, forOthers.id, closedForOthers.id]) {
      const response = await harness.api(person, method, `/api/surveys/${id}${suffix}`, body);
      seen.push(JSON.stringify([response.status, response.data]));
    }
    return seen;
  };

  // Wer nicht eingeladen ist, bekommt immer dieselbe Antwort, ohne Titel und ohne Hinweis auf den Stand.
  for (const [method, suffix, body] of [['GET', '/form'], ['POST', '/responses', answers]]) {
    const seen = await seenBy('anna', method, suffix, body);
    assert.equal(new Set(seen).size, 1, `${method} ${suffix}: ${seen.join(' | ')}`);
    assert.doesNotMatch(seen[0], /Geheimer|Führung|Runde|eingeladen|geöffnet|beendet/);
  }
  // Auswertung und Verwaltung antworten Mitarbeitenden für jede Nummer gleich.
  for (const suffix of ['/results', '']) {
    assert.equal(new Set(await seenBy('anna', 'GET', suffix)).size, 1, suffix);
  }
  // Eine Führungskraft sieht in der Auswertung keinen Entwurf: unbekannt und Entwurf sind gleich.
  const unknownForLead = await harness.api('manager', 'GET', `/api/surveys/${unknownId}/results`);
  const draftForLead = await harness.api('manager', 'GET', `/api/surveys/${draft.id}/results`);
  assert.deepEqual([draftForLead.status, draftForLead.data], [unknownForLead.status, unknownForLead.data]);
  assert.equal((await harness.api('manager', 'GET', `/api/surveys/${draft.id}`)).status, 403);
  assert.equal((await harness.api('manager', 'GET', `/api/surveys/${unknownId}`)).status, 403);

  // Und nichts davon hat etwas geschrieben.
  assert.equal(harness.db.prepare('SELECT COUNT(*) AS count FROM surveys_answers').get().count, 0);
}));

test('Anonymität: Die Formularseite nennt nur den eigenen Stand, und mehr steht auch nicht darin', withHarness({}, async harness => {
  const { id, questionIds: [questionId] } = await createOpen(harness);
  await submitOk(harness, 'anna', id, [{ questionId, value: 5 }]);
  const own = await harness.api('anna', 'GET', `/api/surveys/${id}/form`);
  assert.deepEqual({ submitted: own.data.submitted, questions: own.data.questions }, { submitted: true, questions: [] });
  assert.deepEqual(Object.keys(own.data.survey).sort(), ['anonymityThreshold', 'endsAt', 'id', 'intro', 'startsAt', 'status', 'title']);
  // Für alle anderen sieht die Seite aus, als hätte niemand abgegeben.
  const other = await harness.api('ben', 'GET', `/api/surveys/${id}/form`);
  assert.equal(other.data.submitted, false);
  assert.doesNotMatch(JSON.stringify(other.data), /Anna|anna|invited|responded|count/i);
}));

/** Führt die Oberfläche ohne Browser aus, mit einem Formular, das nur aus dem Nötigsten besteht. */
function loadSurveysPage({ role = 'employee', confirmAnswer = true, sendFails = false } = {}) {
  const page = { confirms: [], navigated: [], calls: [], pushed: [], rendered: 0, listeners: {}, module: null, address: null, hash: '#/surveysFill/12' };
  page.form = { dataset: { surveyId: '12' }, querySelector: () => ({ disabled: false }), querySelectorAll: () => [] };
  const loop = {
    api: async url => {
      page.calls.push(url);
      if (sendFails) throw new Error('Abgelehnt');
      return { ok: true };
    },
    ui: { esc: value => String(value ?? ''), toast: () => {}, header: () => '', empty: () => '', stat: () => '' },
    me: { id: 5, role },
    view: 'surveysFill',
    roles: {},
    navigate: view => {
      page.navigated.push(view);
      sandbox.view = view;
      return sandbox.render();
    },
    registerAddress: handlers => { page.address = handlers; },
    registerModule: definition => { page.module = definition; }
  };
  const listen = target => (type, listener) => { page.listeners[`${target}:${type}`] = listener; };
  const sandbox = {
    window: { loop, scrollY: 300, scrollTo: () => {}, addEventListener: listen('window'), confirm: text => { page.confirms.push(text); return confirmAnswer; } },
    document: {
      addEventListener: listen('document'),
      querySelectorAll: () => [],
      querySelector: selector => {
        if (selector === '#surveysFillForm') return page.form;
        if (selector === '#surveysFillForm[data-unsent]') return page.form.dataset.unsent ? page.form : null;
        if (selector === '#surveysFillError') return { textContent: '' };
        return null;
      }
    },
    history: { pushState: (state, title, address) => page.pushed.push([state, address]) },
    get location() { return { hash: page.hash }; },
    render: async () => { page.rendered += 1; },
    view: 'surveysFill',
    setTimeout: run => run(),
    FormData: class { get() { return null; } getAll() { return []; } },
    Number, String, Object, Array, Set, Map, JSON, encodeURIComponent, Math, Boolean, Promise, Error
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'surveys.js'), 'utf8'), sandbox);
  page.sandbox = sandbox;
  page.loop = loop;
  return page;
}

const clickOn = element => ({ target: { closest: () => element }, prevented: 0, preventDefault() { this.prevented += 1; }, stopPropagation() {} });

test('Oberfläche: Verwaltung und Auswertung stehen nur den passenden Rollen offen', () => {
  const { module: { allowed } } = loadSurveysPage();
  const rights = { hr_admin: [true, true, true, true], hrbp: [true, true, true, true], super_admin: [true, true, true, true], manager: [false, false, true, true], director: [false, false, true, true], employee: [false, false, false, false], hr_staff: [false, false, false, false] };
  for (const [role, expected] of Object.entries(rights)) {
    const me = { role };
    assert.deepEqual(['surveysManage', 'surveysEdit', 'surveysResultsList', 'surveysResults'].map(view => allowed(view, me)), expected, role);
    assert.equal(allowed('surveysHome', me), true, role);
    assert.equal(allowed('surveysFill', me), true, role);
    assert.equal(allowed('dashboard', me), true, 'Fremde Seiten gehen dieses Modul nichts an');
  }
});

test('Oberfläche: Detailseiten tragen die Nummer in der Adresse und laden direkt danach ihre Daten', async () => {
  const page = loadSurveysPage({ role: 'hr_admin' });
  const expected = { surveysFill: '/api/surveys/12/form', surveysEdit: '/api/surveys/12', surveysResults: '/api/surveys/12/results' };
  assert.deepEqual(Object.keys(page.address).sort(), Object.keys(expected).sort());
  for (const [view, url] of Object.entries(expected)) {
    page.address[view].set(12);
    assert.equal(page.address[view].get(), 12);
    page.calls.length = 0;
    await page.module.pages[view]().catch(() => {});
    assert.equal(page.calls[0], url, view);
  }
});

test('Oberfläche: Wer nicht abgesendete Antworten verlässt, wird gefragt und kann bleiben', async () => {
  const page = loadSurveysPage({ confirmAnswer: false });
  page.module.bind();
  page.address.surveysFill.set(12);

  // Ohne Eingabe kein Hinweis, die Seite wechselt einfach.
  await page.sandbox.render();
  assert.deepEqual([page.confirms.length, page.rendered], [0, 1]);

  page.form.oninput();
  page.rendered = 0;
  // Knöpfe und Sprünge von außen wie bei Dayo: Die Ansicht ist schon gewechselt, das Formular bleibt.
  await page.loop.navigate('dashboard');
  assert.equal(page.confirms.length, 1);
  assert.equal(page.rendered, 0, 'Das Formular wird nicht neu aufgebaut');
  assert.equal(page.sandbox.view, 'surveysFill');
  assert.equal(page.form.dataset.unsent, '1');
  assert.deepEqual(page.pushed, [], 'Die Adresse stand noch richtig');

  // Abmelden, Neu laden und Schließen.
  let event = clickOn({});
  page.listeners['document:click'](event);
  assert.deepEqual([page.confirms.length, event.prevented], [2, 1]);
  event = clickOn(null);
  page.listeners['document:click'](event);
  assert.deepEqual([page.confirms.length, event.prevented], [2, 0], 'Andere Klicks gehen das nichts an');
  const unload = { prevented: 0, preventDefault() { this.prevented += 1; } };
  page.listeners['window:beforeunload'](unload);
  assert.equal(unload.prevented, 1);

  // Zurück im Browser: Die Anwendung hat schon gewechselt. Ansicht, Nummer und Adresse kommen zurück.
  page.hash = '#/surveysFill/13';
  page.sandbox.view = 'surveysFill';
  page.address.surveysFill.set(13);
  await page.sandbox.render();
  assert.equal(page.rendered, 0);
  assert.equal(page.address.surveysFill.get(), 12);
  assert.equal(page.pushed[0][1], '#/surveysFill/12');
  assert.deepEqual({ view: page.pushed[0][0].view, item: page.pushed[0][0].item }, { view: 'surveysFill', item: 12 });
});

test('Oberfläche: Wer verlassen will, darf, und nach dem Absenden fragt niemand mehr', async () => {
  const leaving = loadSurveysPage({ confirmAnswer: true });
  leaving.module.bind();
  leaving.form.oninput();
  await leaving.loop.navigate('dashboard');
  assert.equal(leaving.rendered, 1);
  assert.equal(leaving.form.dataset.unsent, undefined);
  await leaving.loop.navigate('goals');
  assert.equal(leaving.confirms.length, 1, 'Nur einmal gefragt');
  assert.equal(leaving.rendered, 2);

  const page = loadSurveysPage({ confirmAnswer: false });
  page.module.bind();
  page.address.surveysFill.set(12);
  page.form.oninput();
  await page.form.onsubmit({ preventDefault() {} });
  assert.equal(page.calls[0], '/api/surveys/12/responses');
  assert.equal(page.confirms.length, 0);
  assert.deepEqual(page.navigated, ['surveysHome'], 'Nach dem Absenden geht es ohne Rückfrage weiter');
  assert.equal(page.rendered, 1);
  const unload = { prevented: 0, preventDefault() { this.prevented += 1; } };
  page.listeners['window:beforeunload'](unload);
  assert.equal(unload.prevented, 0);

  // Scheitert das Absenden, bleibt alles offen und die Rückfrage bestehen.
  const failing = loadSurveysPage({ confirmAnswer: false, sendFails: true });
  failing.module.bind();
  failing.address.surveysFill.set(12);
  failing.form.oninput();
  await failing.form.onsubmit({ preventDefault() {} });
  assert.equal(failing.form.dataset.unsent, '1');
  assert.deepEqual(failing.navigated, []);
});
