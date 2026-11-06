'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');
const express = require('express');
const { createModuleHarness } = require('../lib/testing/module-harness');
const { createAbsenceModule } = require('../routes/absence');
const { createPersonnelModule } = require('../routes/personnel');
const { createTimeModule, csvField } = require('../routes/time');

// Der 11.03.2026 ist ein Mittwoch. Die Woche davor läuft von Montag, 02.03., bis Sonntag, 08.03.
const TODAY = '2026-03-11';
const LAST_WEEK = '2026-03-02';
const THIS_WEEK = '2026-03-09';
const HINT_TEXT = 'Bitte prüfe, ob das stimmt und bei euch erlaubt ist.';

/** Jeder Test bekommt eine frische Datenbank und eine eigene, steuerbare Uhr. */
async function setup(t, { today = TODAY, time = '09:00', modules = [], extra = {} } = {}) {
  const clock = { date: today, time };
  const enabled = new Set(modules);
  const h = await createModuleHarness(createTimeModule, {
    isModuleEnabled: key => enabled.has(key),
    extra: { now: () => clock, ...extra }
  });
  t.after(() => h.close());
  const add = (person, date, startTime, endTime, more = {}) => h.api(person, 'POST', '/api/time/entries', { date, startTime, endTime, ...more });
  const fullDay = (person, date) => add(person, date, '08:00', '16:30', { breakMinutes: 30 });
  const fillWeek = async (person, weekStart = LAST_WEEK) => {
    for (let offset = 0; offset < 5; offset += 1) await fullDay(person, plusDays(weekStart, offset));
  };
  const week = async (person, query = `?week=${LAST_WEEK}`) => (await h.api(person, 'GET', `/api/time/week${query}`)).data.week;
  const submit = (person, weekStart = LAST_WEEK) => h.api(person, 'POST', '/api/time/weeks/submit', { week: weekStart });
  const decide = (person, id, decision, comment) => h.api(person, 'POST', `/api/time/weeks/${id}/decision`, { decision, comment });
  const tasksOf = (userId, type) => h.db.prepare('SELECT * FROM tasks WHERE user_id = ? AND type = ? AND done = 0').all(userId, type);
  return { ...h, clock, enabled, add, fullDay, fillWeek, week, submit, decide, tasksOf };
}

function plusDays(isoDate, days) {
  const [year, month, day] = isoDate.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

const hintCodes = hints => hints.map(item => item.code);

// ------------------------------------------------------------------ Anmeldung und Eingaben

test('ohne Anmeldung gibt es nirgends eine Antwort außer 401', async t => {
  const h = await setup(t);
  const routes = [
    ['GET', '/api/time/week'],
    ['GET', '/api/time/history'],
    ['POST', '/api/time/entries'],
    ['PATCH', '/api/time/entries/1'],
    ['DELETE', '/api/time/entries/1'],
    ['POST', '/api/time/clock/in'],
    ['POST', '/api/time/clock/out'],
    ['POST', '/api/time/weeks/submit'],
    ['GET', '/api/time/weeks'],
    ['GET', '/api/time/weeks/1'],
    ['POST', '/api/time/weeks/1/decision'],
    ['POST', '/api/time/weeks/1/reopen'],
    ['POST', '/api/time/weeks/1/withdraw'],
    ['GET', '/api/time/settings'],
    ['PUT', '/api/time/settings'],
    ['GET', '/api/time/people'],
    ['PUT', '/api/time/people/5/hours'],
    ['GET', '/api/time/export?month=2026-03']
  ];
  for (const [method, url] of routes) {
    const response = await h.api(null, method, url, method === 'GET' ? undefined : {});
    assert.equal(response.status, 401, `${method} ${url}`);
  }
});

test('Einträge werden geprüft: Datum, Uhrzeit, Reihenfolge und Pause', async t => {
  const h = await setup(t);
  assert.equal((await h.add('anna', '2026-02-30', '08:00', '12:00')).status, 400, 'Datum gibt es nicht');
  assert.equal((await h.add('anna', '02.03.2026', '08:00', '12:00')).status, 400, 'falsches Format');
  assert.equal((await h.add('anna', undefined, '08:00', '12:00')).status, 400, 'Datum fehlt');
  assert.equal((await h.add('anna', '2026-03-12', '08:00', '12:00')).status, 400, 'Zukunft');
  assert.equal((await h.add('anna', '2015-03-02', '08:00', '12:00')).status, 400, 'zu lange her');
  assert.equal((await h.add('anna', LAST_WEEK, '8 Uhr', '12:00')).status, 400, 'Beginn unlesbar');
  assert.equal((await h.add('anna', LAST_WEEK, '24:00', '24:00')).status, 400, 'Beginn 24:00 gibt es nicht');
  assert.equal((await h.add('anna', LAST_WEEK, '25:00', '26:00')).status, 400);
  assert.equal((await h.add('anna', LAST_WEEK, '08:00', '12:60')).status, 400);
  assert.equal((await h.add('anna', LAST_WEEK, '08:00')).status, 400, 'von Hand braucht es ein Ende');
  assert.equal((await h.add('anna', LAST_WEEK, '08:00', '')).status, 400);

  const backwards = await h.add('anna', LAST_WEEK, '22:00', '06:00');
  assert.equal(backwards.status, 400, 'über Mitternacht geht nur in zwei Einträgen');
  assert.match(backwards.data.error, /zwei Einträge/);
  assert.equal((await h.add('anna', LAST_WEEK, '08:00', '08:00')).status, 400, 'Ende muss nach Beginn liegen');

  assert.equal((await h.add('anna', LAST_WEEK, '08:00', '09:00', { breakMinutes: 60 })).status, 400, 'Pause so lang wie die Zeit');
  assert.equal((await h.add('anna', LAST_WEEK, '08:00', '12:00', { breakMinutes: -5 })).status, 400);
  assert.equal((await h.add('anna', LAST_WEEK, '08:00', '12:00', { breakMinutes: 1.5 })).status, 400);
  assert.equal((await h.add('anna', LAST_WEEK, '08:00', '12:00', { breakMinutes: 'lang' })).status, 400);

  // Über Mitternacht in zwei Einträgen.
  const lateShift = await h.add('anna', LAST_WEEK, '22:00', '24:00');
  assert.equal(lateShift.status, 201);
  assert.equal(lateShift.data.entry.netMinutes, 120);
  const morningAfter = await h.add('anna', plusDays(LAST_WEEK, 1), '00:00', '06:00', { note: 'Nachtschicht <b>' });
  assert.equal(morningAfter.status, 201);
  assert.equal(morningAfter.data.entry.note, 'Nachtschicht b', 'Spitze Klammern werden entfernt');
  assert.equal((await h.add('anna', TODAY, '07:00', '08:00')).status, 201, 'heute geht');
});

test('Überschneidungen am selben Tag werden abgelehnt, beim Anlegen und beim Ändern', async t => {
  const h = await setup(t);
  const first = await h.add('anna', LAST_WEEK, '08:00', '12:00');
  assert.equal(first.status, 201);

  const overlap = await h.add('anna', LAST_WEEK, '11:00', '13:00');
  assert.equal(overlap.status, 400);
  assert.match(overlap.data.error, /überschneidet/);
  assert.equal((await h.add('anna', LAST_WEEK, '07:00', '08:01')).status, 400, 'hängt ins andere hinein');
  assert.equal((await h.add('anna', LAST_WEEK, '09:00', '10:00')).status, 400, 'liegt innerhalb');
  assert.equal((await h.add('anna', LAST_WEEK, '07:00', '13:00')).status, 400, 'umschließt');
  assert.equal((await h.add('anna', LAST_WEEK, '08:00', '12:00')).status, 400, 'identisch');

  assert.equal((await h.add('anna', LAST_WEEK, '12:00', '13:00')).status, 201, 'direkt danach ist frei');
  assert.equal((await h.add('anna', LAST_WEEK, '07:00', '08:00')).status, 201, 'direkt davor ist frei');
  assert.equal((await h.add('anna', plusDays(LAST_WEEK, 1), '08:00', '12:00')).status, 201, 'anderer Tag');
  assert.equal((await h.add('ben', LAST_WEEK, '08:00', '12:00')).status, 201, 'andere Person');

  const other = await h.add('anna', plusDays(LAST_WEEK, 2), '08:00', '12:00');
  const patch = body => h.api('anna', 'PATCH', `/api/time/entries/${other.data.entry.id}`, body);
  assert.equal((await patch({ date: LAST_WEEK })).status, 400, 'Verschieben auf einen belegten Tag');
  assert.equal((await patch({ endTime: '13:00' })).status, 200, 'eigener Eintrag zählt nicht als Überschneidung');
});

// ------------------------------------------------------------------ Kommen und Gehen

test('Kommen und Gehen: starten, nicht doppelt, beenden', async t => {
  const h = await setup(t, { time: '08:00' });
  assert.equal((await h.api('anna', 'POST', '/api/time/clock/out', {})).status, 400, 'noch nicht eingestempelt');

  const started = await h.api('anna', 'POST', '/api/time/clock/in', {});
  assert.equal(started.status, 201);
  assert.equal(started.data.entry.running, true);
  assert.equal(started.data.entry.endTime, null);
  assert.equal(started.data.entry.date, TODAY);
  assert.equal((await h.api('anna', 'POST', '/api/time/clock/in', {})).status, 400, 'schon eingestempelt');

  const live = await h.week('anna', '');
  assert.equal(live.running.id, started.data.entry.id);
  assert.equal(live.actualMinutes, 0, 'läuft noch: zählt noch nicht');
  assert.equal(live.canSubmit, false);

  // In der Minute des Kommens lässt sich nicht gehen.
  assert.equal((await h.api('anna', 'POST', '/api/time/clock/out', {})).status, 400);

  // Einträge nach dem Beginn sind blockiert, solange das Ende offen ist, davor nicht.
  assert.equal((await h.add('anna', TODAY, '10:00', '11:00')).status, 400);
  assert.equal((await h.add('anna', TODAY, '06:00', '07:00')).status, 201);

  h.clock.time = '16:30';
  assert.equal((await h.api('anna', 'POST', '/api/time/clock/out', { breakMinutes: 'lang' })).status, 400);
  assert.equal((await h.api('anna', 'POST', '/api/time/clock/out', { breakMinutes: 600 })).status, 400, 'Pause zu lang');
  const stopped = await h.api('anna', 'POST', '/api/time/clock/out', { breakMinutes: 30 });
  assert.equal(stopped.status, 200);
  assert.equal(stopped.data.entries.length, 1);
  assert.equal(stopped.data.entries[0].endTime, '16:30');
  assert.equal(stopped.data.entries[0].netMinutes, 480);
  assert.equal((await h.week('anna', '')).running, null);

  // Überschneidung: Kommen innerhalb eines erfassten Blocks.
  h.clock.time = '16:00';
  assert.equal((await h.api('anna', 'POST', '/api/time/clock/in', {})).status, 400);
  h.clock.time = '17:00';
  assert.equal((await h.api('anna', 'POST', '/api/time/clock/in', {})).status, 201);
});

test('Gehen am nächsten Tag: Nachtschicht wird geteilt, ein vergessenes Gehen nicht', async t => {
  const h = await setup(t, { time: '22:00' });
  await h.api('anna', 'POST', '/api/time/clock/in', {});
  h.clock.date = '2026-03-12';
  h.clock.time = '06:00';
  const split = await h.api('anna', 'POST', '/api/time/clock/out', { breakMinutes: 30 });
  assert.equal(split.status, 200);
  assert.equal(split.data.entries.length, 2);
  assert.deepEqual(
    split.data.entries.map(entry => [entry.date, entry.startTime, entry.endTime, entry.breakMinutes]),
    [[TODAY, '22:00', '24:00', 30], ['2026-03-12', '00:00', '06:00', 0]]
  );
  assert.equal(hintCodes(split.data.hints).includes('short_rest'), false, 'durchgehende Schicht ist keine Ruhezeit');

  // Genau um Mitternacht entsteht kein zweiter Eintrag.
  h.clock.date = '2026-03-13';
  h.clock.time = '20:00';
  await h.api('anna', 'POST', '/api/time/clock/in', {});
  h.clock.date = '2026-03-14';
  h.clock.time = '00:00';
  const midnight = await h.api('anna', 'POST', '/api/time/clock/out', {});
  assert.equal(midnight.data.entries.length, 1);
  assert.equal(midnight.data.entries[0].endTime, '24:00');

  // Vergessen: Über 16 Stunden wird nicht geteilt.
  h.clock.date = '2026-03-16';
  h.clock.time = '08:00';
  await h.api('ben', 'POST', '/api/time/clock/in', {});
  h.clock.date = '2026-03-17';
  h.clock.time = '08:05';
  const forgotten = await h.api('ben', 'POST', '/api/time/clock/out', {});
  assert.equal(forgotten.status, 400);
  assert.match(forgotten.data.error, /16\.03\.2026.*von Hand/);

  // Mehr als ein Tag dazwischen geht auch nicht.
  h.clock.date = '2026-03-19';
  assert.equal((await h.api('ben', 'POST', '/api/time/clock/out', {})).status, 400);

  // Die Korrektur von Hand beendet den Eintrag.
  const running = await h.week('ben', '?week=2026-03-16');
  const fixed = await h.api('ben', 'PATCH', `/api/time/entries/${running.running.id}`, { endTime: '17:00', breakMinutes: 60 });
  assert.equal(fixed.status, 200);
  assert.equal(fixed.data.entry.running, false);
  assert.equal((await h.week('ben', '?week=2026-03-16')).running, null);
  const reopen = await h.api('ben', 'PATCH', `/api/time/entries/${running.running.id}`, { endTime: null });
  assert.equal(reopen.status, 400, 'ein beendeter Eintrag lässt sich nicht wieder öffnen');
});

test('Kommen und Gehen beachten die Wochensperre und eine zweite Hälfte kann nicht überschneiden', async t => {
  const h = await setup(t, { time: '22:00' });
  await h.api('anna', 'POST', '/api/time/clock/in', {});
  h.clock.date = '2026-03-12';
  h.clock.time = '06:00';
  await h.add('anna', '2026-03-12', '03:00', '04:00');
  const blocked = await h.api('anna', 'POST', '/api/time/clock/out', {});
  assert.equal(blocked.status, 400);
  assert.match(blocked.data.error, /überschneidet/);
  const stillRunning = await h.week('anna', `?week=${THIS_WEEK}`);
  assert.ok(stillRunning.running, 'nichts wurde halb gespeichert');

  // Bestehende Wochensperre verhindert Kommen.
  await h.fillWeek('ben');
  await h.submit('ben');
  h.clock.date = '2026-03-08';
  h.clock.time = '10:00';
  const locked = await h.api('ben', 'POST', '/api/time/clock/in', {});
  assert.equal(locked.status, 409);
});

// ------------------------------------------------------------------ Wochenablauf

test('Hauptablauf: einreichen, Aufgabe, genehmigen', async t => {
  const h = await setup(t);
  await h.fillWeek('anna');
  const before = await h.week('anna');
  assert.equal(before.status, 'open');
  assert.equal(before.canSubmit, true);
  assert.equal(before.canEdit, true);
  assert.equal(before.weekStart, LAST_WEEK);
  assert.equal(before.weekEnd, '2026-03-08');

  const submitted = await h.submit('anna');
  assert.equal(submitted.status, 200);
  assert.equal(submitted.data.warning, undefined);
  const id = submitted.data.id;

  const tasks = h.tasksOf(4, 'time_week_approval');
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].entity_id, id);
  assert.match(tasks[0].title, /Anna Ahrens.*02\.03\.2026/);

  const list = await h.api('manager', 'GET', '/api/time/weeks');
  assert.equal(list.data.weeks.length, 1);
  assert.equal(list.data.weeks[0].userName, 'Anna Ahrens');
  assert.equal(list.data.weeks[0].status, 'submitted');
  assert.equal(list.data.weeks[0].canDecide, true);
  assert.equal(list.data.weeks[0].actualMinutes, 2400);

  const seen = await h.week('manager', `?week=${LAST_WEEK}&userId=5`);
  assert.equal(seen.status, 'submitted');
  assert.equal(seen.canDecide, true);
  assert.equal(seen.canEdit, false);
  assert.equal(seen.totalBalanceMinutes, undefined, 'Gesamtsaldo bleibt bei Person und HR');
  assert.equal(seen.running, undefined, 'keine Live-Ansicht');

  const approved = await h.decide('manager', id, 'approve');
  assert.equal(approved.status, 200);
  assert.equal(approved.data.status, 'approved');
  assert.equal(h.tasksOf(4, 'time_week_approval').length, 0);

  const after = await h.week('anna');
  assert.equal(after.status, 'approved');
  assert.equal(after.statusLabel, 'genehmigt');
  assert.equal(after.decidedByName, 'Malte Manager');
  assert.equal(after.canEdit, false);
  assert.equal(after.canSubmit, false);
  assert.equal((await h.submit('anna')).status, 409);
});

test('Zurückgeben: Kommentar ist Pflicht, Woche wird wieder bearbeitbar, erneutes Einreichen', async t => {
  const h = await setup(t);
  await h.fillWeek('anna');
  const id = (await h.submit('anna')).data.id;

  assert.equal((await h.decide('manager', id, 'return')).status, 400, 'ohne Kommentar');
  assert.equal((await h.decide('manager', id, 'vielleicht')).status, 400);
  assert.equal((await h.decide('manager', 9999, 'approve')).status, 404);

  assert.equal((await h.decide('manager', id, 'return', 'Dienstag fehlt die Notiz')).status, 200);
  assert.equal(h.tasksOf(4, 'time_week_approval').length, 0);
  assert.equal(h.tasksOf(5, 'time_week_returned').length, 1);
  const returned = await h.week('anna');
  assert.equal(returned.status, 'returned');
  assert.equal(returned.decisionComment, 'Dienstag fehlt die Notiz');
  assert.equal(returned.canEdit, true);
  assert.equal(returned.canSubmit, true);
  assert.equal((await h.decide('manager', id, 'approve')).status, 409, 'wartet nicht mehr auf Entscheidung');

  assert.equal((await h.add('anna', '2026-03-07', '09:00', '10:00')).status, 201, 'zurückgegeben heißt bearbeitbar');

  const again = await h.submit('anna');
  assert.equal(again.status, 200);
  assert.equal(again.data.id, id, 'dieselbe Woche');
  assert.equal(h.tasksOf(5, 'time_week_returned').length, 0, 'Korrekturaufgabe ist erledigt');
  assert.equal(h.tasksOf(4, 'time_week_approval').length, 1);
  const resubmitted = await h.week('anna');
  assert.equal(resubmitted.decisionComment, null, 'alter Kommentar ist weg');
  assert.equal((await h.decide('manager', id, 'approve')).status, 200);
});

test('Einreichen geht nicht bei leerer Woche und nicht bei laufendem Eintrag', async t => {
  const h = await setup(t, { time: '08:00' });
  const empty = await h.submit('anna');
  assert.equal(empty.status, 400);
  assert.match(empty.data.error, /keine Einträge/);
  assert.equal((await h.submit('anna', '2026-04-06')).status, 400, 'Woche in der Zukunft ist leer');
  assert.equal((await h.submit('anna', 'gestern')).status, 400);

  await h.api('anna', 'POST', '/api/time/clock/in', {});
  const running = await h.submit('anna', THIS_WEEK);
  assert.equal(running.status, 400);
  assert.match(running.data.error, /läuft noch/);

  // Irgendein Tag der Woche genügt, die Woche beginnt immer am Montag.
  await h.fullDay('ben', LAST_WEEK);
  const byWednesday = await h.submit('ben', '2026-03-04');
  assert.equal(byWednesday.status, 200);
  assert.equal(h.db.prepare('SELECT week_start FROM time_weeks WHERE id = ?').get(byWednesday.data.id).week_start, LAST_WEEK);
  assert.equal((await h.week('ben', '?week=2026-03-08')).weekStart, LAST_WEEK, 'Sonntag gehört zur selben Woche');
});

test('Sperre: Nach dem Einreichen darf niemand mehr ändern, auch HR nicht', async t => {
  const h = await setup(t);
  await h.fillWeek('anna');
  const entry = (await h.week('anna')).days[0].entries[0];
  const id = (await h.submit('anna')).data.id;

  const attempts = async expected => {
    assert.equal((await h.add('anna', '2026-03-07', '09:00', '10:00')).status, expected, 'anlegen');
    assert.equal((await h.api('anna', 'PATCH', `/api/time/entries/${entry.id}`, { note: 'neu' })).status, expected, 'ändern');
    assert.equal((await h.api('anna', 'DELETE', `/api/time/entries/${entry.id}`)).status, expected, 'löschen');
    assert.equal((await h.api('hr', 'PATCH', `/api/time/entries/${entry.id}`, { note: 'neu' })).status, expected, 'HR ändert');
    assert.equal((await h.add('hr', '2026-03-07', '09:00', '10:00', { userId: 5 })).status, expected, 'HR legt an');
  };
  await attempts(409);

  await h.decide('manager', id, 'approve');
  await attempts(409);
  const message = (await h.api('anna', 'DELETE', `/api/time/entries/${entry.id}`)).data.error;
  assert.match(message, /genehmigt/);

  // Verschieben aus einer offenen in eine gesperrte Woche geht auch nicht.
  const open = await h.add('anna', THIS_WEEK, '08:00', '12:00');
  const moved = await h.api('anna', 'PATCH', `/api/time/entries/${open.data.entry.id}`, { date: '2026-03-06' });
  assert.equal(moved.status, 409);
});

test('Wieder öffnen: nur HR, nur mit Begründung, nur genehmigte Wochen', async t => {
  const h = await setup(t);
  await h.fillWeek('anna');
  const id = (await h.submit('anna')).data.id;
  const reopen = (person, reason) => h.api(person, 'POST', `/api/time/weeks/${id}/reopen`, { reason });

  assert.equal((await reopen('hr', 'Tippfehler')).status, 409, 'noch nicht genehmigt');
  await h.decide('manager', id, 'approve');

  assert.equal((await reopen('anna', 'Fehler')).status, 403);
  assert.equal((await reopen('manager', 'Fehler')).status, 403);
  assert.equal((await reopen('director', 'Fehler')).status, 403);
  assert.equal((await reopen('hr')).status, 400, 'ohne Begründung');
  assert.equal((await reopen('hr', '   ')).status, 400);
  assert.equal((await h.api('hr', 'POST', '/api/time/weeks/9999/reopen', { reason: 'x' })).status, 404);

  const ok = await reopen('bp', 'Lohnbüro meldet Tippfehler');
  assert.equal(ok.status, 200);
  assert.equal(h.tasksOf(5, 'time_week_reopened').length, 1);
  const opened = await h.week('anna');
  assert.equal(opened.status, 'open');
  assert.equal(opened.reopenReason, 'Lohnbüro meldet Tippfehler');
  assert.equal(opened.canEdit, true);
  assert.equal((await h.add('anna', '2026-03-07', '09:00', '10:00')).status, 201);

  assert.equal((await h.submit('anna')).status, 200);
  assert.equal(h.tasksOf(5, 'time_week_reopened').length, 0);
  assert.equal(h.tasksOf(4, 'time_week_approval').length, 1);
  const logged = h.db.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE action = 'time_week_reopened'").get().count;
  assert.equal(logged, 1);
});

test('Wer alle Einträge einer zurückgegebenen Woche löscht, hat keine offene Aufgabe mehr dazu', async t => {
  const h = await setup(t);
  await h.fullDay('anna', LAST_WEEK);
  const id = (await h.submit('anna')).data.id;
  await h.decide('manager', id, 'return', 'Falsche Woche');
  assert.equal(h.tasksOf(5, 'time_week_returned').length, 1);
  const entry = (await h.week('anna')).days[0].entries[0];
  await h.api('anna', 'DELETE', `/api/time/entries/${entry.id}`);
  assert.equal(h.tasksOf(5, 'time_week_returned').length, 0);
});

// ------------------------------------------------------------------ Entscheidungsrechte

test('Entscheiden dürfen nur die direkte Führungskraft oder HR, nie die Person selbst', async t => {
  const h = await setup(t);
  await h.fillWeek('anna');
  const id = (await h.submit('anna')).data.id;

  assert.equal((await h.decide('anna', id, 'approve')).status, 403, 'eigene Woche');
  assert.equal((await h.decide('ben', id, 'approve')).status, 403, 'Kollege');
  assert.equal((await h.decide('clara', id, 'approve')).status, 403, 'anderes Team');
  assert.equal((await h.decide('director', id, 'approve')).status, 403, 'Führungslinie sieht, entscheidet aber nicht');

  const directorSees = await h.week('director', `?week=${LAST_WEEK}&userId=5`);
  assert.equal(directorSees.canDecide, false);
  const directorList = await h.api('director', 'GET', '/api/time/weeks');
  assert.equal(directorList.data.weeks.length, 1);
  assert.equal(directorList.data.weeks[0].canDecide, false);

  assert.equal((await h.decide('bp', id, 'approve')).status, 200, 'HR darf');
  assert.equal(h.tasksOf(4, 'time_week_approval').length, 0, 'Aufgabe der Führungskraft ist auch erledigt');
});

test('Eigene Woche: auch Führungskräfte und HR entscheiden nicht selbst', async t => {
  const h = await setup(t);
  await h.fillWeek('manager');
  const managerWeek = (await h.submit('manager')).data.id;
  assert.equal(h.tasksOf(3, 'time_week_approval').length, 1, 'Aufgabe geht eine Ebene höher');
  assert.equal((await h.decide('manager', managerWeek, 'approve')).status, 403);
  assert.equal((await h.decide('director', managerWeek, 'approve')).status, 200);

  // HR ohne Führungskraft: Aufgabe nie an sich selbst.
  await h.fillWeek('hr');
  const hrWeek = (await h.submit('hr')).data.id;
  assert.equal(h.tasksOf(1, 'time_week_approval').length, 0);
  assert.equal(h.tasksOf(2, 'time_week_approval').length, 1, 'mangels zweiter HR-Administration an HR Business Partner');
  assert.equal((await h.decide('hr', hrWeek, 'approve')).status, 403);
  const own = (await h.api('hr', 'GET', '/api/time/weeks?scope=all')).data.weeks.find(week => week.id === hrWeek);
  assert.equal(own.canDecide, false);
  assert.equal((await h.decide('bp', hrWeek, 'approve')).status, 200);

  // Ohne Führungskraft und mit HR-Administration geht es an sie, gesperrte Führungskräfte zählen nicht.
  await h.fillWeek('director');
  await h.submit('director');
  assert.equal(h.tasksOf(1, 'time_week_approval').length, 1);
  h.deps.setUserActive(4, false, { id: 1 });
  await h.fillWeek('ben');
  await h.submit('ben');
  assert.equal(h.tasksOf(4, 'time_week_approval').length, 0);
  assert.equal(h.tasksOf(1, 'time_week_approval').length, 2);
});

test('Eine eingereichte Woche einer inzwischen gesperrten Person bleibt für die Führungskraft entscheidbar', async t => {
  const h = await setup(t);
  await h.fillWeek('anna');
  const id = (await h.submit('anna')).data.id;
  h.deps.setUserActive(5, false, { id: 1 });
  const list = await h.api('manager', 'GET', '/api/time/weeks');
  assert.deepEqual(list.data.weeks.map(week => week.id), [id]);
  assert.equal(list.data.weeks[0].canDecide, true);
  assert.equal((await h.decide('manager', id, 'approve')).status, 200);
});

test('HR öffnet die eigene genehmigte Woche nur, wenn die Organisation das erlaubt, und ohne Aufgabe an sich selbst', async t => {
  const h = await setup(t);
  await h.fullDay('hr', LAST_WEEK);
  const id = (await h.submit('hr')).data.id;
  await h.decide('bp', id, 'approve');
  const denied = await h.api('hr', 'POST', `/api/time/weeks/${id}/reopen`, { reason: 'Eigener Tippfehler' });
  assert.equal(denied.status, 403);
  assert.match(denied.data.error, /andere HR-Person/);
  assert.equal((await h.week('hr')).canReopen, false);
  h.deps.setApprovalRule('personnel.hr_self_edit', 'allowed', { id: 1 });
  assert.equal((await h.week('hr')).canReopen, true);
  assert.equal((await h.api('hr', 'POST', `/api/time/weeks/${id}/reopen`, { reason: 'Eigener Tippfehler' })).status, 200);
  assert.equal(h.tasksOf(1, 'time_week_reopened').length, 0);
});

test('Wenn niemand sonst entscheiden kann, erfährt die Person das sofort', async t => {
  const h = await setup(t);
  h.db.prepare('UPDATE users SET active = 0 WHERE id = 2').run();
  await h.fullDay('hr', LAST_WEEK);
  const response = await h.submit('hr');
  assert.equal(response.status, 200);
  assert.match(response.data.warning, /niemand außer dir/);
});

test('Wartung ordnet Prüfaufgaben neu zu, wenn sich die Führung ändert, und ist wiederholbar', async t => {
  const h = await setup(t);
  await h.fillWeek('anna');
  const id = (await h.submit('anna')).data.id;
  h.db.prepare('UPDATE users SET manager_id = 3 WHERE id = 5').run();
  h.instance.maintenance();
  assert.equal(h.tasksOf(4, 'time_week_approval').length, 0);
  assert.equal(h.tasksOf(3, 'time_week_approval').length, 1);
  h.instance.maintenance();
  assert.equal(h.tasksOf(3, 'time_week_approval').length, 1);
  assert.equal((await h.decide('manager', id, 'approve')).status, 403, 'frühere Führungskraft');
  assert.equal((await h.decide('director', id, 'approve')).status, 200);
  h.instance.maintenance();
  assert.equal(h.tasksOf(3, 'time_week_approval').length, 0);
});

// ------------------------------------------------------------------ Sichten

test('Sichten: Person sieht nur sich, Führungskraft nur Eingereichtes ihrer Linie, HR alles', async t => {
  const h = await setup(t);
  await h.fillWeek('anna');
  const view = (person, userId = 5, week = LAST_WEEK) => h.api(person, 'GET', `/api/time/week?week=${week}&userId=${userId}`);

  // Offene Woche.
  assert.equal((await view('anna')).status, 200);
  assert.equal((await view('ben')).status, 403, 'Kollege');
  assert.equal((await view('clara')).status, 403, 'anderes Team');
  const managerOpen = await view('manager');
  assert.equal(managerOpen.status, 403, 'Führungskraft sieht noch nicht Eingereichtes nicht');
  assert.equal(JSON.stringify(managerOpen.data).includes('08:00'), false);
  assert.equal((await view('director')).status, 403);
  const hrOpen = await view('hr');
  assert.equal(hrOpen.status, 200);
  assert.equal(hrOpen.data.week.actualMinutes, 2400);
  assert.equal(hrOpen.data.week.totalBalanceMinutes, 0);
  assert.equal((await view('anna', 4)).status, 403, 'nach oben');
  assert.equal((await view('hr', 9999)).status, 404);
  assert.equal((await view('hr', 'abc')).status, 400);
  assert.equal((await h.api('anna', 'GET', '/api/time/week?week=gestern')).status, 400);

  // Offene Wochen tauchen in Listen für Führungskräfte nicht auf.
  assert.equal((await h.api('manager', 'GET', '/api/time/weeks?status=open')).status, 403);
  assert.equal((await h.api('manager', 'GET', '/api/time/weeks?status=all')).data.weeks.length, 0);

  // Eingereicht.
  const id = (await h.submit('anna')).data.id;
  assert.equal((await view('manager')).status, 200);
  assert.equal((await view('director')).status, 200, 'Führungslinie');
  assert.equal((await view('ben')).status, 403);
  assert.equal((await view('clara')).status, 403);
  assert.equal((await h.api('manager', 'GET', `/api/time/week?week=${THIS_WEEK}&userId=5`)).status, 403, 'andere Woche bleibt zu');

  assert.equal((await h.api('ben', 'GET', `/api/time/weeks/${id}`)).status, 403);
  assert.equal((await h.api('manager', 'GET', `/api/time/weeks/${id}`)).data.week.weekStart, LAST_WEEK);
  assert.equal((await h.api('hr', 'GET', '/api/time/weeks/9999')).status, 404);

  // Listen.
  assert.equal((await h.api('anna', 'GET', '/api/time/weeks')).data.weeks.length, 0, 'keine Unterstellten');
  assert.equal((await h.api('clara', 'GET', '/api/time/weeks')).data.weeks.length, 0);
  assert.equal((await h.api('anna', 'GET', '/api/time/weeks?scope=all')).status, 403);
  assert.equal((await h.api('manager', 'GET', '/api/time/weeks?scope=all')).status, 403);
  assert.equal((await h.api('manager', 'GET', '/api/time/weeks?scope=irgendwas')).status, 400);
  assert.equal((await h.api('manager', 'GET', '/api/time/weeks?status=irgendwas')).status, 400);
  assert.equal((await h.api('hr', 'GET', '/api/time/weeks?scope=all&status=all')).data.weeks.length, 1);

  // Wenn die Führungskraft die Woche zurückgibt, bleibt sie sichtbar, ein HR-Wiederöffnen schließt sie.
  await h.decide('manager', id, 'approve');
  await h.api('hr', 'POST', `/api/time/weeks/${id}/reopen`, { reason: 'Korrektur' });
  assert.equal((await view('manager')).status, 403, 'wieder offen: wieder nur Person und HR');
});

test('Rollengrenzen beim Schreiben: Führungskräfte ändern keine Zeiten, HR schon', async t => {
  const h = await setup(t);
  const created = await h.add('anna', LAST_WEEK, '08:00', '12:00');
  const id = created.data.entry.id;

  for (const person of ['ben', 'manager', 'director', 'clara']) {
    assert.equal((await h.add(person, LAST_WEEK, '08:00', '12:00', { userId: 5 })).status, 403, `${person} legt an`);
    assert.equal((await h.api(person, 'PATCH', `/api/time/entries/${id}`, { endTime: '13:00' })).status, 403, `${person} ändert`);
    assert.equal((await h.api(person, 'DELETE', `/api/time/entries/${id}`)).status, 403, `${person} löscht`);
  }
  assert.equal((await h.api('anna', 'PATCH', '/api/time/entries/9999', { endTime: '13:00' })).status, 404);
  assert.equal((await h.api('anna', 'DELETE', '/api/time/entries/abc')).status, 404);
  assert.equal((await h.add('hr', LAST_WEEK, '08:00', '12:00', { userId: 9999 })).status, 404);
  assert.equal((await h.add('hr', LAST_WEEK, '08:00', '12:00', { userId: 'abc' })).status, 400);

  const byHr = await h.add('bp', plusDays(LAST_WEEK, 1), '08:00', '12:00', { userId: 5, reason: 'Stempeluhr vergessen' });
  assert.equal(byHr.status, 201);
  assert.equal(byHr.data.entry.userId, 5);
  assert.equal(h.db.prepare('SELECT created_by FROM time_entries WHERE id = ?').get(byHr.data.entry.id).created_by, 2);
  assert.equal((await h.api('hr', 'PATCH', `/api/time/entries/${id}`, { endTime: '13:00', reason: 'Tippfehler' })).status, 200);
  assert.equal((await h.submit('hr')).status, 400, 'HR reicht nicht für andere ein, die eigene Woche ist leer');
});

test('Keine Rangliste und kein Leistungswert: Listen sind neutral nach Woche und Name sortiert', async t => {
  const h = await setup(t);
  for (const person of ['ben', 'anna']) {
    await h.fillWeek(person);
    await h.submit(person);
  }
  await h.fullDay('anna', THIS_WEEK);
  await h.submit('anna', THIS_WEEK);
  const list = await h.api('manager', 'GET', '/api/time/weeks');
  assert.deepEqual(
    list.data.weeks.map(week => [week.weekStart, week.userName]),
    [[THIS_WEEK, 'Anna Ahrens'], [LAST_WEEK, 'Anna Ahrens'], [LAST_WEEK, 'Ben Berg']]
  );
  const fields = Object.keys(list.data.weeks[0]).join(',');
  assert.doesNotMatch(fields, /rank|score|rating|leistung|performance/i);
  assert.equal((await h.api('hr', 'GET', '/api/time/people')).data.people[0].name, 'Anna Ahrens', 'alphabetisch');
});

// ------------------------------------------------------------------ Historie

test('Historie hält jede Änderung und Löschung fest, und Berechtigte können sie lesen', async t => {
  const h = await setup(t);
  const id = (await h.add('anna', LAST_WEEK, '08:00', '12:00', { note: 'erste Fassung' })).data.entry.id;
  assert.equal((await h.api('anna', 'GET', `/api/time/history?week=${LAST_WEEK}`)).data.history.length, 0, 'Anlegen ist noch keine Änderung');

  assert.equal((await h.api('anna', 'PATCH', `/api/time/entries/${id}`, { endTime: '13:00', note: 'korrigiert' })).status, 200);
  assert.equal((await h.api('hr', 'PATCH', `/api/time/entries/${id}`, { breakMinutes: 15, reason: 'Pause nachgetragen' })).status, 200);
  const changed = await h.week('anna');
  assert.equal(changed.days[0].entries[0].changed, true);

  const removable = (await h.add('anna', plusDays(LAST_WEEK, 1), '08:00', '12:00')).data.entry.id;
  assert.equal(h.db.prepare('SELECT COUNT(*) AS count FROM time_entry_history').get().count, 2);
  assert.equal((await h.api('anna', 'DELETE', `/api/time/entries/${removable}`)).status, 200);
  assert.equal(h.db.prepare('SELECT COUNT(*) AS count FROM time_entries WHERE id = ?').get(removable).count, 0);

  const { data } = await h.api('anna', 'GET', `/api/time/history?week=${LAST_WEEK}`);
  assert.deepEqual(data.history.map(row => row.action), ['delete', 'update', 'update']);

  const [deleted, byHr, byAnna] = data.history;
  assert.equal(deleted.entryId, removable);
  assert.equal(deleted.before.startTime, '08:00');
  assert.equal(deleted.after, null);
  assert.equal(deleted.changedByName, 'Anna Ahrens');

  assert.equal(byAnna.before.endTime, '12:00');
  assert.equal(byAnna.before.note, 'erste Fassung');
  assert.equal(byAnna.after.endTime, '13:00');
  assert.equal(byAnna.after.note, 'korrigiert');

  assert.equal(byHr.before.breakMinutes, 0);
  assert.equal(byHr.after.breakMinutes, 15);
  assert.equal(byHr.changedByName, 'Hanna HR');
  assert.equal(byHr.reason, 'Pause nachgetragen');
  assert.equal(byAnna.reason, null, 'eigene Änderungen brauchen keinen Grund');

  // Sicht wie bei der Woche.
  const read = (person, query = '') => h.api(person, 'GET', `/api/time/history?week=${LAST_WEEK}&userId=5${query}`);
  assert.equal((await read('ben')).status, 403);
  assert.equal((await read('manager')).status, 403, 'noch nicht eingereicht');
  assert.equal((await read('hr')).status, 200);
  assert.equal((await h.api('hr', 'GET', `/api/time/history?week=${LAST_WEEK}&userId=9999`)).status, 404);
  assert.equal((await h.api('anna', 'GET', '/api/time/history?week=nie')).status, 400);
  await h.submit('anna');
  assert.equal((await read('manager')).status, 200);
  assert.equal((await read('clara')).status, 403);
});

test('Historie: Verschieben ist in beiden Wochen zu sehen, und Gehen wird festgehalten', async t => {
  const h = await setup(t, { time: '08:00' });
  const id = (await h.add('anna', LAST_WEEK, '08:00', '12:00')).data.entry.id;
  await h.api('anna', 'PATCH', `/api/time/entries/${id}`, { date: THIS_WEEK });
  const old = await h.api('anna', 'GET', `/api/time/history?week=${LAST_WEEK}`);
  const moved = await h.api('anna', 'GET', `/api/time/history?week=${THIS_WEEK}`);
  assert.equal(old.data.history.length, 1);
  assert.equal(moved.data.history.length, 1);
  assert.equal(moved.data.history[0].after.date, THIS_WEEK);

  await h.api('ben', 'POST', '/api/time/clock/in', {});
  h.clock.time = '12:00';
  await h.api('ben', 'POST', '/api/time/clock/out', {});
  const clock = await h.api('ben', 'GET', `/api/time/history?week=${THIS_WEEK}`);
  assert.equal(clock.data.history.length, 1);
  assert.equal(clock.data.history[0].action, 'clock_out');
  assert.equal(clock.data.history[0].before.endTime, null);
  assert.equal(clock.data.history[0].after.endTime, '12:00');
});

// ------------------------------------------------------------------ Saldo

test('Saldo: Wochensaldo und Gesamtsaldo aus Ist und Soll', async t => {
  const h = await setup(t, { today: '2026-03-20' });
  // Woche 1: 5 mal 8 Stunden, genau das Soll.
  await h.fillWeek('anna', LAST_WEEK);
  let week = await h.week('anna');
  assert.equal(week.targetMinutes, 2400);
  assert.equal(week.dueMinutes, 2400);
  assert.equal(week.actualMinutes, 2400);
  assert.equal(week.balanceMinutes, 0);
  assert.equal(week.counted, true);
  assert.equal(week.weeklyHours, 40);
  assert.equal(week.totalBalanceMinutes, 0);
  assert.equal(week.days[0].weekday, 'Montag');
  assert.equal(week.days[0].targetMinutes, 480);
  assert.equal(week.days[5].targetMinutes, 0, 'Samstag hat kein Soll');
  assert.equal(week.days[6].targetMinutes, 0, 'Sonntag hat kein Soll');

  // Samstag kommt dazu: 2 Stunden plus.
  await h.add('anna', '2026-03-07', '10:00', '12:00');
  week = await h.week('anna');
  assert.equal(week.balanceMinutes, 120);

  // Woche 2: nur vier Tage. Saldo minus 8 Stunden, Gesamt minus 6 Stunden.
  for (let offset = 0; offset < 4; offset += 1) await h.fullDay('anna', plusDays(THIS_WEEK, offset));
  week = await h.week('anna', `?week=${THIS_WEEK}`);
  assert.equal(week.balanceMinutes, -480);
  assert.equal(week.totalBalanceMinutes, 120 - 480);
});

test('Saldo: Wochen ohne Einträge zählen nicht, das Soll beginnt mit dem ersten Eintrag', async t => {
  const h = await setup(t, { today: '2026-03-27' });
  // Erster Eintrag erst am Mittwoch: Montag und Dienstag gehören nicht zum Soll.
  await h.fullDay('anna', '2026-03-04');
  await h.fullDay('anna', '2026-03-05');
  await h.fullDay('anna', '2026-03-06');
  const first = await h.week('anna');
  assert.equal(first.targetMinutes, 2400, 'das volle Wochensoll wird angezeigt');
  assert.equal(first.dueMinutes, 1440);
  assert.equal(first.balanceMinutes, 0);

  // Danach zwei leere Wochen, dann eine vollständige Woche.
  await h.fillWeek('anna', '2026-03-23');
  const empty = await h.week('anna', '?week=2026-03-09');
  assert.equal(empty.counted, false);
  assert.equal(empty.dueMinutes, 0);
  assert.equal(empty.balanceMinutes, 0);
  assert.equal(empty.targetMinutes, 2400);
  const total = (await h.week('anna', '?week=2026-03-23')).totalBalanceMinutes;
  assert.equal(total, 0, 'leere Wochen erzeugen kein falsches Minus');

  // Ein fremder Saldo bleibt unberührt.
  assert.equal((await h.week('ben', '?week=2026-03-23')).totalBalanceMinutes, 0);
});

test('Saldo: In der laufenden Woche zählt das Soll nur bis heute, heute erst mit dem ersten Abschluss', async t => {
  const h = await setup(t, { today: THIS_WEEK });
  await h.fullDay('anna', LAST_WEEK);
  h.clock.date = '2026-03-11';
  await h.fullDay('anna', THIS_WEEK);
  await h.fullDay('anna', plusDays(THIS_WEEK, 1));
  let week = await h.week('anna', '');
  assert.equal(week.targetMinutes, 2400);
  assert.equal(week.dueMinutes, 960, 'Montag und Dienstag, heute noch nicht');
  assert.equal(week.balanceMinutes, 0);

  await h.add('anna', TODAY, '08:00', '12:00');
  week = await h.week('anna', '');
  assert.equal(week.dueMinutes, 1440, 'jetzt zählt auch heute');
  assert.equal(week.actualMinutes, 1200);
  assert.equal(week.balanceMinutes, -240);
});

test('Soll: Wochenstunden kommen aus der Voreinstellung oder von der Person, HR kann setzen', async t => {
  const h = await setup(t);
  assert.equal((await h.api('anna', 'GET', '/api/time/settings')).status, 403);
  assert.equal((await h.api('manager', 'PUT', '/api/time/settings', { weeklyHours: 38 })).status, 403);
  assert.equal((await h.api('anna', 'GET', '/api/time/people')).status, 403);
  assert.equal((await h.api('manager', 'PUT', '/api/time/people/5/hours', { reason: 'Vertrag', weeklyHours: 20 })).status, 403);
  assert.equal((await h.api('hr', 'GET', '/api/time/settings')).data.settings.weeklyHours, 40);

  for (const value of [0, -1, 81, 'viel', '', null]) {
    assert.equal((await h.api('hr', 'PUT', '/api/time/settings', { weeklyHours: value })).status, 400, `Voreinstellung ${value}`);
  }
  for (const value of [-1, 81, 'viel']) {
    assert.equal((await h.api('hr', 'PUT', '/api/time/people/5/hours', { reason: 'Vertrag', weeklyHours: value })).status, 400, `Person ${value}`);
  }
  assert.equal((await h.api('hr', 'PUT', '/api/time/people/9999/hours', { reason: 'Vertrag', weeklyHours: 20 })).status, 404);

  assert.equal((await h.api('hr', 'PUT', '/api/time/settings', { weeklyHours: 38.5 })).status, 200);
  await h.fullDay('anna', LAST_WEEK);
  let week = await h.week('anna');
  assert.equal(week.weeklyHours, 38.5);
  assert.equal(week.hoursSource, 'default');
  assert.equal(week.targetMinutes, 2310);
  assert.equal(week.days[0].targetMinutes, 462);

  const personal = await h.api('bp', 'PUT', '/api/time/people/5/hours', { reason: 'Vertrag', weeklyHours: 20 });
  assert.equal(personal.status, 200);
  assert.equal(personal.data.hoursSource, 'person');
  week = await h.week('anna');
  assert.equal(week.weeklyHours, 20);
  assert.equal(week.targetMinutes, 1200);
  assert.equal(week.hoursSource, 'person');
  assert.equal((await h.week('ben')).weeklyHours, 38.5, 'andere bleiben bei der Voreinstellung');

  const list = await h.api('hr', 'GET', '/api/time/people');
  const anna = list.data.people.find(person => person.id === 5);
  assert.equal(anna.weeklyHours, 20);
  assert.equal(anna.hoursSource, 'person');
  assert.equal(list.data.people.length, 7);

  assert.equal((await h.api('hr', 'PUT', '/api/time/people/5/hours', { reason: 'Vertrag', weeklyHours: null })).data.hoursSource, 'default');
  assert.equal((await h.week('anna')).weeklyHours, 38.5);
});

test('Soll: Eine genehmigte Woche behält ihre Wochenstunden, wenn sich die Zahl später ändert', async t => {
  const h = await setup(t);
  await h.fillWeek('anna');
  const id = (await h.submit('anna')).data.id;
  await h.decide('manager', id, 'approve');
  await h.api('hr', 'PUT', '/api/time/people/5/hours', { reason: 'Vertrag', weeklyHours: 20 });

  const approved = await h.week('anna');
  assert.equal(approved.weeklyHours, 40);
  assert.equal(approved.balanceMinutes, 0);
  assert.equal(approved.totalBalanceMinutes, 0);

  await h.api('hr', 'POST', `/api/time/weeks/${id}/reopen`, { reason: 'Vertrag rückwirkend geändert' });
  const reopened = await h.week('anna');
  assert.equal(reopened.weeklyHours, 20, 'wieder offen: wieder der aktuelle Wert');
  assert.equal(reopened.balanceMinutes, 1200);
});

// ------------------------------------------------------------------ Hinweise

test('Hinweis: mehr als 10 Stunden am Tag, aber genau 10 Stunden nicht', async t => {
  const h = await setup(t);
  const exactly = await h.add('anna', LAST_WEEK, '08:00', '18:45', { breakMinutes: 45 });
  assert.equal(exactly.status, 201);
  assert.equal(hintCodes(exactly.data.hints).includes('daily_limit'), false);

  const more = await h.add('ben', LAST_WEEK, '08:00', '18:46', { breakMinutes: 45 });
  assert.equal(more.status, 201, 'der Hinweis blockiert nicht');
  const found = more.data.hints.find(item => item.code === 'daily_limit');
  assert.ok(found);
  assert.equal(found.date, LAST_WEEK);
  assert.match(found.message, new RegExp(HINT_TEXT));
  assert.match(found.message, /10:01 Stunden/);

  // Mehrere Einträge am Tag zählen zusammen.
  const part1 = await h.add('clara', LAST_WEEK, '06:00', '12:00');
  assert.equal(hintCodes(part1.data.hints).includes('daily_limit'), false);
  const part2 = await h.add('clara', LAST_WEEK, '13:00', '18:30');
  assert.equal(hintCodes(part2.data.hints).includes('daily_limit'), true);
});

test('Hinweis: zu wenig Pause bei über 6 Stunden und bei über 9 Stunden', async t => {
  const h = await setup(t);
  const shortBreak = async (person, date, start, end, breakMinutes) => {
    const response = await h.add(person, date, start, end, { breakMinutes });
    assert.equal(response.status, 201);
    return response.data.hints.some(item => item.code === 'short_break' && item.date === date);
  };

  // Genau 6 Stunden Arbeit brauchen keine Pause.
  assert.equal(await shortBreak('anna', '2026-03-02', '08:00', '14:00', 0), false);
  // 6:01 Stunden ohne Pause lösen den Hinweis aus.
  assert.equal(await shortBreak('anna', '2026-03-03', '08:00', '14:01', 0), true);
  // 29 Minuten reichen nicht, 30 schon.
  assert.equal(await shortBreak('anna', '2026-03-04', '08:00', '15:00', 29), true);
  assert.equal(await shortBreak('anna', '2026-03-05', '08:00', '15:00', 30), false);
  // Genau 9 Stunden Arbeit brauchen nur 30 Minuten.
  assert.equal(await shortBreak('ben', '2026-03-02', '08:00', '17:30', 30), false);
  // Über 9 Stunden sind 44 Minuten zu wenig, 45 genug.
  assert.equal(await shortBreak('ben', '2026-03-03', '08:00', '17:45', 44), true);
  assert.equal(await shortBreak('ben', '2026-03-04', '08:00', '17:46', 45), false);

  const text = (await h.add('clara', '2026-03-03', '08:00', '18:00', { breakMinutes: 10 })).data.hints.find(item => item.code === 'short_break');
  assert.match(text.message, new RegExp(HINT_TEXT));
  assert.match(text.message, /weniger als 45 Minuten/);

  // Die Lücke zwischen zwei Einträgen zählt als Pause, unter 15 Minuten aber nicht.
  await h.add('clara', '2026-03-04', '08:00', '12:00');
  const withGap = await h.add('clara', '2026-03-04', '12:30', '16:30');
  assert.equal(hintCodes(withGap.data.hints.filter(item => item.date === '2026-03-04')).includes('short_break'), false);
  await h.add('clara', '2026-03-05', '08:00', '12:00');
  const shortGap = await h.add('clara', '2026-03-05', '12:10', '16:30');
  assert.equal(hintCodes(shortGap.data.hints.filter(item => item.date === '2026-03-05')).includes('short_break'), true);
});

test('Hinweis: weniger als 11 Stunden Ruhezeit bis zum nächsten Arbeitsbeginn', async t => {
  const h = await setup(t);
  await h.add('anna', '2026-03-02', '12:00', '22:00', { breakMinutes: 60 });
  const tooSoon = await h.add('anna', '2026-03-03', '08:59', '12:00');
  assert.equal(tooSoon.status, 201, 'der Hinweis blockiert nicht');
  const found = tooSoon.data.hints.find(item => item.code === 'short_rest');
  assert.ok(found);
  assert.equal(found.date, '2026-03-03');
  assert.match(found.message, new RegExp(HINT_TEXT));
  assert.match(found.message, /10:59 Stunden/);

  // Genau 11 Stunden sind in Ordnung.
  await h.add('ben', '2026-03-02', '12:00', '22:00', { breakMinutes: 60 });
  const exactly = await h.add('ben', '2026-03-03', '09:00', '12:00');
  assert.equal(hintCodes(exactly.data.hints).includes('short_rest'), false);

  // Eine Mittagspause am selben Tag ist keine Ruhezeit.
  await h.add('clara', '2026-03-02', '08:00', '12:00');
  const lunch = await h.add('clara', '2026-03-02', '13:00', '17:00');
  assert.equal(hintCodes(lunch.data.hints).includes('short_rest'), false);

  // Auch über die Wochengrenze hinweg: Sonntag spät, Montag früh.
  await h.add('director', '2026-03-08', '18:00', '23:00');
  const monday = await h.add('director', '2026-03-09', '06:00', '10:00');
  assert.ok(monday.data.hints.some(item => item.code === 'short_rest' && item.date === '2026-03-09'));
});

test('Hinweis: Ruhezeit bei Nachtschichten über Mitternacht', async t => {
  const h = await setup(t);
  // Durchgehende Schicht über Mitternacht ist keine Ruhezeit, auch nicht mit 23:59 als Ende.
  await h.add('anna', '2026-03-02', '22:00', '24:00');
  const continued = await h.add('anna', '2026-03-03', '00:00', '06:00');
  assert.equal(hintCodes(continued.data.hints).includes('short_rest'), false);
  await h.add('ben', '2026-03-02', '22:00', '23:59');
  const almost = await h.add('ben', '2026-03-03', '00:00', '06:00');
  assert.equal(hintCodes(almost.data.hints).includes('short_rest'), false);

  // Pause mitten in der Schicht bleibt eine Pause.
  const inShiftBreak = await h.add('anna', '2026-03-03', '06:30', '07:00');
  assert.equal(hintCodes(inShiftBreak.data.hints).includes('short_rest'), false);

  // Nächste Schicht am selben Datum: Jetzt liegt die Ruhezeit innerhalb eines Kalendertags.
  const secondShift = await h.add('anna', '2026-03-03', '14:00', '20:00', { breakMinutes: 30 });
  assert.ok(secondShift.data.hints.some(item => item.code === 'short_rest' && item.date === '2026-03-03'));
});

test('Hinweis: Arbeit am Sonntag und am Feiertag, Samstag nicht', async t => {
  const h = await setup(t, { modules: ['absence'] });
  createAbsenceModule({ ...h.deps, now: () => h.clock }).initialize();
  h.db.prepare("INSERT INTO absence_holidays (date, name, source, created_at) VALUES ('2026-03-03', 'Betriebsfeiertag', 'custom', '2026-01-01')").run();

  const saturday = await h.add('anna', '2026-03-07', '10:00', '11:00');
  assert.equal(hintCodes(saturday.data.hints).includes('sunday_or_holiday'), false);

  const sunday = await h.add('anna', '2026-03-08', '10:00', '11:00');
  assert.equal(sunday.status, 201, 'der Hinweis blockiert nicht');
  const sundayHint = sunday.data.hints.find(item => item.code === 'sunday_or_holiday');
  assert.equal(sundayHint.date, '2026-03-08');
  assert.match(sundayHint.message, new RegExp(HINT_TEXT));
  assert.match(sundayHint.message, /Sonntag/);

  const holiday = await h.add('ben', '2026-03-03', '10:00', '11:00');
  const holidayHint = holiday.data.hints.find(item => item.code === 'sunday_or_holiday');
  assert.equal(holidayHint.date, '2026-03-03');
  assert.match(holidayHint.message, /Betriebsfeiertag/);

  const normalDay = await h.add('clara', '2026-03-04', '10:00', '11:00');
  assert.equal(normalDay.data.hints.length, 0);
});

test('Hinweise erscheinen in der Wochenansicht für Berechtigte, jeder ist als Prüfhinweis gekennzeichnet', async t => {
  const h = await setup(t);
  await h.add('anna', '2026-03-02', '06:00', '20:00');
  await h.add('anna', '2026-03-03', '06:00', '08:00');
  await h.add('anna', '2026-03-08', '06:00', '08:00');
  const { hints, days } = await h.week('anna');
  assert.deepEqual([...new Set(hintCodes(hints))].sort(), ['daily_limit', 'short_break', 'short_rest', 'sunday_or_holiday']);
  for (const item of hints) assert.ok(item.message.endsWith(HINT_TEXT), item.message);
  assert.deepEqual(hints.map(item => item.date), [...hints.map(item => item.date)].sort(), 'nach Datum sortiert');
  assert.equal(days.length, 7);

  await h.submit('anna');
  const asManager = await h.week('manager', `?week=${LAST_WEEK}&userId=5`);
  assert.equal(asManager.hints.length, hints.length);
});

test('Die Ruhezeit vor Wochenbeginn verrät der Führungskraft nichts aus nicht eingereichten Wochen', async t => {
  const h = await setup(t);
  await h.add('anna', '2026-03-01', '18:00', '23:00'); // Sonntag der Vorwoche, nicht eingereicht
  await h.add('anna', '2026-03-02', '06:00', '12:00');
  await h.submit('anna');
  const asAnna = await h.week('anna');
  assert.equal(hintCodes(asAnna.hints).includes('short_rest'), true);
  const asManager = await h.week('manager', `?week=${LAST_WEEK}&userId=5`);
  assert.equal(hintCodes(asManager.hints).includes('short_rest'), false);
});

// ------------------------------------------------------------------ Andere Module

test('Abwesenheit an: Feiertage und genehmigte Abwesenheiten mindern das Soll, ohne die Art zu nennen', async t => {
  const h = await setup(t, { modules: ['absence'] });
  const absence = createAbsenceModule({ ...h.deps, now: () => h.clock });
  absence.initialize();
  const typeId = code => h.db.prepare('SELECT id FROM absence_types WHERE code = ?').get(code).id;
  const addRequest = (start, end, status, code = 'vacation', startHalf = 0, endHalf = 0) => h.db.prepare(`
    INSERT INTO absence_requests (user_id, type_id, start_date, end_date, start_half, end_half, status, created_by, created_at)
    VALUES (5, ?, ?, ?, ?, ?, ?, 5, '2026-01-01')
  `).run(typeId(code), start, end, startHalf, endHalf, status);

  h.db.prepare("INSERT INTO absence_holidays (date, name, source, created_at) VALUES ('2026-03-02', 'Betriebsfeiertag', 'custom', '2026-01-01')").run();
  addRequest('2026-03-03', '2026-03-03', 'approved', 'sick');         // Dienstag krank
  addRequest('2026-03-04', '2026-03-04', 'approved', 'vacation', 1);  // Mittwoch halber Urlaubstag
  addRequest('2026-03-05', '2026-03-05', 'pending');                  // Donnerstag nur beantragt
  addRequest('2026-03-06', '2026-03-06', 'rejected');                 // Freitag abgelehnt

  await h.add('anna', '2026-03-05', '08:00', '16:30', { breakMinutes: 30 });
  const week = await h.week('anna');
  assert.deepEqual(week.days.map(day => day.targetMinutes), [0, 0, 240, 480, 480, 0, 0]);
  assert.equal(week.targetMinutes, 1200);
  assert.equal(week.days[0].holidayName, 'Betriebsfeiertag');
  assert.equal(week.days[1].absentShare, 1);
  assert.equal(week.days[2].absentShare, 0.5);
  assert.equal(week.days[3].absentShare, 0);

  // Auch die Führungskraft erfährt über die Zeiten nichts über die Art.
  await h.submit('anna');
  const asManager = await h.api('manager', 'GET', `/api/time/week?week=${LAST_WEEK}&userId=5`);
  assert.doesNotMatch(JSON.stringify(asManager.data), /krank|sick|urlaub|vacation/i);

  // Zwei halbe Abwesenheiten am selben Tag ergeben einen ganzen Tag, nicht mehr.
  addRequest('2026-03-10', '2026-03-10', 'approved', 'vacation', 1);
  addRequest('2026-03-10', '2026-03-10', 'approved', 'special', 0, 1);
  await h.fullDay('anna', THIS_WEEK);
  const current = await h.week('anna', `?week=${THIS_WEEK}`);
  assert.equal(current.days[1].absentShare, 1);
  assert.equal(current.days[1].targetMinutes, 0);
});

test('Abwesenheit aus: Das Soll bleibt unberührt, auch wenn die Tabellen da sind', async t => {
  const h = await setup(t, { modules: ['absence'] });
  createAbsenceModule({ ...h.deps, now: () => h.clock }).initialize();
  h.db.prepare("INSERT INTO absence_holidays (date, name, source, created_at) VALUES ('2026-03-02', 'Feiertag', 'custom', '2026-01-01')").run();
  await h.fullDay('anna', '2026-03-02');
  assert.equal((await h.week('anna')).targetMinutes, 1920);

  h.enabled.delete('absence');
  const week = await h.week('anna');
  assert.equal(week.targetMinutes, 2400);
  assert.equal(week.days[0].holidayName, null);
  assert.equal(hintCodes(week.hints).includes('sunday_or_holiday'), false, 'ohne Modul kein Feiertagshinweis');
});

test('Abwesenheit eingeschaltet, aber Tabellen fehlen: Die Zeiterfassung läuft weiter', async t => {
  const h = await setup(t, { modules: ['absence'] });
  await h.fullDay('anna', LAST_WEEK);
  const week = await h.week('anna');
  assert.equal(week.targetMinutes, 2400);
  assert.equal(week.days[0].holidayName, null);
});

test('Personalakte an: Wochenstunden kommen von dort, sonst greift die Rückfallreihe', async t => {
  const h = await setup(t, { modules: ['personnel'] });
  await h.fullDay('anna', LAST_WEEK);

  // Modul an, aber Tabelle fehlt noch.
  assert.equal((await h.week('anna')).hoursSource, 'default');

  // Tabelle ohne die erwartete Spalte: kein Absturz.
  h.db.exec('CREATE TABLE personnel_records (user_id INTEGER PRIMARY KEY)');
  assert.equal((await h.week('anna')).hoursSource, 'default');
  h.db.exec('DROP TABLE personnel_records');

  h.db.exec('CREATE TABLE personnel_records (user_id INTEGER PRIMARY KEY, weekly_hours REAL)');
  h.db.prepare('INSERT INTO personnel_records (user_id, weekly_hours) VALUES (5, 32), (6, NULL)').run();
  await h.api('hr', 'PUT', '/api/time/people/5/hours', { reason: 'Vertrag', weeklyHours: 20 });
  await h.api('hr', 'PUT', '/api/time/people/6/hours', { reason: 'Vertrag', weeklyHours: 25 });

  const anna = await h.week('anna');
  assert.equal(anna.weeklyHours, 32, 'Personalakte hat Vorrang');
  assert.equal(anna.hoursSource, 'personnel');
  assert.equal(anna.targetMinutes, 1920);

  const ben = await h.week('ben');
  assert.equal(ben.weeklyHours, 25, 'kein Wert in der Akte: Eintrag aus der Zeiterfassung');
  assert.equal(ben.hoursSource, 'person');

  const clara = await h.week('clara');
  assert.equal(clara.weeklyHours, 40, 'keine Akte: Voreinstellung');
  assert.equal(clara.hoursSource, 'default');

  // Modul aus: Die Akte zählt nicht mehr, auch wenn die Tabelle da ist.
  h.enabled.delete('personnel');
  const off = await h.week('anna');
  assert.equal(off.weeklyHours, 20);
  assert.equal(off.hoursSource, 'person');
});

test('Zusammenspiel: Ein echter Abwesenheitsantrag über das Abwesenheitsmodul wirkt auf das Soll', async t => {
  const h = await setup(t, { modules: ['absence'] });
  const absence = createAbsenceModule({ ...h.deps, now: () => h.clock });
  absence.initialize();
  const app = express();
  app.use(express.json());
  app.use('/api', absence.router);
  const server = await new Promise(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const post = (user, url, body) => fetch(`http://127.0.0.1:${server.address().port}${url}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-test-user': String(user) },
    body: JSON.stringify(body)
  }).then(response => response.json());
  const typeId = h.db.prepare("SELECT id FROM absence_types WHERE code = 'vacation'").get().id;

  const created = await post(5, '/api/absence/requests', { typeId, startDate: '2026-03-16', endDate: '2026-03-20' });
  await h.fullDay('anna', '2026-03-09');
  assert.equal((await h.week('anna', '?week=2026-03-16')).targetMinutes, 2400, 'noch nicht genehmigt');
  await post(4, `/api/absence/requests/${created.id}/decision`, { decision: 'approve' });
  assert.equal((await h.week('anna', '?week=2026-03-16')).targetMinutes, 0, 'genehmigt');
  await post(5, `/api/absence/requests/${created.id}/cancel`, {});
  assert.equal((await h.week('anna', '?week=2026-03-16')).targetMinutes, 2400, 'storniert');
});

// ------------------------------------------------------------------ Export

test('Export: nur HR, und Felder sind gegen Formeln geschützt', async t => {
  const h = await setup(t);
  h.db.prepare("UPDATE users SET name = '=HYPERLINK(\"http://böse.example\")' WHERE id = 6").run();
  await h.fullDay('anna', LAST_WEEK);
  await h.add('anna', plusDays(LAST_WEEK, 1), '08:00', '12:30', { note: '=SUMME(A1:A9)' });
  await h.add('anna', plusDays(LAST_WEEK, 2), '08:00', '12:00', { note: '+49 170 1;2' });
  await h.add('ben', LAST_WEEK, '08:00', '12:00', { note: '@cmd' });
  await h.add('clara', '2026-02-27', '08:00', '12:00', { note: 'Falscher Monat' });
  await h.api('clara', 'POST', '/api/time/clock/in', {});
  const id = (await h.submit('ben')).data.id;
  await h.decide('manager', id, 'approve');

  for (const person of ['anna', 'manager', 'director']) {
    assert.equal((await h.api(person, 'GET', '/api/time/export?month=2026-03')).status, 403, person);
  }
  assert.equal((await h.api('hr', 'GET', '/api/time/export')).status, 400);
  assert.equal((await h.api('hr', 'GET', '/api/time/export?month=2026-13')).status, 400);
  assert.equal((await h.api('hr', 'GET', '/api/time/export?month=x')).status, 400);

  const response = await h.api('hr', 'GET', '/api/time/export?month=2026-03');
  assert.equal(response.status, 200);
  const lines = response.data.trim().split('\r\n');
  assert.equal(lines[0], 'Name;Personalnummer;E-Mail;Datum;Beginn;Ende;Pause (Min.);Arbeitszeit (Std.);Wochenstatus;Notiz');
  assert.equal(lines.length, 5, 'Kopf und vier beendete Einträge im März; laufende und andere Monate fehlen');
  assert.ok(lines.includes('Anna Ahrens;;anna@test.local;02.03.2026;08:00;16:30;30;8,00;offen;'), lines.join('\n'));
  assert.ok(lines.includes("Anna Ahrens;;anna@test.local;03.03.2026;08:00;12:30;0;4,50;offen;'=SUMME(A1:A9)"), lines.join('\n'));
  assert.ok(lines.includes(`Anna Ahrens;;anna@test.local;04.03.2026;08:00;12:00;0;4,00;offen;"'+49 170 1;2"`), lines.join('\n'));
  assert.ok(lines.includes(`"'=HYPERLINK(""http://böse.example"")";;ben@test.local;02.03.2026;08:00;12:00;0;4,00;genehmigt;'@cmd`), lines.join('\n'));

  assert.equal(csvField('-1+1'), "'-1+1");
  assert.equal(h.db.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE action = 'time_exported'").get().count, 1);
});

test('Export: Die Antwort ist UTF-8 mit BOM und wird als Datei angeboten', async t => {
  const h = await setup(t);
  const app = express();
  app.use('/api', h.instance.router);
  const server = await new Promise(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/time/export?month=2026-03`, { headers: { 'x-test-user': '1' } });
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.match(response.headers.get('content-type'), /text\/csv.*utf-8/i);
  assert.match(response.headers.get('content-disposition'), /attachment; filename="zeiten-2026-03\.csv"/);
});

// ------------------------------------------------------------------ Unsinnige Eingaben

test('Unsinnige Eingaben führen nie zu einem Serverfehler', async t => {
  const h = await setup(t);
  const entryId = (await h.add('anna', LAST_WEEK, '08:00', '12:00')).data.entry.id;
  await h.fullDay('ben', LAST_WEEK);
  const weekId = (await h.submit('ben')).data.id;
  const garbage = [[], {}, ['a'], ['08:00'], { a: 1 }, true, false, null, -1, 1.5, 0, '', '   ', 'x'.repeat(5000), '<script>', '2026-13-45', '99:99', '1e9'];
  const forms = [
    ['POST', '/api/time/entries', ['date', 'startTime', 'endTime', 'breakMinutes', 'note', 'userId', 'reason'], { date: TODAY, startTime: '20:00', endTime: '21:00' }],
    ['PATCH', `/api/time/entries/${entryId}`, ['date', 'startTime', 'endTime', 'breakMinutes', 'note', 'reason'], {}],
    ['POST', '/api/time/clock/out', ['breakMinutes'], {}],
    ['POST', '/api/time/weeks/submit', ['week'], {}],
    ['POST', `/api/time/weeks/${weekId}/decision`, ['decision', 'comment'], { decision: 'return' }],
    ['POST', `/api/time/weeks/${weekId}/reopen`, ['reason'], {}],
    ['PUT', '/api/time/settings', ['weeklyHours'], {}],
    ['PUT', '/api/time/people/5/hours', ['weeklyHours', 'reason'], {}]
  ];
  for (const [method, url, fields, base] of forms) {
    for (const field of fields) {
      for (const value of garbage) {
        const response = await h.api('hr', method, url, { ...base, [field]: value });
        assert.ok(response.status < 500, `${method} ${url} ${field}=${JSON.stringify(value)?.slice(0, 40)}: ${response.status} ${JSON.stringify(response.data)?.slice(0, 200)}`);
      }
    }
    assert.ok((await h.api('hr', method, url, ['liste'])).status < 500, `${url} mit Liste als Inhalt`);
  }
  for (const url of [
    '/api/time/week?week=a&week=b',
    '/api/time/week?userId=1&userId=2',
    '/api/time/history?week=a&userId=b',
    '/api/time/weeks?scope=a&scope=b',
    '/api/time/weeks?status=a&status=b',
    '/api/time/weeks/abc',
    '/api/time/export?month=a&month=b'
  ]) {
    const response = await h.api('hr', 'GET', url);
    assert.ok(response.status < 500, `${url}: ${response.status}`);
  }
  const week = await h.week('anna');
  assert.ok(week.days.every(day => day.entries.every(entry => /^\d\d:\d\d$/.test(entry.startTime))), 'die Einträge sind heil geblieben');
});

// ------------------------------------------------------------------ Systemkonto, Demo, Hilfe, Stammdaten

test('Die Systemadministration wird wie HR behandelt, hat aber keine eigene Erfassung', async t => {
  const SYSTEM_ID = 50;
  let harness;
  const current = req => {
    const id = Number(req.get('x-test-user'));
    if (id === SYSTEM_ID) return { id: SYSTEM_ID, name: 'Systemadministration', role: 'super_admin', manager_id: null };
    return harness.db.prepare('SELECT id, name, email, role, title, manager_id FROM users WHERE id = ? AND is_system_account = 0 AND active = 1').get(id) || null;
  };
  const auth = (req, res, next) => (current(req) ? next() : res.status(401).json({ error: 'Nicht angemeldet' }));
  harness = await setup(t, { extra: { current, auth } });
  harness.db.prepare("INSERT INTO users (id, name, email, password_hash, role, is_system_account) VALUES (?, 'Systemadministration', 'system@test.local', '!', 'hr_admin', 1)").run(SYSTEM_ID);

  await harness.fillWeek('anna');
  const id = (await harness.submit('anna')).data.id;
  assert.equal((await harness.api(SYSTEM_ID, 'GET', '/api/time/week')).status, 404);
  assert.equal((await harness.api(SYSTEM_ID, 'POST', '/api/time/clock/in', {})).status, 404);
  assert.equal((await harness.api(SYSTEM_ID, 'POST', '/api/time/weeks/submit', {})).status, 404);
  assert.equal((await harness.api(SYSTEM_ID, 'GET', '/api/time/people')).data.people.some(person => person.id === SYSTEM_ID), false);
  assert.equal((await harness.api(SYSTEM_ID, 'GET', `/api/time/week?week=${LAST_WEEK}&userId=5`)).status, 200);
  assert.equal((await harness.decide(SYSTEM_ID, id, 'approve')).status, 200);
  assert.equal((await harness.api(SYSTEM_ID, 'POST', `/api/time/weeks/${id}/reopen`, { reason: 'Support' })).status, 200);
});

test('Stammdaten: Ein zweites Initialisieren ändert nichts', async t => {
  const h = await setup(t);
  await h.api('hr', 'PUT', '/api/time/settings', { weeklyHours: 35 });
  await h.fullDay('anna', LAST_WEEK);
  h.instance.initialize();
  assert.equal((await h.api('hr', 'GET', '/api/time/settings')).data.settings.weeklyHours, 35);
  assert.equal(h.db.prepare('SELECT COUNT(*) AS count FROM time_entries').get().count, 1);
});

test('Demodaten: wiederholbar, ohne neue Konten, und ohne Personen passiert nichts', async t => {
  const h = await setup(t);
  const usersBefore = h.db.prepare('SELECT COUNT(*) AS count FROM users').get().count;
  h.instance.seedDemo();
  const entries = h.db.prepare('SELECT COUNT(*) AS count FROM time_entries').get().count;
  assert.equal(entries, 10);
  const statuses = h.db.prepare('SELECT status FROM time_weeks ORDER BY status').all().map(row => row.status);
  assert.deepEqual(statuses, ['approved', 'submitted']);
  const openTasks = h.db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE type = 'time_week_approval' AND done = 0").get().count;
  assert.equal(openTasks, 1);
  h.instance.seedDemo();
  assert.equal(h.db.prepare('SELECT COUNT(*) AS count FROM time_entries').get().count, entries);
  assert.equal(h.db.prepare('SELECT COUNT(*) AS count FROM users').get().count, usersBefore);

  const empty = await setup(t);
  empty.db.prepare('UPDATE users SET active = 0').run();
  empty.instance.seedDemo();
  assert.equal(empty.db.prepare('SELECT COUNT(*) AS count FROM time_entries').get().count, 0);
});

test('Hilfeartikel haben die verlangte Form und nennen keine Fremdmarke', async t => {
  const h = await setup(t);
  assert.ok(h.instance.helpArticles.length >= 3);
  for (const article of h.instance.helpArticles) {
    for (const field of ['id', 'title', 'answer']) assert.equal(typeof article[field], 'string', field);
    for (const field of ['roles', 'views', 'keywords', 'steps', 'actions']) assert.ok(Array.isArray(article[field]), field);
    for (const action of article.actions) assert.match(action.view, /^time/);
    assert.doesNotMatch(JSON.stringify(article), /workday/i);
  }
});

// ------------------------------------------------------------------ Rollen und Rechte

function addStaff(h, { name = 'Sach Bearbeiter', email = 'sb@test.local' } = {}) {
  const { id } = h.deps.createUserAccount({ name, email, role: 'hr_staff', actor: { id: 1 } });
  h.db.prepare('UPDATE users SET must_change_password = 0 WHERE id = ?').run(id);
  return id;
}

test('HR-Sachbearbeitung: sieht und korrigiert Zeiten ohne HR-Rolle, entscheidet aber nichts', async t => {
  const h = await setup(t);
  const staff = addStaff(h);
  await h.fillWeek('anna');
  await h.fullDay('bp', LAST_WEEK);

  // Sehen: auch noch nicht Eingereichtes, wie HR, aber keine HR-Personen.
  const anna = await h.api(staff, 'GET', `/api/time/week?week=${LAST_WEEK}&userId=5`);
  assert.equal(anna.status, 200);
  assert.equal(anna.data.week.actualMinutes, 2400);
  assert.equal(anna.data.week.canEdit, true);
  assert.equal(anna.data.week.canDecide, false);
  assert.equal(anna.data.week.totalBalanceMinutes, 0);
  assert.equal((await h.api(staff, 'GET', `/api/time/week?week=${LAST_WEEK}&userId=2`)).status, 403, 'HR-Kollege');
  assert.equal((await h.api(staff, 'GET', `/api/time/week?week=${LAST_WEEK}&userId=1`)).status, 403, 'HR-Leitung');
  assert.equal((await h.api(staff, 'GET', `/api/time/history?week=${LAST_WEEK}&userId=5`)).status, 200);
  assert.equal((await h.api(staff, 'GET', `/api/time/history?week=${LAST_WEEK}&userId=2`)).status, 403);
  const people = (await h.api(staff, 'GET', '/api/time/people')).data.people.map(person => person.id).sort();
  assert.deepEqual(people, [3, 4, 5, 6, 7]);
  assert.equal((await h.api(staff, 'GET', '/api/time/settings')).data.settings.canEdit, false);

  // Korrigieren: nur mit Grund, nie bei HR.
  const entry = anna.data.week.days[0].entries[0];
  assert.equal((await h.api(staff, 'PATCH', `/api/time/entries/${entry.id}`, { endTime: '16:00' })).status, 400);
  assert.equal((await h.api(staff, 'PATCH', `/api/time/entries/${entry.id}`, { endTime: '16:00', reason: 'Tippfehler' })).status, 200);
  assert.equal((await h.add(staff, '2026-03-07', '09:00', '10:00', { userId: 2, reason: 'Versuch' })).status, 403);

  // Wochen: nicht entscheiden, aber eine genehmigte Woche zur Korrektur wieder öffnen.
  const id = (await h.submit('anna')).data.id;
  const decision = await h.decide(staff, id, 'approve');
  assert.equal(decision.status, 403);
  assert.match(decision.data.error, /Sachbearbeitung/);
  const list = (await h.api(staff, 'GET', '/api/time/weeks?scope=all')).data.weeks;
  assert.deepEqual(list.map(week => week.id), [id]);
  assert.equal(list[0].canDecide, false);
  await h.decide('manager', id, 'approve');
  assert.equal((await h.api(staff, 'POST', `/api/time/weeks/${id}/reopen`, { reason: 'Lohnbüro meldet Fehler' })).status, 200);

  // Voreinstellung nein, Wochenstunden einer Person mit Grund ja, die eigenen nein.
  assert.equal((await h.api(staff, 'PUT', '/api/time/settings', { weeklyHours: 38 })).status, 403);
  assert.equal((await h.api(staff, 'PUT', '/api/time/people/5/hours', { weeklyHours: 30 })).status, 400);
  assert.equal((await h.api(staff, 'PUT', '/api/time/people/5/hours', { weeklyHours: 30, reason: 'Vertrag geändert' })).status, 200);
  assert.equal((await h.api(staff, 'PUT', '/api/time/people/2/hours', { weeklyHours: 30, reason: 'Versuch' })).status, 403);
  assert.equal((await h.api(staff, 'PUT', `/api/time/people/${staff}/hours`, { weeklyHours: 30, reason: 'Versuch' })).status, 403);

  // Export: ja, ohne HR-Personen.
  const exported = await h.api(staff, 'GET', '/api/time/export?month=2026-03');
  assert.equal(exported.status, 200);
  assert.match(exported.data, /Anna Ahrens/);
  assert.doesNotMatch(exported.data, /Boris Partner/);
});

test('HR ändert die eigenen Wochenstunden nicht, außer die Organisation erlaubt es', async t => {
  const h = await setup(t);
  const body = { weeklyHours: 20, reason: 'Eigener Wunsch' };
  assert.equal((await h.api('hr', 'PUT', '/api/time/people/1/hours', body)).status, 403);
  assert.equal((await h.api('bp', 'PUT', '/api/time/people/2/hours', body)).status, 403);
  const own = (await h.api('bp', 'GET', '/api/time/people')).data.people.find(person => person.id === 2);
  assert.equal(own.canSetHours, false);
  h.deps.setApprovalRule('personnel.hr_self_edit', 'allowed', { id: 1 });
  assert.equal((await h.api('hr', 'PUT', '/api/time/people/1/hours', body)).status, 200);
  assert.equal(h.tasksOf(1, 'time_correction_notice').length, 0, 'kein Hinweis an sich selbst');
});

test('Der HR Business Partner liest und ändert nichts an den Zeiten der HR-Leitung', async t => {
  const h = await setup(t);
  await h.fullDay('hr', LAST_WEEK);
  const week = await h.week('hr');
  const entry = week.days[0].entries[0];

  assert.equal((await h.api('bp', 'GET', `/api/time/week?week=${LAST_WEEK}&userId=1`)).status, 403);
  assert.equal((await h.api('bp', 'GET', `/api/time/history?week=${LAST_WEEK}&userId=1`)).status, 403);
  assert.equal((await h.api('bp', 'PATCH', `/api/time/entries/${entry.id}`, { endTime: '09:00', reason: 'Versuch' })).status, 403);
  assert.equal((await h.api('bp', 'DELETE', `/api/time/entries/${entry.id}`, { reason: 'Versuch' })).status, 403);
  assert.equal((await h.add('bp', '2026-03-03', '09:00', '10:00', { userId: 1, reason: 'Versuch' })).status, 403);
  assert.equal((await h.api('bp', 'PUT', '/api/time/people/1/hours', { weeklyHours: 1, reason: 'Versuch' })).status, 403);
  assert.equal((await h.api('bp', 'GET', '/api/time/people')).data.people.some(person => person.id === 1), false);

  // Mangels zweiter HR-Administration entscheidet er aber über ihre Woche und darf sie dafür sehen.
  const id = (await h.submit('hr')).data.id;
  assert.equal((await h.api('bp', 'GET', `/api/time/weeks/${id}`)).status, 200);
  const seen = await h.api('bp', 'GET', `/api/time/week?week=${LAST_WEEK}&userId=1`);
  assert.equal(seen.status, 200);
  assert.equal(seen.data.week.canDecide, true);
  assert.equal(seen.data.week.totalBalanceMinutes, undefined);
  assert.deepEqual((await h.api('bp', 'GET', '/api/time/weeks?scope=all')).data.weeks.map(item => item.id), [id]);
  assert.equal((await h.decide('bp', id, 'approve')).status, 200);
  assert.equal((await h.api('bp', 'POST', `/api/time/weeks/${id}/reopen`, { reason: 'Versuch' })).status, 403, 'wieder öffnen geht nicht');
  assert.equal((await h.api('bp', 'GET', `/api/time/export?month=2026-03`)).data.includes('Hanna HR'), false);
  assert.equal((await h.api('bp', 'GET', '/api/time/weeks?scope=all&status=all')).data.weeks.length, 0);
});

// ------------------------------------------------------------------ Genehmigungsregel

test('Regel geändert: Eingereichte Wochen bleiben entscheidbar, neue folgen der neuen Regel, in allen Stellungen', async t => {
  const rules = ['manager', 'hr', 'none'];
  const expected = {
    manager: { status: 'submitted', holders: [4] },
    hr: { status: 'submitted', holders: [1] },
    none: { status: 'approved', holders: [] }
  };
  const holdersOf = (h, id) => h.db.prepare("SELECT user_id FROM tasks WHERE type = 'time_week_approval' AND entity_id = ? AND done = 0").all(id).map(row => row.user_id);

  for (const from of rules) {
    for (const to of rules) {
      const label = `${from} nach ${to}`;
      const h = await setup(t);
      h.deps.setApprovalRule('time.approval', from, { id: 1 });
      await h.fullDay('anna', LAST_WEEK);
      const before = await h.submit('anna');
      assert.equal(before.data.status, expected[from].status, label);
      assert.deepEqual(holdersOf(h, before.data.id), expected[from].holders, label);

      h.deps.setApprovalRule('time.approval', to, { id: 1 });
      h.instance.maintenance();
      assert.deepEqual(holdersOf(h, before.data.id), expected[from].holders, `${label}: die Wartung verschiebt nichts`);

      // Die neue Woche folgt der neuen Regel.
      await h.fullDay('anna', THIS_WEEK);
      const after = await h.submit('anna', THIS_WEEK);
      assert.equal(after.data.status, expected[to].status, label);
      assert.deepEqual(holdersOf(h, after.data.id), expected[to].holders, label);
      const managerList = (await h.api('manager', 'GET', '/api/time/weeks')).data.weeks;
      if (to === 'hr') {
        assert.equal(managerList.find(week => week.id === after.data.id).canDecide, false, label);
        assert.equal((await h.decide('manager', after.data.id, 'approve')).status, 403, label);
      }
      const announced = (await h.week('anna', `?week=${plusDays(THIS_WEEK, 7)}`)).decider;
      assert.equal(announced.kind, { manager: 'manager', hr: 'hr', none: 'none' }[to], `${label}: die Woche sagt, wer entscheidet`);

      // Die alte Woche bleibt für die entscheidbar, die sie haben. „Prüfen“ findet sie also.
      if (expected[from].status === 'submitted') {
        const holder = expected[from].holders[0];
        const seen = await h.api(holder, 'GET', `/api/time/week?week=${LAST_WEEK}&userId=5`);
        assert.equal(seen.data.week.canDecide, true, `${label}: Woche entscheidbar`);
        assert.equal((await h.decide(holder, before.data.id, 'approve')).status, 200, label);
        assert.deepEqual(holdersOf(h, before.data.id), [], label);
      }
    }
  }
});

test('Führungswechsel: Prüfaufgaben ziehen mit um, und die frühere Führungskraft entscheidet nicht mehr', async t => {
  const h = await setup(t);
  await h.fillWeek('anna');
  const id = (await h.submit('anna')).data.id;
  await h.fillWeek('ben');
  const ben = (await h.submit('ben')).data.id;

  assert.equal(h.deps.changeManager(5, 3), true);
  assert.deepEqual(h.tasksOf(4, 'time_week_approval').map(task => task.entity_id), [ben]);
  assert.deepEqual(h.tasksOf(3, 'time_week_approval').map(task => task.entity_id), [id]);
  assert.equal((await h.decide('manager', id, 'approve')).status, 403);
  assert.equal((await h.decide('director', id, 'approve')).status, 200);

  // Ohne neue Führungskraft geht es an HR, und ein neuer Wechsel bei „Nur HR“ ändert nichts mehr.
  h.deps.changeManager(6, null);
  assert.equal(h.tasksOf(4, 'time_week_approval').length, 0);
  assert.deepEqual(h.tasksOf(1, 'time_week_approval').map(task => task.entity_id), [ben]);
  h.deps.setApprovalRule('time.approval', 'hr', { id: 1 });
  h.deps.changeManager(6, 4);
  assert.equal(h.tasksOf(4, 'time_week_approval').length, 0);
  assert.equal(h.tasksOf(1, 'time_week_approval').length, 1);
});

// ------------------------------------------------------------------ Korrekturen durch HR

test('Korrektur durch HR: Pflichtgrund, im Verlauf sichtbar, Hinweis an die Person', async t => {
  const h = await setup(t);

  // Anlegen
  const missing = await h.add('hr', LAST_WEEK, '08:00', '12:00', { userId: 5 });
  assert.equal(missing.status, 400);
  assert.match(missing.data.error, /Grund/);
  assert.equal((await h.add('hr', LAST_WEEK, '08:00', '12:00', { userId: 5, reason: '   ' })).status, 400);
  const created = await h.add('hr', LAST_WEEK, '08:00', '12:00', { userId: 5, reason: 'Stempeluhr defekt' });
  assert.equal(created.status, 201);
  const entryId = created.data.entry.id;
  let history = (await h.api('anna', 'GET', `/api/time/history?week=${LAST_WEEK}`)).data.history;
  assert.equal(history.length, 1);
  assert.equal(history[0].action, 'create');
  assert.equal(history[0].before, null);
  assert.equal(history[0].after.startTime, '08:00');
  assert.equal(history[0].reason, 'Stempeluhr defekt');
  assert.equal(history[0].changedByName, 'Hanna HR');
  let notices = h.tasksOf(5, 'time_correction_notice');
  assert.equal(notices.length, 1);
  assert.match(notices[0].title, /02\.03\.2026.*ergänzt.*Stempeluhr defekt/);
  assert.ok(notices[0].entity_id, 'der Hinweis führt zur Woche');
  const entryView = (await h.week('anna')).days[0].entries[0];
  assert.equal(entryView.enteredByOther, true);
  assert.equal(entryView.changed, false, 'ein neuer Eintrag ist nicht geändert');
  assert.equal(h.db.prepare('SELECT COUNT(*) AS count FROM audit_log WHERE action = ? AND new_values LIKE ?').get('time_entry_created', '%Stempeluhr defekt%').count, 1);

  // Ändern
  assert.equal((await h.api('hr', 'PATCH', `/api/time/entries/${entryId}`, { endTime: '13:00' })).status, 400);
  assert.equal((await h.api('hr', 'PATCH', `/api/time/entries/${entryId}`, { endTime: '13:00', reason: 'Ende falsch' })).status, 200);
  assert.equal((await h.week('anna')).days[0].entries[0].changed, true);

  // Löschen
  assert.equal((await h.api('hr', 'DELETE', `/api/time/entries/${entryId}`)).status, 400);
  assert.equal((await h.api('hr', 'DELETE', `/api/time/entries/${entryId}`, { reason: 'Doppelt erfasst' })).status, 200);
  history = (await h.api('anna', 'GET', `/api/time/history?week=${LAST_WEEK}`)).data.history;
  assert.deepEqual(history.map(row => [row.action, row.reason]), [['delete', 'Doppelt erfasst'], ['update', 'Ende falsch'], ['create', 'Stempeluhr defekt']]);
  notices = h.tasksOf(5, 'time_correction_notice');
  assert.equal(notices.length, 3);

  // Die Person selbst schreibt ohne Grund und ohne Hinweis an sich selbst.
  const own = await h.add('anna', LAST_WEEK, '08:00', '12:00');
  assert.equal(own.status, 201);
  assert.equal(own.data.entry.enteredByOther, false);
  assert.equal((await h.api('anna', 'GET', `/api/time/history?week=${LAST_WEEK}`)).data.history.length, 3, 'Anlegen der eigenen Zeit bleibt ohne Verlauf');
  assert.equal((await h.api('anna', 'PATCH', `/api/time/entries/${own.data.entry.id}`, { endTime: '12:30' })).status, 200);
  assert.equal(h.tasksOf(5, 'time_correction_notice').length, 3);

  // Wochenstunden einer Person: Grund und Hinweis.
  assert.equal((await h.api('hr', 'PUT', '/api/time/people/6/hours', { weeklyHours: 30 })).status, 400);
  assert.equal((await h.api('hr', 'PUT', '/api/time/people/6/hours', { weeklyHours: 30, reason: 'Teilzeit ab heute' })).status, 200);
  assert.match(h.tasksOf(6, 'time_correction_notice')[0].title, /Wochenstunden.*Teilzeit ab heute/);
});

test('Eintragen geht auch als 17.30, 17,30 oder 1730, und Unlesbares bleibt abgelehnt', async t => {
  const h = await setup(t);
  const dotted = await h.add('anna', LAST_WEEK, '8.15', '17.30', { breakMinutes: 30 });
  assert.equal(dotted.status, 201);
  assert.equal(dotted.data.entry.startTime, '08:15');
  assert.equal(dotted.data.entry.endTime, '17:30');
  const comma = await h.add('anna', plusDays(LAST_WEEK, 1), '8,00', '1730');
  assert.equal(comma.data.entry.endTime, '17:30');
  const hours = await h.add('anna', plusDays(LAST_WEEK, 2), '8', '24');
  assert.equal(hours.status, 201);
  assert.equal(hours.data.entry.endTime, '24:00');
  for (const value of ['25.00', '17.60', '7:5', 'abc', '1.5.26']) {
    assert.equal((await h.add('anna', plusDays(LAST_WEEK, 3), '08:00', value)).status, 400, value);
  }
  const patched = await h.api('anna', 'PATCH', `/api/time/entries/${dotted.data.entry.id}`, { endTime: '18.00' });
  assert.equal(patched.data.entry.endTime, '18:00');
});

// ------------------------------------------------------------------ Einreichen, Zurückziehen, Stempeln

test('Zurückziehen: bis zur Entscheidung durch die Person selbst, die Aufgabe verschwindet, Stempeln geht wieder', async t => {
  const h = await setup(t, { time: '12:00' });
  await h.add('anna', '2026-03-09', '08:00', '12:00');

  const running = await h.week('anna', `?week=${THIS_WEEK}`);
  assert.equal(running.inProgress, true, 'die Woche läuft noch, die Oberfläche warnt');
  assert.deepEqual(running.clock, { canClockIn: true, reason: null });
  assert.equal(running.decider.kind, 'manager');
  assert.equal(running.decider.name, 'Malte Manager');
  assert.equal((await h.week('anna', `?week=${LAST_WEEK}`)).inProgress, false);

  const id = (await h.submit('anna', THIS_WEEK)).data.id;
  assert.equal(h.tasksOf(4, 'time_week_approval').length, 1);

  // Mitten in der Woche gesperrt: „Kommen“ wird nicht mehr angeboten, und die Antwort des Servers passt dazu.
  const locked = await h.week('anna', `?week=${THIS_WEEK}`);
  assert.equal(locked.canWithdraw, true);
  assert.equal(locked.clock.canClockIn, false);
  assert.equal(locked.clock.reason, 'week_locked');
  assert.equal(locked.clock.weekId, id);
  assert.equal(locked.clock.canWithdraw, true);
  assert.equal((await h.week('anna', `?week=${LAST_WEEK}`)).clock.canClockIn, false, 'auch beim Blick in eine andere Woche');
  assert.equal((await h.api('anna', 'POST', '/api/time/clock/in', {})).status, 409);

  // Nur die Person selbst.
  assert.equal((await h.api('manager', 'POST', `/api/time/weeks/${id}/withdraw`, {})).status, 403);
  assert.equal((await h.api('hr', 'POST', `/api/time/weeks/${id}/withdraw`, {})).status, 403);
  assert.equal((await h.api('anna', 'POST', '/api/time/weeks/9999/withdraw', {})).status, 404);

  const withdrawn = await h.api('anna', 'POST', `/api/time/weeks/${id}/withdraw`, {});
  assert.equal(withdrawn.status, 200);
  assert.equal(h.tasksOf(4, 'time_week_approval').length, 0, 'die Führungskraft muss nichts mehr tun');
  const open = await h.week('anna', `?week=${THIS_WEEK}`);
  assert.equal(open.status, 'open');
  assert.equal(open.canEdit, true);
  assert.equal(open.clock.canClockIn, true);
  assert.equal((await h.api('manager', 'GET', `/api/time/week?week=${THIS_WEEK}&userId=5`)).status, 403, 'wieder nur bei der Person');
  assert.equal(h.db.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE action = 'time_week_withdrawn'").get().count, 1);
  assert.equal((await h.api('anna', 'POST', '/api/time/clock/in', {})).status, 201);
  h.clock.time = '13:00';
  await h.api('anna', 'POST', '/api/time/clock/out', {});

  // Nach einer Entscheidung ist Schluss. Dann hilft nur HR.
  const again = (await h.submit('anna', THIS_WEEK)).data.id;
  assert.equal(again, id);
  await h.decide('manager', id, 'approve');
  const decided = await h.week('anna', `?week=${THIS_WEEK}`);
  assert.equal(decided.canWithdraw, false);
  assert.equal(decided.clock.canWithdraw, false);
  assert.equal((await h.api('anna', 'POST', `/api/time/weeks/${id}/withdraw`, {})).status, 409);
});

test('Zurückziehen: Ohne Freigaberegel hat niemand entschieden, die Woche lässt sich also noch zurückholen', async t => {
  const h = await setup(t);
  h.deps.setApprovalRule('time.approval', 'none', { id: 1 });
  await h.fullDay('anna', LAST_WEEK);
  const id = (await h.submit('anna')).data.id;
  const approved = await h.week('anna');
  assert.equal(approved.status, 'approved');
  assert.equal(approved.canWithdraw, true);
  assert.equal((await h.api('anna', 'POST', `/api/time/weeks/${id}/withdraw`, {})).status, 200);
  const open = h.db.prepare('SELECT status, weekly_minutes, decided_at FROM time_weeks WHERE id = ?').get(id);
  assert.deepEqual({ ...open }, { status: 'open', weekly_minutes: null, decided_at: null });
});

test('Normales Kommen und Gehen gilt nicht als geändert, eine echte Änderung schon', async t => {
  const h = await setup(t, { time: '08:00' });
  await h.api('anna', 'POST', '/api/time/clock/in', {});
  h.clock.time = '12:00';
  const out = await h.api('anna', 'POST', '/api/time/clock/out', {});
  assert.equal(out.data.entries[0].changed, false);
  const entry = (await h.week('anna', `?week=${THIS_WEEK}`)).days[2].entries[0];
  assert.equal(entry.changed, false);
  assert.equal(entry.enteredByOther, false);
  assert.equal((await h.api('anna', 'GET', `/api/time/history?week=${THIS_WEEK}`)).data.history[0].action, 'clock_out', 'im Verlauf bleibt das Gehen sichtbar');
  await h.api('anna', 'PATCH', `/api/time/entries/${entry.id}`, { endTime: '12:30' });
  assert.equal((await h.week('anna', `?week=${THIS_WEEK}`)).days[2].entries[0].changed, true);
});

test('Soll, Ist und Saldo gehen auf: Listen nennen auch das Soll bis heute', async t => {
  const h = await setup(t, { time: '09:00' });
  for (const offset of [0, 1]) await h.fullDay('anna', plusDays(THIS_WEEK, offset));
  const week = await h.week('anna', `?week=${THIS_WEEK}`);
  assert.equal(week.targetMinutes, 2400);
  assert.equal(week.dueMinutes, 960, 'Montag und Dienstag sind fällig, der heutige Mittwoch noch nicht');
  assert.equal(week.actualMinutes, 960);
  assert.equal(week.balanceMinutes, week.actualMinutes - week.dueMinutes);
  await h.submit('anna', THIS_WEEK);
  const listed = (await h.api('manager', 'GET', '/api/time/weeks')).data.weeks[0];
  assert.equal(listed.targetMinutes, 2400);
  assert.equal(listed.dueMinutes, 960);
  assert.equal(listed.balanceMinutes, listed.actualMinutes - listed.dueMinutes);
});

test('Kommen am Abwesenheitstag: wird nicht angeboten, ein halber Tag bleibt möglich', async t => {
  const h = await setup(t, { modules: ['absence'], time: '09:00' });
  const absence = createAbsenceModule({ ...h.deps, now: () => h.clock });
  absence.initialize();
  const sick = h.db.prepare("SELECT id FROM absence_types WHERE code = 'sick'").get().id;
  const add = (userId, startHalf, status = 'approved') => h.db.prepare(`
    INSERT INTO absence_requests (user_id, type_id, start_date, end_date, start_half, end_half, status, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, 0, ?, ?, '2026-01-01')
  `).run(userId, sick, TODAY, TODAY, startHalf, status, userId);

  add(5, 0);
  const absent = await h.week('anna', `?week=${THIS_WEEK}`);
  assert.deepEqual(absent.clock, { canClockIn: false, reason: 'absent' });
  assert.doesNotMatch(JSON.stringify(absent.clock), /krank|sick/i);
  const denied = await h.api('anna', 'POST', '/api/time/clock/in', {});
  assert.equal(denied.status, 409);
  assert.match(denied.data.error, /Abwesenheit/);
  assert.equal((await h.add('anna', TODAY, '08:00', '09:00')).status, 201, 'von Hand nachtragen bleibt möglich');

  add(6, 1);
  assert.equal((await h.week('ben', `?week=${THIS_WEEK}`)).clock.canClockIn, true, 'am halben Tag geht es');
  assert.equal((await h.api('ben', 'POST', '/api/time/clock/in', {})).status, 201);

  add(7, 0, 'pending');
  assert.equal((await h.week('clara', `?week=${THIS_WEEK}`)).clock.canClockIn, true, 'nur beantragt zählt nicht');
});

// ------------------------------------------------------------------ Austritt

test('Austritt: Ausgetretene bleiben in der HR-Liste, und HR kann Vergangenes nachtragen', async t => {
  const h = await setup(t);
  await h.fullDay('anna', LAST_WEEK);
  const personnel = createPersonnelModule(h.deps);
  personnel.initialize();
  h.db.prepare(`
    INSERT INTO personnel_changes (user_id, kind, old_values, new_values, effective_date, reason, status, created_by, created_at)
    VALUES (5, 'exit', '{}', '{}', ?, 'Test', 'applied', 1, ?)
  `).run(LAST_WEEK, new Date().toISOString());
  h.deps.setUserActive(5, false, { id: 1 });

  const people = (await h.api('hr', 'GET', '/api/time/people')).data.people;
  const anna = people.find(person => person.id === 5);
  assert.equal(anna.active, false);
  assert.equal(anna.exitDate, LAST_WEEK);
  assert.equal(anna.totalBalanceMinutes, -1920, 'Der Saldo bleibt ablesbar: 8 von 40 Stunden erfasst');
  assert.equal(people.find(person => person.id === 6).active, true);
  assert.equal(people.find(person => person.id === 6).exitDate, null);

  const entry = await h.add('hr', plusDays(LAST_WEEK, 1), '08:00', '12:00', { userId: 5, reason: 'Nachtrag vor dem Austritt' });
  assert.equal(entry.status, 201);
  assert.equal(h.tasksOf(5, 'time_correction_notice').length, 0, 'wer gegangen ist, sieht keine Aufgaben mehr');
  assert.equal((await h.api('hr', 'GET', `/api/time/week?week=${LAST_WEEK}&userId=5`)).status, 200);
});

// ------------------------------------------------------------------ Listen

test('Listen sind nach Nachname und nach deutscher Regel sortiert und durchsuchbar', async t => {
  const h = await setup(t);
  const add = h.db.prepare("INSERT INTO users (id, name, email, password_hash, role, manager_id) VALUES (?, ?, ?, '!', 'employee', 3)");
  add.run(30, 'Julia Abel', 'julia@test.local');
  add.run(31, 'Jörg Abel', 'joerg@test.local');
  add.run(32, 'Ümit Aaron', 'uemit@test.local');
  const personnel = createPersonnelModule(h.deps);
  personnel.initialize();
  h.db.prepare("INSERT INTO personnel_records (user_id, personnel_number, created_at, updated_at) VALUES (31, 'P-0031', 'x', 'x')").run();
  h.enabled.add('personnel');

  const people = (await h.api('hr', 'GET', '/api/time/people')).data.people;
  assert.deepEqual(people.slice(0, 4).map(person => person.name), ['Ümit Aaron', 'Jörg Abel', 'Julia Abel', 'Anna Ahrens']);
  assert.equal(people[1].email, 'joerg@test.local');
  assert.equal(people[1].personnelNumber, 'P-0031');

  for (const id of [30, 31, 32]) {
    await h.add('hr', LAST_WEEK, '08:00', '12:00', { userId: id, reason: 'Nachtrag' });
  }
  const lines = (await h.api('hr', 'GET', '/api/time/export?month=2026-03')).data.trim().split('\r\n');
  assert.deepEqual(lines.slice(1).map(line => line.split(';')[0]), ['Ümit Aaron', 'Jörg Abel', 'Julia Abel']);
  h.db.prepare("UPDATE time_weeks SET status = 'submitted' WHERE user_id IN (30, 31, 32)").run();
  const weeks = (await h.api('hr', 'GET', '/api/time/weeks?scope=all')).data.weeks;
  assert.deepEqual(weeks.map(week => week.userName), ['Ümit Aaron', 'Jörg Abel', 'Julia Abel']);
  assert.equal(weeks[1].personnelNumber, 'P-0031');
  assert.equal(weeks[1].userEmail, 'joerg@test.local');
  assert.equal((await h.api('director', 'GET', '/api/time/weeks')).data.weeks[0].userEmail, undefined, 'Führungskräfte brauchen das nicht');
});

test('Wochenlisten zeigen direkt oder indirekt, und wer entscheidet', async t => {
  const h = await setup(t);
  await h.fillWeek('anna');
  await h.submit('anna');
  await h.fillWeek('clara');
  await h.submit('clara');
  const list = (await h.api('director', 'GET', '/api/time/weeks')).data.weeks;
  const anna = list.find(week => week.userId === 5);
  assert.equal(anna.direct, false);
  assert.equal(anna.managerName, 'Malte Manager');
  assert.equal(anna.deciderName, 'Malte Manager');
  assert.equal(anna.canDecide, false);
  const clara = list.find(week => week.userId === 7);
  assert.equal(clara.direct, true);
  assert.equal(clara.deciderName, 'Dora Direktor');
  assert.equal(clara.canDecide, true);

  h.deps.setApprovalRule('time.approval', 'hr', { id: 1 });
  await h.fullDay('ben', LAST_WEEK);
  await h.submit('ben');
  const ben = (await h.api('director', 'GET', '/api/time/weeks')).data.weeks.find(week => week.userId === 6);
  assert.equal(ben.deciderName, 'HR');
  assert.equal((await h.api('manager', 'GET', '/api/time/weeks')).data.weeks.find(week => week.userId === 5).deciderName, 'Malte Manager', 'die alte Aufgabe bleibt bei ihr');
});

// ------------------------------------------------------------------ Tempo

test('Die HR-Personenliste fragt nicht je Person neu, und rechnet wie die Einzelansicht', async t => {
  const h = await setup(t);
  const add = h.db.prepare("INSERT INTO users (id, name, email, password_hash, role, manager_id) VALUES (?, ?, ?, '!', 'employee', 3)");
  for (let index = 0; index < 40; index += 1) add.run(100 + index, `Person ${index}`, `p${index}@test.local`);
  await h.fillWeek(100);
  await h.fullDay(100, THIS_WEEK);
  await h.submit(100);
  await h.api('hr', 'PUT', '/api/time/people/101/hours', { weeklyHours: 20, reason: 'Teilzeit' });
  await h.fullDay(101, LAST_WEEK);

  const prepare = h.db.prepare;
  let prepared = 0;
  h.db.prepare = function countedPrepare(sql) {
    prepared += 1;
    return prepare.call(this, sql);
  };
  t.after(() => {
    h.db.prepare = prepare;
  });
  const response = await h.api('hr', 'GET', '/api/time/people');
  h.db.prepare = prepare;
  assert.equal(response.status, 200);
  assert.ok(prepared <= 20, `höchstens eine feste Zahl von Abfragen, waren ${prepared}`);

  for (const person of response.data.people.filter(item => [100, 101, 102].includes(item.id))) {
    const single = await h.api('hr', 'GET', `/api/time/week?userId=${person.id}`);
    assert.equal(person.totalBalanceMinutes, single.data.week.totalBalanceMinutes, `${person.name}: Gesamtsaldo`);
    assert.equal(person.weeklyHours, single.data.week.weeklyHours, `${person.name}: Wochenstunden`);
  }
  const part = response.data.people.find(person => person.id === 101);
  assert.equal(part.weeklyHours, 20);
  assert.equal(part.hoursSource, 'person');
});

test('Ältere Datenbank: Der Verlauf bekommt die neuen Spalten, alte Einträge bleiben lesbar', async t => {
  const h = await createModuleHarness(deps => {
    deps.db.exec(`
      CREATE TABLE time_entry_history (
        id INTEGER PRIMARY KEY, entry_id INTEGER NOT NULL, user_id INTEGER NOT NULL REFERENCES users(id),
        action TEXT NOT NULL CHECK (action IN ('update', 'clock_out', 'delete')), old_date TEXT NOT NULL, new_date TEXT,
        old_values TEXT NOT NULL, new_values TEXT, changed_by INTEGER NOT NULL REFERENCES users(id), changed_at TEXT NOT NULL
      );
      INSERT INTO time_entry_history (id, entry_id, user_id, action, old_date, new_date, old_values, new_values, changed_by, changed_at)
      VALUES (1, 77, 5, 'update', '2026-03-02', '2026-03-02', '{"date":"2026-03-02"}', '{"date":"2026-03-02"}', 5, '2026-03-02T10:00:00Z');
    `);
    return createTimeModule({ ...deps, now: () => ({ date: TODAY, time: '09:00' }) });
  });
  t.after(() => h.close());
  const history = async () => (await h.api('anna', 'GET', `/api/time/history?week=${LAST_WEEK}`)).data.history;
  assert.equal((await history())[0].action, 'update');
  assert.equal((await history())[0].reason, null);
  // Die alte Prüfregel kennt „create“ nicht. Das Anlegen durch HR geht trotzdem.
  const created = await h.api('hr', 'POST', '/api/time/entries', { userId: 5, date: LAST_WEEK, startTime: '08:00', endTime: '12:00', reason: 'Nachtrag' });
  assert.equal(created.status, 201);
  assert.deepEqual((await history()).map(row => row.action), ['create', 'update']);
});

test('Wer eine Prüfaufgabe von früher hat und gesperrt wird, gibt sie an HR ab', async t => {
  const h = await setup(t);
  await h.fillWeek('anna');
  const id = (await h.submit('anna')).data.id;
  h.deps.setApprovalRule('time.approval', 'hr', { id: 1 });
  h.instance.maintenance();
  assert.equal(h.tasksOf(4, 'time_week_approval').length, 1);
  h.deps.setUserActive(4, false, { id: 1 });
  h.instance.maintenance();
  assert.equal(h.tasksOf(4, 'time_week_approval').length, 0);
  assert.deepEqual(h.tasksOf(1, 'time_week_approval').map(task => task.entity_id), [id]);
});

// ------------------------------------------------------------------ Oberfläche ohne Browser

/**
 * Führt die Datei der Oberfläche mit nachgebautem window und document aus. Die Seiten liefern HTML,
 * das sich hier prüfen lässt; Abläufe im echten Browser ersetzt das nicht, es hält aber Texte und Knöpfe fest.
 */
function loadClient(file, { me, responses = {}, view }) {
  const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  const client = { modals: [], toasts: [], navigations: [], requests: [], confirmations: [], address: {} };
  const makeElement = () => {
    const element = {
      dataset: {},
      value: '',
      classList: { add() {} },
      focus() {},
      scrollIntoView() {
        element.scrolled = true;
      },
      querySelector: () => makeElement()
    };
    return element;
  };
  const elements = new Map();
  const lists = new Map();
  client.element = selector => {
    if (!elements.has(selector)) elements.set(selector, makeElement());
    return elements.get(selector);
  };
  client.list = (selector, items) => lists.set(selector, items);
  client.button = (selector, dataset = {}) => {
    const button = { ...makeElement(), dataset };
    lists.set(selector, [button]);
    return button;
  };
  const ui = {
    esc,
    toast: (message, type) => client.toasts.push({ message, type }),
    modal: options => client.modals.push(options),
    closeModal() {},
    header: (title, subtitle = '', actions = '') => `<header><h1>${esc(title)}</h1><p>${esc(subtitle)}</p>${actions}</header>`,
    stat: (label, value, sub = '') => `<article><small>${esc(label)}</small><strong>${esc(value)}</strong><span>${esc(sub)}</span></article>`,
    empty: message => `<p>${esc(message)}</p>`,
    plural: (count, one, many) => `${count} ${count === 1 ? one : many}`
  };
  const loop = {
    ui,
    me,
    view,
    isModuleEnabled: () => true,
    navigate: next => client.navigations.push(next),
    registerModule: definition => Object.assign(client, { definition, pages: definition.pages }),
    registerAddress: handlers => Object.assign(client.address, handlers),
    api: async (url, options = {}) => {
      client.requests.push({ url, method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null });
      if ((options.method || 'GET') !== 'GET') return responses[`${options.method} ${url}`] ?? { ok: true };
      const match = Object.keys(responses).filter(prefix => url.startsWith(prefix)).sort((left, right) => right.length - left.length)[0];
      if (!match) throw new Error(`Unerwartete Anfrage: ${url}`);
      return responses[match];
    }
  };
  client.loop = loop;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'public', file), 'utf8'), {
    window: { loop },
    document: { querySelector: selector => client.element(selector), querySelectorAll: selector => lists.get(selector) || [] },
    setTimeout: work => work(),
    FormData: class {
      constructor(form) {
        this.values = form.values || {};
      }

      get(name) {
        return this.values[name] ?? '';
      }
    },
    confirm: message => {
      client.confirmations.push(message);
      return true;
    }
  });
  return client;
}

const STAFF = { id: 50, role: 'hr_staff', name: 'Sach Bearbeiter' };
const ADMIN = { id: 1, role: 'hr_admin', name: 'Hanna HR' };
const EMPLOYEE = { id: 5, role: 'employee', name: 'Anna Ahrens' };
const clientWeek = (more = {}) => ({
  id: 9, person: { id: 5, name: 'Anna Ahrens' }, weekStart: '2026-03-02', weekEnd: '2026-03-08', status: 'open', statusLabel: 'offen', decidedByName: null, decisionComment: null,
  reopenReason: null, targetMinutes: 2400, dueMinutes: 960, actualMinutes: 900, balanceMinutes: -60, counted: true, weeklyHours: 40, totalBalanceMinutes: -60,
  days: [{ date: '2026-03-02', weekday: 'Montag', targetMinutes: 480, holidayName: null, absentShare: 0, entries: [{ id: 3, userId: 5, date: '2026-03-02', startTime: '08:00', endTime: '16:00', breakMinutes: 30, note: null, netMinutes: 450, running: false, changed: false, enteredByOther: false }] }],
  hints: [], inProgress: false, decider: { kind: 'manager', name: 'Malte Manager' }, canEdit: true, canSubmit: true, canWithdraw: false, canDecide: false, canReopen: false,
  running: null, clock: { canClockIn: true, reason: null }, ...more
});
const homeClient = week => loadClient('time.js', { me: EMPLOYEE, view: 'timeHome', responses: { '/api/time/week': { week } } });

test('Oberfläche: Die Stempelkarte bietet Kommen nur an, wenn es geht', async () => {
  const open = await homeClient(clientWeek()).pages.timeHome();
  assert.match(open, /data-time-clock-in/);

  const locked = await homeClient(clientWeek({
    status: 'submitted', statusLabel: 'eingereicht', canSubmit: false, canEdit: false, canWithdraw: true,
    clock: { canClockIn: false, reason: 'week_locked', weekId: 9, weekStart: '2026-03-02', statusLabel: 'eingereicht', canWithdraw: true }
  })).pages.timeHome();
  assert.doesNotMatch(locked, /data-time-clock-in/);
  assert.match(locked, /Stempeln geht gerade nicht/);
  assert.match(locked, /data-time-withdraw="9"/);

  const decided = await homeClient(clientWeek({
    status: 'approved', statusLabel: 'genehmigt', canSubmit: false, canEdit: false, decidedByName: 'Malte Manager',
    clock: { canClockIn: false, reason: 'week_locked', weekId: 9, weekStart: '2026-03-02', statusLabel: 'genehmigt', canWithdraw: false }
  })).pages.timeHome();
  assert.doesNotMatch(decided, /data-time-clock-in|data-time-withdraw/);
  assert.match(decided, /kann HR sie wieder öffnen/);
  assert.match(decided, /Genehmigt von Malte Manager/);

  const absent = await homeClient(clientWeek({ clock: { canClockIn: false, reason: 'absent' } })).pages.timeHome();
  assert.doesNotMatch(absent, /data-time-clock-in/);
  assert.match(absent, /Abwesenheit eingetragen/);
  assert.match(absent, /data-view="absenceHome"/);

  // Wer läuft, sieht Gehen, auch wenn sonst nichts mehr ginge.
  const running = await homeClient(clientWeek({ running: { date: '2026-03-02', startTime: '08:00' } })).pages.timeHome();
  assert.match(running, /data-time-clock-out/);
});

test('Oberfläche: Einreichen warnt nur, solange die Woche läuft, und Zurückziehen geht', async () => {
  const warning = homeClient(clientWeek({ inProgress: true }));
  await warning.pages.timeHome();
  const submit = warning.button('[data-time-submit]');
  warning.definition.bind();
  await submit.onclick();
  assert.equal(warning.requests.filter(item => item.method === 'POST').length, 0, 'noch nichts abgeschickt');
  const modal = warning.modals.at(-1);
  assert.match(modal.body, /läuft noch bis 08\.03\.2026/);
  assert.match(modal.body, /nicht mehr stempeln/);
  assert.match(modal.body, /zurückziehen/);
  await modal.onSubmit({});
  assert.deepEqual(warning.requests.at(-1).body, { week: '2026-03-02' });

  const finished = homeClient(clientWeek({ inProgress: false }));
  await finished.pages.timeHome();
  const direct = finished.button('[data-time-submit]');
  finished.definition.bind();
  await direct.onclick();
  assert.equal(finished.modals.length, 0);
  assert.equal(finished.requests.at(-1).url, '/api/time/weeks/submit');

  const withdraw = homeClient(clientWeek({ status: 'submitted', statusLabel: 'eingereicht', canSubmit: false, canWithdraw: true }));
  const html = await withdraw.pages.timeHome();
  assert.match(html, /Zurückziehen/);
  const button = withdraw.button('[data-time-withdraw]', { timeWithdraw: '9' });
  withdraw.definition.bind();
  await button.onclick();
  assert.equal(withdraw.requests.at(-1).url, '/api/time/weeks/9/withdraw');
  assert.match(withdraw.toasts[0].message, /wieder stempeln/);
});

test('Oberfläche: Soll bis heute, Kalenderwoche und erklärte Begriffe statt KW', async () => {
  const html = await homeClient(clientWeek()).pages.timeHome();
  assert.match(html, /Soll der Woche/);
  assert.match(html, /Soll bis heute/);
  assert.match(html, /16:00/, 'das Soll bis heute');
  assert.match(html, /Ist minus Soll bis heute/);
  assert.match(html, /Plus heißt Überstunden/);
  assert.match(html, /Kalenderwoche 10/);
  assert.doesNotMatch(html, /\bKW\b/);
  assert.match(html, /Entscheidet: Malte Manager/);
});

test('Oberfläche: Beginn und Ende sind gleiche Felder, und HR nennt einen Grund', async () => {
  const own = homeClient(clientWeek());
  await own.pages.timeHome();
  const add = own.button('[data-time-new]');
  own.definition.bind();
  add.onclick();
  const body = own.modals.at(-1).body;
  assert.equal((body.match(/data-time-input/g) || []).length, 2);
  assert.doesNotMatch(body, /type="time"/);
  assert.doesNotMatch(body, /name="reason"/, 'eigene Einträge brauchen keinen Grund');
  assert.match(body, /17\.30/);

  // Das Feld zeigt nach dem Verlassen, was gemeint war.
  const input = { dataset: {}, value: ' 17.30 ' };
  own.list('#uiModalForm [data-time-input]', [input]);
  add.onclick();
  input.onblur();
  assert.equal(input.value, '17:30');
  input.value = '830';
  input.onblur();
  assert.equal(input.value, '08:30');
  input.value = 'abends';
  input.onblur();
  assert.equal(input.value, 'abends', 'Unlesbares bleibt stehen, der Server meldet es');

  const foreign = loadClient('time.js', {
    me: STAFF,
    view: 'timeHr',
    responses: {
      '/api/time/people': { people: [{ id: 5, name: 'Anna Ahrens', email: 'a@test.local', personnelNumber: null, active: true, exitDate: null, weeklyHours: 40, hoursSource: 'default', totalBalanceMinutes: 0, canSetHours: true }] },
      '/api/time/week': { week: clientWeek({ clock: undefined }) }
    }
  });
  const open = foreign.button('[data-time-hr-person]', { timeHrPerson: '5' });
  foreign.definition.bind();
  open.onclick();
  foreign.loop.view = 'timeHrPerson';
  await foreign.pages.timeHrPerson();
  const newEntry = foreign.button('[data-time-hr-new]');
  foreign.definition.bind();
  newEntry.onclick();
  assert.match(foreign.modals.at(-1).body, /name="reason"[^>]*required/);

  // Löschen in fremden Zeiten fragt nach dem Grund und nennt das Datum.
  const remove = foreign.button('[data-time-delete]', { timeDelete: '3' });
  foreign.definition.bind();
  await remove.onclick();
  const deletion = foreign.modals.at(-1);
  assert.match(deletion.subtitle, /Anna Ahrens: 02\.03\.2026, 08:00 bis 16:00/);
  assert.match(deletion.body, /name="reason"[^>]*required/);
  await deletion.onSubmit({ reason: 'Doppelt' });
  assert.deepEqual(foreign.requests.at(-1), { url: '/api/time/entries/3', method: 'DELETE', body: { reason: 'Doppelt' } });

  // Die eigene Löschung fragt kurz nach und nennt das Datum ebenso.
  const ownDelete = own.button('[data-time-delete]', { timeDelete: '3' });
  own.definition.bind();
  await ownDelete.onclick();
  assert.match(own.confirmations[0], /02\.03\.2026, 08:00 bis 16:00/);
});

test('Oberfläche: Einträge zeigen, ob HR sie angelegt hat, und Gehen gilt nicht als Änderung', async () => {
  const entry = more => ({ id: 3, userId: 5, date: '2026-03-02', startTime: '08:00', endTime: '16:00', breakMinutes: 30, note: null, netMinutes: 450, running: false, changed: false, enteredByOther: false, ...more });
  const page = entries => homeClient(clientWeek({ days: [{ date: '2026-03-02', weekday: 'Montag', targetMinutes: 480, holidayName: null, absentShare: 0, entries }] })).pages.timeHome();
  const plain = await page([entry()]);
  assert.doesNotMatch(plain, /geändert|von HR eingetragen/);
  assert.match(await page([entry({ changed: true })]), /geändert/);
  assert.match(await page([entry({ enteredByOther: true })]), /von HR eingetragen/);
  assert.match(plain, /time-cards/);
  assert.match(plain, /data-label="Zeit"/);
  assert.match(plain, /data-time-delete="3"/);

  const history = {
    '/api/time/history': { history: [
      { action: 'create', before: null, after: { date: '2026-03-02', startTime: '08:00', endTime: '12:00', breakMinutes: 0, note: null }, reason: 'Stempeluhr defekt', changedByName: 'Hanna HR', changedAt: '2026-03-03T10:00:00Z' }
    ] }
  };
  const withHistory = loadClient('time.js', { me: EMPLOYEE, view: 'timeHome', responses: { '/api/time/week': { week: clientWeek() }, ...history } });
  await withHistory.pages.timeHome();
  const button = withHistory.button('[data-time-history]');
  withHistory.definition.bind();
  await button.onclick();
  const body = withHistory.modals.at(-1).body;
  assert.match(body, /Eingetragen von Hanna HR/);
  assert.match(body, /Stempeluhr defekt/);
  assert.doesNotMatch(body, /Vorher/);
});

test('Oberfläche: Team zeigt direkt oder indirekt, wer entscheidet, und das Soll bis heute', async () => {
  const week = more => ({ id: 1, userId: 5, userName: 'Anna Ahrens', weekStart: '2026-03-02', weekEnd: '2026-03-08', status: 'submitted', statusLabel: 'eingereicht', targetMinutes: 2400, dueMinutes: 960, actualMinutes: 900, balanceMinutes: -60, direct: true, managerName: 'Malte Manager', deciderName: 'Malte Manager', canDecide: true, canReopen: false, ...more });
  const page = (weeks, rule, me = { id: 3, role: 'director', name: 'Dora Direktor' }) => loadClient('time.js', { me, view: 'timeTeam', responses: { '/api/time/weeks': { weeks, rule, truncated: false, limit: 200 } } }).pages.timeTeam();
  const html = await page([week(), week({ id: 2, userName: 'Ben Berg', direct: false, canDecide: false })], 'manager');
  assert.match(html, /direkt unterstellt/);
  assert.match(html, /indirekt unterstellt, über Malte Manager, entscheidet: Malte Manager/);
  assert.match(html, /Soll bis heute/);
  assert.match(html, /16:00/);
  assert.doesNotMatch(html, /Führungslinie/);
  assert.match(await page([], 'hr'), /entscheidet bei euch HR/);
  assert.match(await page([], 'none'), /gelten bei euch sofort/);
  const hrView = await page([week({ canDecide: false, userEmail: 'a@test.local', personnelNumber: 'P-5' })], 'manager', STAFF);
  assert.match(hrView, /Ahrens, Anna/);
  assert.match(hrView, /data-time-search="weeks"/);
  assert.match(hrView, /a@test\.local P-5/);
});

test('Oberfläche: Die Personenliste lässt sich durchsuchen, und die Bereiche passen zur Rolle', async () => {
  const person = more => ({ id: 5, name: 'Tom Köhler', email: 't@test.local', personnelNumber: 'P-5', active: true, exitDate: null, weeklyHours: 40, hoursSource: 'default', totalBalanceMinutes: 0, canSetHours: true, ...more });
  const responses = {
    '/api/time/people': { people: [person(), person({ id: 6, name: 'Lea Leaver', active: false, exitDate: '2026-02-27' }), person({ id: 50, name: 'Sach Bearbeiter', canSetHours: false })] },
    '/api/time/week': { week: clientWeek({ clock: undefined }) },
    '/api/time/settings': { settings: { weeklyHours: 40, personnelActive: false, absenceActive: false, canEdit: true } }
  };
  const client = loadClient('time.js', { me: STAFF, view: 'timeHr', responses });
  assert.ok(client.definition.tabs('timeHome', STAFF).some(tab => tab.route === 'timeHr'));
  const list = await client.pages.timeHr();
  assert.match(list, /data-time-section="people"/);
  assert.match(list, /data-time-section="export"/);
  assert.doesNotMatch(list, /data-time-section="settings"/);
  assert.match(list, /Köhler, Tom/);
  assert.match(list, /letzter Arbeitstag 27\.02\.2026/);
  assert.equal((list.match(/data-time-hours=/g) || []).length, 2, 'die eigenen Wochenstunden ändert jemand anders');

  const rows = [{ dataset: { search: 'Tom Köhler t@test.local P-5', left: '0' } }, { dataset: { search: 'Lea Leaver', left: '1' } }];
  client.list('[data-time-row="people"]', rows);
  const input = client.button('[data-time-search]', { timeSearch: 'people' });
  client.definition.bind();
  assert.deepEqual(rows.map(row => Boolean(row.hidden)), [false, true], 'Ausgetretene erst auf Wunsch');
  input.value = 'koehler';
  input.oninput();
  assert.deepEqual(rows.map(row => Boolean(row.hidden)), [false, true]);
  input.value = 'p-5';
  input.oninput();
  assert.deepEqual(rows.map(row => Boolean(row.hidden)), [false, true]);
  input.value = 'lea';
  input.oninput();
  assert.deepEqual(rows.map(row => Boolean(row.hidden)), [true, true]);
  const toggle = client.element('#timeShowLeft');
  toggle.checked = true;
  toggle.onchange();
  assert.deepEqual(rows.map(row => Boolean(row.hidden)), [true, false]);

  // Die Korrektur der Wochenstunden verlangt einen Grund.
  const hours = client.button('[data-time-hours]', { timeHours: '5' });
  client.definition.bind();
  hours.onclick();
  assert.match(client.modals.at(-1).body, /name="reason"[^>]*required/);

  const admin = loadClient('time.js', { me: ADMIN, view: 'timeHr', responses });
  assert.match(await admin.pages.timeHr(), /data-time-section="settings"/);
});

test('Oberfläche: Der Export ohne Monat erklärt sich, statt still zu scheitern', async () => {
  const client = loadClient('time.js', { me: STAFF, view: 'timeHr', responses: {} });
  client.definition.bind();
  const month = client.element('#timeExportMonth');
  const link = client.element('#timeExportLink');
  month.value = '';
  month.onchange();
  let prevented = false;
  link.onclick({ preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true);
  assert.match(client.toasts[0].message, /Monat/);
  month.value = '2026-03';
  month.onchange();
  assert.match(link.href, /month=2026-03/);
});

test('Oberfläche: Aufgaben führen zum Vorgang, Hinweise lassen sich erledigen', async () => {
  const client = loadClient('time.js', { me: { id: 4, role: 'manager', name: 'Malte Manager' }, responses: {
    '/api/time/weeks/9': { week: { id: 9, userId: 5, weekStart: '2026-03-02', status: 'submitted' } },
    '/api/time/week': { week: clientWeek({ canDecide: true, clock: undefined }) }
  } });
  const action = type => client.definition.taskAction({ id: 3, type, entity_id: 9 });
  assert.match(action('time_week_approval'), /data-time-review-task="9"[^>]*>Prüfen/);
  assert.match(action('time_week_returned'), /data-time-open-week="9"/);
  assert.match(action('time_week_reopened'), /data-time-open-week="9"/);
  assert.match(action('time_correction_notice'), /data-time-open-week="9"/);
  assert.match(action('time_correction_notice'), /data-task-done="3"/);
  assert.equal(action('etwas_anderes'), '');

  // „Prüfen“ öffnet die Woche gleich zum Entscheiden.
  const review = client.button('[data-time-review-task]', { timeReviewTask: '9' });
  client.definition.bind();
  await review.onclick();
  const modal = client.modals.at(-1);
  assert.equal(modal.title, 'Anna Ahrens');
  assert.match(modal.body, /name="decision"/);
  assert.match(modal.body, /Soll bis heute 16:00/);
});

// ------------------------------------------------------------------ Runde 3

test('Lohnexport: Die Personalnummer steht darin, und wer fehlt, steht in der Datei und auf der Seite', async t => {
  const h = await setup(t, { modules: ['personnel'] });
  const staff = addStaff(h);
  const personnel = createPersonnelModule(h.deps);
  personnel.initialize();
  h.db.prepare("INSERT INTO personnel_records (user_id, personnel_number, created_at, updated_at) VALUES (5, 'P-5', 'x', 'x')").run();
  await h.fullDay('anna', LAST_WEEK);
  await h.fullDay('ben', LAST_WEEK);

  const full = (await h.api('hr', 'GET', '/api/time/export?month=2026-03')).data.trim().split('\r\n');
  assert.equal(full[0], 'Name;Personalnummer;E-Mail;Datum;Beginn;Ende;Pause (Min.);Arbeitszeit (Std.);Wochenstatus;Notiz');
  assert.equal(full.length, 3);
  assert.equal(full[1], 'Anna Ahrens;P-5;anna@test.local;02.03.2026;08:00;16:30;30;8,00;offen;');
  assert.equal(full[2], 'Ben Berg;;ben@test.local;02.03.2026;08:00;16:30;30;8,00;offen;');
  assert.deepEqual((await h.api('hr', 'GET', '/api/time/export/scope?month=2026-03')).data, { month: '2026-03', withheldPeople: 0, note: null });

  const fromStaff = (await h.api(staff, 'GET', '/api/time/export?month=2026-03')).data.trim().split('\r\n');
  assert.equal(fromStaff.length, 4);
  assert.match(fromStaff.at(-1), /^Hinweis: In dieser Datei fehlen 3 Personen mit HR-Rolle/);
  assert.equal(fromStaff.at(-1).split(';').length, 10, 'gleich viele Spalten wie die anderen Zeilen');
  const scope = (await h.api(staff, 'GET', '/api/time/export/scope?month=2026-03')).data;
  assert.equal(scope.withheldPeople, 3);
  assert.match(scope.note, /fehlen 3 Personen/);
  assert.match(h.db.prepare("SELECT new_values FROM audit_log WHERE action = 'time_exported' ORDER BY id DESC").get().new_values, /"rows":2/, 'der Hinweis zählt nicht als Zeile');

  const fromPartner = (await h.api('bp', 'GET', '/api/time/export?month=2026-03')).data.trim().split('\r\n');
  assert.match(fromPartner.at(-1), /^Hinweis: In dieser Datei fehlt 1 Person mit HR-Rolle/);

  await h.fullDay('bp', LAST_WEEK);
  h.deps.setUserActive(2, false, { id: 1 });
  assert.equal((await h.api(staff, 'GET', '/api/time/export/scope?month=2026-03')).data.withheldPeople, 3, 'Boris hat im März Einträge');
  assert.equal((await h.api(staff, 'GET', '/api/time/export/scope?month=2026-04')).data.withheldPeople, 2, 'im April nicht mehr');

  for (const person of ['anna', 'manager', 'director']) {
    assert.equal((await h.api(person, 'GET', '/api/time/export/scope?month=2026-03')).status, 403, person);
  }
  assert.equal((await h.api(staff, 'GET', '/api/time/export/scope')).status, 400);
  assert.equal((await h.api(null, 'GET', '/api/time/export/scope?month=2026-03')).status, 401);
});

test('Hinweis: Arbeitszeit an einem ganzen Abwesenheitstag, ohne die Art zu nennen', async t => {
  const h = await setup(t, { modules: ['absence'] });
  const absence = createAbsenceModule({ ...h.deps, now: () => h.clock });
  absence.initialize();
  const sick = h.db.prepare("SELECT id FROM absence_types WHERE code = 'sick'").get().id;
  const addAbsence = (userId, date, startHalf = 0) => h.db.prepare(`
    INSERT INTO absence_requests (user_id, type_id, start_date, end_date, start_half, end_half, status, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, 0, 'approved', ?, '2026-01-01')
  `).run(userId, sick, date, date, startHalf, userId);
  addAbsence(5, LAST_WEEK);
  addAbsence(5, plusDays(LAST_WEEK, 1), 1);

  // Ganzer Tag: Der Hinweis kommt sofort beim Speichern und steht in der Woche.
  const entry = await h.add('anna', LAST_WEEK, '08:00', '12:00');
  assert.equal(entry.status, 201, 'nachtragen bleibt möglich');
  const absent = entry.data.hints.find(item => item.code === 'absent_day');
  assert.ok(absent);
  assert.match(absent.message, /Am 02\.03\.2026 ist Arbeitszeit erfasst, obwohl für den ganzen Tag eine Abwesenheit eingetragen ist/);
  assert.match(absent.message, /Bitte prüfe, ob beides stimmt/);
  assert.doesNotMatch(absent.message, /krank|sick/i);

  // Halber Tag: Da darf man arbeiten.
  const half = await h.add('anna', plusDays(LAST_WEEK, 1), '13:00', '16:00');
  assert.equal(half.data.hints.filter(item => item.date === plusDays(LAST_WEEK, 1) && item.code === 'absent_day').length, 0);

  // HR bekommt den Hinweis auch, und die Führungskraft liest nach dem Einreichen nichts über die Art.
  addAbsence(6, LAST_WEEK);
  const byHr = await h.add('hr', LAST_WEEK, '08:00', '12:00', { userId: 6, reason: 'Nachtrag' });
  assert.ok(byHr.data.hints.some(item => item.code === 'absent_day'));
  await h.submit('anna');
  const asManager = await h.api('manager', 'GET', `/api/time/week?week=${LAST_WEEK}&userId=5`);
  assert.ok(asManager.data.week.hints.some(item => item.code === 'absent_day'));
  assert.doesNotMatch(JSON.stringify(asManager.data.week.hints), /krank|sick/i);
});

test('Hinweise sagen, was zu prüfen ist', async t => {
  const h = await setup(t);
  const response = await h.add('anna', LAST_WEEK, '06:00', '20:00');
  const hint = response.data.hints.find(item => item.code === 'daily_limit');
  assert.match(hint.message, /sind 14:00 Stunden Arbeitszeit erfasst/);
  assert.match(hint.message, /Bitte prüfe, ob das stimmt und bei euch erlaubt ist\.$/);
  assert.doesNotMatch(JSON.stringify(response.data.hints), /im Einzelfall/);
  assert.doesNotMatch(JSON.stringify(h.instance.helpArticles), /im Einzelfall/);
});

test('Sortierung: Ein Name mit Komma nennt seinen Nachnamen selbst', async t => {
  const h = await setup(t);
  const add = h.db.prepare("INSERT INTO users (id, name, email, password_hash, role, manager_id) VALUES (?, ?, ?, '!', 'employee', 3)");
  add.run(30, 'Müller, Anna', 'mueller@test.local');
  add.run(31, 'Lisa Mahler', 'mahler@test.local');
  const names = (await h.api('hr', 'GET', '/api/time/people')).data.people.map(person => person.name);
  assert.ok(names.indexOf('Lisa Mahler') < names.indexOf('Malte Manager'), names.join(', '));
  assert.ok(names.indexOf('Malte Manager') < names.indexOf('Müller, Anna'), 'unter M, nicht unter A');
  assert.ok(names.indexOf('Müller, Anna') < names.indexOf('Boris Partner'), names.join(', '));
});

test('Oberfläche: Namen mit Komma bleiben, wie sie sind, und die Suche findet jedes Wort in jeder Reihenfolge', async () => {
  const person = more => ({ id: 5, name: 'Tom Köhler', email: 't@test.local', personnelNumber: null, active: true, exitDate: null, weeklyHours: 40, hoursSource: 'default', totalBalanceMinutes: 0, canSetHours: true, ...more });
  const client = loadClient('time.js', { me: STAFF, view: 'timeHr', responses: { '/api/time/people': { people: [
    person({ id: 30, name: 'Müller, Anna' }),
    person({ id: 31, name: 'Lena Schmitt', email: 'lena.a@test.local' }),
    person({ id: 32, name: 'Lena Schmitt', email: 'lena.b@test.local' })
  ] } } });
  const html = await client.pages.timeHr();
  assert.match(html, /<b>Müller, Anna<\/b>/);
  assert.doesNotMatch(html, /Anna, Müller/);
  assert.match(html, /lena\.a@test\.local<\/small>/, 'gleiche Namen unterscheidet die E-Mail');
  assert.equal(html.includes('t@test.local</small>'), false, 'alle anderen bleiben kurz');

  const rows = [{ dataset: { search: 'Anna Schäfer anna@test.local' } }, { dataset: { search: 'Anna Berg P-7' } }, { dataset: { search: 'Müller, Anna' } }];
  client.list('[data-time-row="people"]', rows);
  const input = client.button('[data-time-search]', { timeSearch: 'people' });
  client.definition.bind();
  const search = text => {
    input.value = text;
    input.oninput();
    return rows.map(row => !row.hidden);
  };
  assert.deepEqual(search('Schäfer, Anna'), [true, false, false]);
  assert.deepEqual(search('anna schaefer'), [true, false, false]);
  assert.deepEqual(search('Anna Müller'), [false, false, true]);
  assert.deepEqual(search('anna p-7'), [false, true, false]);
  assert.deepEqual(search('Anna, Köhler'), [false, false, false], 'jedes Wort muss vorkommen');
});

test('Oberfläche: Die Stempelkarte spricht richtig Deutsch', async () => {
  const older = await homeClient(clientWeek({ running: { date: '2026-03-02', startTime: '08:00' } })).pages.timeHome();
  assert.match(older, /Eingestempelt seit dem 02\.03\.2026 um 08:00\./);
  assert.doesNotMatch(older, /seit am/);
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin' }).format(new Date());
  const current = await homeClient(clientWeek({ running: { date: today, startTime: '08:00' } })).pages.timeHome();
  assert.match(current, /Eingestempelt seit heute um 08:00\./);
});

test('Oberfläche: Die Zeiten einer Person haben eine eigene Adresse, und HR-Seiten sind geschützt', async () => {
  const responses = {
    '/api/time/people': { people: [] },
    '/api/time/week': { week: clientWeek({ clock: undefined }) }
  };
  const client = loadClient('time.js', { me: STAFF, view: 'timeHrPerson', responses });

  // Beim Neuladen kommt nur die Nummer aus der Adresse, und die Seite lädt alles frisch.
  const address = client.address.timeHrPerson;
  assert.equal(address.get(), null);
  address.set(5);
  assert.equal(address.get(), 5);
  const html = await client.pages.timeHrPerson();
  assert.match(client.requests.at(-1).url, /\/api\/time\/week\?userId=5/);
  assert.match(html, /Zeiten von Anna Ahrens/);
  assert.match(html, /data-time-hr-close/);

  // Ohne Nummer gibt es hier nichts zu zeigen: zurück zur Liste.
  const empty = loadClient('time.js', { me: STAFF, view: 'timeHrPerson', responses });
  assert.equal(await empty.pages.timeHrPerson(), '');
  assert.equal(empty.navigations.at(-1), 'timeHr');

  // Darf die Person das nicht sehen, kommt der Fehler bei der Oberfläche an, und die Nummer wird vergessen.
  const denied = loadClient('time.js', { me: STAFF, view: 'timeHrPerson', responses: {} });
  denied.address.timeHrPerson.set(1);
  await assert.rejects(denied.pages.timeHrPerson());
  assert.equal(denied.address.timeHrPerson.get(), null);

  // Die Liste öffnet die Person, und die eigene Seite führt zurück.
  const list = loadClient('time.js', { me: STAFF, view: 'timeHr', responses });
  const open = list.button('[data-time-hr-person]', { timeHrPerson: '7' });
  list.definition.bind();
  open.onclick();
  assert.equal(list.navigations.at(-1), 'timeHrPerson');
  assert.equal(list.address.timeHrPerson.get(), 7);
  const close = list.button('[data-time-hr-close]');
  list.definition.bind();
  close.onclick();
  assert.equal(list.navigations.at(-1), 'timeHr');
  const row = list.element('[data-time-person-row="7"]');
  list.definition.bind();
  assert.equal(row.scrolled, true, 'zurück in der Liste steht man wieder bei der Person');

  const allowed = client.definition.allowed;
  for (const view of ['timeHr', 'timeHrPerson']) {
    assert.equal(allowed(view, EMPLOYEE), false, view);
    assert.equal(allowed(view, { role: 'manager' }), false, view);
    assert.equal(allowed(view, STAFF), true, view);
    assert.equal(allowed(view, ADMIN), true, view);
  }
  assert.equal(allowed('timeTeam', EMPLOYEE), false);
  assert.equal(allowed('timeTeam', { role: 'manager' }), true);
  assert.equal(allowed('timeTeam', STAFF), true);
  assert.equal(allowed('timeHome', { role: 'super_admin' }), false);
  assert.equal(allowed('timeHome', EMPLOYEE), true);
  assert.equal(allowed('dashboard', EMPLOYEE), true, 'fremde Seiten gehen dieses Modul nichts an');
  assert.ok(client.definition.tabs('timeHrPerson', STAFF).find(tab => tab.route === 'timeHr').active);
  assert.ok(client.definition.nav(STAFF)[0].views.includes('timeHrPerson'));
});

test('Oberfläche: Der Export nennt auf der Seite, wer fehlt, passend zum Monat', async () => {
  const client = loadClient('time.js', { me: STAFF, view: 'timeHr', responses: {
    '/api/time/people': { people: [] },
    '/api/time/export/scope': { note: 'Hinweis: In dieser Datei fehlen 3 Personen mit HR-Rolle.' }
  } });
  await client.pages.timeHr();
  const section = client.button('[data-time-section]', { timeSection: 'export' });
  client.definition.bind();
  section.onclick();
  const html = await client.pages.timeHr();
  assert.match(html, /id="timeExportNote">Hinweis: In dieser Datei fehlen 3 Personen/);
  client.definition.bind();
  const month = client.element('#timeExportMonth');
  month.value = '2026-02';
  await month.onchange();
  assert.match(client.element('#timeExportLink').href, /export\?month=2026-02/);
  assert.match(client.requests.at(-1).url, /scope\?month=2026-02/);
  assert.equal(client.element('#timeExportNote').hidden, false);

  const admin = loadClient('time.js', { me: ADMIN, view: 'timeHr', responses: { '/api/time/people': { people: [] }, '/api/time/export/scope': { note: null } } });
  await admin.pages.timeHr();
  const adminSection = admin.button('[data-time-section]', { timeSection: 'export' });
  admin.definition.bind();
  adminSection.onclick();
  assert.match(await admin.pages.timeHr(), /id="timeExportNote" hidden>/);
});

test('Oberfläche: Die Voreinstellung lässt sich nicht doppelt absenden', async () => {
  const client = loadClient('time.js', { me: ADMIN, view: 'timeHr', responses: {} });
  client.definition.bind();
  const form = client.element('#timeSettingsForm');
  const submit = { disabled: false };
  form.values = { weeklyHours: '38' };
  form.querySelector = selector => (selector === 'button' ? submit : { textContent: '' });
  const first = form.onsubmit({ preventDefault() {} });
  assert.equal(submit.disabled, true, 'läuft: der Knopf ist gesperrt');
  await form.onsubmit({ preventDefault() {} });
  await first;
  const sent = client.requests.filter(item => item.method === 'PUT');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body.weeklyHours, '38');
  assert.equal(submit.disabled, false, 'danach geht es wieder');
});
