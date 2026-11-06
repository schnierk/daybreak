'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { after, before, test } = require('node:test');
const express = require('express');
const { createModuleHarness } = require('../lib/testing/module-harness');
const { createLearningModule } = require('../routes/learning');

let h;
let courseCounter = 0;

before(async () => {
  h = await createModuleHarness(createLearningModule);
});
after(() => h.close());

function shiftDays(days) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
const today = () => shiftDays(0);

async function createCourse(harness, overrides = {}) {
  courseCounter += 1;
  const response = await harness.api('hr', 'POST', '/api/learning/courses', {
    title: `Testkurs ${courseCounter}`,
    courseType: 'online',
    ...overrides
  });
  assert.equal(response.status, 200, JSON.stringify(response.data));
  return response.data.id;
}

async function assign(harness, courseId, target, actor = 'hr', dueDate = shiftDays(30)) {
  const response = await harness.api(actor, 'POST', '/api/learning/assignments', { courseId, dueDate, ...target });
  assert.equal(response.status, 200, JSON.stringify(response.data));
  return response.data;
}

const assignmentRow = (harness, id) => harness.db.prepare('SELECT * FROM learning_assignments WHERE id=?').get(id);
const openTasks = (harness, type, entityId) => harness.db.prepare('SELECT * FROM tasks WHERE type=? AND entity_id=? AND done=0').all(type, entityId);
const allTasks = (harness, type, entityId) => harness.db.prepare('SELECT * FROM tasks WHERE type=? AND entity_id=?').all(type, entityId);

test('Ohne Anmeldung gibt es nichts (401)', async () => {
  const calls = [
    ['GET', '/api/learning/my'],
    ['GET', '/api/learning/courses'],
    ['POST', '/api/learning/courses', {}],
    ['POST', '/api/learning/assignments', {}],
    ['POST', '/api/learning/courses/1/enroll', {}],
    ['POST', '/api/learning/assignments/1/complete', {}],
    ['POST', '/api/learning/assignments/1/confirm', {}],
    ['GET', '/api/learning/team'],
    ['GET', '/api/learning/report'],
    ['GET', '/api/learning/report/export.csv']
  ];
  for (const [method, url, body] of calls) {
    const response = await h.api(null, method, url, body);
    assert.equal(response.status, 401, `${method} ${url}`);
  }
});

test('Nur HR pflegt den Kurskatalog', async () => {
  for (const person of ['anna', 'manager', 'director']) {
    const created = await h.api(person, 'POST', '/api/learning/courses', { title: 'Nicht erlaubt', courseType: 'online' });
    assert.equal(created.status, 403, person);
  }
  const id = await createCourse(h);
  const patched = await h.api('manager', 'PATCH', `/api/learning/courses/${id}`, { title: 'Geändert' });
  assert.equal(patched.status, 403);
  assert.notEqual(h.db.prepare('SELECT title FROM learning_courses WHERE id=?').get(id).title, 'Geändert');

  const byPartner = await h.api('bp', 'POST', '/api/learning/courses', { title: 'Vom HR Business Partner', courseType: 'classroom' });
  assert.equal(byPartner.status, 200);
  const audit = h.db.prepare("SELECT * FROM audit_log WHERE action='learning_course_created' AND entity_id=?").get(byPartner.data.id);
  assert.ok(audit, 'Das Anlegen wird protokolliert');
});

test('Kurslinks: nur http und https, serverseitig geprüft', async () => {
  const rejected = [
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    '  javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
    'ftp://example.org/kurs',
    '//example.org/kurs',
    'example.org/kurs',
    'https://bank.example@boese.example/',
    42
  ];
  for (const linkUrl of rejected) {
    const response = await h.api('hr', 'POST', '/api/learning/courses', { title: 'Link', courseType: 'online', linkUrl });
    assert.equal(response.status, 400, String(linkUrl));
  }
  const id = await createCourse(h, { linkUrl: 'https://example.org/kurs?a=1' });
  assert.equal(h.db.prepare('SELECT link_url FROM learning_courses WHERE id=?').get(id).link_url, 'https://example.org/kurs?a=1');
  const patchRejected = await h.api('hr', 'PATCH', `/api/learning/courses/${id}`, { linkUrl: 'javascript:alert(1)' });
  assert.equal(patchRejected.status, 400);
  const plainHttp = await h.api('hr', 'PATCH', `/api/learning/courses/${id}`, { linkUrl: 'http://example.org/' });
  assert.equal(plainHttp.status, 200);
  const cleared = await h.api('hr', 'PATCH', `/api/learning/courses/${id}`, { linkUrl: '' });
  assert.equal(cleared.data.course.linkUrl, null);
});

test('Ungültige Kursangaben werden abgelehnt', async () => {
  const invalid = [
    { courseType: 'online' },
    { title: '   ', courseType: 'online' },
    { title: 'Art fehlt' },
    { title: 'Unbekannte Art', courseType: 'webinar' },
    { title: 'Art aus dem Prototyp', courseType: 'constructor' },
    { title: 'Art als Liste', courseType: ['online'] },
    { title: 'Dauer', courseType: 'online', durationMinutes: 'lang' },
    { title: 'Dauer', courseType: 'online', durationMinutes: -5 },
    { title: 'Gültigkeit', courseType: 'online', validityMonths: 1.5 },
    { title: 'Gültigkeit', courseType: 'online', validityMonths: [12] }
  ];
  for (const body of invalid) {
    const response = await h.api('hr', 'POST', '/api/learning/courses', body);
    assert.equal(response.status, 400, JSON.stringify(body));
  }
  const missing = await h.api('hr', 'PATCH', '/api/learning/courses/999999', { title: 'Gibt es nicht' });
  assert.equal(missing.status, 404);
  const notANumber = await h.api('hr', 'PATCH', '/api/learning/courses/abc', { title: 'Keine Zahl' });
  assert.equal(notANumber.status, 404);
});

test('Bestätigung gibt es nur bei Pflichtkursen', async () => {
  const voluntary = await createCourse(h, { mandatory: false, requiresConfirmation: true });
  assert.equal(h.db.prepare('SELECT requires_confirmation FROM learning_courses WHERE id=?').get(voluntary).requires_confirmation, 0);
  const mandatory = await createCourse(h, { mandatory: true, requiresConfirmation: true });
  assert.equal(h.db.prepare('SELECT requires_confirmation FROM learning_courses WHERE id=?').get(mandatory).requires_confirmation, 1);
});

test('Beschäftigte sehen nur aktive Kurse, HR auf Wunsch auch inaktive', async () => {
  const id = await createCourse(h, { active: false, title: 'Stillgelegter Kurs' });
  const forEmployee = await h.api('anna', 'GET', '/api/learning/courses?includeInactive=true');
  assert.ok(!forEmployee.data.courses.some(course => course.id === id));
  const forHr = await h.api('hr', 'GET', '/api/learning/courses');
  assert.ok(!forHr.data.courses.some(course => course.id === id));
  const withInactive = await h.api('hr', 'GET', '/api/learning/courses?includeInactive=true');
  assert.ok(withInactive.data.courses.some(course => course.id === id));
});

test('Massenzuweisung: einzelne Personen, Rollen und alle, ohne Doppel und mit Aufgabe je Person', async () => {
  const courseId = await createCourse(h, { mandatory: true });

  const single = await assign(h, courseId, { userIds: [5, 5, 6] });
  assert.equal(single.created, 2, 'Doppelte IDs in der Anfrage zählen einmal');

  const byRole = await assign(h, courseId, { roles: ['employee'] });
  assert.equal(byRole.created, 1, 'Nur Clara ist neu');
  assert.equal(byRole.alreadyOpen, 2, 'Anna und Ben haben den Kurs schon offen');

  const everyone = await assign(h, courseId, { all: true });
  assert.equal(everyone.created, 4, 'hr, bp, director und manager kommen dazu');
  assert.equal(everyone.alreadyOpen, 3);

  const again = await assign(h, courseId, { all: true });
  assert.equal(again.created, 0);
  assert.equal(again.alreadyOpen, 7);

  const rows = h.db.prepare('SELECT id, user_id FROM learning_assignments WHERE course_id=?').all(courseId);
  assert.equal(rows.length, 7);
  assert.equal(new Set(rows.map(row => row.user_id)).size, 7);
  for (const row of rows) {
    const tasks = openTasks(h, 'learning_assignment', row.id);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].user_id, row.user_id);
  }
});

test('Die Datenbank verhindert eine zweite offene Zuweisung auch ohne Vorabprüfung', async () => {
  const courseId = await createCourse(h);
  await assign(h, courseId, { userIds: [7] });
  assert.throws(() => h.db.prepare(`
    INSERT INTO learning_assignments(user_id, course_id, source, status, created_at, updated_at)
    VALUES(7, ?, 'hr', 'assigned', 'x', 'x')
  `).run(courseId), /UNIQUE/);
});

test('Massenzuweisung übergeht gesperrte Konten und Systemkonten', async () => {
  const harness = await createModuleHarness(createLearningModule);
  try {
    harness.db.prepare('UPDATE users SET active=0 WHERE id=6').run();
    harness.db.prepare('UPDATE users SET is_system_account=1 WHERE id=7').run();
    const courseId = await createCourse(harness);
    const result = await assign(harness, courseId, { all: true });
    assert.equal(result.created, 5);
    const assigned = harness.db.prepare('SELECT user_id FROM learning_assignments WHERE course_id=?').all(courseId).map(row => row.user_id);
    assert.ok(!assigned.includes(6) && !assigned.includes(7));
    const locked = await harness.api('hr', 'POST', '/api/learning/assignments', { courseId, userIds: [6] });
    assert.equal(locked.status, 400);
  } finally {
    await harness.close();
  }
});

test('Rollengrenzen beim Zuweisen', async () => {
  const courseId = await createCourse(h);
  const body = target => ({ courseId, dueDate: shiftDays(10), ...target });

  const employee = await h.api('anna', 'POST', '/api/learning/assignments', body({ userIds: [6] }));
  assert.equal(employee.status, 403, 'Mitarbeitende weisen nichts zu');

  const foreignTeam = await h.api('manager', 'POST', '/api/learning/assignments', body({ userIds: [7] }));
  assert.equal(foreignTeam.status, 403, 'Clara gehört nicht zum Team von manager');

  const indirect = await h.api('director', 'POST', '/api/learning/assignments', body({ userIds: [5] }));
  assert.equal(indirect.status, 403, 'Anna ist für director nur indirekt unterstellt');

  const self = await h.api('manager', 'POST', '/api/learning/assignments', body({ userIds: [4] }));
  assert.equal(self.status, 403, 'Sich selbst zuweisen ist kein Führungsvorgang');

  const mixed = await h.api('manager', 'POST', '/api/learning/assignments', body({ userIds: [5, 7] }));
  assert.equal(mixed.status, 403, 'Eine fremde Person blockiert die ganze Anfrage');

  for (const target of [{ roles: ['employee'] }, { all: true }]) {
    const wide = await h.api('manager', 'POST', '/api/learning/assignments', body(target));
    assert.equal(wide.status, 403, JSON.stringify(target));
  }
  assert.equal(h.db.prepare('SELECT COUNT(*) AS count FROM learning_assignments WHERE course_id=?').get(courseId).count, 0);

  const allowed = await h.api('manager', 'POST', '/api/learning/assignments', body({ userIds: [5, 6] }));
  assert.equal(allowed.status, 200);
  assert.equal(allowed.data.created, 2);
  const direct = await h.api('director', 'POST', '/api/learning/assignments', body({ userIds: [7] }));
  assert.equal(direct.data.created, 1);
  assert.equal(assignmentRow(h, direct.data.ids[0]).assigned_by, 3);
  assert.equal(assignmentRow(h, direct.data.ids[0]).source, 'manager');
});

test('Zuweisen prüft Kurs, Frist und Zielgruppe', async () => {
  const courseId = await createCourse(h);
  const inactive = await createCourse(h, { active: false });
  const calls = [
    { courseId, userIds: [5], dueDate: '2026-13-45' },
    { courseId, userIds: [5], dueDate: '2026-02-30' },
    { courseId, userIds: [5], dueDate: ['2030-01-01'] },
    { courseId, userIds: [5], dueDate: shiftDays(-1) },
    { courseId, userIds: [424242], dueDate: shiftDays(5) },
    { courseId, userIds: ['abc'], dueDate: shiftDays(5) },
    { courseId, roles: ['super_admin'], dueDate: shiftDays(5) },
    { courseId, dueDate: shiftDays(5) },
    { courseId, userIds: [5], all: true, dueDate: shiftDays(5) },
    { courseId: inactive, userIds: [5], dueDate: shiftDays(5) },
    { courseId: 999999, userIds: [5], dueDate: shiftDays(5) }
  ];
  for (const body of calls) {
    const response = await h.api('hr', 'POST', '/api/learning/assignments', body);
    assert.equal(response.status, 400, JSON.stringify(body));
  }
});

test('Selbst anmelden: nur für aktive freiwillige Kurse', async () => {
  const voluntary = await createCourse(h);
  const enrolled = await h.api('clara', 'POST', `/api/learning/courses/${voluntary}/enroll`);
  assert.equal(enrolled.status, 200);
  const row = assignmentRow(h, enrolled.data.id);
  assert.equal(row.user_id, 7);
  assert.equal(row.source, 'self');
  assert.equal(row.status, 'assigned');

  const twice = await h.api('clara', 'POST', `/api/learning/courses/${voluntary}/enroll`);
  assert.equal(twice.status, 409);

  const mandatory = await createCourse(h, { mandatory: true });
  const refused = await h.api('clara', 'POST', `/api/learning/courses/${mandatory}/enroll`);
  assert.equal(refused.status, 400);

  const inactive = await createCourse(h, { active: false });
  assert.equal((await h.api('clara', 'POST', `/api/learning/courses/${inactive}/enroll`)).status, 404);
  assert.equal((await h.api('clara', 'POST', '/api/learning/courses/999999/enroll')).status, 404);
});

test('Abschluss ohne Bestätigung: von Beginn bis Aufgabe erledigt', async () => {
  const courseId = await createCourse(h, { mandatory: true, validityMonths: 12, provider: 'Testanbieter' });
  const { ids: [id] } = await assign(h, courseId, { userIds: [5] });

  const foreignStart = await h.api('ben', 'POST', `/api/learning/assignments/${id}/start`);
  assert.equal(foreignStart.status, 403);
  const started = await h.api('anna', 'POST', `/api/learning/assignments/${id}/start`);
  assert.equal(started.status, 200);
  assert.equal(assignmentRow(h, id).status, 'started');
  assert.equal((await h.api('anna', 'POST', `/api/learning/assignments/${id}/start`)).status, 409);

  for (const person of ['ben', 'manager', 'director']) {
    const foreign = await h.api(person, 'POST', `/api/learning/assignments/${id}/complete`, { proof: 'Fremd' });
    assert.equal(foreign.status, 403, person);
  }
  const invalidDate = await h.api('anna', 'POST', `/api/learning/assignments/${id}/complete`, { completedAt: '2026-02-31' });
  assert.equal(invalidDate.status, 400);
  const futureDate = await h.api('anna', 'POST', `/api/learning/assignments/${id}/complete`, { completedAt: shiftDays(2) });
  assert.equal(futureDate.status, 400);
  assert.equal(openTasks(h, 'learning_assignment', id).length, 1);

  const done = await h.api('anna', 'POST', `/api/learning/assignments/${id}/complete`, { proof: 'Zertifikat Nr. 42' });
  assert.equal(done.status, 200);
  assert.equal(done.data.status, 'completed');
  const row = assignmentRow(h, id);
  assert.equal(row.status, 'completed');
  assert.equal(row.completed_at, today());
  assert.equal(row.proof_text, 'Zertifikat Nr. 42');
  assert.ok(row.expires_at > today());
  assert.equal(openTasks(h, 'learning_assignment', id).length, 0, 'Der Abschluss erledigt die Aufgabe');

  const again = await h.api('anna', 'POST', `/api/learning/assignments/${id}/complete`, { proof: 'Noch einmal' });
  assert.equal(again.status, 409);
  assert.equal((await h.api('anna', 'POST', '/api/learning/assignments/999999/complete', {})).status, 404);
});

test('Das Ablaufdatum läuft nicht über das Monatsende hinaus', async () => {
  const courseId = await createCourse(h, { validityMonths: 1 });
  const { ids: [id] } = await assign(h, courseId, { userIds: [6] });
  const year = new Date().getUTCFullYear() - 1;
  const response = await h.api('ben', 'POST', `/api/learning/assignments/${id}/complete`, { completedAt: `${year}-01-31` });
  assert.equal(response.status, 200);
  const lastDayOfFebruary = new Date(Date.UTC(year, 2, 0)).getUTCDate();
  assert.equal(assignmentRow(h, id).expires_at, `${year}-02-${lastDayOfFebruary}`);
});

test('HR kann den Abschluss für andere erfassen, Führungskräfte nicht', async () => {
  const courseId = await createCourse(h, { mandatory: true, requiresConfirmation: true });
  const { ids: [id] } = await assign(h, courseId, { userIds: [6] });
  const response = await h.api('bp', 'POST', `/api/learning/assignments/${id}/complete`, { proof: 'Teilnahmeliste' });
  assert.equal(response.status, 200);
  assert.equal(response.data.status, 'completed');
  const row = assignmentRow(h, id);
  assert.equal(row.confirmed_by, 2);
  assert.equal(allTasks(h, 'learning_confirmation', id).length, 0);
});

test('Abschluss mit Bestätigung: Aufgabe an die direkte Führungskraft, nur sie oder HR bestätigt', async () => {
  const courseId = await createCourse(h, { mandatory: true, requiresConfirmation: true, validityMonths: 24 });
  const { ids: [id] } = await assign(h, courseId, { userIds: [5] });

  const reported = await h.api('anna', 'POST', `/api/learning/assignments/${id}/complete`, { proof: 'Teilgenommen' });
  assert.equal(reported.status, 200);
  assert.equal(reported.data.confirmationPending, true);
  let row = assignmentRow(h, id);
  assert.equal(row.status, 'started');
  assert.equal(row.confirmation_pending, 1);
  assert.equal(row.completed_at, null);
  assert.equal(row.expires_at, null);
  assert.equal(openTasks(h, 'learning_assignment', id).length, 0, 'Die Person hat ihren Teil getan, jetzt liegt es bei der Führungskraft');

  const confirmationTasks = openTasks(h, 'learning_confirmation', id);
  assert.equal(confirmationTasks.length, 1);
  assert.equal(confirmationTasks[0].user_id, 4);

  assert.equal((await h.api('anna', 'POST', `/api/learning/assignments/${id}/complete`, {})).status, 409, 'Doppelt melden geht nicht');
  for (const person of ['anna', 'ben', 'clara', 'director']) {
    const denied = await h.api(person, 'POST', `/api/learning/assignments/${id}/confirm`, { approved: true });
    assert.equal(denied.status, 403, person);
  }
  assert.equal((await h.api('manager', 'POST', `/api/learning/assignments/${id}/confirm`, {})).status, 400);
  assert.equal((await h.api('manager', 'POST', `/api/learning/assignments/${id}/confirm`, { approved: false })).status, 400, 'Ablehnung braucht eine Begründung');

  const rejected = await h.api('manager', 'POST', `/api/learning/assignments/${id}/confirm`, { approved: false, comment: 'Nachweis fehlt' });
  assert.equal(rejected.status, 200);
  row = assignmentRow(h, id);
  assert.equal(row.status, 'started');
  assert.equal(row.confirmation_pending, 0);
  assert.equal(row.confirmation_note, 'Nachweis fehlt');
  assert.equal(openTasks(h, 'learning_confirmation', id).length, 0);
  assert.equal(openTasks(h, 'learning_assignment', id).length, 1, 'Die Person muss weiter nacharbeiten');
  assert.equal((await h.api('manager', 'POST', `/api/learning/assignments/${id}/confirm`, { approved: true })).status, 409, 'Nichts wartet mehr auf Bestätigung');

  await h.api('anna', 'POST', `/api/learning/assignments/${id}/complete`, { proof: 'Nachweis ergänzt' });
  const confirmed = await h.api('manager', 'POST', `/api/learning/assignments/${id}/confirm`, { approved: true });
  assert.equal(confirmed.status, 200);
  row = assignmentRow(h, id);
  assert.equal(row.status, 'completed');
  assert.equal(row.completed_at, today());
  assert.equal(row.confirmed_by, 4);
  assert.equal(row.proof_text, 'Nachweis ergänzt');
  assert.ok(row.expires_at > today());
  assert.equal(openTasks(h, 'learning_assignment', id).length, 0);
  assert.equal(openTasks(h, 'learning_confirmation', id).length, 0);
});

test('HR darf den eigenen Abschluss nicht selbst bestätigen', async () => {
  const courseId = await createCourse(h, { mandatory: true, requiresConfirmation: true });
  const { ids: [id] } = await assign(h, courseId, { userIds: [2] });
  const reported = await h.api('bp', 'POST', `/api/learning/assignments/${id}/complete`, {});
  assert.equal(reported.data.confirmationPending, true);
  const recipients = openTasks(h, 'learning_confirmation', id).map(task => task.user_id);
  assert.deepEqual(recipients, [1], 'Ohne Führungskraft geht die Aufgabe an andere HR-Personen');
  assert.equal((await h.api('bp', 'POST', `/api/learning/assignments/${id}/confirm`, { approved: true })).status, 403);
  assert.equal((await h.api('hr', 'POST', `/api/learning/assignments/${id}/confirm`, { approved: true })).status, 200);
});

test('Den Abschluss der HR-Leitung bestätigt keine HR-Rolle ohne Zugriff auf ihre Daten', async () => {
  const harness = await createModuleHarness(createLearningModule);
  try {
    const courseId = await createCourse(harness, { mandatory: true, requiresConfirmation: true });
    const secondAdmin = harness.deps.createUserAccount({ name: 'Zweite Admin', email: 'zweite@test.local', role: 'hr_admin', actor: { id: 1 } }).id;
    const { ids: [id] } = await assign(harness, courseId, { userIds: [1] });
    const reported = await harness.api('hr', 'POST', `/api/learning/assignments/${id}/complete`, {});
    assert.equal(reported.data.confirmationPending, true);
    assert.deepEqual(openTasks(harness, 'learning_confirmation', id).map(task => task.user_id), [secondAdmin], 'Nur die andere HR-Administration');
    assert.equal((await harness.api('bp', 'POST', `/api/learning/assignments/${id}/confirm`, { approved: true })).status, 403);
    assert.equal((await harness.api(secondAdmin, 'POST', `/api/learning/assignments/${id}/confirm`, { approved: true })).status, 200);

    // Ohne zweite HR-Administration gibt es niemanden mit Zugriff. Der Abschluss gilt dann unbestätigt.
    harness.db.prepare('UPDATE users SET active=0 WHERE id=?').run(secondAdmin);
    const second = await createCourse(harness, { mandatory: true, requiresConfirmation: true });
    const { ids: [other] } = await assign(harness, second, { userIds: [1] });
    const alone = await harness.api('hr', 'POST', `/api/learning/assignments/${other}/complete`, {});
    assert.equal(alone.data.status, 'completed');
    assert.equal(assignmentRow(harness, other).confirmed_by, null);
    assert.equal(openTasks(harness, 'learning_confirmation', other).length, 0);
  } finally {
    await harness.close();
  }
});

test('Ist HR die direkte Führungskraft, bestätigt sie auch bei der HR-Leitung', async () => {
  const harness = await createModuleHarness(createLearningModule);
  try {
    harness.db.prepare('UPDATE users SET manager_id=2 WHERE id=1').run();
    const courseId = await createCourse(harness, { mandatory: true, requiresConfirmation: true });
    const { ids: [id] } = await assign(harness, courseId, { userIds: [1] });
    await harness.api('hr', 'POST', `/api/learning/assignments/${id}/complete`, {});
    assert.deepEqual(openTasks(harness, 'learning_confirmation', id).map(task => task.user_id), [2]);
    const pending = (await harness.api('bp', 'GET', '/api/learning/team')).data.pendingConfirmations;
    assert.deepEqual(pending.map(item => item.id), [id], 'Auf der Seite, zu der die Aufgabe führt, steht sie auch');
    assert.equal((await harness.api('bp', 'POST', `/api/learning/assignments/${id}/confirm`, { approved: true })).status, 200, 'Sonst bliebe die Aufgabe für immer offen');
  } finally {
    await harness.close();
  }
});

test('Die HR-Sachbearbeitung nutzt Lernen wie alle Mitarbeitenden', async () => {
  const harness = await createModuleHarness(createLearningModule);
  try {
    const staff = harness.deps.createUserAccount({ name: 'Sach Bearbeiter', email: 'sb@test.local', role: 'hr_staff', actor: { id: 1 } }).id;
    const courseId = await createCourse(harness, { mandatory: true, requiresConfirmation: true });
    const free = await createCourse(harness);

    const byRole = await assign(harness, courseId, { roles: ['hr_staff'] });
    assert.equal(byRole.created, 1, 'Als Zielgruppe lässt sie sich wählen');
    const id = byRole.ids[0];
    assert.equal((await harness.api(staff, 'GET', '/api/learning/my')).data.open.length, 1);
    assert.equal((await harness.api(staff, 'POST', `/api/learning/courses/${free}/enroll`, {})).status, 200);
    const reported = await harness.api(staff, 'POST', `/api/learning/assignments/${id}/complete`, {});
    assert.equal(reported.data.confirmationPending, true);
    assert.deepEqual(openTasks(harness, 'learning_confirmation', id).map(task => task.user_id).sort(), [1, 2], 'HR bestätigt, nicht sie selbst');
    const denied = [
      ['GET', '/api/learning/team'],
      ['GET', '/api/learning/report'],
      ['GET', '/api/learning/report/export.csv'],
      ['POST', '/api/learning/courses', { title: 'Neu', courseType: 'online' }],
      ['PATCH', `/api/learning/courses/${free}`, { title: 'Neu' }],
      ['POST', '/api/learning/assignments', { courseId: free, userIds: [5] }],
      ['POST', `/api/learning/assignments/${id}/confirm`, { approved: true }]
    ];
    for (const [method, url, body] of denied) {
      assert.equal((await harness.api(staff, method, url, body)).status, 403, `${method} ${url}`);
    }
    const { ids: [annas] } = await assign(harness, free, { userIds: [5] });
    assert.equal((await harness.api(staff, 'POST', `/api/learning/assignments/${annas}/complete`, {})).status, 403, 'Auch nicht für andere');
  } finally {
    await harness.close();
  }
});

test('HR Business Partner sehen und ändern nichts an den Kursen der HR-Leitung', async () => {
  const harness = await createModuleHarness(createLearningModule);
  try {
    const courseId = await createCourse(harness, { title: 'Pflichtkurs', mandatory: true });
    const { ids: [adminCourse] } = await assign(harness, courseId, { userIds: [1] });
    await assign(harness, courseId, { userIds: [5] });

    const team = (await harness.api('bp', 'GET', '/api/learning/team')).data;
    assert.equal(team.people.some(person => person.id === 1), false, 'Nicht im Lernstand');
    assert.ok(team.people.some(person => person.id === 5));
    const report = (await harness.api('bp', 'GET', '/api/learning/report')).data;
    assert.equal(report.people.some(person => person.userId === 1), false, 'Nicht in der Erfüllung je Person');
    assert.equal(report.overall.required, 1, 'Auch nicht in der Summe, sonst ließe sie sich errechnen');
    assert.equal(report.courses.find(course => course.courseId === courseId).required, 1);
    assert.equal((await harness.api('hr', 'GET', '/api/learning/report')).data.overall.required, 2, 'Die HR-Administration sieht alle');
    const csv = await harness.api('bp', 'GET', '/api/learning/report/export.csv');
    assert.equal(String(csv.data).includes('Hanna HR'), false, 'Nicht im Export');
    assert.equal(String((await harness.api('hr', 'GET', '/api/learning/report/export.csv')).data).includes('Hanna HR'), true);

    assert.equal((await harness.api('bp', 'POST', `/api/learning/assignments/${adminCourse}/complete`, {})).status, 403);
    const free = await createCourse(harness);
    assert.equal((await harness.api('bp', 'POST', '/api/learning/assignments', { courseId: free, userIds: [1] })).status, 403, 'Nicht gezielt');
    assert.equal((await harness.api('bp', 'POST', '/api/learning/assignments', { courseId: free, roles: ['hr_admin'] })).status, 403, 'Nicht über die Rolle');
    const everyone = await harness.api('bp', 'POST', '/api/learning/assignments', { courseId: free, all: true });
    assert.equal(everyone.status, 200, 'Ein Kurs für alle meint auch die HR-Leitung');
    assert.equal(everyone.data.created, 7);
    assert.ok(harness.db.prepare('SELECT id FROM learning_assignments WHERE user_id=1 AND course_id=?').get(free));
  } finally {
    await harness.close();
  }
});

test('Aufgaben: Überfällig nennt die echte Frist und ersetzt die Aufgabe „abschließen“', async () => {
  const harness = await createModuleHarness(createLearningModule);
  try {
    const courseId = await createCourse(harness, { title: 'Brandschutz' });
    const dueDate = shiftDays(5);
    const { ids: [id] } = await assign(harness, courseId, { userIds: [5] }, 'hr', dueDate);
    const [start] = openTasks(harness, 'learning_assignment', id);
    assert.equal(start.due_date, dueDate, 'Die Aufgabe trägt die Frist der Schulung');
    assert.match(start.title, /Brandschutz/);

    const pastDue = shiftDays(-3);
    harness.db.prepare('UPDATE learning_assignments SET due_date=? WHERE id=?').run(pastDue, id);
    harness.instance.maintenance();
    assert.equal(openTasks(harness, 'learning_assignment', id).length, 0, 'Zwei Aufgaben für denselben Kurs wären doppelt');
    const overdue = openTasks(harness, 'learning_overdue', id);
    assert.deepEqual(overdue.map(task => task.user_id).sort(), [4, 5]);
    assert.ok(overdue.every(task => task.due_date === pastDue), 'Fällig ist die überschrittene Frist, nicht der heutige Tag');
    assert.match(overdue.find(task => task.user_id === 4).title, /Anna Ahrens/, 'Die Führungskraft sieht, um wen es geht');
    assert.equal((await harness.api('anna', 'POST', `/api/learning/assignments/${id}/complete`, {})).status, 200);
    assert.equal(openTasks(harness, 'learning_overdue', id).length, 0);
  } finally {
    await harness.close();
  }
});

test('Aufgaben ziehen beim Wechsel der Führungskraft mit', async () => {
  const harness = await createModuleHarness(createLearningModule);
  try {
    const courseId = await createCourse(harness, { title: 'Sicherheit', mandatory: true, requiresConfirmation: true });
    const { ids: [confirming] } = await assign(harness, courseId, { userIds: [5] });
    await harness.api('anna', 'POST', `/api/learning/assignments/${confirming}/complete`, {});
    assert.deepEqual(openTasks(harness, 'learning_confirmation', confirming).map(task => task.user_id), [4]);

    const late = await createCourse(harness, { title: 'Datenschutz' });
    const { ids: [overdueId] } = await assign(harness, late, { userIds: [5] });
    harness.db.prepare('UPDATE learning_assignments SET due_date=? WHERE id=?').run(shiftDays(-3), overdueId);
    harness.instance.maintenance();
    assert.deepEqual(openTasks(harness, 'learning_overdue', overdueId).map(task => task.user_id).sort(), [4, 5]);

    harness.deps.changeManager(5, 3);
    assert.deepEqual(openTasks(harness, 'learning_confirmation', confirming).map(task => task.user_id), [3], 'Die neue Führungskraft bestätigt');
    assert.deepEqual(openTasks(harness, 'learning_overdue', overdueId).map(task => task.user_id).sort(), [3, 5], 'Die Person behält ihre eigene Aufgabe');
    assert.equal((await harness.api('manager', 'POST', `/api/learning/assignments/${confirming}/confirm`, { approved: true })).status, 403);
    assert.equal((await harness.api('director', 'POST', `/api/learning/assignments/${confirming}/confirm`, { approved: true })).status, 200);

    // Ohne neue Führungskraft bestätigt HR, der reine Hinweis ist hinfällig.
    const third = await createCourse(harness, { title: 'Erste Hilfe', mandatory: true, requiresConfirmation: true });
    const { ids: [withHr] } = await assign(harness, third, { userIds: [5] });
    await harness.api('anna', 'POST', `/api/learning/assignments/${withHr}/complete`, {});
    harness.deps.changeManager(5, null);
    assert.deepEqual(openTasks(harness, 'learning_confirmation', withHr).map(task => task.user_id).sort(), [1, 2]);
    assert.ok(openTasks(harness, 'learning_confirmation', withHr).every(task => /Anna Ahrens/.test(task.title)));
    assert.ok(openTasks(harness, 'learning_confirmation', withHr).every(task => task.due_date === shiftDays(30)), 'Die Frist der Schulung zieht mit');
    assert.deepEqual(openTasks(harness, 'learning_overdue', overdueId).map(task => task.user_id), [5]);

    // Wer im Modul kein Team sieht, bekommt auch keinen Hinweis, dem er nicht nachgehen könnte.
    harness.deps.changeManager(5, 7);
    harness.db.prepare('UPDATE learning_assignments SET overdue_reminded=0 WHERE id=?').run(overdueId);
    harness.db.prepare("UPDATE tasks SET done=1 WHERE type='learning_overdue' AND entity_id=?").run(overdueId);
    harness.instance.maintenance();
    assert.deepEqual(openTasks(harness, 'learning_overdue', overdueId).map(task => task.user_id), [5], 'Clara ist keine Führungskraft in der Rolle');
  } finally {
    await harness.close();
  }
});

test('Aufgaben schließen sich, wenn der Kurs abgeschaltet wird, und kommen mit ihm zurück', async () => {
  const harness = await createModuleHarness(createLearningModule);
  try {
    const courseId = await createCourse(harness, { title: 'Alter Kurs' });
    const { ids: [id] } = await assign(harness, courseId, { userIds: [5] });
    assert.equal(openTasks(harness, 'learning_assignment', id).length, 1);
    assert.equal((await harness.api('hr', 'PATCH', `/api/learning/courses/${courseId}`, { active: false })).status, 200);
    assert.equal(openTasks(harness, 'learning_assignment', id).length, 0, 'Ein abgeschalteter Kurs lässt sich nicht mehr verlangen');
    harness.db.prepare('UPDATE learning_assignments SET due_date=? WHERE id=?').run(shiftDays(-3), id);
    harness.instance.maintenance();
    assert.equal(openTasks(harness, 'learning_overdue', id).length, 0, 'Auch kein Hinweis auf eine Frist');
    harness.db.prepare('UPDATE learning_assignments SET due_date=? WHERE id=?').run(shiftDays(3), id);
    assert.equal((await harness.api('hr', 'PATCH', `/api/learning/courses/${courseId}`, { active: true })).status, 200);
    assert.equal(openTasks(harness, 'learning_assignment', id).length, 1);
  } finally {
    await harness.close();
  }
});

test('Ist die Person nicht mehr da, sind Hinweise und Bestätigungen an andere hinfällig', async () => {
  const harness = await createModuleHarness(createLearningModule);
  try {
    const courseId = await createCourse(harness, { title: 'Sicherheit', mandatory: true, requiresConfirmation: true });
    const { ids: [id] } = await assign(harness, courseId, { userIds: [5] });
    await harness.api('anna', 'POST', `/api/learning/assignments/${id}/complete`, {});
    assert.equal(openTasks(harness, 'learning_confirmation', id).length, 1);
    const second = await createCourse(harness, { title: 'Eigene Aufgabe' });
    const { ids: [own] } = await assign(harness, second, { userIds: [5] });
    harness.deps.setUserActive(5, false, null);
    harness.instance.maintenance();
    assert.equal(openTasks(harness, 'learning_confirmation', id).length, 0);
    assert.equal(openTasks(harness, 'learning_assignment', own).length, 1, 'Die eigene Aufgabe bleibt für einen Wiedereintritt erhalten');
  } finally {
    await harness.close();
  }
});

test('Oberfläche: Am Handy läuft nichts über den Rand und die Knöpfe bleiben sichtbar', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'learning.css'), 'utf8');
  const script = fs.readFileSync(path.join(__dirname, '..', 'public', 'learning.js'), 'utf8');
  assert.match(css, /\.learning-stack \{[^}]*grid-template-columns: minmax\(0, 1fr\)/, 'Sonst weitet die breiteste Tabelle die ganze Seite');
  assert.match(css, /@media \(max-width: 700px\)[^]*\.learning-table thead \{ display: none; \}/);
  assert.equal((script.match(/<table class="table">/g) || []).length, 0, 'Jede Tabelle wird am Handy zu Karten');
  for (const label of ['Status', 'Frist', 'Abschluss', 'Gültig bis', 'Art', 'Gültigkeit', 'Quote', 'Erfüllt', 'Überfällig']) {
    assert.ok(script.includes(`data-label="${label}"`), label);
  }
  assert.equal(script.includes('Führungslinie'.concat("'")), false);
  assert.equal(/Meine Führungslinie/.test(script), false, 'Verständlich: Mein Team');
});

test('Gibt es niemanden zum Bestätigen, bleibt der Abschluss nicht ewig hängen', async () => {
  const harness = await createModuleHarness(createLearningModule);
  try {
    harness.db.prepare('UPDATE users SET active=0 WHERE id=2').run();
    const courseId = await createCourse(harness, { mandatory: true, requiresConfirmation: true });
    const { ids: [id] } = await assign(harness, courseId, { userIds: [1] });
    const reported = await harness.api('hr', 'POST', `/api/learning/assignments/${id}/complete`, {});
    assert.equal(reported.data.status, 'completed');
    assert.equal(assignmentRow(harness, id).confirmed_by, null, 'Es wird nichts als bestätigt ausgegeben, was niemand bestätigt hat');
  } finally {
    await harness.close();
  }
});

test('Qualifikationseintrag: bei eingeschaltetem Talentmodul genau einmal', async () => {
  const courseId = await createCourse(h, { title: 'Ersthelfer', provider: 'Testanbieter', validityMonths: 24 });
  const { ids: [id] } = await assign(h, courseId, { userIds: [7] });
  await h.api('clara', 'POST', `/api/learning/assignments/${id}/complete`, { proof: 'Bescheinigung' });
  const records = () => h.db.prepare("SELECT * FROM qualification_records WHERE user_id=7 AND source='learning' AND title='Ersthelfer'").all();
  assert.equal(records().length, 1);
  const [record] = records();
  assert.equal(record.record_type, 'training');
  assert.equal(record.issuer, 'Testanbieter');
  assert.equal(record.issued_at, today());
  assert.equal(record.expires_at, assignmentRow(h, id).expires_at);
  assert.equal(record.evidence_text, 'Bescheinigung');
  assert.equal(record.status, 'valid');
  assert.equal(assignmentRow(h, id).qualification_record_id, record.id);

  assert.equal((await h.api('clara', 'POST', `/api/learning/assignments/${id}/complete`, {})).status, 409);
  h.instance.maintenance();
  h.instance.maintenance();
  assert.equal(records().length, 1);
});

test('Qualifikationseintrag bei Bestätigung erst danach und als geprüft', async () => {
  const courseId = await createCourse(h, { title: 'Brandschutz', mandatory: true, requiresConfirmation: true });
  const { ids: [id] } = await assign(h, courseId, { userIds: [5] });
  await h.api('anna', 'POST', `/api/learning/assignments/${id}/complete`, {});
  const records = () => h.db.prepare("SELECT * FROM qualification_records WHERE user_id=5 AND title='Brandschutz'").all();
  assert.equal(records().length, 0);
  await h.api('manager', 'POST', `/api/learning/assignments/${id}/confirm`, { approved: true });
  assert.equal(records().length, 1);
  assert.equal(records()[0].status, 'verified');
});

test('Ohne Talentmodul entsteht kein Qualifikationseintrag und Kompetenzen bleiben außen vor', async () => {
  const harness = await createModuleHarness(createLearningModule, { isModuleEnabled: key => key !== 'talent' });
  try {
    const competencyId = Number(harness.db.prepare("INSERT INTO competencies(name, name_normalized, category) VALUES('Testen', 'testen', 'technical')").run().lastInsertRowid);
    const courseId = await createCourse(harness, { competencyId });
    assert.equal(harness.db.prepare('SELECT competency_id FROM learning_courses WHERE id=?').get(courseId).competency_id, null);
    const { ids: [id] } = await assign(harness, courseId, { userIds: [5] });
    const done = await harness.api('anna', 'POST', `/api/learning/assignments/${id}/complete`, { proof: 'Nachweis' });
    assert.equal(done.data.status, 'completed');
    assert.equal(harness.db.prepare('SELECT COUNT(*) AS count FROM qualification_records').get().count, 0);
    assert.equal(assignmentRow(harness, id).qualification_record_id, null);
  } finally {
    await harness.close();
  }
});

test('Kompetenzverknüpfung nur bei eingeschaltetem Talentmodul und nur mit vorhandener Kompetenz', async () => {
  const competencyId = Number(h.db.prepare("INSERT INTO competencies(name, name_normalized, category) VALUES('Moderation Test', 'moderation test', 'social')").run().lastInsertRowid);
  const created = await h.api('hr', 'POST', '/api/learning/courses', { title: 'Mit Kompetenz', courseType: 'online', competencyId });
  assert.equal(created.status, 200);
  assert.deepEqual(created.data.course.competency, { id: competencyId, name: 'Moderation Test' });
  const unknown = await h.api('hr', 'POST', '/api/learning/courses', { title: 'Ohne Kompetenz', courseType: 'online', competencyId: 999999 });
  assert.equal(unknown.status, 400);
  const cleared = await h.api('hr', 'PATCH', `/api/learning/courses/${created.data.id}`, { competencyId: '' });
  assert.equal(cleared.data.course.competency, null);
});

test('Wartung: Überfällige erhalten genau einmal eine Erinnerung, auch die direkte Führungskraft', async () => {
  const harness = await createModuleHarness(createLearningModule);
  try {
    const courseId = await createCourse(harness, { title: 'Fristkurs' });
    const { ids: [annaId, claraId, hrId] } = await assign(harness, courseId, { userIds: [5, 7, 1] }, 'hr', shiftDays(1));
    harness.db.prepare('UPDATE learning_assignments SET due_date=? WHERE course_id=?').run(shiftDays(-3), courseId);

    const firstRun = harness.instance.maintenance();
    assert.equal(firstRun.overdueReminded, 3);
    const recipients = id => openTasks(harness, 'learning_overdue', id).map(task => task.user_id).sort();
    assert.deepEqual(recipients(annaId), [4, 5]);
    assert.deepEqual(recipients(claraId), [3, 7]);
    assert.deepEqual(recipients(hrId), [1], 'Ohne Führungskraft nur die Person selbst');

    for (let run = 0; run < 3; run += 1) {
      const nextRun = harness.instance.maintenance();
      assert.equal(nextRun.overdueReminded, 0);
    }
    assert.equal(allTasks(harness, 'learning_overdue', annaId).length, 2, 'Keine weiteren Erinnerungen');

    await harness.api('anna', 'POST', `/api/learning/assignments/${annaId}/complete`, {});
    assert.equal(openTasks(harness, 'learning_overdue', annaId).length, 0, 'Der Abschluss erledigt auch die Erinnerungen');
    harness.instance.maintenance();
    assert.equal(allTasks(harness, 'learning_overdue', annaId).length, 2);
  } finally {
    await harness.close();
  }
});

test('Wartung: Nicht überfällig ist, was noch Frist hat, gesperrt ist oder auf Bestätigung wartet', async () => {
  const harness = await createModuleHarness(createLearningModule);
  try {
    const courseId = await createCourse(harness, { mandatory: true, requiresConfirmation: true });
    const { ids: [waiting, inTime, locked] } = await assign(harness, courseId, { userIds: [5, 6, 7] });
    await harness.api('anna', 'POST', `/api/learning/assignments/${waiting}/complete`, {});
    harness.db.prepare('UPDATE learning_assignments SET due_date=? WHERE id IN (?, ?)').run(shiftDays(-1), waiting, locked);
    harness.db.prepare('UPDATE learning_assignments SET due_date=? WHERE id=?').run(today(), inTime);
    harness.db.prepare('UPDATE users SET active=0 WHERE id=7').run();
    assert.equal(harness.instance.maintenance().overdueReminded, 0);
    assert.equal(harness.db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE type='learning_overdue'").get().count, 0);
  } finally {
    await harness.close();
  }
});

test('Wartung: Rezertifizierung entsteht genau einmal, abgelaufene werden markiert', async () => {
  const harness = await createModuleHarness(createLearningModule);
  try {
    const courseId = await createCourse(harness, { title: 'Jährliche Pflicht', mandatory: true, validityMonths: 12 });
    const { ids: [id] } = await assign(harness, courseId, { userIds: [5] });
    await harness.api('anna', 'POST', `/api/learning/assignments/${id}/complete`, {});
    const countFor = () => harness.db.prepare('SELECT COUNT(*) AS count FROM learning_assignments WHERE course_id=? AND user_id=5').get(courseId).count;

    harness.db.prepare('UPDATE learning_assignments SET expires_at=? WHERE id=?').run(shiftDays(31), id);
    assert.equal(harness.instance.maintenance().recertifications, 0, '31 Tage vor Ablauf ist es noch zu früh');
    assert.equal(countFor(), 1);

    harness.db.prepare('UPDATE learning_assignments SET expires_at=? WHERE id=?').run(shiftDays(30), id);
    assert.equal(harness.instance.maintenance().recertifications, 1);
    assert.equal(countFor(), 2);
    const original = assignmentRow(harness, id);
    assert.equal(original.status, 'completed', 'Der alte Abschluss gilt bis zum Ablauf weiter');
    const renewed = assignmentRow(harness, original.recertification_id);
    assert.equal(renewed.source, 'recertification');
    assert.equal(renewed.status, 'assigned');
    assert.equal(renewed.due_date, shiftDays(30));
    assert.equal(renewed.user_id, 5);
    assert.equal(openTasks(harness, 'learning_assignment', renewed.id).length, 1);

    for (let run = 0; run < 3; run += 1) assert.equal(harness.instance.maintenance().recertifications, 0);
    assert.equal(countFor(), 2);

    harness.db.prepare('UPDATE learning_assignments SET expires_at=? WHERE id=?').run(shiftDays(-1), id);
    const expiredRun = harness.instance.maintenance();
    assert.equal(expiredRun.expired, 1);
    assert.equal(expiredRun.recertifications, 0);
    assert.equal(assignmentRow(harness, id).status, 'expired');
    assert.equal(harness.instance.maintenance().expired, 0);
    assert.equal(countFor(), 2);
  } finally {
    await harness.close();
  }
});

test('Wartung: keine Rezertifizierung neben offener Zuweisung, neuerem Abschluss oder freiwilligem Kurs', async () => {
  const harness = await createModuleHarness(createLearningModule);
  try {
    const mandatory = await createCourse(harness, { mandatory: true, validityMonths: 12 });
    const voluntary = await createCourse(harness, { mandatory: false, validityMonths: 12 });
    const inactive = await createCourse(harness, { mandatory: true, validityMonths: 12 });

    const { ids: [annaFirst] } = await assign(harness, mandatory, { userIds: [5] });
    await harness.api('anna', 'POST', `/api/learning/assignments/${annaFirst}/complete`, {});
    const { ids: [annaOpen] } = await assign(harness, mandatory, { userIds: [5] });

    const { ids: [benFirst] } = await assign(harness, mandatory, { userIds: [6] });
    await harness.api('ben', 'POST', `/api/learning/assignments/${benFirst}/complete`, {});
    const { ids: [benSecond] } = await assign(harness, mandatory, { userIds: [6] });
    await harness.api('ben', 'POST', `/api/learning/assignments/${benSecond}/complete`, {});

    const { ids: [claraVoluntary] } = await assign(harness, voluntary, { userIds: [7] });
    await harness.api('clara', 'POST', `/api/learning/assignments/${claraVoluntary}/complete`, {});

    const { ids: [claraInactive] } = await assign(harness, inactive, { userIds: [7] });
    await harness.api('clara', 'POST', `/api/learning/assignments/${claraInactive}/complete`, {});
    await harness.api('hr', 'PATCH', `/api/learning/courses/${inactive}`, { active: false });

    const soon = shiftDays(5);
    harness.db.prepare('UPDATE learning_assignments SET expires_at=? WHERE id IN (?, ?, ?, ?)').run(soon, annaFirst, benFirst, claraVoluntary, claraInactive);

    assert.equal(harness.instance.maintenance().recertifications, 0);
    assert.equal(assignmentRow(harness, annaFirst).recertification_id, annaOpen);
    assert.equal(assignmentRow(harness, benFirst).recertification_id, benSecond);
    assert.equal(harness.db.prepare("SELECT COUNT(*) AS count FROM learning_assignments WHERE source='recertification'").get().count, 0);

    harness.db.prepare('UPDATE learning_assignments SET expires_at=? WHERE id=?').run(shiftDays(-1), claraVoluntary);
    assert.equal(harness.instance.maintenance().expired, 1, 'Auch freiwillige Abschlüsse laufen ab');
    assert.equal(assignmentRow(harness, claraVoluntary).status, 'expired');
  } finally {
    await harness.close();
  }
});

test('Meine Kurse: offen, überfällig, abgeschlossen und Katalog', async () => {
  const harness = await createModuleHarness(createLearningModule);
  try {
    const open = await createCourse(harness, { title: 'Offener Kurs', mandatory: true });
    const late = await createCourse(harness, { title: 'Später Kurs', mandatory: true });
    const done = await createCourse(harness, { title: 'Fertiger Kurs' });
    const free = await createCourse(harness, { title: 'Wahlkurs' });
    const hidden = await createCourse(harness, { title: 'Stillgelegt', active: false });
    await assign(harness, open, { userIds: [5] });
    const { ids: [lateId] } = await assign(harness, late, { userIds: [5] });
    harness.db.prepare('UPDATE learning_assignments SET due_date=? WHERE id=?').run(shiftDays(-2), lateId);
    const { ids: [doneId] } = await assign(harness, done, { userIds: [5] });
    await harness.api('anna', 'POST', `/api/learning/assignments/${doneId}/complete`, { proof: 'Beleg' });
    await assign(harness, free, { userIds: [6] });

    const { status, data } = await harness.api('anna', 'GET', '/api/learning/my');
    assert.equal(status, 200);
    assert.deepEqual(data.open.map(item => item.courseTitle), ['Offener Kurs']);
    assert.deepEqual(data.overdue.map(item => item.courseTitle), ['Später Kurs']);
    assert.equal(data.overdue[0].overdue, true);
    assert.deepEqual(data.completed.map(item => item.courseTitle), ['Fertiger Kurs']);
    assert.equal(data.completed[0].proofText, 'Beleg');

    const catalog = new Map(data.catalog.map(item => [item.title, item]));
    assert.ok(!catalog.has('Stillgelegt') && hidden);
    assert.equal(catalog.get('Wahlkurs').canEnroll, true);
    assert.equal(catalog.get('Offener Kurs').canEnroll, false);
    assert.equal(catalog.get('Fertiger Kurs').canEnroll, true, 'Ein abgeschlossener freiwilliger Kurs lässt sich wiederholen');

    const foreign = await harness.api('ben', 'GET', '/api/learning/my');
    assert.deepEqual(foreign.data.open.map(item => item.courseTitle), ['Wahlkurs'], 'Niemand sieht fremde Kurse');
  } finally {
    await harness.close();
  }
});

test('Führungslinie: nur eigene Linie, Nachweis nur für die direkte Führungskraft', async () => {
  const harness = await createModuleHarness(createLearningModule);
  try {
    const courseId = await createCourse(harness, { title: 'Linienkurs', mandatory: true, requiresConfirmation: true });
    const { ids: [annaId] } = await assign(harness, courseId, { userIds: [5, 7] });
    await harness.api('anna', 'POST', `/api/learning/assignments/${annaId}/complete`, { proof: 'Annas Nachweis' });

    assert.equal((await harness.api('anna', 'GET', '/api/learning/team')).status, 403);

    const manager = await harness.api('manager', 'GET', '/api/learning/team');
    assert.equal(manager.status, 200);
    assert.deepEqual(manager.data.people.map(person => person.id).sort(), [5, 6]);
    assert.deepEqual(manager.data.pendingConfirmations.map(item => item.id), [annaId]);
    const annaForManager = manager.data.people.find(person => person.id === 5).assignments[0];
    assert.equal(annaForManager.proofText, 'Annas Nachweis');

    const director = await harness.api('director', 'GET', '/api/learning/team');
    assert.deepEqual(director.data.people.map(person => person.id).sort(), [4, 5, 6, 7], 'Auch indirekt unterstellte Personen');
    assert.equal(director.data.pendingConfirmations.length, 0, 'Indirekt Führende bestätigen nicht');
    assert.equal(director.data.people.find(person => person.id === 5).assignments[0].proofText, '', 'Indirekt Führende sehen den Nachweis nicht');

    const hr = await harness.api('hr', 'GET', '/api/learning/team');
    assert.equal(hr.data.people.length, 7);
    assert.equal(hr.data.pendingConfirmations.length, 1);
  } finally {
    await harness.close();
  }
});

test('Erfüllungsquote je Pflichtkurs und je Person', async () => {
  const harness = await createModuleHarness(createLearningModule);
  try {
    const first = await createCourse(harness, { title: 'Pflicht A', mandatory: true, validityMonths: 12 });
    const second = await createCourse(harness, { title: 'Pflicht B', mandatory: true });
    const unassigned = await createCourse(harness, { title: 'Pflicht ohne Zuweisung', mandatory: true });
    const voluntary = await createCourse(harness, { title: 'Freiwillig' });
    const { ids: [annaA, benA, claraA, managerA] } = await assign(harness, first, { userIds: [5, 6, 7, 4] });
    await assign(harness, voluntary, { userIds: [5] });
    const { ids: [annaB] } = await assign(harness, second, { userIds: [5] });

    await harness.api('anna', 'POST', `/api/learning/assignments/${annaA}/complete`, {});
    await harness.api('ben', 'POST', `/api/learning/assignments/${benA}/complete`, {});
    harness.db.prepare('UPDATE learning_assignments SET expires_at=? WHERE id=?').run(shiftDays(-1), benA);
    harness.instance.maintenance();
    harness.db.prepare('UPDATE learning_assignments SET due_date=? WHERE id=?').run(shiftDays(-1), claraA);
    assert.ok(managerA && annaB);

    assert.equal((await harness.api('manager', 'GET', '/api/learning/report')).status, 403);
    const { status, data } = await harness.api('bp', 'GET', '/api/learning/report');
    assert.equal(status, 200);

    const courseA = data.courses.find(course => course.courseId === first);
    assert.equal(courseA.required, 4);
    assert.equal(courseA.fulfilled, 1, 'Abgelaufene Abschlüsse zählen nicht');
    assert.equal(courseA.overdue, 1);
    assert.equal(courseA.ratePercent, 25);
    assert.equal(data.courses.find(course => course.courseId === second).ratePercent, 0);
    const empty = data.courses.find(course => course.courseId === unassigned);
    assert.equal(empty.required, 0);
    assert.equal(empty.ratePercent, null);
    assert.ok(!data.courses.some(course => course.courseId === voluntary), 'Freiwillige Kurse zählen nicht');

    const anna = data.people.find(person => person.userId === 5);
    assert.equal(anna.required, 2);
    assert.equal(anna.fulfilled, 1);
    assert.equal(anna.ratePercent, 50);
    assert.equal(data.people.find(person => person.userId === 6).ratePercent, 0);
    assert.equal(data.overall.required, 5);
    assert.equal(data.overall.fulfilled, 1);
    assert.equal(data.overall.ratePercent, 20);
  } finally {
    await harness.close();
  }
});

test('Eine laufende Rezertifizierung senkt die Quote nicht, solange der alte Abschluss gilt', async () => {
  const harness = await createModuleHarness(createLearningModule);
  try {
    const courseId = await createCourse(harness, { mandatory: true, validityMonths: 12 });
    const { ids: [id] } = await assign(harness, courseId, { userIds: [5] });
    await harness.api('anna', 'POST', `/api/learning/assignments/${id}/complete`, {});
    harness.db.prepare('UPDATE learning_assignments SET expires_at=? WHERE id=?').run(shiftDays(10), id);
    harness.instance.maintenance();
    const { data } = await harness.api('hr', 'GET', '/api/learning/report');
    assert.equal(data.courses[0].required, 1, 'Eine Person, nicht zwei Zuweisungen');
    assert.equal(data.courses[0].fulfilled, 1);
  } finally {
    await harness.close();
  }
});

/** Zerlegt eine Zeile nach CSV-Regeln: Semikolon trennt, doppelte Anführungszeichen schützen. */
function parseCsvLine(line) {
  const fields = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quoted && char === '"' && line[index + 1] === '"') {
      field += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === ';' && !quoted) {
      fields.push(field);
      field = '';
    } else {
      field += char;
    }
  }
  fields.push(field);
  return fields;
}

test('CSV-Export: Semikolon, UTF-8 mit BOM und Schutz vor Formel-Injektion', async () => {
  const harness = await createModuleHarness(createLearningModule);
  const app = express();
  app.use('/api', harness.instance.router);
  const server = await new Promise(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  try {
    harness.db.prepare("INSERT INTO users(id, name, email, password_hash, role, manager_id) VALUES(8, '-Mallory', '@mallory@test.local', '!TEST!', 'employee', 4)").run();
    const titles = ['=HYPERLINK("http://boese.example";"klick")', '+Kurs mit Plus', '-Kurs mit Minus', '@Kurs mit Klammeraffe', 'Müller; Größe "Spezial"'];
    for (const title of titles) {
      const courseId = await createCourse(harness, { title, mandatory: true });
      const { ids: [id] } = await assign(harness, courseId, { userIds: [8] });
      await harness.api(8, 'POST', `/api/learning/assignments/${id}/complete`, { proof: '=cmd|\' /C calc\'!A0' });
    }

    assert.equal((await harness.api('anna', 'GET', '/api/learning/report/export.csv')).status, 403);
    assert.equal((await harness.api('manager', 'GET', '/api/learning/report/export.csv')).status, 403);

    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/learning/report/export.csv`, { headers: { 'x-test-user': '1' } });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/csv/);
    assert.match(response.headers.get('content-disposition'), /attachment/);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'BOM am Anfang');

    const text = bytes.subarray(3).toString('utf8');
    const lines = text.trim().split('\r\n');
    assert.equal(lines[0], 'Person;E-Mail;Pflichtkurs;Status;Erfüllt;Frist;Abschluss;Gültig bis;Nachweis');
    assert.equal(lines.length, titles.length + 1);
    const rows = lines.slice(1).map(parseCsvLine);
    for (const row of rows) {
      assert.equal(row.length, 9);
      for (const field of row) assert.doesNotMatch(field, /^\s*[=+\-@]/, `Gefährliches Feld: ${field}`);
      assert.equal(row[0], "'-Mallory");
      assert.equal(row[1], "'@mallory@test.local");
      assert.equal(row[8], "'=cmd|' /C calc'!A0");
    }
    const exportedTitles = rows.map(row => row[2]);
    assert.ok(exportedTitles.includes('\'=HYPERLINK("http://boese.example";"klick")'), 'Anführungszeichen und Semikolon bleiben erhalten');
    assert.ok(exportedTitles.includes("'+Kurs mit Plus"));
    assert.ok(exportedTitles.includes("'-Kurs mit Minus"));
    assert.ok(exportedTitles.includes("'@Kurs mit Klammeraffe"));
    assert.ok(exportedTitles.includes('Müller; Größe "Spezial"'), 'Harmlose Felder bleiben unverändert');
    assert.ok(harness.db.prepare("SELECT id FROM audit_log WHERE action='learning_report_exported'").get(), 'Der Export wird protokolliert');
  } finally {
    await new Promise(resolve => server.close(resolve));
    await harness.close();
  }
});

test('Hilfeartikel haben die vom Assistenten erwartete Form', () => {
  assert.ok(h.instance.helpArticles.length > 0);
  for (const article of h.instance.helpArticles) {
    assert.ok(article.id.startsWith('learning-'));
    assert.ok(article.title && article.answer);
    for (const key of ['roles', 'views', 'keywords', 'steps', 'actions']) assert.ok(Array.isArray(article[key]), key);
    assert.ok(article.keywords.every(keyword => keyword === keyword.toLowerCase()));
  }
  const forStaff = h.instance.helpArticles.filter(article => article.roles.includes('hr_staff')).map(article => article.id);
  assert.deepEqual(forStaff, ['learning-my-courses'], 'Die Sachbearbeitung findet nur, was sie darf');
  assert.equal(/Rezertifizierung|Führungslinie/.test(h.instance.helpArticles.map(article => article.answer + article.title).join(' ')), false);
});

test('Beispieldaten sind mehrfach aufrufbar, legen keine Konten an und brauchen Personen', async () => {
  const harness = await createModuleHarness(createLearningModule);
  try {
    const usersBefore = harness.db.prepare('SELECT COUNT(*) AS count FROM users').get().count;
    harness.instance.seedDemo();
    const snapshot = () => ({
      courses: harness.db.prepare('SELECT COUNT(*) AS count FROM learning_courses').get().count,
      assignments: harness.db.prepare('SELECT COUNT(*) AS count FROM learning_assignments').get().count,
      tasks: harness.db.prepare('SELECT COUNT(*) AS count FROM tasks').get().count
    });
    const first = snapshot();
    assert.ok(first.courses > 0 && first.assignments > 0 && first.tasks > 0);
    harness.instance.seedDemo();
    assert.deepEqual(snapshot(), first);
    assert.equal(harness.db.prepare('SELECT COUNT(*) AS count FROM users').get().count, usersBefore);
    const overdue = await harness.api('ben', 'GET', '/api/learning/my');
    assert.equal(overdue.status, 200);
    assert.ok(overdue.data.overdue.length > 0, 'Die Demo zeigt auch eine überfällige Schulung');
  } finally {
    await harness.close();
  }

  const empty = await createModuleHarness(createLearningModule);
  try {
    empty.db.prepare('UPDATE users SET active=0').run();
    empty.instance.seedDemo();
    assert.equal(empty.db.prepare('SELECT COUNT(*) AS count FROM learning_courses').get().count, 0);
  } finally {
    await empty.close();
  }
});

test('Die Systemadministration wird wie HR behandelt, ist aber selbst keine Teilnehmerin', async () => {
  const systemId = 900;
  const currentWithSystem = harnessDb => req => {
    const id = Number(req.get('x-test-user'));
    if (id === systemId) return { id: systemId, name: 'Systemadministration', email: 'root@test.local', role: 'super_admin', manager_id: null };
    return id ? harnessDb().prepare('SELECT id,name,email,role,title,manager_id FROM users WHERE id=? AND is_system_account=0 AND active=1').get(id) || null : null;
  };
  let database = null;
  const current = currentWithSystem(() => database);
  const harness = await createModuleHarness(createLearningModule, {
    extra: { current, auth: (req, res, next) => (current(req) ? next() : res.status(401).json({ error: 'Nicht angemeldet' })) }
  });
  database = harness.db;
  try {
    harness.db.prepare("INSERT INTO users(id, name, email, password_hash, role, is_system_account) VALUES(?, 'Systemadministration', 'system@test.local', '!ENV!', 'hr_admin', 1)").run(systemId);
    const created = await harness.api(systemId, 'POST', '/api/learning/courses', { title: 'Vom Support angelegt', courseType: 'online' });
    assert.equal(created.status, 200);
    const assigned = await harness.api(systemId, 'POST', '/api/learning/assignments', { courseId: created.data.id, all: true });
    assert.equal(assigned.data.created, 7, 'Das technische Konto bekommt selbst keine Zuweisung');
    assert.equal((await harness.api(systemId, 'GET', '/api/learning/report')).status, 200);
    assert.equal((await harness.api(systemId, 'GET', '/api/learning/team')).data.people.length, 7);
    assert.equal((await harness.api(systemId, 'POST', `/api/learning/courses/${created.data.id}/enroll`)).status, 400);
    const recorded = await harness.api(systemId, 'POST', `/api/learning/assignments/${assigned.data.ids[0]}/complete`, {});
    assert.equal(recorded.data.status, 'completed');
    assert.equal(assignmentRow(harness, assigned.data.ids[0]).confirmed_by, systemId);
  } finally {
    await harness.close();
  }
});

test('Modul läuft auch ohne eingeschaltete andere Module', async () => {
  const harness = await createModuleHarness(createLearningModule, { isModuleEnabled: () => false });
  try {
    const courseId = await createCourse(harness);
    const { ids: [id] } = await assign(harness, courseId, { userIds: [5] });
    assert.equal((await harness.api('anna', 'POST', `/api/learning/assignments/${id}/complete`, {})).status, 200);
    assert.equal((await harness.api('anna', 'GET', '/api/learning/my')).status, 200);
  } finally {
    await harness.close();
  }
});
