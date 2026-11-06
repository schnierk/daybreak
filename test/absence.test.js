'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');
const express = require('express');
const { createModuleHarness } = require('../lib/testing/module-harness');
const {
  GERMAN_STATES,
  countWorkdays,
  createAbsenceModule,
  csvField,
  easterSunday,
  statutoryHolidays,
  toCsv
} = require('../routes/absence');
const { createPersonnelModule } = require('../routes/personnel');

/** Jeder Test bekommt eine frische Datenbank und eine eigene, steuerbare Uhr. */
async function setup(t, { today = '2026-03-02', extra = {} } = {}) {
  const clock = { date: today, time: '09:00' };
  const h = await createModuleHarness(createAbsenceModule, { extra: { now: () => clock, ...extra } });
  t.after(() => h.close());
  const typeId = code => h.db.prepare('SELECT id FROM absence_types WHERE code = ?').get(code).id;
  const request = (person, startDate, endDate, more = {}) => h.api(person, 'POST', '/api/absence/requests', {
    typeId: typeId('vacation'),
    startDate,
    endDate,
    ...more
  });
  const tasksOf = (userId, type) => h.db.prepare('SELECT * FROM tasks WHERE user_id = ? AND type = ? AND done = 0').all(userId, type);
  const account = async (person, query = '') => (await h.api(person, 'GET', `/api/absence/account${query}`)).data.account;
  return { ...h, clock, typeId, request, tasksOf, account };
}

function workdays(start_date, end_date, { startHalf = false, endHalf = false, holidays = [] } = {}) {
  return countWorkdays({ start_date, end_date, start_half: startHalf, end_half: endHalf }, new Map(holidays.map(date => [date, 'Feiertag'])));
}

// ------------------------------------------------------------------ Berechnungen ohne Datenbank

test('Ostersonntag nach Gauß stimmt für bekannte Jahre, auch für die beiden Ausnahmen der Formel', () => {
  const known = {
    2024: '2024-03-31',
    2025: '2025-04-20',
    2026: '2026-04-05',
    2027: '2027-03-28',
    2008: '2008-03-23',
    2038: '2038-04-25',
    1981: '1981-04-19', // Ausnahme: 19. statt 26. April
    2049: '2049-04-18', // Ausnahme: 18. statt 25. April
    2076: '2076-04-19'
  };
  for (const [year, sunday] of Object.entries(known)) assert.equal(easterSunday(Number(year)), sunday, `Ostern ${year}`);
});

test('gesetzliche Feiertage hängen vom Bundesland und vom Jahr ab', () => {
  const dates = (year, state) => new Map(statutoryHolidays(year, state).map(holiday => [holiday.name, holiday.date]));

  const nrw = dates(2026, 'NW');
  assert.equal(nrw.size, 11);
  assert.equal(nrw.get('Karfreitag'), '2026-04-03');
  assert.equal(nrw.get('Ostermontag'), '2026-04-06');
  assert.equal(nrw.get('Christi Himmelfahrt'), '2026-05-14');
  assert.equal(nrw.get('Pfingstmontag'), '2026-05-25');
  assert.equal(nrw.get('Fronleichnam'), '2026-06-04');
  assert.equal(nrw.get('Allerheiligen'), '2026-11-01');
  assert.equal(nrw.has('Reformationstag'), false);

  assert.equal(dates(2026, 'SN').get('Buß- und Bettag'), '2026-11-18');
  assert.equal(dates(2023, 'SN').get('Buß- und Bettag'), '2023-11-22');
  assert.equal(dates(2026, 'BE').get('Internationaler Frauentag'), '2026-03-08');
  assert.equal(dates(2026, 'BB').get('Ostersonntag'), '2026-04-05');
  assert.equal(dates(2026, 'BY').get('Heilige Drei Könige'), '2026-01-06');
  assert.equal(dates(2026, 'TH').get('Weltkindertag'), '2026-09-20');
  assert.equal(dates(2026, 'SL').get('Mariä Himmelfahrt'), '2026-08-15');
  assert.equal(dates(2026, 'NI').get('Reformationstag'), '2026-10-31');

  // Der Frauentag gilt in Mecklenburg-Vorpommern erst seit 2023.
  assert.equal(dates(2022, 'MV').has('Internationaler Frauentag'), false);
  assert.equal(dates(2023, 'MV').has('Internationaler Frauentag'), true);
  // Einmaliger Feiertag in Berlin.
  assert.equal(dates(2025, 'BE').get('Tag der Befreiung'), '2025-05-08');
  assert.equal(dates(2026, 'BE').has('Tag der Befreiung'), false);

  // Bundesweite Tage gibt es überall, und die Liste ist nach Datum sortiert.
  for (const state of Object.keys(GERMAN_STATES)) {
    const list = statutoryHolidays(2026, state);
    assert.ok(list.length >= 10, state);
    assert.deepEqual(list.map(holiday => holiday.date), [...list.map(holiday => holiday.date)].sort());
  }
});

test('Arbeitstage: Montag bis Freitag, ohne Feiertage, mit Halbtagen am Anfang und Ende', () => {
  assert.equal(workdays('2026-03-09', '2026-03-13'), 5, 'Montag bis Freitag');
  assert.equal(workdays('2026-03-09', '2026-03-15'), 5, 'Wochenende zählt nicht');
  assert.equal(workdays('2026-03-13', '2026-03-16'), 2, 'Freitag bis Montag');
  assert.equal(workdays('2026-03-14', '2026-03-15'), 0, 'nur Wochenende');
  assert.equal(workdays('2026-03-09', '2026-03-13', { holidays: ['2026-03-11'] }), 4, 'Feiertag zählt nicht');
  assert.equal(workdays('2026-03-11', '2026-03-11', { holidays: ['2026-03-11'] }), 0, 'nur Feiertag');

  assert.equal(workdays('2026-03-09', '2026-03-13', { startHalf: true }), 4.5);
  assert.equal(workdays('2026-03-09', '2026-03-13', { endHalf: true }), 4.5);
  assert.equal(workdays('2026-03-09', '2026-03-13', { startHalf: true, endHalf: true }), 4);
  assert.equal(workdays('2026-03-09', '2026-03-09', { startHalf: true }), 0.5, 'einzelner halber Tag');
  assert.equal(workdays('2026-03-09', '2026-03-09', { startHalf: true, endHalf: true }), 0.5, 'beide Haken ergeben keinen Null-Tag');
  assert.equal(workdays('2026-03-14', '2026-03-16', { startHalf: true }), 1, 'Halbtag auf dem Wochenende zieht nichts ab');
  assert.equal(workdays('2026-03-09', '2026-03-11', { endHalf: true, holidays: ['2026-03-11'] }), 2, 'Halbtag auf dem Feiertag zieht nichts ab');
  assert.equal(workdays('2026-12-28', '2027-01-04', { holidays: ['2027-01-01'] }), 5, 'über den Jahreswechsel');
});

test('CSV-Felder sind gegen Formeln geschützt und korrekt maskiert', () => {
  assert.equal(csvField('=SUMME(A1)'), "'=SUMME(A1)");
  assert.equal(csvField('+49 170'), "'+49 170");
  assert.equal(csvField('-2+3'), "'-2+3");
  assert.equal(csvField('@cmd'), "'@cmd");
  assert.equal(csvField('\t=1'), "'\t=1");
  assert.equal(csvField(' =1'), "' =1", 'führende Leerzeichen helfen nicht');
  assert.equal(csvField('Anna'), 'Anna');
  assert.equal(csvField('a;b'), '"a;b"');
  assert.equal(csvField('sag "hallo"'), '"sag ""hallo"""');
  assert.equal(csvField('=a;b'), `"'=a;b"`);
  assert.equal(csvField(null), '');
  assert.ok(toCsv([['a', 'b']]).startsWith('﻿a;b\r\n'));
});

// ------------------------------------------------------------------ Anmeldung und Stammdaten

test('ohne Anmeldung gibt es nirgends eine Antwort außer 401', async t => {
  const h = await setup(t);
  const routes = [
    ['GET', '/api/absence/types'],
    ['POST', '/api/absence/types'],
    ['PATCH', '/api/absence/types/1'],
    ['GET', '/api/absence/settings'],
    ['PUT', '/api/absence/settings'],
    ['GET', '/api/absence/account'],
    ['GET', '/api/absence/accounts'],
    ['PUT', '/api/absence/accounts/5/2026'],
    ['GET', '/api/absence/holidays'],
    ['POST', '/api/absence/holidays'],
    ['POST', '/api/absence/holidays/import'],
    ['DELETE', '/api/absence/holidays/1'],
    ['GET', '/api/absence/requests'],
    ['POST', '/api/absence/requests'],
    ['GET', '/api/absence/requests/1'],
    ['POST', '/api/absence/requests/1/decision'],
    ['POST', '/api/absence/requests/1/cancel'],
    ['GET', '/api/absence/approvals'],
    ['GET', '/api/absence/calendar'],
    ['GET', '/api/absence/export?month=2026-03'],
    ['POST', '/api/absence/tasks/1/done']
  ];
  for (const [method, url] of routes) {
    const response = await h.api(null, method, url, method === 'GET' ? undefined : {});
    assert.equal(response.status, 401, `${method} ${url}`);
  }
});

test('die Abwesenheitsarten sind da, und ein zweites Initialisieren ändert nichts', async t => {
  const h = await setup(t);
  const { data } = await h.api('anna', 'GET', '/api/absence/types');
  assert.deepEqual(data.types.map(type => type.name), ['Urlaub', 'Krankheit', 'Sonderurlaub', 'Unbezahlter Urlaub', 'Elternzeit']);
  const byCode = Object.fromEntries(data.types.map(type => [type.code, type]));
  assert.equal(byCode.vacation.countsAgainstBalance, true);
  assert.equal(byCode.vacation.requiresApproval, true);
  assert.equal(byCode.sick.requiresApproval, false);
  assert.equal(byCode.sick.confidential, true);
  assert.equal(byCode.sick.countsAgainstBalance, false);

  await h.api('hr', 'PATCH', `/api/absence/types/${byCode.special.id}`, { name: 'Freistellung', active: false });
  h.instance.initialize();
  const types = h.db.prepare('SELECT code, name, active FROM absence_types').all();
  assert.equal(types.length, 5);
  const special = types.find(type => type.code === 'special');
  assert.equal(special.name, 'Freistellung', 'Änderungen von HR bleiben erhalten');
  assert.equal(special.active, 0);
  assert.equal(h.db.prepare('SELECT COUNT(*) AS count FROM absence_settings').get().count, 1);
});

test('HR ergänzt und deaktiviert Arten, andere dürfen das nicht', async t => {
  const h = await setup(t);
  assert.equal((await h.api('anna', 'POST', '/api/absence/types', { name: 'Kur' })).status, 403);
  assert.equal((await h.api('manager', 'POST', '/api/absence/types', { name: 'Kur' })).status, 403);
  assert.equal((await h.api('hr', 'POST', '/api/absence/types', { name: '' })).status, 400);
  assert.equal((await h.api('hr', 'POST', '/api/absence/types', { name: 'urlaub' })).status, 400, 'Name schon vergeben');

  const created = await h.api('bp', 'POST', '/api/absence/types', { name: 'Fortbildung', requiresApproval: true });
  assert.equal(created.status, 201);
  const id = created.data.type.id;

  assert.equal((await h.api('anna', 'PATCH', `/api/absence/types/${id}`, { active: false })).status, 403);
  assert.equal((await h.api('hr', 'PATCH', '/api/absence/types/9999', { active: false })).status, 404);
  assert.equal((await h.api('hr', 'PATCH', `/api/absence/types/${id}`, { name: 'Krankheit' })).status, 400, 'Name schon vergeben');
  assert.equal((await h.api('hr', 'PATCH', `/api/absence/types/${id}`, { active: false })).status, 200);

  const visibleToAnna = (await h.api('anna', 'GET', '/api/absence/types')).data.types.map(type => type.id);
  assert.equal(visibleToAnna.includes(id), false);
  const visibleToHr = (await h.api('hr', 'GET', '/api/absence/types?all=1')).data.types.map(type => type.id);
  assert.equal(visibleToHr.includes(id), true);
  const onlyActiveForAnna = (await h.api('anna', 'GET', '/api/absence/types?all=1')).data.types.map(type => type.id);
  assert.equal(onlyActiveForAnna.includes(id), false, 'der Schalter gilt nur für HR');

  const blocked = await h.api('anna', 'POST', '/api/absence/requests', { typeId: id, startDate: '2026-03-09', endDate: '2026-03-09' });
  assert.equal(blocked.status, 400, 'deaktivierte Art ist nicht mehr wählbar');
});

test('Krankheit lässt sich nicht aus der Vertraulichkeit herausnehmen', async t => {
  const h = await setup(t);
  const sick = h.typeId('sick');
  assert.equal((await h.api('hr', 'PATCH', `/api/absence/types/${sick}`, { confidential: false })).status, 400);
  assert.equal((await h.api('hr', 'PATCH', `/api/absence/types/${sick}`, { requiresApproval: true })).status, 400);
  assert.equal((await h.api('hr', 'PATCH', `/api/absence/types/${sick}`, { countsAgainstBalance: true })).status, 400);
  assert.equal((await h.api('hr', 'PATCH', `/api/absence/types/${sick}`, { name: 'Krank' })).status, 200);
  assert.equal(h.db.prepare('SELECT confidential FROM absence_types WHERE id = ?').get(sick).confidential, 1);
});

test('Voreinstellungen: nur HR, und ungültige Werte werden abgelehnt', async t => {
  const h = await setup(t);
  assert.equal((await h.api('anna', 'GET', '/api/absence/settings')).status, 403);
  assert.equal((await h.api('manager', 'PUT', '/api/absence/settings', { defaultEntitlementDays: 40 })).status, 403);

  const { data } = await h.api('hr', 'GET', '/api/absence/settings');
  assert.equal(data.settings.defaultEntitlementDays, 30);
  assert.equal(data.settings.carryoverExpiryDay, '03-31');
  assert.equal(data.settings.state, null);

  for (const invalid of [
    { defaultEntitlementDays: -1 },
    { defaultEntitlementDays: 27.3 },
    { defaultEntitlementDays: 'viele' },
    { defaultEntitlementDays: '' },
    { defaultEntitlementDays: 400 },
    { carryoverExpiryDay: '02-29' },
    { carryoverExpiryDay: '13-01' },
    { carryoverExpiryDay: 'Ende März' },
    { state: 'XX' },
    { state: 'constructor' },
    { state: ['BW'] }
  ]) {
    assert.equal((await h.api('hr', 'PUT', '/api/absence/settings', invalid)).status, 400, JSON.stringify(invalid));
  }

  const saved = await h.api('hr', 'PUT', '/api/absence/settings', { defaultEntitlementDays: 27.5, carryoverExpiryDay: '06-30', state: 'BY' });
  assert.equal(saved.status, 200);
  assert.equal(saved.data.settings.defaultEntitlementDays, 27.5);
  assert.equal(saved.data.settings.carryoverExpiryDay, '06-30');
  assert.equal(saved.data.settings.state, 'BY');

  const fresh = await h.account('clara');
  assert.equal(fresh.entitlementDays, 27.5, 'neues Konto folgt der Voreinstellung');
  assert.equal(fresh.carryoverExpires, '2026-06-30');
});

// ------------------------------------------------------------------ Feiertage

test('Feiertage einspielen: nur HR, wiederholbar, eigene Tage bleiben, Bundeslandwechsel ersetzt', async t => {
  const h = await setup(t);
  assert.equal((await h.api('anna', 'POST', '/api/absence/holidays/import', { year: 2026, state: 'NW' })).status, 403);
  assert.equal((await h.api('manager', 'POST', '/api/absence/holidays', { date: '2026-12-24', name: 'Heiligabend' })).status, 403);
  assert.equal((await h.api('hr', 'POST', '/api/absence/holidays/import', { year: 2026 })).status, 400, 'ohne Bundesland');
  assert.equal((await h.api('hr', 'POST', '/api/absence/holidays/import', { year: 2026, state: 'XX' })).status, 400);
  assert.equal((await h.api('hr', 'POST', '/api/absence/holidays/import', { year: 1900, state: 'NW' })).status, 400);

  const first = await h.api('hr', 'POST', '/api/absence/holidays/import', { year: 2026, state: 'NW' });
  assert.equal(first.status, 200);
  assert.equal(first.data.imported, 11);
  const again = await h.api('hr', 'POST', '/api/absence/holidays/import', { year: 2026, state: 'NW' });
  assert.equal(again.data.imported, 11);
  assert.equal(h.db.prepare('SELECT COUNT(*) AS count FROM absence_holidays').get().count, 11);

  // Eigene Tage ergänzen.
  assert.equal((await h.api('hr', 'POST', '/api/absence/holidays', { date: '2026-13-01', name: 'Quatsch' })).status, 400);
  assert.equal((await h.api('hr', 'POST', '/api/absence/holidays', { date: '2026-12-24' })).status, 400);
  assert.equal((await h.api('hr', 'POST', '/api/absence/holidays', { date: '2026-12-25', name: 'Doppelt' })).status, 400, 'Tag ist schon belegt');
  const custom = await h.api('hr', 'POST', '/api/absence/holidays', { date: '2026-12-24', name: 'Heiligabend' });
  assert.equal(custom.status, 201);
  const customReform = await h.api('hr', 'POST', '/api/absence/holidays', { date: '2026-10-31', name: 'Betriebsfest' });
  assert.equal(customReform.status, 201);

  // Wechsel nach Niedersachsen: Fronleichnam fällt weg, der eigene Tag bleibt, auch wenn dort gesetzlich etwas läge.
  const changed = await h.api('hr', 'POST', '/api/absence/holidays/import', { year: 2026, state: 'NI' });
  assert.equal(changed.data.skipped, 1);
  const list = await h.api('anna', 'GET', '/api/absence/holidays?year=2026');
  assert.equal(list.status, 200, 'alle dürfen Feiertage lesen');
  assert.equal(list.data.statutoryImported, true);
  const names = new Map(list.data.holidays.map(holiday => [holiday.date, holiday.name]));
  assert.equal(names.has('2026-06-04'), false);
  assert.equal(names.get('2026-12-24'), 'Heiligabend');
  assert.equal(names.get('2026-10-31'), 'Betriebsfest');

  // Einstellung als Voreinstellung fürs Einspielen; anderes Jahr bleibt unberührt.
  await h.api('hr', 'PUT', '/api/absence/settings', { state: 'BE' });
  const byDefault = await h.api('hr', 'POST', '/api/absence/holidays/import', { year: 2027 });
  assert.equal(byDefault.data.state, 'BE');
  assert.equal(byDefault.data.imported, 10);
  assert.equal((await h.api('hr', 'GET', '/api/absence/holidays?year=2028')).data.statutoryImported, false);
  assert.equal((await h.api('hr', 'GET', '/api/absence/holidays?year=1900')).status, 400);

  // Löschen.
  assert.equal((await h.api('anna', 'DELETE', `/api/absence/holidays/${custom.data.id}`)).status, 403);
  assert.equal((await h.api('hr', 'DELETE', '/api/absence/holidays/99999')).status, 404);
  assert.equal((await h.api('hr', 'DELETE', `/api/absence/holidays/${custom.data.id}`)).status, 200);
  assert.equal(h.db.prepare("SELECT COUNT(*) AS count FROM absence_holidays WHERE date = '2026-12-24'").get().count, 0);
});

// ------------------------------------------------------------------ Antrag und Prüfungen

test('Anträge werden geprüft: Datum, Art, Arbeitstage und fremde Personen', async t => {
  const h = await setup(t);
  await h.api('hr', 'POST', '/api/absence/holidays/import', { year: 2026, state: 'NW' });

  assert.equal((await h.request('anna', '2026-03-13', '2026-03-09')).status, 400, 'Ende vor Anfang');
  assert.equal((await h.request('anna', '2026-02-30', '2026-03-02')).status, 400, 'Datum gibt es nicht');
  assert.equal((await h.request('anna', '13.03.2026', '14.03.2026')).status, 400, 'falsches Format');
  assert.equal((await h.request('anna', undefined, '2026-03-02')).status, 400, 'Anfang fehlt');
  assert.equal((await h.request('anna', '2026-03-09', ['2026-03-10'])).status, 400, 'Liste statt Text');
  assert.equal((await h.request('anna', '2040-03-09', '2040-03-10')).status, 400, 'zu weit in der Zukunft');
  assert.equal((await h.request('anna', '2026-03-09', '2031-03-10', { typeId: h.typeId('parental') })).status, 400, 'zu lang');

  const weekend = await h.request('anna', '2026-03-14', '2026-03-15');
  assert.equal(weekend.status, 400, 'nur Wochenende');
  assert.match(weekend.data.error, /keinen Arbeitstag/);
  assert.equal((await h.request('anna', '2026-04-03', '2026-04-03')).status, 400, 'nur Feiertag');

  assert.equal((await h.request('anna', '2026-03-09', '2026-03-09', { typeId: 9999 })).status, 400, 'unbekannte Art');
  assert.equal((await h.request('anna', '2026-03-09', '2026-03-09', { typeId: 'abc' })).status, 400);

  assert.equal((await h.request('ben', '2026-03-09', '2026-03-09', { userId: 5 })).status, 403, 'Kollege für Kollegin');
  assert.equal((await h.request('manager', '2026-03-09', '2026-03-09', { userId: 5 })).status, 403, 'Führungskraft erfasst nicht für andere');
  assert.equal((await h.request('hr', '2026-03-09', '2026-03-09', { userId: 9999 })).status, 404);
  assert.equal((await h.request('hr', '2026-03-09', '2026-03-09', { userId: 'abc' })).status, 400);

  // Gültig: Gründonnerstag bis Dienstag nach Ostern enthält Wochenende und zwei Feiertage.
  const easter = await h.request('anna', '2026-04-02', '2026-04-07');
  assert.equal(easter.status, 201);
  assert.equal(easter.data.days, 2);
  assert.equal(easter.data.status, 'pending');

  const half = await h.request('anna', '2026-03-09', '2026-03-13', { startHalf: true, endHalf: true, comment: 'Reise' });
  assert.equal(half.data.days, 4);
  const single = await h.request('anna', '2026-03-16', '2026-03-16', { endHalf: true });
  assert.equal(single.data.days, 0.5);

  const stored = await h.api('anna', 'GET', `/api/absence/requests/${half.data.id}`);
  assert.equal(stored.data.request.comment, 'Reise');
  assert.equal(stored.data.request.startHalf, true);
  assert.equal(stored.data.request.endHalf, true);
  assert.equal(stored.data.request.days, 4);
});

test('Überschneidungen mit eigenen offenen oder genehmigten Anträgen werden abgelehnt', async t => {
  const h = await setup(t);
  const first = await h.request('anna', '2026-03-09', '2026-03-13');
  assert.equal(first.status, 201);

  const overlapPending = await h.request('anna', '2026-03-13', '2026-03-17');
  assert.equal(overlapPending.status, 400, 'offener Antrag blockiert');
  assert.match(overlapPending.data.error, /09\.03\.2026 bis 13\.03\.2026/);
  assert.equal((await h.request('anna', '2026-03-10', '2026-03-10')).status, 400, 'liegt innerhalb');
  assert.equal((await h.request('anna', '2026-03-02', '2026-03-20')).status, 400, 'umschließt');
  const sickDuring = await h.api('anna', 'POST', '/api/absence/requests', { typeId: h.typeId('sick'), startDate: '2026-03-11', endDate: '2026-03-11' });
  assert.equal(sickDuring.status, 400, 'gilt auch über Arten hinweg');

  assert.equal((await h.request('anna', '2026-03-16', '2026-03-16')).status, 201, 'direkt danach ist frei');
  assert.equal((await h.request('ben', '2026-03-09', '2026-03-13')).status, 201, 'andere Person stört nicht');

  await h.api('manager', 'POST', `/api/absence/requests/${first.data.id}/decision`, { decision: 'approve' });
  assert.equal((await h.request('anna', '2026-03-13', '2026-03-13')).status, 400, 'genehmigter Antrag blockiert');

  await h.api('anna', 'POST', `/api/absence/requests/${first.data.id}/cancel`);
  assert.equal((await h.request('anna', '2026-03-13', '2026-03-13')).status, 201, 'stornierter Antrag blockiert nicht');

  const toReject = await h.request('anna', '2026-03-23', '2026-03-24');
  await h.api('manager', 'POST', `/api/absence/requests/${toReject.data.id}/decision`, { decision: 'reject', comment: 'Messe' });
  assert.equal((await h.request('anna', '2026-03-23', '2026-03-23')).status, 201, 'abgelehnter Antrag blockiert nicht');
});

test('zwei halbe Tage dürfen sich ein Datum teilen, mehr nicht', async t => {
  const h = await setup(t);
  assert.equal((await h.request('anna', '2026-03-09', '2026-03-09', { startHalf: true })).status, 201);
  assert.equal((await h.request('anna', '2026-03-09', '2026-03-09')).status, 400, 'ganzer Tag passt nicht mehr');
  assert.equal((await h.request('anna', '2026-03-09', '2026-03-09', { endHalf: true })).status, 201, 'zweite Hälfte passt');
  assert.equal((await h.request('anna', '2026-03-09', '2026-03-09', { endHalf: true })).status, 400, 'dritte Hälfte passt nicht');

  // Antrag endet halb am Mittwoch, der nächste beginnt dort halb.
  assert.equal((await h.request('ben', '2026-03-16', '2026-03-18', { endHalf: true })).status, 201);
  assert.equal((await h.request('ben', '2026-03-18', '2026-03-20', { startHalf: true })).status, 201);
  assert.equal((await h.request('ben', '2026-03-18', '2026-03-18', { startHalf: true })).status, 400);
  const account = await h.account('ben');
  assert.equal(account.plannedDays, 5, '2,5 und 2,5 ergeben fünf Tage');
});

test('zu wenig Resturlaub führt zur Ablehnung mit Meldung, und nichts wird gespeichert', async t => {
  const h = await setup(t);
  await h.api('hr', 'PUT', '/api/absence/accounts/5/2026', { reason: 'Korrektur', entitlementDays: 5, carryoverDays: 0 });

  const tooMuch = await h.request('anna', '2026-03-09', '2026-03-16');
  assert.equal(tooMuch.status, 400);
  assert.match(tooMuch.data.error, /Resturlaub für 2026 reicht nicht/);
  assert.match(tooMuch.data.error, /Beantragt sind 6 Tage, frei sind noch 5/);
  assert.equal(h.db.prepare('SELECT COUNT(*) AS count FROM absence_requests').get().count, 0);
  assert.equal(h.tasksOf(4, 'absence_approval').length, 0);

  assert.equal((await h.request('anna', '2026-03-09', '2026-03-13')).status, 201, 'genau passend geht');
  const none = await h.request('anna', '2026-03-16', '2026-03-16', { startHalf: true });
  assert.equal(none.status, 400);
  assert.match(none.data.error, /frei sind noch 0/);

  // Arten, die nicht aufs Konto gehen, sind nicht betroffen.
  const special = await h.api('anna', 'POST', '/api/absence/requests', { typeId: h.typeId('special'), startDate: '2026-03-16', endDate: '2026-03-20' });
  assert.equal(special.status, 201);
  const sick = await h.api('hr', 'POST', '/api/absence/requests', { userId: 5, typeId: h.typeId('sick'), startDate: '2026-03-23', endDate: '2026-03-27' });
  assert.equal(sick.status, 201);
  assert.equal((await h.account('anna')).restDays, 0);
});

test('ein Antrag über den Jahreswechsel belastet jedes Jahr mit seinem Anteil', async t => {
  const h = await setup(t, { today: '2026-11-02' });
  await h.api('hr', 'POST', '/api/absence/holidays/import', { year: 2026, state: 'NW' });
  await h.api('hr', 'POST', '/api/absence/holidays/import', { year: 2027, state: 'NW' });

  // 28.12. bis 31.12.2026 sind 4 Tage, 04.01. bis 05.01.2027 sind 2 Tage, 01.01.2027 ist Feiertag.
  const request = await h.request('anna', '2026-12-28', '2027-01-05');
  assert.equal(request.data.days, 6);
  assert.equal((await h.account('anna', '?year=2026')).plannedDays, 4);
  assert.equal((await h.account('anna', '?year=2027')).plannedDays, 2);

  await h.api('hr', 'PUT', '/api/absence/accounts/6/2027', { reason: 'Korrektur', entitlementDays: 1, carryoverDays: 0 });
  const tooMuch = await h.request('ben', '2026-12-28', '2027-01-05');
  assert.equal(tooMuch.status, 400, 'nur der Anteil 2027 reicht nicht');
  assert.match(tooMuch.data.error, /für 2027/);

  // Mit automatischem Übertrag aus 2026 reicht es dann doch.
  await h.api('hr', 'PUT', '/api/absence/accounts/6/2027', { reason: 'Korrektur', carryoverDays: null });
  assert.equal((await h.request('ben', '2026-12-28', '2027-01-05')).status, 201);
});

// ------------------------------------------------------------------ Konten

test('Konto: wird automatisch angelegt und unterscheidet genommen, geplant und Rest', async t => {
  const h = await setup(t);
  const fresh = await h.account('anna');
  assert.deepEqual(
    { ...fresh, userId: undefined },
    {
      userId: undefined,
      year: 2026,
      entitlementDays: 30,
      carryoverDays: 0,
      carryoverAutomatic: true,
      carryoverExpires: '2026-03-31',
      carryoverExpiredDays: 0,
      carryoverExpiringDays: 0,
      takenDays: 0,
      plannedDays: 0,
      pendingDays: 0,
      restDays: 30,
      correction: null
    }
  );
  assert.equal(h.db.prepare('SELECT COUNT(*) AS count FROM absence_accounts WHERE user_id = 5').get().count, 1);

  const past = await h.request('anna', '2026-03-09', '2026-03-13');
  const future = await h.request('anna', '2026-03-23', '2026-03-25');
  const open = await h.request('anna', '2026-04-13', '2026-04-14');
  await h.api('manager', 'POST', `/api/absence/requests/${past.data.id}/decision`, { decision: 'approve' });
  await h.api('manager', 'POST', `/api/absence/requests/${future.data.id}/decision`, { decision: 'approve' });
  assert.ok(open.data.id);

  h.clock.date = '2026-03-11';
  const during = await h.account('anna');
  assert.equal(during.takenDays, 3, 'Montag bis Mittwoch sind genommen');
  assert.equal(during.plannedDays, 2 + 3 + 2, 'Rest der Woche, genehmigt später und offen');
  assert.equal(during.pendingDays, 2);
  assert.equal(during.restDays, 30 - 3 - 7);

  h.clock.date = '2026-05-01';
  const later = await h.account('anna');
  assert.equal(later.takenDays, 8);
  assert.equal(later.plannedDays, 2, 'nur der offene Antrag ist noch geplant');
  assert.equal(later.restDays, 20);
});

test('Konto: HR passt je Person an, mit Halbtagen und nur mit gültigen Werten', async t => {
  const h = await setup(t);
  assert.equal((await h.api('anna', 'PUT', '/api/absence/accounts/5/2026', { reason: 'Korrektur', entitlementDays: 99 })).status, 403);
  assert.equal((await h.api('manager', 'PUT', '/api/absence/accounts/5/2026', { reason: 'Korrektur', entitlementDays: 99 })).status, 403);
  assert.equal((await h.api('hr', 'PUT', '/api/absence/accounts/9999/2026', { reason: 'Korrektur', entitlementDays: 20 })).status, 404);
  assert.equal((await h.api('hr', 'PUT', '/api/absence/accounts/5/1999', { reason: 'Korrektur', entitlementDays: 20 })).status, 400);
  assert.equal((await h.api('hr', 'PUT', '/api/absence/accounts/5/2026', { reason: 'Korrektur', entitlementDays: 20.25 })).status, 400);
  assert.equal((await h.api('hr', 'PUT', '/api/absence/accounts/5/2026', { reason: 'Korrektur', carryoverDays: -1 })).status, 400);
  assert.equal((await h.api('hr', 'PUT', '/api/absence/accounts/5/2026', { reason: 'Korrektur', carryoverExpires: '2025-12-31' })).status, 400);
  assert.equal((await h.api('hr', 'PUT', '/api/absence/accounts/5/2026', { reason: 'Korrektur', carryoverExpires: 'bald' })).status, 400);

  const saved = await h.api('bp', 'PUT', '/api/absence/accounts/5/2026', { reason: 'Korrektur', entitlementDays: 27.5, carryoverDays: 2.5, carryoverExpires: '2026-06-30' });
  assert.equal(saved.status, 200);
  assert.equal(saved.data.account.entitlementDays, 27.5);
  assert.equal(saved.data.account.carryoverDays, 2.5);
  assert.equal(saved.data.account.carryoverAutomatic, false);
  assert.equal(saved.data.account.carryoverExpires, '2026-06-30');
  assert.equal(saved.data.account.restDays, 30);

  const list = await h.api('hr', 'GET', '/api/absence/accounts?year=2026');
  assert.equal(list.status, 200);
  assert.equal(list.data.accounts.length, 7);
  assert.equal(list.data.accounts.find(account => account.userId === 5).restDays, 30);
  assert.equal((await h.api('anna', 'GET', '/api/absence/accounts?year=2026')).status, 403);
  assert.equal((await h.api('manager', 'GET', '/api/absence/accounts?year=2026')).status, 403);
  assert.equal((await h.api('hr', 'GET', '/api/absence/accounts?year=nie')).status, 400);
});

test('Konto: nur die Person, ihre Führungslinie und HR dürfen es sehen', async t => {
  const h = await setup(t);
  assert.equal((await h.api('anna', 'GET', '/api/absence/account?userId=6')).status, 403, 'Kollege');
  assert.equal((await h.api('clara', 'GET', '/api/absence/account?userId=5')).status, 403, 'anderes Team');
  assert.equal((await h.api('anna', 'GET', '/api/absence/account?userId=4')).status, 403, 'nach oben');
  assert.equal((await h.api('manager', 'GET', '/api/absence/account?userId=7')).status, 403, 'fremdes Team');
  assert.equal((await h.api('manager', 'GET', '/api/absence/account?userId=5')).status, 200, 'direkte Führungskraft');
  assert.equal((await h.api('director', 'GET', '/api/absence/account?userId=5')).status, 200, 'Führungslinie');
  assert.equal((await h.api('bp', 'GET', '/api/absence/account?userId=5')).status, 200, 'HR');
  assert.equal((await h.api('hr', 'GET', '/api/absence/account?userId=9999')).status, 404);
  assert.equal((await h.api('hr', 'GET', '/api/absence/account?userId=abc')).status, 400);
  assert.equal((await h.api('anna', 'GET', '/api/absence/account?year=1990')).status, 400);
});

test('Übertrag: wird zuerst verbraucht und verfällt nach dem Stichtag beim Lesen', async t => {
  const h = await setup(t, { today: '2026-02-02' });
  await h.api('hr', 'PUT', '/api/absence/accounts/5/2026', { reason: 'Korrektur', entitlementDays: 30, carryoverDays: 5 });

  // Vor dem Verfall zählt der ganze Übertrag zum Rest, ist aber als gefährdet ausgewiesen.
  let account = await h.account('anna');
  assert.equal(account.carryoverDays, 5);
  assert.equal(account.carryoverExpiredDays, 0);
  assert.equal(account.carryoverExpiringDays, 5);
  assert.equal(account.restDays, 35);

  // Drei Tage im März verbrauchen zuerst den Übertrag.
  const march = await h.request('anna', '2026-03-09', '2026-03-11');
  await h.api('manager', 'POST', `/api/absence/requests/${march.data.id}/decision`, { decision: 'approve' });
  account = await h.account('anna');
  assert.equal(account.carryoverExpiringDays, 2);
  assert.equal(account.restDays, 32);

  // Stichtag selbst: Der Übertrag gilt noch.
  h.clock.date = '2026-03-31';
  account = await h.account('anna');
  assert.equal(account.carryoverExpiredDays, 0);
  assert.equal(account.restDays, 32);

  // Einen Tag später sind die zwei unverbrauchten Tage weg. Der Anspruch bleibt unberührt.
  h.clock.date = '2026-04-01';
  account = await h.account('anna');
  assert.equal(account.carryoverExpiredDays, 2);
  assert.equal(account.carryoverExpiringDays, 0);
  assert.equal(account.takenDays, 3);
  assert.equal(account.restDays, 30);
});

test('Übertrag: mehr Urlaub vor dem Stichtag als Übertrag lässt nichts verfallen', async t => {
  const h = await setup(t, { today: '2026-02-02' });
  await h.api('hr', 'PUT', '/api/absence/accounts/5/2026', { reason: 'Korrektur', entitlementDays: 30, carryoverDays: 3 });
  const request = await h.request('anna', '2026-03-09', '2026-03-13');
  await h.api('manager', 'POST', `/api/absence/requests/${request.data.id}/decision`, { decision: 'approve' });
  h.clock.date = '2026-05-01';
  const account = await h.account('anna');
  assert.equal(account.carryoverExpiredDays, 0);
  assert.equal(account.takenDays, 5);
  assert.equal(account.restDays, 28);
});

test('Übertrag: Urlaub nach dem Stichtag kann den Übertrag nicht mehr nutzen', async t => {
  const h = await setup(t, { today: '2026-02-02' });
  await h.api('hr', 'PUT', '/api/absence/accounts/5/2026', { reason: 'Korrektur', entitlementDays: 5, carryoverDays: 5 });

  // Sechs Tage im Mai: Der Rest zeigt zwar 10, aber der Übertrag ist dann schon verfallen.
  const late = await h.request('anna', '2026-05-04', '2026-05-11');
  assert.equal(late.status, 400);
  assert.match(late.data.error, /frei sind noch 5/);

  assert.equal((await h.request('anna', '2026-05-04', '2026-05-08')).status, 201, 'fünf Tage passen in den Anspruch');
  // Vor dem Stichtag passt noch der ganze Übertrag.
  assert.equal((await h.request('anna', '2026-03-09', '2026-03-13')).status, 201);
  const account = await h.account('anna');
  assert.equal(account.restDays, 0);
  assert.equal((await h.request('anna', '2026-03-16', '2026-03-16')).status, 400);
});

test('Übertrag: Ein abgewiesener oder stornierter Antrag gibt den Übertrag vor dem Stichtag wieder frei', async t => {
  const h = await setup(t, { today: '2026-02-02' });
  await h.api('hr', 'PUT', '/api/absence/accounts/5/2026', { reason: 'Korrektur', entitlementDays: 30, carryoverDays: 2 });
  const request = await h.request('anna', '2026-03-09', '2026-03-10');
  assert.equal((await h.account('anna')).carryoverExpiringDays, 0);
  await h.api('anna', 'POST', `/api/absence/requests/${request.data.id}/cancel`);
  h.clock.date = '2026-04-15';
  const account = await h.account('anna');
  assert.equal(account.carryoverExpiredDays, 2, 'nach Storno ist der Übertrag unverbraucht verfallen');
  assert.equal(account.restDays, 30);
});

test('Übertrag: Ohne Verfallsdatum oder mit Datum im Folgejahr bleibt er bis zum Jahresende nutzbar', async t => {
  const h = await setup(t, { today: '2026-06-01' });
  await h.api('hr', 'PUT', '/api/absence/accounts/5/2026', { reason: 'Korrektur', entitlementDays: 2, carryoverDays: 3, carryoverExpires: null });
  let account = await h.account('anna');
  assert.equal(account.carryoverExpires, null);
  assert.equal(account.carryoverExpiringDays, 0);
  assert.equal(account.restDays, 5);
  assert.equal((await h.request('anna', '2026-09-07', '2026-09-11')).status, 201, 'alle fünf Tage passen auch spät im Jahr');
  assert.equal((await h.request('anna', '2026-09-14', '2026-09-14')).status, 400, 'der sechste nicht');
  assert.equal((await h.account('anna', '?year=2027')).carryoverDays, 0);

  await h.api('hr', 'PUT', '/api/absence/accounts/6/2026', { reason: 'Korrektur', entitlementDays: 2, carryoverDays: 3, carryoverExpires: '2027-06-30' });
  assert.equal((await h.request('ben', '2026-09-07', '2026-09-11')).status, 201);
  assert.equal((await h.request('ben', '2026-09-14', '2026-09-14')).status, 400);

  // Unverbrauchter Rest ohne Verfall läuft ins nächste Jahr.
  await h.api('hr', 'PUT', '/api/absence/accounts/7/2026', { reason: 'Korrektur', entitlementDays: 2, carryoverDays: 3, carryoverExpires: null });
  account = await h.account('clara', '?year=2027');
  assert.equal(account.carryoverDays, 5);
});

test('Übertrag: Der Rest des Vorjahres kommt automatisch, HR kann ihn ersetzen oder abschalten', async t => {
  const h = await setup(t, { today: '2026-06-01' });
  await h.api('hr', 'PUT', '/api/absence/accounts/5/2026', { reason: 'Korrektur', entitlementDays: 10, carryoverDays: 0 });
  const summer = await h.request('anna', '2026-07-06', '2026-07-08');
  await h.api('manager', 'POST', `/api/absence/requests/${summer.data.id}/decision`, { decision: 'approve' });

  let next = await h.account('anna', '?year=2027');
  assert.equal(next.carryoverDays, 7, '10 minus 3');
  assert.equal(next.carryoverAutomatic, true);
  assert.equal(next.carryoverExpires, '2027-03-31');
  assert.equal(next.restDays, 37);

  // Weitere Buchung im alten Jahr ändert den Übertrag von selbst.
  const autumn = await h.request('anna', '2026-10-05', '2026-10-06');
  await h.api('manager', 'POST', `/api/absence/requests/${autumn.data.id}/decision`, { decision: 'approve' });
  next = await h.account('anna', '?year=2027');
  assert.equal(next.carryoverDays, 5);

  // Nimmt das alte Jahr zu viel, wird der Übertrag null statt negativ.
  await h.api('hr', 'PUT', '/api/absence/accounts/5/2026', { reason: 'Korrektur', entitlementDays: 1 });
  next = await h.account('anna', '?year=2027');
  assert.equal(next.carryoverDays, 0);
  await h.api('hr', 'PUT', '/api/absence/accounts/5/2026', { reason: 'Korrektur', entitlementDays: 10 });

  // HR setzt einen festen Wert und später wieder Automatik.
  await h.api('hr', 'PUT', '/api/absence/accounts/5/2027', { reason: 'Korrektur', carryoverDays: 1.5 });
  next = await h.account('anna', '?year=2027');
  assert.equal(next.carryoverDays, 1.5);
  assert.equal(next.carryoverAutomatic, false);
  await h.api('hr', 'PUT', '/api/absence/accounts/5/2027', { reason: 'Korrektur', carryoverDays: null });
  next = await h.account('anna', '?year=2027');
  assert.equal(next.carryoverDays, 5);

  await h.api('hr', 'PUT', '/api/absence/settings', { autoCarryover: false });
  next = await h.account('anna', '?year=2027');
  assert.equal(next.carryoverDays, 0);
});

test('Übertrag: Eine Buchung darf ein Folgejahr nicht überziehen, das auf den Rest gebaut hat', async t => {
  const h = await setup(t, { today: '2026-11-02' });
  await h.api('hr', 'PUT', '/api/absence/accounts/5/2026', { reason: 'Korrektur', entitlementDays: 5, carryoverDays: 0 });
  await h.api('hr', 'PUT', '/api/absence/accounts/5/2027', { reason: 'Korrektur', entitlementDays: 5 });
  // Fünf Resttage aus 2026 werden im Januar 2027 mit eingeplant.
  assert.equal((await h.request('anna', '2027-01-11', '2027-01-22')).status, 201);
  const blocked = await h.request('anna', '2026-11-09', '2026-11-09');
  assert.equal(blocked.status, 400);
  assert.match(blocked.data.error, /Urlaub für 2027 überziehen/);
});

test('Konten und fehlende Jahre dazwischen werden lückenlos angelegt', async t => {
  const h = await setup(t, { today: '2026-06-01' });
  await h.account('anna', '?year=2024');
  await h.account('anna', '?year=2028');
  const years = h.db.prepare('SELECT year FROM absence_accounts WHERE user_id = 5 ORDER BY year').all().map(row => row.year);
  assert.deepEqual(years, [2024, 2025, 2026, 2027, 2028]);

  await h.account('ben', '?year=2028');
  const benYears = h.db.prepare('SELECT year FROM absence_accounts WHERE user_id = 6 ORDER BY year').all().map(row => row.year);
  assert.deepEqual(benYears, [2026, 2027, 2028], 'Planung ab dem laufenden Jahr');
});

// ------------------------------------------------------------------ Genehmigung

test('Hauptablauf: Antrag, Aufgabe an die Führungskraft, Genehmigung, Aufgabe an die Person', async t => {
  const h = await setup(t);
  const created = await h.request('anna', '2026-03-09', '2026-03-13', { comment: 'Skiurlaub' });
  assert.equal(created.status, 201);
  assert.equal(created.data.warning, undefined);
  const id = created.data.id;

  const approvalTasks = h.tasksOf(4, 'absence_approval');
  assert.equal(approvalTasks.length, 1);
  assert.equal(approvalTasks[0].entity_id, id);
  assert.match(approvalTasks[0].title, /Anna Ahrens.*Urlaub.*09\.03\.2026 bis 13\.03\.2026/);
  assert.equal(h.tasksOf(1, 'absence_approval').length, 0, 'HR bekommt die Aufgabe nicht, wenn es eine Führungskraft gibt');

  const inbox = await h.api('manager', 'GET', '/api/absence/approvals');
  assert.equal(inbox.data.requests.length, 1);
  assert.equal(inbox.data.requests[0].comment, 'Skiurlaub');
  assert.equal(inbox.data.requests[0].canDecide, true);
  assert.equal(inbox.data.requests[0].restDays, 25);

  const decision = await h.api('manager', 'POST', `/api/absence/requests/${id}/decision`, { decision: 'approve', comment: 'Viel Spaß' });
  assert.equal(decision.status, 200);
  assert.equal(decision.data.status, 'approved');

  assert.equal(h.tasksOf(4, 'absence_approval').length, 0, 'Prüfaufgabe ist erledigt');
  const decided = h.tasksOf(5, 'absence_decided');
  assert.equal(decided.length, 1);
  assert.match(decided[0].title, /genehmigt/);

  const stored = await h.api('anna', 'GET', `/api/absence/requests/${id}`);
  assert.equal(stored.data.request.status, 'approved');
  assert.equal(stored.data.request.decisionComment, 'Viel Spaß');
  assert.equal(stored.data.request.decidedByName, 'Malte Manager');
  assert.equal((await h.api('manager', 'GET', '/api/absence/approvals')).data.requests.length, 0);
});

test('nur die direkte Führungskraft oder HR darf entscheiden', async t => {
  const h = await setup(t);
  const id = (await h.request('anna', '2026-03-09', '2026-03-13')).data.id;
  const decide = person => h.api(person, 'POST', `/api/absence/requests/${id}/decision`, { decision: 'approve' });

  assert.equal((await decide('ben')).status, 403, 'Kollege');
  assert.equal((await decide('clara')).status, 403, 'anderes Team');
  assert.equal((await decide('director')).status, 403, 'Führungskraft der Führungskraft');
  assert.equal(h.db.prepare('SELECT status FROM absence_requests WHERE id = ?').get(id).status, 'pending');

  assert.equal((await h.api('director', 'GET', '/api/absence/approvals')).data.requests.length, 0);
  assert.equal((await h.api('ben', 'GET', '/api/absence/approvals')).data.requests.length, 0);
  assert.equal((await h.api('bp', 'GET', '/api/absence/approvals')).data.requests.length, 1, 'HR darf eingreifen');

  assert.equal((await h.api('manager', 'POST', '/api/absence/requests/9999/decision', { decision: 'approve' })).status, 404);
  assert.equal((await h.api('manager', 'POST', `/api/absence/requests/${id}/decision`, { decision: 'vielleicht' })).status, 400);
  const noReason = await h.api('manager', 'POST', `/api/absence/requests/${id}/decision`, { decision: 'reject' });
  assert.equal(noReason.status, 400, 'Ablehnung braucht eine Begründung');

  const byHr = await h.api('bp', 'POST', `/api/absence/requests/${id}/decision`, { decision: 'reject', comment: 'Personalengpass' });
  assert.equal(byHr.status, 200);
  assert.equal(h.tasksOf(4, 'absence_approval').length, 0, 'Aufgabe der Führungskraft ist auch nach HR-Entscheidung erledigt');
  assert.match(h.tasksOf(5, 'absence_decided')[0].title, /abgelehnt/);

  assert.equal((await decide('manager')).status, 409, 'schon entschieden');
  assert.equal((await h.account('anna')).restDays, 30, 'abgelehnter Antrag belastet das Konto nicht');
});

test('den eigenen Antrag darf niemand selbst entscheiden, auch nicht HR', async t => {
  const h = await setup(t);
  const ownManager = (await h.request('manager', '2026-03-09', '2026-03-13')).data.id;
  assert.equal((await h.api('manager', 'POST', `/api/absence/requests/${ownManager}/decision`, { decision: 'approve' })).status, 403);
  assert.equal(h.tasksOf(3, 'absence_approval').length, 1, 'Aufgabe geht an die Führungskraft der Führungskraft');
  assert.equal((await h.api('manager', 'GET', '/api/absence/approvals')).data.requests.length, 0);
  assert.equal((await h.api('director', 'POST', `/api/absence/requests/${ownManager}/decision`, { decision: 'approve' })).status, 200);

  // Eine HR-Person ohne Führungskraft: Aufgabe nie an sich selbst.
  const ownHr = (await h.request('hr', '2026-03-09', '2026-03-13')).data.id;
  assert.equal(h.tasksOf(1, 'absence_approval').length, 0);
  assert.equal(h.tasksOf(2, 'absence_approval').length, 1, 'mangels zweiter HR-Administration geht es an HR Business Partner');
  assert.equal((await h.api('hr', 'POST', `/api/absence/requests/${ownHr}/decision`, { decision: 'approve' })).status, 403);
  assert.equal((await h.api('hr', 'GET', '/api/absence/approvals')).data.requests.some(request => request.id === ownHr), false);
  assert.equal((await h.api('bp', 'POST', `/api/absence/requests/${ownHr}/decision`, { decision: 'approve' })).status, 200);
});

test('ohne Führungskraft geht die Aufgabe an alle aus der HR-Administration', async t => {
  const h = await setup(t);
  h.db.prepare("INSERT INTO users (id, name, email, password_hash, role) VALUES (20, 'Hilde Zwei', 'hilde@test.local', '!', 'hr_admin')").run();
  const id = (await h.request('director', '2026-03-09', '2026-03-13')).data.id;
  assert.equal(h.tasksOf(1, 'absence_approval').length, 1);
  assert.equal(h.tasksOf(20, 'absence_approval').length, 1);
  assert.equal(h.tasksOf(2, 'absence_approval').length, 0, 'HR Business Partner nur als Rückfall');
  assert.equal((await h.api('hr', 'POST', `/api/absence/requests/${id}/decision`, { decision: 'approve' })).status, 200);
  assert.equal(h.tasksOf(1, 'absence_approval').length, 0);
  assert.equal(h.tasksOf(20, 'absence_approval').length, 0, 'alle Aufgaben sind erledigt');
});

test('eine gesperrte Führungskraft bekommt keine Aufgabe mehr, HR springt ein', async t => {
  const h = await setup(t);
  h.deps.setUserActive(4, false, { id: 1 });
  const id = (await h.request('anna', '2026-03-09', '2026-03-13')).data.id;
  assert.equal(h.tasksOf(4, 'absence_approval').length, 0);
  assert.equal(h.tasksOf(1, 'absence_approval').length, 1);
  assert.equal((await h.api('hr', 'POST', `/api/absence/requests/${id}/decision`, { decision: 'approve' })).status, 200);
});

test('wenn niemand sonst entscheiden kann, erfährt die Person das sofort', async t => {
  const h = await setup(t);
  h.db.prepare("UPDATE users SET active = 0 WHERE id IN (2)").run();
  const created = await h.request('hr', '2026-03-09', '2026-03-13');
  assert.equal(created.status, 201);
  assert.match(created.data.warning, /niemand außer dir/);
});

test('Wartung ordnet offene Prüfaufgaben neu zu, wenn sich die Führung ändert, und ist wiederholbar', async t => {
  const h = await setup(t);
  const id = (await h.request('anna', '2026-03-09', '2026-03-13')).data.id;
  h.db.prepare('UPDATE users SET manager_id = 3 WHERE id = 5').run();
  h.instance.maintenance();
  assert.equal(h.tasksOf(4, 'absence_approval').length, 0);
  assert.equal(h.tasksOf(3, 'absence_approval').length, 1);
  h.instance.maintenance();
  assert.equal(h.tasksOf(3, 'absence_approval').length, 1, 'kein zweites Mal');
  assert.equal((await h.api('manager', 'POST', `/api/absence/requests/${id}/decision`, { decision: 'approve' })).status, 403, 'frühere Führungskraft darf nicht mehr');
  assert.equal((await h.api('director', 'POST', `/api/absence/requests/${id}/decision`, { decision: 'approve' })).status, 200);
  h.instance.maintenance();
  assert.equal(h.tasksOf(3, 'absence_approval').length, 0, 'entschiedene Anträge bekommen keine Aufgabe mehr');
});

// ------------------------------------------------------------------ Stornieren

test('Stornieren: offener Antrag sofort, Aufgabe verschwindet, Konto stimmt wieder', async t => {
  const h = await setup(t);
  const id = (await h.request('anna', '2026-03-09', '2026-03-13')).data.id;
  assert.equal((await h.account('anna')).restDays, 25);
  assert.equal((await h.api('ben', 'POST', `/api/absence/requests/${id}/cancel`)).status, 403);
  assert.equal((await h.api('manager', 'POST', `/api/absence/requests/${id}/cancel`)).status, 403, 'auch die Führungskraft nicht');
  assert.equal((await h.api('anna', 'POST', '/api/absence/requests/9999/cancel')).status, 404);

  assert.equal((await h.api('anna', 'POST', `/api/absence/requests/${id}/cancel`)).status, 200);
  assert.equal(h.tasksOf(4, 'absence_approval').length, 0);
  assert.equal(h.tasksOf(4, 'absence_info').length, 0, 'bei offenem Antrag keine Extra-Information');
  assert.equal((await h.account('anna')).restDays, 30);
  assert.equal((await h.api('anna', 'POST', `/api/absence/requests/${id}/cancel`)).status, 409, 'schon storniert');
  assert.equal((await h.api('manager', 'POST', `/api/absence/requests/${id}/decision`, { decision: 'approve' })).status, 409);
});

test('Stornieren: genehmigt und nicht begonnen geht, Führungskraft wird informiert, Konto stimmt wieder', async t => {
  const h = await setup(t);
  const id = (await h.request('anna', '2026-03-09', '2026-03-13')).data.id;
  await h.api('manager', 'POST', `/api/absence/requests/${id}/decision`, { decision: 'approve' });
  assert.equal((await h.account('anna')).restDays, 25);

  const listed = await h.api('anna', 'GET', `/api/absence/requests/${id}`);
  assert.equal(listed.data.request.canCancel, true);

  assert.equal((await h.api('anna', 'POST', `/api/absence/requests/${id}/cancel`)).status, 200);
  const info = h.tasksOf(4, 'absence_info');
  assert.equal(info.length, 1);
  assert.match(info[0].title, /Anna Ahrens/);
  assert.equal(h.tasksOf(5, 'absence_decided').length, 0, 'alte Entscheidungsaufgabe ist hinfällig');
  const account = await h.account('anna');
  assert.equal(account.restDays, 30);
  assert.equal(account.plannedDays, 0);
});

test('Stornieren: begonnene Abwesenheit nur durch HR', async t => {
  const h = await setup(t);
  const id = (await h.request('anna', '2026-03-09', '2026-03-13')).data.id;
  await h.api('manager', 'POST', `/api/absence/requests/${id}/decision`, { decision: 'approve' });

  h.clock.date = '2026-03-09';
  const listed = await h.api('anna', 'GET', `/api/absence/requests/${id}`);
  assert.equal(listed.data.request.canCancel, false);
  const denied = await h.api('anna', 'POST', `/api/absence/requests/${id}/cancel`);
  assert.equal(denied.status, 403, 'am ersten Tag gilt sie als begonnen');
  assert.match(denied.data.error, /nur HR/);

  assert.equal((await h.api('bp', 'POST', `/api/absence/requests/${id}/cancel`, { reason: 'Falsch erfasst' })).status, 200);
  assert.equal(h.tasksOf(4, 'absence_info').length, 1, 'Führungskraft wird informiert');
  assert.equal(h.tasksOf(5, 'absence_info').length, 1, 'die Person auch');
  assert.equal((await h.account('anna')).restDays, 30);
});

test('Stornieren: Eine offene, schon begonnene Abwesenheit darf die Person selbst stornieren', async t => {
  const h = await setup(t);
  const id = (await h.request('anna', '2026-03-09', '2026-03-13')).data.id;
  h.clock.date = '2026-03-11';
  assert.equal((await h.api('anna', 'POST', `/api/absence/requests/${id}/cancel`)).status, 200);
});

// ------------------------------------------------------------------ Krankheit

test('Krankheit: Meldung ohne Genehmigung, nur durch die Person oder HR, und ohne Freitext', async t => {
  const h = await setup(t);
  const sick = h.typeId('sick');
  const body = { typeId: sick, startDate: '2026-03-09', endDate: '2026-03-10', comment: 'Grippe', diagnosis: 'J11', reason: 'Fieber' };

  assert.equal((await h.api('manager', 'POST', '/api/absence/requests', { ...body, userId: 5 })).status, 403, 'Führungskraft darf nicht');
  assert.equal((await h.api('ben', 'POST', '/api/absence/requests', { ...body, userId: 5 })).status, 403, 'Kollege darf nicht');

  const own = await h.api('anna', 'POST', '/api/absence/requests', body);
  assert.equal(own.status, 201);
  assert.equal(own.data.status, 'approved', 'keine Genehmigung nötig');
  assert.equal(h.tasksOf(4, 'absence_approval').length, 0);

  const row = h.db.prepare('SELECT * FROM absence_requests WHERE id = ?').get(own.data.id);
  assert.equal(row.comment, null, 'der Freitext wird gar nicht erst gespeichert');
  assert.equal(JSON.stringify(row).includes('Grippe'), false);
  assert.equal(JSON.stringify(row).includes('Fieber'), false);
  const columns = h.db.prepare('PRAGMA table_info(absence_requests)').all().map(column => column.name);
  assert.equal(columns.some(name => /diagnos/i.test(name)), false, 'es gibt kein Feld für Diagnosen');

  const byHr = await h.api('hr', 'POST', '/api/absence/requests', { ...body, userId: 6 });
  assert.equal(byHr.status, 201);
  assert.equal(h.tasksOf(6, 'absence_info').length, 1, 'die Person erfährt von dem Eintrag');
  assert.equal(h.tasksOf(1, 'absence_info').length, 0, 'wer eingetragen hat, braucht keine Nachricht');
});

test('Krankheit: Führungskraft und Führungslinie sehen nur abwesend, in Listen, Einzelansicht und Kalender', async t => {
  const h = await setup(t);
  const sickId = (await h.api('anna', 'POST', '/api/absence/requests', { typeId: h.typeId('sick'), startDate: '2026-03-09', endDate: '2026-03-10', comment: 'Grippe' })).data.id;
  const vacationId = (await h.request('anna', '2026-03-16', '2026-03-17', { comment: 'Besuch' })).data.id;
  await h.api('manager', 'POST', `/api/absence/requests/${vacationId}/decision`, { decision: 'approve' });

  const secrets = /krank|sick|grippe|typeId|typeName|comment|confidential/i;

  for (const viewer of ['manager', 'director']) {
    const list = await h.api(viewer, 'GET', '/api/absence/requests?userId=5');
    assert.equal(list.status, 200);
    const limited = list.data.requests.find(request => request.startDate === '2026-03-09');
    assert.deepEqual(Object.keys(limited).sort(), ['days', 'endDate', 'endHalf', 'label', 'startDate', 'startHalf', 'userId', 'userName']);
    assert.equal(limited.label, 'abwesend');
    assert.doesNotMatch(JSON.stringify(limited), secrets, viewer);
    const vacation = list.data.requests.find(request => request.startDate === '2026-03-16');
    if (viewer === 'manager') assert.equal(vacation.typeName, 'Urlaub', 'wer genehmigt hat, kennt die Art');
    else assert.equal(vacation.label, 'abwesend', 'für alle anderen heißt jede Abwesenheit gleich');

    const single = await h.api(viewer, 'GET', `/api/absence/requests/${sickId}`);
    assert.equal(single.status, 200);
    assert.doesNotMatch(JSON.stringify(single.data), secrets, viewer);

    const calendar = await h.api(viewer, 'GET', '/api/absence/calendar?month=2026-03');
    const entry = calendar.data.entries.find(item => item.userId === 5 && item.startDate === '2026-03-09');
    assert.equal(entry.label, 'abwesend');
    assert.deepEqual(Object.keys(entry).sort(), ['endDate', 'endHalf', 'label', 'startDate', 'startHalf', 'userId']);
    const inCalendar = calendar.data.entries.find(item => item.userId === 5 && item.startDate === '2026-03-16');
    assert.equal(inCalendar.typeName, viewer === 'manager' ? 'Urlaub' : undefined);
  }

  // Team: nur im Kalender, immer nur "abwesend".
  const team = await h.api('ben', 'GET', '/api/absence/calendar?month=2026-03');
  const teamEntries = team.data.entries.filter(item => item.userId === 5);
  assert.equal(teamEntries.length, 2);
  for (const entry of teamEntries) {
    assert.equal(entry.label, 'abwesend');
    assert.equal(entry.typeName, undefined);
    assert.equal(entry.status, undefined);
  }
  assert.doesNotMatch(JSON.stringify(team.data), secrets);
  assert.equal((await h.api('ben', 'GET', '/api/absence/requests?userId=5')).status, 403);
  assert.equal((await h.api('ben', 'GET', `/api/absence/requests/${sickId}`)).status, 403);
  assert.equal((await h.api('clara', 'GET', `/api/absence/requests/${sickId}`)).status, 403);

  // Außerhalb des Teams: gar nichts.
  const other = await h.api('clara', 'GET', '/api/absence/calendar?month=2026-03');
  assert.equal(other.data.entries.some(item => item.userId === 5), false);

  // Die Person selbst und HR sehen die Art.
  const own = await h.api('anna', 'GET', `/api/absence/requests/${sickId}`);
  assert.equal(own.data.request.typeName, 'Krankheit');
  const hr = await h.api('hr', 'GET', '/api/absence/calendar?month=2026-03');
  assert.equal(hr.data.entries.find(item => item.userId === 5 && item.startDate === '2026-03-09').typeName, 'Krankheit');
  const ownCalendar = await h.api('anna', 'GET', '/api/absence/calendar?month=2026-03');
  assert.equal(ownCalendar.data.entries.find(item => item.startDate === '2026-03-09').typeName, 'Krankheit');
  const hrAll = await h.api('bp', 'GET', '/api/absence/requests?scope=all');
  assert.equal(hrAll.data.requests.find(request => request.id === sickId).typeName, 'Krankheit');
});

test('Krankheit: Aufgaben und Protokoll nennen weder Art noch Grund', async t => {
  const h = await setup(t);
  const sick = h.typeId('sick');
  const id = (await h.api('anna', 'POST', '/api/absence/requests', { typeId: sick, startDate: '2026-03-09', endDate: '2026-03-10', comment: 'Grippe' })).data.id;
  await h.api('anna', 'POST', `/api/absence/requests/${id}/cancel`);
  const byHr = (await h.api('hr', 'POST', '/api/absence/requests', { typeId: sick, userId: 5, startDate: '2026-03-16', endDate: '2026-03-16' })).data.id;
  h.clock.date = '2026-03-20';
  await h.api('hr', 'POST', `/api/absence/requests/${byHr}/cancel`);

  const logs = h.db.prepare("SELECT action, entity, old_values, new_values FROM audit_log WHERE entity = 'absence_requests'").all();
  assert.ok(logs.length >= 4);
  const logText = JSON.stringify(logs);
  assert.doesNotMatch(logText, /krank|sick|grippe|typeId|type_id|typeName|confidential/i);

  const tasks = h.db.prepare("SELECT title FROM tasks WHERE type LIKE 'absence_%'").all();
  assert.ok(tasks.length >= 2, 'die Führungskraft wird benachrichtigt');
  assert.doesNotMatch(JSON.stringify(tasks), /krank|grippe/i);
});

test('Krankheit: Eine stornierte Meldung verschwindet für Führungskraft und Team ganz', async t => {
  const h = await setup(t);
  const id = (await h.api('anna', 'POST', '/api/absence/requests', { typeId: h.typeId('sick'), startDate: '2026-03-09', endDate: '2026-03-10' })).data.id;
  await h.api('anna', 'POST', `/api/absence/requests/${id}/cancel`);

  assert.equal((await h.api('manager', 'GET', `/api/absence/requests/${id}`)).status, 403);
  assert.equal((await h.api('manager', 'GET', '/api/absence/requests?userId=5')).data.requests.length, 0);
  assert.equal((await h.api('manager', 'GET', '/api/absence/calendar?month=2026-03')).data.entries.length, 0);
  assert.equal((await h.api('ben', 'GET', '/api/absence/calendar?month=2026-03')).data.entries.length, 0);
});

test('Eine eigene vertrauliche Art mit Genehmigung entscheidet nur HR, nie die Führungskraft', async t => {
  const h = await setup(t);
  const type = (await h.api('hr', 'POST', '/api/absence/types', { name: 'Kur', confidential: true, requiresApproval: true })).data.type;
  const id = (await h.api('anna', 'POST', '/api/absence/requests', { typeId: type.id, startDate: '2026-03-09', endDate: '2026-03-13', comment: 'privat' })).data.id;

  assert.equal(h.tasksOf(4, 'absence_approval').length, 0, 'Führungskraft bekommt keine Aufgabe');
  assert.equal(h.tasksOf(1, 'absence_approval').length, 1);
  assert.doesNotMatch(h.tasksOf(1, 'absence_approval')[0].title, /Kur/);
  assert.equal((await h.api('manager', 'GET', '/api/absence/approvals')).data.requests.length, 0);
  assert.equal((await h.api('manager', 'POST', `/api/absence/requests/${id}/decision`, { decision: 'approve' })).status, 403);
  assert.equal((await h.api('manager', 'GET', `/api/absence/requests/${id}`)).status, 403, 'offen: Führungskraft sieht nichts');
  assert.equal((await h.api('manager', 'GET', '/api/absence/calendar?month=2026-03')).data.entries.length, 0);

  assert.equal((await h.api('hr', 'POST', `/api/absence/requests/${id}/decision`, { decision: 'approve' })).status, 200);
  assert.doesNotMatch(h.tasksOf(5, 'absence_decided')[0].title, /Kur/);
  const seen = await h.api('manager', 'GET', '/api/absence/calendar?month=2026-03');
  assert.equal(seen.data.entries[0].label, 'abwesend');
  assert.equal(seen.data.entries[0].typeName, undefined);
});

// ------------------------------------------------------------------ Kalender

test('Teamkalender: Beschäftigte sehen ihr Team nur als abwesend und keine offenen fremden Anträge', async t => {
  const h = await setup(t);
  await h.api('hr', 'POST', '/api/absence/holidays', { date: '2026-03-20', name: 'Betriebsfeier' });

  const approved = (await h.request('ben', '2026-03-09', '2026-03-10', { comment: 'Geheim' })).data.id;
  await h.api('manager', 'POST', `/api/absence/requests/${approved}/decision`, { decision: 'approve' });
  await h.request('ben', '2026-03-16', '2026-03-17');
  const managerAway = (await h.request('manager', '2026-03-11', '2026-03-12')).data.id;
  await h.api('director', 'POST', `/api/absence/requests/${managerAway}/decision`, { decision: 'approve' });
  const claraAway = (await h.request('clara', '2026-03-11', '2026-03-12')).data.id;
  await h.api('director', 'POST', `/api/absence/requests/${claraAway}/decision`, { decision: 'approve' });
  await h.request('anna', '2026-03-23', '2026-03-24');

  const anna = await h.api('anna', 'GET', '/api/absence/calendar?month=2026-03');
  assert.equal(anna.status, 200);
  assert.deepEqual(anna.data.people.map(person => person.name).sort(), ['Anna Ahrens', 'Ben Berg', 'Malte Manager']);
  assert.deepEqual(anna.data.holidays, [{ date: '2026-03-20', name: 'Betriebsfeier' }]);
  assert.equal(anna.data.firstDay, '2026-03-01');
  assert.equal(anna.data.lastDay, '2026-03-31');

  const others = anna.data.entries.filter(entry => entry.userId !== 5);
  assert.deepEqual(others.map(entry => [entry.userId, entry.startDate]).sort(), [[4, '2026-03-11'], [6, '2026-03-09']], 'ohne offenen Antrag von Ben, ohne Clara');
  for (const entry of others) {
    assert.equal(entry.label, 'abwesend');
    assert.equal(entry.typeName, undefined);
  }
  assert.doesNotMatch(JSON.stringify(anna.data), /Geheim/);
  const own = anna.data.entries.find(entry => entry.userId === 5);
  assert.equal(own.typeName, 'Urlaub', 'eigene Einträge mit Art, auch offene');
  assert.equal(own.status, 'pending');

  // Führungskraft: Unterstellte mit Art und auch offene Anträge.
  const manager = await h.api('manager', 'GET', '/api/absence/calendar?month=2026-03');
  const benEntries = manager.data.entries.filter(entry => entry.userId === 6);
  assert.equal(benEntries.length, 2);
  assert.ok(benEntries.every(entry => entry.typeName === 'Urlaub'));
  assert.ok(benEntries.some(entry => entry.status === 'pending'));

  // Bereichsleitung sieht die Linie darunter, aber nicht mehr.
  const director = await h.api('director', 'GET', '/api/absence/calendar?month=2026-03');
  assert.deepEqual(director.data.people.map(person => person.id).sort(), [3, 4, 5, 6, 7]);

  // Personen ohne Führungskraft bilden kein gemeinsames Team.
  const hrAlone = await h.api('director', 'GET', '/api/absence/calendar?month=2026-03');
  assert.equal(hrAlone.data.people.some(person => person.id === 1 || person.id === 2), false);

  const hr = await h.api('hr', 'GET', '/api/absence/calendar?month=2026-03');
  assert.equal(hr.data.people.length, 7);
  assert.equal(hr.data.entries.length, 5, 'HR sieht alles');
  const partner = await h.api('bp', 'GET', '/api/absence/calendar?month=2026-03');
  assert.equal(partner.data.people.some(person => person.id === 1), false, 'die HR-Leitung bleibt für den HR Business Partner außen vor');
  assert.equal(partner.data.entries.length, 5);

  assert.equal((await h.api('anna', 'GET', '/api/absence/calendar?month=2026-13')).status, 400);
  assert.equal((await h.api('anna', 'GET', '/api/absence/calendar?month=abc')).status, 400);
  assert.equal((await h.api('anna', 'GET', '/api/absence/calendar')).data.month, '2026-03', 'ohne Angabe der laufende Monat');
  assert.equal((await h.api('anna', 'GET', '/api/absence/calendar?month=2026-05')).data.entries.length, 0);
});

test('Gesperrte Personen erscheinen nicht im Kalender', async t => {
  const h = await setup(t);
  const id = (await h.request('ben', '2026-03-09', '2026-03-10')).data.id;
  await h.api('manager', 'POST', `/api/absence/requests/${id}/decision`, { decision: 'approve' });
  h.deps.setUserActive(6, false, { id: 1 });
  const anna = await h.api('anna', 'GET', '/api/absence/calendar?month=2026-03');
  assert.equal(anna.data.people.some(person => person.id === 6), false);
  assert.equal(anna.data.entries.length, 0);
});

// ------------------------------------------------------------------ Listen und fremde Daten

test('Listen: Fremde IDs liefern nichts, und Filter sind geprüft', async t => {
  const h = await setup(t);
  const id = (await h.request('ben', '2026-03-09', '2026-03-10', { comment: 'Geheim' })).data.id;

  const asAnna = await h.api('anna', 'GET', '/api/absence/requests?userId=6');
  assert.equal(asAnna.status, 403);
  assert.equal(JSON.stringify(asAnna.data).includes('Geheim'), false);
  assert.equal((await h.api('anna', 'GET', `/api/absence/requests/${id}`)).status, 403);
  assert.equal((await h.api('anna', 'GET', '/api/absence/requests/9999')).status, 404);
  assert.equal((await h.api('anna', 'GET', '/api/absence/requests/abc')).status, 404);
  assert.equal((await h.api('anna', 'GET', '/api/absence/requests?scope=all')).status, 403);
  assert.equal((await h.api('manager', 'GET', '/api/absence/requests?scope=all')).status, 403);
  assert.equal((await h.api('anna', 'GET', '/api/absence/requests?status=frei')).status, 400);
  assert.equal((await h.api('anna', 'GET', '/api/absence/requests?year=abc')).status, 400);
  assert.equal((await h.api('anna', 'GET', '/api/absence/requests?userId=abc')).status, 400);
  assert.equal((await h.api('anna', 'GET', '/api/absence/requests')).data.requests.length, 0, 'ohne Angabe nur die eigenen');

  const asManager = await h.api('manager', 'GET', '/api/absence/requests?userId=6&status=pending&year=2026');
  assert.equal(asManager.data.requests.length, 1);
  assert.equal(asManager.data.requests[0].comment, 'Geheim');
  assert.equal(asManager.data.requests[0].canDecide, true);
  assert.equal(asManager.data.requests[0].canCancel, false);
  const directorView = await h.api('director', 'GET', '/api/absence/requests?userId=6');
  assert.deepEqual(directorView.data.requests, [], 'indirekt: offene Anträge gehen nur die an, die entscheiden');
  assert.equal((await h.api('manager', 'GET', '/api/absence/requests?userId=6&status=approved')).data.requests.length, 0);
  assert.equal((await h.api('hr', 'GET', '/api/absence/requests?scope=all&year=2027')).data.requests.length, 0);
});

// ------------------------------------------------------------------ Export

test('Export: nur HR, Semikolon, mit BOM, nur genehmigte Tage des Monats und Schutz vor Formeln', async t => {
  const h = await setup(t);
  await h.api('hr', 'POST', '/api/absence/holidays/import', { year: 2026, state: 'NW' });
  h.db.prepare("UPDATE users SET name = '=HYPERLINK(\"http://böse.example\")' WHERE id = 5").run();
  h.db.prepare("UPDATE users SET name = '@Ben; Berg' WHERE id = 6").run();
  const evilType = (await h.api('hr', 'POST', '/api/absence/types', { name: '+Fortbildung' })).data.type;

  // Über den Monatswechsel: 30.03. bis 01.04. mit Ostern danach.
  const spanning = (await h.request('anna', '2026-03-30', '2026-04-01', { startHalf: true })).data.id;
  await h.api('manager', 'POST', `/api/absence/requests/${spanning}/decision`, { decision: 'approve' });
  const evil = (await h.request('ben', '2026-03-16', '2026-03-17', { typeId: evilType.id })).data.id;
  await h.api('manager', 'POST', `/api/absence/requests/${evil}/decision`, { decision: 'approve' });
  await h.api('clara', 'POST', '/api/absence/requests', { typeId: h.typeId('sick'), startDate: '2026-03-11', endDate: '2026-03-11', comment: 'Grippe' });
  await h.request('manager', '2026-03-23', '2026-03-24');
  const onlyWeekendInMonth = (await h.request('director', '2026-02-27', '2026-03-01')).data.id;
  await h.api('hr', 'POST', `/api/absence/requests/${onlyWeekendInMonth}/decision`, { decision: 'approve' });

  for (const person of ['anna', 'manager', 'director']) {
    assert.equal((await h.api(person, 'GET', '/api/absence/export?month=2026-03')).status, 403, person);
  }
  assert.equal((await h.api('hr', 'GET', '/api/absence/export')).status, 400);
  assert.equal((await h.api('hr', 'GET', '/api/absence/export?month=2026-3')).status, 400);
  assert.equal((await h.api('hr', 'GET', '/api/absence/export?month=../../x')).status, 400);

  const response = await h.api('hr', 'GET', '/api/absence/export?month=2026-03');
  assert.equal(response.status, 200);
  const lines = response.data.trim().split('\r\n');
  assert.equal(lines[0], 'Name;Personalnummer;E-Mail;Art;Von;Bis;Arbeitstage im Monat');
  assert.equal(lines.length, 4, 'Kopf plus drei genehmigte Einträge; offene und reine Wochenenden fehlen');

  assert.ok(lines.includes(`"'=HYPERLINK(""http://böse.example"")";;anna@test.local;Urlaub;30.03.2026;31.03.2026;1,5`), lines.join('\n'));
  assert.ok(lines.includes(`"'@Ben; Berg";;ben@test.local;'+Fortbildung;16.03.2026;17.03.2026;2`), lines.join('\n'));
  assert.ok(lines.includes('Clara Cordes;;clara@test.local;Krankheit;11.03.2026;11.03.2026;1'), 'HR sieht die Art für die Lohnabrechnung');
  assert.equal(response.data.includes('Grippe'), false, 'kein Freitext im Export');

  const april = await h.api('hr', 'GET', '/api/absence/export?month=2026-04');
  assert.ok(april.data.includes('01.04.2026;01.04.2026;1'), 'der Rest des Antrags landet im April');

  const logged = h.db.prepare("SELECT new_values FROM audit_log WHERE action = 'absence_exported'").all();
  assert.equal(logged.length, 2);
});

test('Export: Die Antwort ist UTF-8 mit BOM und wird als Datei angeboten', async t => {
  const h = await setup(t);
  const app = express();
  app.use('/api', h.instance.router);
  const server = await new Promise(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/absence/export?month=2026-03`, { headers: { 'x-test-user': '1' } });
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(response.status, 200);
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.match(response.headers.get('content-type'), /text\/csv.*utf-8/i);
  assert.match(response.headers.get('content-disposition'), /attachment; filename="abwesenheiten-2026-03\.csv"/);
});

// ------------------------------------------------------------------ Unsinnige Eingaben

test('Unsinnige Eingaben führen nie zu einem Serverfehler und schreiben nichts Falsches', async t => {
  const h = await setup(t);
  const id = (await h.request('anna', '2026-03-09', '2026-03-10')).data.id;
  const garbage = [[], {}, ['a'], ['2026-03-09'], { a: 1 }, true, false, null, -1, 1.5, 0, '', '   ', 'x'.repeat(5000), '<script>', '2026-13-45', '1e9'];
  const forms = [
    ['POST', '/api/absence/types', ['name', 'countsAgainstBalance', 'requiresApproval', 'confidential']],
    ['PATCH', '/api/absence/types/1', ['name', 'countsAgainstBalance', 'requiresApproval', 'confidential', 'active']],
    ['PUT', '/api/absence/settings', ['defaultEntitlementDays', 'carryoverExpiryDay', 'state', 'autoCarryover']],
    ['PUT', '/api/absence/accounts/5/2026', ['entitlementDays', 'carryoverDays', 'carryoverExpires', 'reason']],
    ['POST', '/api/absence/holidays/import', ['year', 'state']],
    ['POST', '/api/absence/holidays', ['date', 'name']],
    ['POST', '/api/absence/requests', ['typeId', 'startDate', 'endDate', 'startHalf', 'endHalf', 'halfDayPart', 'comment', 'userId']],
    ['POST', `/api/absence/requests/${id}/decision`, ['decision', 'comment']]
  ];
  for (const [method, url, fields] of forms) {
    for (const field of fields) {
      for (const value of garbage) {
        const response = await h.api('hr', method, url, { [field]: value });
        assert.ok(response.status < 500, `${method} ${url} ${field}=${JSON.stringify(value)?.slice(0, 40)}: ${response.status} ${JSON.stringify(response.data)?.slice(0, 200)}`);
      }
    }
    assert.ok((await h.api('hr', method, url, ['liste'])).status < 500, `${url} mit Liste als Inhalt`);
  }
  for (const url of [
    '/api/absence/account?year=1&year=2',
    '/api/absence/account?userId=1&userId=2',
    '/api/absence/requests?status=a&status=b',
    '/api/absence/requests?year=x&userId=y',
    '/api/absence/holidays?year=x&year=y',
    '/api/absence/calendar?month=a&month=b',
    '/api/absence/export?month=a&month=b',
    '/api/absence/requests/%00',
    '/api/absence/types?all=1&all=2'
  ]) {
    const response = await h.api('hr', 'GET', url);
    assert.ok(response.status < 500, `${url}: ${response.status}`);
  }

  // Die Einstellungen sind danach noch brauchbar: Anspruch ist eine Zahl, Bundesland gültig oder leer.
  const { settings } = (await h.api('hr', 'GET', '/api/absence/settings')).data;
  assert.equal(typeof settings.defaultEntitlementDays, 'number');
  assert.ok(settings.state === null || Object.hasOwn(GERMAN_STATES, settings.state));
  assert.equal(typeof (await h.account('clara')).restDays, 'number');
});

// ------------------------------------------------------------------ Aufgaben, Systemkonto, Demo, Hilfe

test('Hinweisaufgaben bestätigt nur die eigene Person, Prüfaufgaben gar nicht', async t => {
  const h = await setup(t);
  const id = (await h.request('anna', '2026-03-09', '2026-03-10')).data.id;
  const approval = h.tasksOf(4, 'absence_approval')[0];
  assert.equal((await h.api('manager', 'POST', `/api/absence/tasks/${approval.id}/done`)).status, 404, 'Prüfaufgabe endet nur mit der Entscheidung');
  await h.api('manager', 'POST', `/api/absence/requests/${id}/decision`, { decision: 'approve' });
  const decided = h.tasksOf(5, 'absence_decided')[0];
  assert.equal((await h.api('ben', 'POST', `/api/absence/tasks/${decided.id}/done`)).status, 404, 'fremde Aufgabe');
  assert.equal((await h.api('anna', 'POST', '/api/absence/tasks/abc/done')).status, 404);
  assert.equal((await h.api('anna', 'POST', `/api/absence/tasks/${decided.id}/done`)).status, 200);
  assert.equal(h.tasksOf(5, 'absence_decided').length, 0);
  assert.equal((await h.api('anna', 'POST', `/api/absence/tasks/${decided.id}/done`)).status, 404, 'schon erledigt');
});

test('Die Systemadministration wird wie HR behandelt, hat aber kein eigenes Konto', async t => {
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

  const id = (await harness.request('anna', '2026-03-09', '2026-03-10')).data.id;
  assert.equal((await harness.api(SYSTEM_ID, 'GET', '/api/absence/accounts')).status, 200);
  assert.equal((await harness.api(SYSTEM_ID, 'GET', '/api/absence/accounts')).data.accounts.some(account => account.userId === SYSTEM_ID), false);
  assert.equal((await harness.api(SYSTEM_ID, 'GET', '/api/absence/account')).status, 404, 'technisches Konto hat kein Urlaubskonto');
  assert.equal((await harness.api(SYSTEM_ID, 'POST', '/api/absence/requests', { typeId: harness.typeId('vacation'), startDate: '2026-03-09', endDate: '2026-03-10' })).status, 404);
  assert.equal((await harness.api(SYSTEM_ID, 'GET', '/api/absence/calendar?month=2026-03')).data.people.some(person => person.id === SYSTEM_ID), false);
  assert.equal((await harness.api(SYSTEM_ID, 'POST', `/api/absence/requests/${id}/decision`, { decision: 'approve' })).status, 200);
});

test('Demodaten: wiederholbar, ohne neue Konten, und ohne Personen passiert nichts', async t => {
  const h = await setup(t, { today: '2026-06-10' });
  const usersBefore = h.db.prepare('SELECT COUNT(*) AS count FROM users').get().count;
  h.instance.seedDemo();
  const requests = h.db.prepare('SELECT COUNT(*) AS count FROM absence_requests').get().count;
  assert.equal(requests, 3);
  assert.ok(h.db.prepare('SELECT COUNT(*) AS count FROM absence_holidays').get().count > 0);
  h.instance.seedDemo();
  assert.equal(h.db.prepare('SELECT COUNT(*) AS count FROM absence_requests').get().count, requests);
  assert.equal(h.db.prepare('SELECT COUNT(*) AS count FROM users').get().count, usersBefore);
  assert.equal(h.tasksOf(4, 'absence_approval').length + h.tasksOf(3, 'absence_approval').length, 1);

  const empty = await setup(t, { today: '2026-06-10' });
  empty.db.prepare('UPDATE users SET active = 0').run();
  empty.instance.seedDemo();
  assert.equal(empty.db.prepare('SELECT COUNT(*) AS count FROM absence_requests').get().count, 0);
  assert.equal(empty.db.prepare('SELECT COUNT(*) AS count FROM absence_holidays').get().count, 0);
});

test('Hilfeartikel haben die verlangte Form und nennen keine Fremdmarke', async t => {
  const h = await setup(t);
  assert.ok(h.instance.helpArticles.length >= 3);
  for (const article of h.instance.helpArticles) {
    for (const field of ['id', 'title', 'answer']) assert.equal(typeof article[field], 'string', field);
    for (const field of ['roles', 'views', 'keywords', 'steps', 'actions']) assert.ok(Array.isArray(article[field]), field);
    for (const action of article.actions) assert.match(action.view, /^absence/);
    assert.doesNotMatch(JSON.stringify(article), /workday/i);
  }
});

// ------------------------------------------------------------------ Rollen und Rechte

function addStaff(h, { name = 'Sach Bearbeiter', email = 'sb@test.local', managerId = null } = {}) {
  const { id } = h.deps.createUserAccount({ name, email, role: 'hr_staff', managerId, actor: { id: 1 } });
  h.db.prepare('UPDATE users SET must_change_password = 0 WHERE id = ?').run(id);
  return id;
}

/** Wie ein vollzogener Austritt in der Personalakte: Eintrag in der Historie, Konto gesperrt. */
function recordExit(h, userId, exitDate) {
  const personnel = createPersonnelModule(h.deps);
  personnel.initialize();
  h.db.prepare(`
    INSERT INTO personnel_changes (user_id, kind, old_values, new_values, effective_date, reason, status, created_by, created_at)
    VALUES (?, 'exit', '{}', '{}', ?, 'Test', 'applied', 1, ?)
  `).run(userId, exitDate, new Date().toISOString());
  h.deps.setUserActive(userId, false, { id: 1 });
}

test('HR-Sachbearbeitung: sieht und korrigiert Personen ohne HR-Rolle, entscheidet aber nichts', async t => {
  const h = await setup(t);
  const staff = addStaff(h);
  const annaRequest = (await h.request('anna', '2026-03-09', '2026-03-13')).data.id;
  const partnerRequest = (await h.request('bp', '2026-03-09', '2026-03-10')).data.id;
  await h.api('hr', 'POST', `/api/absence/requests/${partnerRequest}/decision`, { decision: 'approve' });

  // Sehen: alle ohne HR-Rolle, mit Art.
  const accounts = await h.api(staff, 'GET', '/api/absence/accounts?year=2026');
  assert.equal(accounts.status, 200);
  assert.deepEqual(accounts.data.accounts.map(account => account.userId).sort(), [3, 4, 5, 6, 7]);
  const everything = await h.api(staff, 'GET', '/api/absence/requests?scope=all');
  assert.deepEqual(everything.data.requests.map(request => request.id), [annaRequest]);
  assert.equal(everything.data.requests[0].typeName, 'Urlaub');
  assert.equal(everything.data.requests[0].canDecide, false);
  assert.equal(everything.data.requests[0].canCancel, true);
  assert.equal((await h.api(staff, 'GET', '/api/absence/account?userId=5')).status, 200);
  assert.equal((await h.api(staff, 'GET', '/api/absence/requests?userId=5')).data.requests.length, 1);
  assert.equal((await h.api(staff, 'GET', '/api/absence/account?userId=1')).status, 403, 'HR-Leitung');
  assert.equal((await h.api(staff, 'GET', '/api/absence/account?userId=2')).status, 403, 'HR-Kollege');
  assert.equal((await h.api(staff, 'GET', `/api/absence/requests/${partnerRequest}`)).status, 403);
  const calendar = await h.api(staff, 'GET', '/api/absence/calendar?month=2026-03');
  assert.equal(calendar.data.people.some(person => person.id === 2), false);
  assert.equal(calendar.data.entries.find(entry => entry.userId === 5).typeName, 'Urlaub');

  // Entscheiden: nie.
  const decision = await h.api(staff, 'POST', `/api/absence/requests/${annaRequest}/decision`, { decision: 'approve' });
  assert.equal(decision.status, 403);
  assert.match(decision.data.error, /Sachbearbeitung/);
  assert.equal((await h.api(staff, 'GET', '/api/absence/approvals')).data.requests.length, 0);

  // Krankmeldung erfassen: ja, aber nicht für HR.
  const sick = { typeId: h.typeId('sick'), startDate: '2026-03-16', endDate: '2026-03-17' };
  assert.equal((await h.api(staff, 'POST', '/api/absence/requests', { ...sick, userId: 5 })).status, 201);
  assert.equal(h.tasksOf(5, 'absence_info').length, 1, 'die Person erfährt es');
  assert.equal((await h.api(staff, 'POST', '/api/absence/requests', { ...sick, userId: 2 })).status, 403);
  assert.equal((await h.api(staff, 'POST', '/api/absence/requests', { ...sick, userId: 1 })).status, 403);

  // Konto korrigieren: nur mit Grund, nie HR, nie sich selbst.
  const missing = await h.api(staff, 'PUT', '/api/absence/accounts/5/2026', { entitlementDays: 28 });
  assert.equal(missing.status, 400);
  assert.match(missing.data.error, /Grund/);
  assert.equal((await h.api(staff, 'PUT', '/api/absence/accounts/5/2026', { entitlementDays: 28, reason: '   ' })).status, 400);
  const corrected = await h.api(staff, 'PUT', '/api/absence/accounts/5/2026', { entitlementDays: 28, reason: 'Vertrag rückwirkend geändert' });
  assert.equal(corrected.status, 200);
  assert.equal(corrected.data.account.correction.reason, 'Vertrag rückwirkend geändert');
  assert.equal(corrected.data.account.correction.byName, 'Sach Bearbeiter');
  const notice = h.tasksOf(5, 'absence_account_notice');
  assert.equal(notice.length, 1);
  assert.match(notice[0].title, /Vertrag rückwirkend geändert/);
  const audit = h.db.prepare("SELECT new_values FROM audit_log WHERE action = 'absence_account_updated'").all();
  assert.match(audit[0].new_values, /Vertrag rückwirkend geändert/);
  const body = { entitlementDays: 40, reason: 'Versuch' };
  assert.equal((await h.api(staff, 'PUT', '/api/absence/accounts/2/2026', body)).status, 403);
  assert.equal((await h.api(staff, 'PUT', '/api/absence/accounts/1/2026', body)).status, 403);
  assert.equal((await h.api(staff, 'PUT', `/api/absence/accounts/${staff}/2026`, body)).status, 403);

  // Arten, Feiertage und Voreinstellungen: nein.
  assert.equal((await h.api(staff, 'POST', '/api/absence/types', { name: 'Kur' })).status, 403);
  assert.equal((await h.api(staff, 'PATCH', `/api/absence/types/${h.typeId('special')}`, { active: false })).status, 403);
  assert.equal((await h.api(staff, 'GET', '/api/absence/settings')).status, 403);
  assert.equal((await h.api(staff, 'PUT', '/api/absence/settings', { state: 'NW' })).status, 403);
  assert.equal((await h.api(staff, 'POST', '/api/absence/holidays', { date: '2026-03-20', name: 'Betriebsfeier' })).status, 403);
  assert.equal((await h.api(staff, 'POST', '/api/absence/holidays/import', { year: 2026, state: 'NW' })).status, 403);

  // Export: ja, ohne HR-Personen.
  const exported = await h.api(staff, 'GET', '/api/absence/export?month=2026-03');
  assert.equal(exported.status, 200);
  assert.match(exported.data, /Anna Ahrens/);
  assert.doesNotMatch(exported.data, /Boris Partner/);

  // Stornieren einer falschen Meldung gehört zur Korrektur, bei HR-Personen nicht.
  const sickId = (await h.api(staff, 'GET', '/api/absence/requests?userId=5')).data.requests.find(request => request.startDate === '2026-03-16').id;
  assert.equal((await h.api(staff, 'POST', `/api/absence/requests/${sickId}/cancel`)).status, 200);
  assert.equal((await h.api(staff, 'POST', `/api/absence/requests/${partnerRequest}/cancel`)).status, 403);

  // Führt die Sachbearbeitung selbst jemanden, entscheidet sie dort als Führungskraft.
  h.deps.changeManager(7, staff);
  const claraRequest = (await h.request('clara', '2026-03-23', '2026-03-24')).data.id;
  assert.equal((await h.api(staff, 'POST', `/api/absence/requests/${claraRequest}/decision`, { decision: 'approve' })).status, 200);
});

test('HR ändert das eigene Konto nicht, außer die Organisation erlaubt es', async t => {
  const h = await setup(t);
  const body = { entitlementDays: 99, reason: 'Eigener Wunsch' };
  assert.equal((await h.api('hr', 'PUT', '/api/absence/accounts/1/2026', body)).status, 403);
  assert.equal((await h.api('bp', 'PUT', '/api/absence/accounts/2/2026', body)).status, 403);
  assert.equal((await h.api('bp', 'GET', '/api/absence/accounts?year=2026')).data.accounts.find(account => account.userId === 2).canAdjust, false);
  assert.equal((await h.account('bp')).entitlementDays, 30);

  h.deps.setApprovalRule('personnel.hr_self_edit', 'allowed', { id: 1 });
  assert.equal((await h.api('hr', 'PUT', '/api/absence/accounts/1/2026', body)).status, 200);
  assert.equal(h.tasksOf(1, 'absence_account_notice').length, 0, 'kein Hinweis an sich selbst');
  assert.equal((await h.api('bp', 'GET', '/api/absence/accounts?year=2026')).data.accounts.find(account => account.userId === 2).canAdjust, true);
});

test('HR ändert eine eigene begonnene Abwesenheit nicht selbst', async t => {
  const h = await setup(t);
  const own = (await h.request('bp', '2026-03-09', '2026-03-10')).data.id;
  await h.api('hr', 'POST', `/api/absence/requests/${own}/decision`, { decision: 'approve' });
  h.clock.date = '2026-03-10';
  assert.equal((await h.api('bp', 'POST', `/api/absence/requests/${own}/cancel`)).status, 403);
  h.deps.setApprovalRule('personnel.hr_self_edit', 'allowed', { id: 1 });
  assert.equal((await h.api('bp', 'POST', `/api/absence/requests/${own}/cancel`)).status, 200);
});

test('Der HR Business Partner liest und ändert nichts an den Abwesenheiten der HR-Leitung', async t => {
  const h = await setup(t);
  const own = (await h.request('hr', '2026-03-09', '2026-03-10', { comment: 'Privat' })).data.id;
  const body = { entitlementDays: 0, reason: 'Versuch' };

  assert.equal((await h.api('bp', 'PUT', '/api/absence/accounts/1/2026', body)).status, 403);
  assert.equal((await h.api('bp', 'GET', '/api/absence/account?userId=1')).status, 403);
  assert.equal((await h.api('bp', 'GET', '/api/absence/requests?userId=1')).status, 403);
  assert.equal((await h.api('bp', 'POST', '/api/absence/requests', { userId: 1, typeId: h.typeId('sick'), startDate: '2026-03-16', endDate: '2026-03-16' })).status, 403);
  assert.equal((await h.api('bp', 'POST', `/api/absence/requests/${own}/cancel`)).status, 403);
  const accounts = (await h.api('bp', 'GET', '/api/absence/accounts?year=2026')).data.accounts;
  assert.equal(accounts.some(account => account.userId === 1), false);
  assert.equal((await h.api('bp', 'GET', '/api/absence/requests?scope=all')).data.requests.some(request => request.userId === 1), false);

  // Mangels zweiter HR-Administration entscheidet der HR Business Partner aber über ihren Antrag.
  const inbox = (await h.api('bp', 'GET', '/api/absence/approvals')).data.requests;
  assert.deepEqual(inbox.map(request => request.id), [own]);
  assert.equal(inbox[0].comment, 'Privat');
  assert.equal((await h.api('bp', 'POST', `/api/absence/requests/${own}/decision`, { decision: 'approve' })).status, 200);
  const exported = await h.api('bp', 'GET', '/api/absence/export?month=2026-03');
  assert.doesNotMatch(exported.data, /Hanna HR/);

  // Gibt es eine zweite HR-Administration, entscheidet sie, und für den Partner bleibt der Antrag zu.
  h.db.prepare("INSERT INTO users (id, name, email, password_hash, role) VALUES (20, 'Hilde Zwei', 'hilde@test.local', '!', 'hr_admin')").run();
  const next = (await h.request('hr', '2026-03-16', '2026-03-17')).data.id;
  assert.equal(h.tasksOf(20, 'absence_approval').length, 1);
  assert.equal((await h.api('bp', 'POST', `/api/absence/requests/${next}/decision`, { decision: 'approve' })).status, 403);
  assert.equal((await h.api('hr', 'GET', '/api/absence/accounts?year=2026')).data.accounts.length, 8, 'die HR-Administration sieht alle');
});

// ------------------------------------------------------------------ Genehmigungsregel

test('Regel geändert: Offene Anträge bleiben entscheidbar, neue folgen der neuen Regel, in allen Stellungen', async t => {
  const rules = ['manager', 'hr', 'none'];
  const expected = {
    manager: { status: 'pending', holders: [4] },
    hr: { status: 'pending', holders: [1] },
    none: { status: 'approved', holders: [] }
  };
  const holdersOf = (h, id) => h.db.prepare("SELECT user_id FROM tasks WHERE type = 'absence_approval' AND entity_id = ? AND done = 0").all(id).map(row => row.user_id);

  for (const from of rules) {
    for (const to of rules) {
      const label = `${from} nach ${to}`;
      const h = await setup(t);
      h.deps.setApprovalRule('absence.approval', from, { id: 1 });
      const before = await h.request('anna', '2026-03-09', '2026-03-10');
      assert.equal(before.data.status, expected[from].status, label);
      assert.deepEqual(holdersOf(h, before.data.id), expected[from].holders, label);

      h.deps.setApprovalRule('absence.approval', to, { id: 1 });
      h.instance.maintenance();
      assert.deepEqual(holdersOf(h, before.data.id), expected[from].holders, `${label}: die Wartung verschiebt nichts`);

      // Der neue Antrag folgt der neuen Regel.
      const after = await h.request('anna', '2026-03-16', '2026-03-17');
      assert.equal(after.data.status, expected[to].status, label);
      assert.deepEqual(holdersOf(h, after.data.id), expected[to].holders, label);
      const managerInbox = (await h.api('manager', 'GET', '/api/absence/approvals')).data;
      assert.equal(managerInbox.rule, to, label);
      const managerSees = managerInbox.requests.map(request => request.id);
      assert.equal(managerSees.includes(after.data.id), to === 'manager', `${label}: neuer Antrag bei der Führungskraft`);
      const hrSees = (await h.api('hr', 'GET', '/api/absence/approvals')).data.requests.map(request => request.id);
      assert.equal(hrSees.includes(after.data.id), to !== 'none', `${label}: neuer Antrag bei HR`);
      if (to === 'hr') {
        assert.equal((await h.api('manager', 'POST', `/api/absence/requests/${after.data.id}/decision`, { decision: 'approve' })).status, 403, label);
      }

      // Der alte Antrag bleibt für die entscheidbar, die ihn haben. „Prüfen“ findet ihn also.
      if (expected[from].status === 'pending') {
        const holder = expected[from].holders[0];
        const inbox = (await h.api(holder, 'GET', '/api/absence/approvals')).data.requests;
        assert.equal(inbox.some(request => request.id === before.data.id), true, `${label}: Antrag sichtbar`);
        const decided = await h.api(holder, 'POST', `/api/absence/requests/${before.data.id}/decision`, { decision: 'approve' });
        assert.equal(decided.status, 200, `${label}: Antrag entscheidbar`);
        assert.deepEqual(holdersOf(h, before.data.id), [], label);
      }
    }
  }
});

test('Das Antragsfenster erfährt die Regel und nennt, wer entscheidet', async t => {
  const h = await setup(t);
  const route = async person => (await h.api(person, 'GET', '/api/absence/types')).data.approval;
  assert.deepEqual(await route('anna'), { rule: 'manager', decider: 'manager', name: 'Malte Manager' });
  assert.deepEqual(await route('director'), { rule: 'manager', decider: 'hr' }, 'ohne Führungskraft');
  h.deps.setUserActive(4, false, { id: 1 });
  assert.deepEqual(await route('anna'), { rule: 'manager', decider: 'hr' }, 'gesperrte Führungskraft');
  h.deps.setUserActive(4, true, { id: 1 });
  h.deps.setApprovalRule('absence.approval', 'hr', { id: 1 });
  assert.deepEqual(await route('anna'), { rule: 'hr', decider: 'hr' });
  h.db.prepare('UPDATE users SET active = 0 WHERE id = 2').run();
  assert.deepEqual(await route('hr'), { rule: 'hr', decider: 'nobody' }, 'die einzige HR-Person');
  h.deps.setApprovalRule('absence.approval', 'none', { id: 1 });
  assert.deepEqual(await route('anna'), { rule: 'none', decider: 'none' });
});

test('Dass jemand fehlt, erfährt die Führungskraft auch dann, wenn nur HR entscheidet', async t => {
  const h = await setup(t);
  h.deps.setApprovalRule('absence.approval', 'hr', { id: 1 });
  await h.api('anna', 'POST', '/api/absence/requests', { typeId: h.typeId('sick'), startDate: '2026-03-02', endDate: '2026-03-02' });
  assert.equal(h.tasksOf(4, 'absence_info').length, 1);
  assert.doesNotMatch(h.tasksOf(4, 'absence_info')[0].title, /krank/i);
  assert.equal(h.tasksOf(1, 'absence_info').length, 0);
});

test('Führungswechsel: Offene Prüfaufgaben ziehen um, Vertrauliches bleibt bei HR', async t => {
  const h = await setup(t);
  const id = (await h.request('anna', '2026-03-09', '2026-03-10', { comment: 'Besuch' })).data.id;
  const kur = (await h.api('hr', 'POST', '/api/absence/types', { name: 'Kur', confidential: true, requiresApproval: true })).data.type.id;
  await h.api('anna', 'POST', '/api/absence/requests', { typeId: kur, startDate: '2026-03-16', endDate: '2026-03-17' });

  assert.equal(h.deps.changeManager(5, 3), true);
  assert.equal(h.tasksOf(4, 'absence_approval').length, 0, 'die frühere Führungskraft hat nichts mehr zu tun');
  const moved = h.tasksOf(3, 'absence_approval');
  assert.equal(moved.length, 1);
  assert.equal(moved[0].entity_id, id);
  assert.equal(moved[0].due_date, '2026-03-09');
  assert.equal(h.tasksOf(1, 'absence_approval').length, 1, 'die vertrauliche Art bleibt bei HR');
  assert.equal((await h.api('manager', 'GET', '/api/absence/approvals')).data.requests.length, 0);
  assert.equal((await h.api('manager', 'POST', `/api/absence/requests/${id}/decision`, { decision: 'approve' })).status, 403);
  const inbox = (await h.api('director', 'GET', '/api/absence/approvals')).data.requests;
  assert.deepEqual(inbox.map(request => request.comment), ['Besuch']);
  assert.equal((await h.api('director', 'POST', `/api/absence/requests/${id}/decision`, { decision: 'approve' })).status, 200);

  // Ohne neue Führungskraft geht es an HR, und bei „Nur HR“ ändert ein Wechsel nichts.
  const ben = (await h.request('ben', '2026-03-09', '2026-03-10')).data.id;
  h.deps.changeManager(6, null);
  assert.equal(h.tasksOf(4, 'absence_approval').length, 0);
  assert.equal(h.db.prepare("SELECT user_id FROM tasks WHERE type = 'absence_approval' AND entity_id = ? AND done = 0").get(ben).user_id, 1);
  h.deps.setApprovalRule('absence.approval', 'hr', { id: 1 });
  h.deps.changeManager(6, 4);
  assert.equal(h.tasksOf(4, 'absence_approval').length, 0);
  assert.equal(h.db.prepare("SELECT user_id FROM tasks WHERE type = 'absence_approval' AND entity_id = ? AND done = 0").get(ben).user_id, 1);
});

// ------------------------------------------------------------------ Arten

test('Krankheit lässt sich nicht abschalten, andere Arten schon', async t => {
  const h = await setup(t);
  const sick = h.typeId('sick');
  const off = await h.api('hr', 'PATCH', `/api/absence/types/${sick}`, { active: false });
  assert.equal(off.status, 400);
  assert.match(off.data.error, /nicht abschalten/);
  assert.equal(h.db.prepare('SELECT active FROM absence_types WHERE id = ?').get(sick).active, 1);
  const types = (await h.api('hr', 'GET', '/api/absence/types?all=1')).data.types;
  assert.equal(types.find(type => type.code === 'sick').canDisable, false);
  assert.equal(types.find(type => type.code === 'special').canDisable, true);
  assert.equal((await h.api('hr', 'PATCH', `/api/absence/types/${h.typeId('special')}`, { active: false })).status, 200);

  // Wurde sie früher abgeschaltet, lässt sie sich wieder einschalten.
  h.db.prepare('UPDATE absence_types SET active = 0 WHERE id = ?').run(sick);
  assert.equal((await h.api('hr', 'PATCH', `/api/absence/types/${sick}`, { active: true })).status, 200);
  assert.equal(h.db.prepare('SELECT active FROM absence_types WHERE id = ?').get(sick).active, 1);
});

// ------------------------------------------------------------------ Austritt

test('Austritt: Künftiges wird hinfällig, Vergangenes bleibt entscheidbar, Konto und Export stimmen', async t => {
  const h = await setup(t);
  const past = (await h.request('anna', '2026-02-23', '2026-02-24')).data.id;
  const lastDay = (await h.request('anna', '2026-03-03', '2026-03-03')).data.id;
  const future = (await h.request('anna', '2026-03-09', '2026-03-10')).data.id;
  const approved = (await h.request('anna', '2026-03-16', '2026-03-17')).data.id;
  await h.api('manager', 'POST', `/api/absence/requests/${approved}/decision`, { decision: 'approve' });
  await h.api('anna', 'POST', `/api/absence/requests/${lastDay}/cancel`);
  const lastDayAgain = (await h.request('anna', '2026-03-03', '2026-03-03')).data.id;
  await h.api('manager', 'POST', `/api/absence/requests/${lastDayAgain}/decision`, { decision: 'approve' });
  h.clock.date = '2026-03-03';
  recordExit(h, 5, '2026-03-03');

  const inbox = (await h.api('manager', 'GET', '/api/absence/approvals')).data.requests;
  assert.deepEqual(inbox.map(request => request.id), [past], 'nur der vergangene Antrag wartet noch');
  assert.equal(h.tasksOf(4, 'absence_approval').length, 1);

  const all = (await h.api('hr', 'GET', '/api/absence/requests?scope=all')).data.requests;
  const statusOf = id => all.find(request => request.id === id);
  assert.equal(statusOf(future).status, 'cancelled');
  assert.equal(statusOf(future).cancelReason, 'Durch den Austritt hinfällig.');
  assert.equal(statusOf(approved).status, 'cancelled');
  assert.equal(statusOf(lastDayAgain).status, 'approved', 'der letzte Arbeitstag zählt noch');
  assert.equal(statusOf(past).status, 'pending');
  assert.equal(statusOf(past).personInactive, true);
  assert.deepEqual(h.tasksOf(5, 'absence_decided').map(task => task.entity_id), [lastDayAgain], 'die hinfällige Entscheidung ist weg');

  assert.equal((await h.api('manager', 'POST', `/api/absence/requests/${future}/decision`, { decision: 'approve' })).status, 409);
  assert.equal((await h.api('manager', 'POST', `/api/absence/requests/${past}/decision`, { decision: 'approve' })).status, 200);

  // Der Resturlaub bleibt ablesbar, die Person ist gekennzeichnet.
  const accounts = (await h.api('hr', 'GET', '/api/absence/accounts?year=2026')).data.accounts;
  const anna = accounts.find(account => account.userId === 5);
  assert.equal(anna.active, false);
  assert.equal(anna.exitDate, '2026-03-03');
  assert.equal(anna.restDays, 27);
  assert.equal((await h.api('hr', 'GET', '/api/absence/accounts?year=2027')).data.accounts.some(account => account.userId === 5), false, 'kein neues Konto nach dem Austritt');

  // Export: nur, was wirklich stattfand.
  const march = (await h.api('hr', 'GET', '/api/absence/export?month=2026-03')).data.trim().split('\r\n');
  assert.equal(march.length, 2, 'nur der letzte Arbeitstag');
  assert.match(march[1], /Anna Ahrens.*03\.03\.2026;03\.03\.2026/);
  const february = await h.api('hr', 'GET', '/api/absence/export?month=2026-02');
  assert.match(february.data, /Anna Ahrens/);

  // Die Wartung findet es ebenso und ändert nichts doppelt.
  h.instance.maintenance();
  assert.equal(h.tasksOf(4, 'absence_approval').length, 0);
});

test('Austritt: HR trägt Vergangenes nach, aber nichts Künftiges, und die Person bekommt keine Aufgabe', async t => {
  const h = await setup(t);
  h.clock.date = '2026-03-10';
  recordExit(h, 5, '2026-03-10');
  const sick = h.typeId('sick');
  const backfilled = await h.api('hr', 'POST', '/api/absence/requests', { userId: 5, typeId: sick, startDate: '2026-03-02', endDate: '2026-03-03' });
  assert.equal(backfilled.status, 201);
  assert.equal(backfilled.data.status, 'approved');
  assert.equal(h.tasksOf(5, 'absence_info').length, 0);

  const future = await h.api('hr', 'POST', '/api/absence/requests', { userId: 5, typeId: sick, startDate: '2026-03-16', endDate: '2026-03-17' });
  assert.equal(future.status, 400);
  assert.match(future.data.error, /bis zum 10\.03\.2026 nachtragen/);
  const across = await h.api('hr', 'POST', '/api/absence/requests', { userId: 5, typeId: sick, startDate: '2026-03-09', endDate: '2026-03-17' });
  assert.equal(across.status, 400, 'auch ein Zeitraum in die Zukunft hinein geht nicht');
  h.clock.date = '2026-03-20';
  const afterExit = await h.api('hr', 'POST', '/api/absence/requests', { userId: 5, typeId: sick, startDate: '2026-03-12', endDate: '2026-03-12' });
  assert.equal(afterExit.status, 400, 'auch nichts zwischen Austritt und heute');

  assert.equal((await h.api('manager', 'POST', '/api/absence/requests', { userId: 5, typeId: sick, startDate: '2026-03-02', endDate: '2026-03-02' })).status, 403);
  const staff = addStaff(h);
  assert.equal((await h.api(staff, 'POST', '/api/absence/requests', { userId: 5, typeId: sick, startDate: '2026-03-04', endDate: '2026-03-04' })).status, 201);
  assert.equal((await h.api('hr', 'PUT', '/api/absence/accounts/5/2026', { entitlementDays: 7.5, reason: 'Anteilig bis zum Austritt' })).status, 200);
  assert.equal(h.tasksOf(5, 'absence_account_notice').length, 0);
});

test('Gesperrtes Konto ohne Austritt: Ein künftiger Antrag ruht und kommt nach dem Entsperren zurück', async t => {
  const h = await setup(t);
  const id = (await h.request('anna', '2026-03-09', '2026-03-10')).data.id;
  const approved = (await h.request('anna', '2026-03-16', '2026-03-17')).data.id;
  await h.api('manager', 'POST', `/api/absence/requests/${approved}/decision`, { decision: 'approve' });
  h.deps.setUserActive(5, false, { id: 1 });

  assert.equal((await h.api('manager', 'GET', '/api/absence/approvals')).data.requests.length, 0);
  const blocked = await h.api('manager', 'POST', `/api/absence/requests/${id}/decision`, { decision: 'approve' });
  assert.equal(blocked.status, 409);
  assert.match(blocked.data.error, /nicht mehr aktiv/);
  assert.equal((await h.api('ben', 'POST', `/api/absence/requests/${id}/decision`, { decision: 'approve' })).status, 403, 'Unbeteiligte erfahren nichts');
  h.instance.maintenance();
  assert.equal(h.tasksOf(4, 'absence_approval').length, 0, 'niemand soll auf einen ruhenden Antrag warten');
  const stored = id2 => h.db.prepare('SELECT status FROM absence_requests WHERE id = ?').get(id2).status;
  assert.equal(stored(id), 'pending');
  assert.equal(stored(approved), 'approved', 'eine Sperre löscht keinen genehmigten Urlaub');

  h.deps.setUserActive(5, true, { id: 1 });
  h.instance.maintenance();
  assert.equal(h.tasksOf(4, 'absence_approval').length, 1);
  assert.equal((await h.api('manager', 'POST', `/api/absence/requests/${id}/decision`, { decision: 'approve' })).status, 200);
});

// ------------------------------------------------------------------ Tempo

test('Die Kontenliste legt Konten gebündelt an und fragt nicht je Person neu', async t => {
  const h = await setup(t);
  const add = h.db.prepare("INSERT INTO users (id, name, email, password_hash, role, manager_id) VALUES (?, ?, ?, '!', 'employee', 3)");
  for (let index = 0; index < 60; index += 1) add.run(100 + index, `Person ${index}`, `p${index}@test.local`);
  const prepare = h.db.prepare;
  const transaction = h.db.transaction;
  let prepared = 0;
  let transactions = 0;
  h.db.prepare = function countedPrepare(sql) {
    prepared += 1;
    return prepare.call(this, sql);
  };
  h.db.transaction = function countedTransaction(work) {
    transactions += 1;
    return transaction.call(this, work);
  };
  t.after(() => {
    h.db.prepare = prepare;
    h.db.transaction = transaction;
  });

  const first = await h.api('hr', 'GET', '/api/absence/accounts?year=2028');
  assert.equal(first.status, 200);
  assert.equal(first.data.accounts.length, 67);
  assert.equal(transactions, 1, 'eine einzige Transaktion');
  assert.ok(prepared <= 25, `höchstens eine feste Zahl von Abfragen, waren ${prepared}`);
  h.db.prepare = prepare;
  h.db.transaction = transaction;
  // Zwischen den Jahren entstehen die Konten lückenlos, wie zuvor.
  assert.equal(h.db.prepare('SELECT COUNT(*) AS count FROM absence_accounts WHERE user_id = 100').get().count, 3);
  assert.equal(first.data.accounts.find(account => account.userId === 100).restDays, 60, 'Anspruch 2028 plus der Rest aus 2027');
});

// ------------------------------------------------------------------ Eingaben und Texte

test('Halber Tag: vormittags oder nachmittags, und dieselbe Hälfte nur einmal', async t => {
  const h = await setup(t);
  const morning = await h.request('anna', '2026-03-09', '2026-03-09', { halfDayPart: 'morning' });
  assert.equal(morning.status, 201);
  assert.equal(morning.data.days, 0.5);
  const stored = (await h.api('anna', 'GET', `/api/absence/requests/${morning.data.id}`)).data.request;
  assert.equal(stored.halfDayPart, 'morning');
  assert.equal(stored.startHalf, true);
  assert.equal(stored.endHalf, false);

  const sameHalf = await h.request('anna', '2026-03-09', '2026-03-09', { halfDayPart: 'morning' });
  assert.equal(sameHalf.status, 400);
  const otherHalf = await h.api('anna', 'POST', '/api/absence/requests', { typeId: h.typeId('sick'), startDate: '2026-03-09', endDate: '2026-03-09', halfDayPart: 'afternoon' });
  assert.equal(otherHalf.status, 201);

  // Bei mehreren Tagen ergibt sich die Hälfte: Der Zeitraum beginnt nachmittags und endet vormittags.
  const range = await h.request('anna', '2026-03-16', '2026-03-18', { startHalf: true, endHalf: true });
  assert.equal(range.data.days, 2);
  const afterRangeEnd = await h.request('anna', '2026-03-18', '2026-03-18', { halfDayPart: 'afternoon' });
  assert.equal(afterRangeEnd.status, 201, 'nachmittags am letzten Tag ist noch frei');
  const beforeRangeStart = await h.request('anna', '2026-03-16', '2026-03-16', { halfDayPart: 'afternoon' });
  assert.equal(beforeRangeStart.status, 400, 'am ersten Tag ist der Nachmittag belegt');
  assert.equal((await h.request('anna', '2026-03-16', '2026-03-16', { halfDayPart: 'morning' })).status, 201);

  // Unsinn wird ignoriert, und bei mehreren Tagen zählt die Angabe nicht.
  const nonsense = await h.request('anna', '2026-03-23', '2026-03-23', { halfDayPart: 'abends' });
  assert.equal(nonsense.data.days, 1);
  const severalDays = await h.request('anna', '2026-03-24', '2026-03-25', { halfDayPart: 'morning' });
  assert.equal(severalDays.data.days, 2);

  // Kalender und Liste nennen die Hälfte, ohne dass ganze Tage neue Felder bekommen.
  const calendar = await h.api('anna', 'GET', '/api/absence/calendar?month=2026-03');
  assert.equal(calendar.data.entries.find(entry => entry.startDate === '2026-03-09' && entry.typeName === 'Urlaub').halfDayPart, 'morning');
});

test('Krankmeldung: höchstens 14 Tage im Voraus, HR darf weiter planen, und heute selbst stornierbar', async t => {
  const h = await setup(t);
  const sick = h.typeId('sick');
  const report = (person, startDate, endDate, more = {}) => h.api(person, 'POST', '/api/absence/requests', { typeId: sick, startDate, endDate, ...more });

  const farAhead = await report('anna', '2027-02-01', '2027-02-01');
  assert.equal(farAhead.status, 400);
  assert.match(farAhead.data.error, /14 Tage/);
  assert.equal((await report('anna', '2026-03-16', '2026-03-16')).status, 201, 'genau 14 Tage geht');
  assert.equal((await report('anna', '2026-03-17', '2026-03-17')).status, 400);
  assert.equal((await report('hr', '2026-05-04', '2026-05-08', { userId: 5 })).status, 201, 'eine geplante Operation trägt HR ein');

  // Heute begonnen: Die Person nimmt es selbst zurück. Gestern begonnen: nur HR.
  const today = (await report('ben', '2026-03-02', '2026-03-04')).data.id;
  const own = (await h.api('ben', 'GET', `/api/absence/requests/${today}`)).data.request;
  assert.equal(own.canCancel, true);
  assert.equal((await h.api('ben', 'POST', `/api/absence/requests/${today}/cancel`)).status, 200);
  const earlier = (await report('clara', '2026-03-02', '2026-03-04')).data.id;
  h.clock.date = '2026-03-03';
  assert.equal((await h.api('clara', 'POST', `/api/absence/requests/${earlier}/cancel`)).status, 403);

  // Urlaub bleibt wie bisher: am ersten Tag nur noch durch HR.
  const vacation = (await h.request('director', '2026-03-03', '2026-03-03')).data.id;
  await h.api('hr', 'POST', `/api/absence/requests/${vacation}/decision`, { decision: 'approve' });
  assert.equal((await h.api('director', 'POST', `/api/absence/requests/${vacation}/cancel`)).status, 403);
});

// ------------------------------------------------------------------ Sicht auf Dritte und Zuständigkeit

test('Für Dritte heißt jede Abwesenheit abwesend, außer sie entscheiden sie', async t => {
  const h = await setup(t);
  const byManager = (await h.request('anna', '2026-03-09', '2026-03-10', { comment: 'Besuch' })).data.id;
  await h.api('manager', 'POST', `/api/absence/requests/${byManager}/decision`, { decision: 'approve' });
  const byHr = (await h.request('anna', '2026-03-16', '2026-03-17', { comment: 'Geheim' })).data.id;
  await h.api('hr', 'POST', `/api/absence/requests/${byHr}/decision`, { decision: 'approve' });
  const custom = (await h.api('hr', 'POST', '/api/absence/types', { name: 'Dienstreise', requiresApproval: false })).data.type.id;
  await h.api('anna', 'POST', '/api/absence/requests', { typeId: custom, startDate: '2026-03-23', endDate: '2026-03-23' });
  await h.request('ben', '2026-03-09', '2026-03-10');

  const entriesFor = async (viewer, userId) => (await h.api(viewer, 'GET', '/api/absence/calendar?month=2026-03')).data.entries
    .filter(entry => entry.userId === userId)
    .sort((left, right) => left.startDate.localeCompare(right.startDate));

  // Führungskraft: Art nur bei dem, was sie entschieden hat oder entscheidet.
  const manager = await entriesFor('manager', 5);
  assert.deepEqual(manager.map(entry => entry.label), ['Urlaub', 'abwesend', 'abwesend']);
  const managerList = (await h.api('manager', 'GET', '/api/absence/requests?userId=5')).data.requests;
  assert.equal(managerList.find(request => request.startDate === '2026-03-16').comment, undefined, 'den Kommentar sieht sie auch nicht');
  assert.equal(managerList.find(request => request.startDate === '2026-03-16').label, 'abwesend');
  assert.equal((await entriesFor('manager', 6))[0].typeName, 'Urlaub', 'über den offenen Antrag entscheidet sie');

  // Bereichsleitung und Kolleg:innen: immer nur abwesend, offene Anträge gar nicht.
  for (const viewer of ['director', 'ben']) {
    const seen = await entriesFor(viewer, 5);
    assert.deepEqual(seen.map(entry => entry.label), ['abwesend', 'abwesend', 'abwesend'], viewer);
    assert.equal(seen[0].typeName, undefined, viewer);
  }
  assert.deepEqual(await entriesFor('director', 6), [], 'offener Antrag eine Ebene tiefer');
  assert.equal((await h.api('director', 'GET', `/api/absence/requests/${byHr}`)).data.request.typeName, undefined);

  // Bei „Nur HR“ sieht die Führungskraft auch neue Anträge nicht mehr.
  h.deps.setApprovalRule('absence.approval', 'hr', { id: 1 });
  const hrOnly = (await h.request('ben', '2026-03-23', '2026-03-24')).data.id;
  assert.equal((await h.api('manager', 'GET', `/api/absence/requests/${hrOnly}`)).status, 403);
  await h.api('hr', 'POST', `/api/absence/requests/${hrOnly}/decision`, { decision: 'approve' });
  assert.equal((await h.api('manager', 'GET', `/api/absence/requests/${hrOnly}`)).data.request.label, 'abwesend');
});

test('Der Kalender trennt direkt, indirekt und Kolleg:innen außerhalb der Führung', async t => {
  const h = await setup(t);
  const people = async viewer => (await h.api(viewer, 'GET', '/api/absence/calendar?month=2026-03')).data.people;
  const director = await people('director');
  const byId = id => director.find(person => person.id === id);
  assert.equal(byId(3).relation, 'self');
  assert.equal(byId(4).relation, 'report');
  assert.equal(byId(4).direct, true);
  assert.equal(byId(5).direct, false);
  assert.equal(byId(5).viaManagerName, 'Malte Manager');
  assert.equal(byId(7).direct, true);

  const manager = await people('manager');
  const managerById = id => manager.find(person => person.id === id);
  assert.equal(managerById(3).relation, 'colleague', 'die eigene Führungskraft');
  assert.equal(managerById(7).relation, 'colleague', 'Kollegin außerhalb der eigenen Führung');
  assert.equal(managerById(5).direct, true);
  assert.equal(managerById(5).email, undefined, 'E-Mail und Personalnummer gibt es nur für HR');
  assert.equal((await people('hr')).find(person => person.id === 5).email, 'anna@test.local');
});

test('Offene Anträge nennen, wer entscheidet, und wer im Team gleichzeitig fehlt', async t => {
  const h = await setup(t);
  const ben = (await h.request('ben', '2026-03-10', '2026-03-11')).data.id;
  await h.api('manager', 'POST', `/api/absence/requests/${ben}/decision`, { decision: 'approve' });
  await h.api('hr', 'POST', '/api/absence/requests', { userId: 7, typeId: h.typeId('sick'), startDate: '2026-03-09', endDate: '2026-03-10' });
  const id = (await h.request('anna', '2026-03-09', '2026-03-10')).data.id;

  const own = (await h.api('anna', 'GET', `/api/absence/requests/${id}`)).data.request;
  assert.equal(own.pendingWith, 'Malte Manager');
  const inbox = (await h.api('manager', 'GET', '/api/absence/approvals')).data.requests[0];
  assert.deepEqual(inbox.overlaps, [{ userName: 'Ben Berg', startDate: '2026-03-10', endDate: '2026-03-11', pending: false }]);
  assert.doesNotMatch(JSON.stringify(inbox.overlaps), /Urlaub|typeName/, 'die Art ist hier kein Thema');

  // Anna hat keine Überschneidung außerhalb des Teams, und ein zweiter offener Antrag zählt mit.
  await h.request('ben', '2026-03-09', '2026-03-09');
  const again = (await h.api('manager', 'GET', '/api/absence/approvals')).data.requests.find(request => request.id === id);
  assert.equal(again.overlaps.length, 2);
  assert.ok(again.overlaps.some(item => item.pending));

  h.deps.setApprovalRule('absence.approval', 'hr', { id: 1 });
  const hrOnly = (await h.request('clara', '2026-03-23', '2026-03-24')).data.id;
  assert.equal((await h.api('clara', 'GET', `/api/absence/requests/${hrOnly}`)).data.request.pendingWith, 'HR');
});

test('Der HR Business Partner erfährt auch über Überschneidungen nichts von der HR-Leitung', async t => {
  const h = await setup(t);
  h.db.prepare('UPDATE users SET manager_id = 3 WHERE id IN (1, 4)').run();
  const own = (await h.request('hr', '2026-03-09', '2026-03-10')).data.id;
  await h.api('director', 'POST', `/api/absence/requests/${own}/decision`, { decision: 'approve' });
  await h.request('clara', '2026-03-09', '2026-03-10');
  const asPartner = (await h.api('bp', 'GET', '/api/absence/approvals')).data.requests.find(request => request.userId === 7);
  assert.deepEqual(asPartner.overlaps, []);
  const asDirector = (await h.api('director', 'GET', '/api/absence/approvals')).data.requests.find(request => request.userId === 7);
  assert.deepEqual(asDirector.overlaps.map(item => item.userName), ['Hanna HR']);
});

test('Aufgaben: echte Frist ist der erste Tag, Nachgetragenes hat keine, und Titel nennen die Person', async t => {
  const h = await setup(t);
  await h.request('anna', '2026-03-09', '2026-03-10');
  const task = h.tasksOf(4, 'absence_approval')[0];
  assert.equal(task.due_date, '2026-03-09');
  assert.match(task.title, /Anna Ahrens/);
  await h.request('ben', '2026-02-23', '2026-02-24');
  const backdated = h.tasksOf(4, 'absence_approval').find(item => item.title.includes('Ben Berg'));
  assert.equal(backdated.due_date, null);
});

test('Listen sind nach Nachname und nach deutscher Regel sortiert und durchsuchbar', async t => {
  const h = await setup(t);
  const add = h.db.prepare("INSERT INTO users (id, name, email, password_hash, role, manager_id) VALUES (?, ?, ?, '!', 'employee', 3)");
  add.run(30, 'Julia Abel', 'julia@test.local');
  add.run(31, 'Jörg Abel', 'joerg@test.local');
  add.run(32, 'Zoe Ärmel', 'zoe@test.local');
  add.run(33, 'Ümit Aaron', 'uemit@test.local');
  const personnel = createPersonnelModule(h.deps);
  personnel.initialize();
  h.db.prepare("INSERT INTO personnel_records (user_id, personnel_number, created_at, updated_at) VALUES (31, 'P-0031', 'x', 'x')").run();

  const { accounts } = (await h.api('hr', 'GET', '/api/absence/accounts?year=2026')).data;
  const order = accounts.map(account => account.userName);
  assert.deepEqual(order.slice(0, 5), ['Ümit Aaron', 'Jörg Abel', 'Julia Abel', 'Anna Ahrens', 'Zoe Ärmel']);
  const joerg = accounts.find(account => account.userId === 31);
  assert.equal(joerg.userEmail, 'joerg@test.local');
  assert.equal(joerg.personnelNumber, 'P-0031');

  const calendar = (await h.api('hr', 'GET', '/api/absence/calendar?month=2026-03')).data.people.map(person => person.name);
  assert.deepEqual(calendar.slice(0, 3), ['Ümit Aaron', 'Jörg Abel', 'Julia Abel']);

  for (const person of [31, 30]) {
    const id = (await h.api('hr', 'POST', '/api/absence/requests', { userId: person, typeId: h.typeId('sick'), startDate: '2026-03-09', endDate: '2026-03-09' })).data.id;
    assert.ok(id);
  }
  const lines = (await h.api('hr', 'GET', '/api/absence/export?month=2026-03')).data.trim().split('\r\n');
  assert.match(lines[1], /^Jörg Abel/);
  assert.match(lines[2], /^Julia Abel/);
  const all = (await h.api('hr', 'GET', '/api/absence/requests?scope=all')).data.requests.find(request => request.userId === 31);
  assert.equal(all.personnelNumber, 'P-0031');
  assert.equal(all.userEmail, 'joerg@test.local');
});

test('Unsinn in den neuen Feldern schadet nicht: Halbtag und Grund', async t => {
  const h = await setup(t);
  const garbage = [[], {}, ['morning'], { a: 1 }, true, false, null, -1, 1.5, 0, '', '   ', 'x'.repeat(5000), '<script>'];
  let date = '2026-03-09';
  for (const value of garbage) {
    const response = await h.api('hr', 'POST', '/api/absence/requests', { userId: 5, typeId: h.typeId('sick'), startDate: date, endDate: date, halfDayPart: value });
    assert.equal(response.status, 201, JSON.stringify(value)?.slice(0, 40));
    assert.equal(response.data.days, 1, 'kein halber Tag aus Versehen');
    const [year, month, day] = date.split('-').map(Number);
    let next = new Date(Date.UTC(year, month - 1, day + 1));
    while ([0, 6].includes(next.getUTCDay())) next = new Date(next.getTime() + 86400000);
    date = next.toISOString().slice(0, 10);
    const account = await h.api('hr', 'PUT', '/api/absence/accounts/5/2026', { entitlementDays: 28, reason: value });
    assert.ok(account.status < 500, JSON.stringify(value)?.slice(0, 40));
    if (typeof value !== 'string' || !value.trim()) assert.equal(account.status, 400, 'ohne lesbaren Grund geht es nicht');
  }
});

test('Ältere Datenbank: Die neuen Spalten kommen dazu, und vorhandene Daten bleiben', async t => {
  const h = await createModuleHarness(deps => {
    deps.db.exec(`
      CREATE TABLE absence_types (
        id INTEGER PRIMARY KEY, code TEXT UNIQUE, name TEXT NOT NULL, counts_against_balance INTEGER NOT NULL DEFAULT 0,
        requires_approval INTEGER NOT NULL DEFAULT 1, confidential INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1,
        sort_order INTEGER NOT NULL DEFAULT 100
      );
      CREATE TABLE absence_accounts (
        id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), year INTEGER NOT NULL, entitlement_days REAL NOT NULL,
        carryover_days REAL, carryover_expires TEXT, updated_by INTEGER REFERENCES users(id), updated_at TEXT, UNIQUE (user_id, year)
      );
      CREATE TABLE absence_requests (
        id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), type_id INTEGER NOT NULL REFERENCES absence_types(id),
        start_date TEXT NOT NULL, end_date TEXT NOT NULL, start_half INTEGER NOT NULL DEFAULT 0, end_half INTEGER NOT NULL DEFAULT 0,
        comment TEXT, status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
        decided_by INTEGER REFERENCES users(id), decided_at TEXT, decision_comment TEXT, cancelled_by INTEGER REFERENCES users(id),
        cancelled_at TEXT, created_by INTEGER NOT NULL REFERENCES users(id), created_at TEXT NOT NULL
      );
      INSERT INTO absence_types (id, code, name, counts_against_balance) VALUES (1, 'vacation', 'Urlaub', 1);
      INSERT INTO absence_accounts (id, user_id, year, entitlement_days, carryover_expires) VALUES (1, 5, 2030, 12.5, '2030-03-31');
      INSERT INTO absence_requests (id, user_id, type_id, start_date, end_date, start_half, comment, status, created_by, created_at)
      VALUES (1, 5, 1, '2030-03-04', '2030-03-04', 1, 'Altbestand', 'pending', 5, '2030-01-01');
    `);
    return createAbsenceModule({ ...deps, now: () => ({ date: '2030-01-10', time: '09:00' }) });
  });
  t.after(() => h.close());
  const columns = h.db.prepare('PRAGMA table_info(absence_requests)').all().map(column => column.name);
  assert.ok(columns.includes('half_day_part') && columns.includes('cancel_reason'));
  const old = (await h.api('anna', 'GET', '/api/absence/requests/1')).data.request;
  assert.equal(old.comment, 'Altbestand');
  assert.equal(old.startHalf, true);
  assert.equal(old.halfDayPart, undefined, 'ein alter halber Tag bleibt ohne Angabe');
  const account = (await h.api('anna', 'GET', '/api/absence/account?year=2030')).data.account;
  assert.equal(account.entitlementDays, 12.5);
  assert.equal(account.correction, null);
  h.instance.initialize();
  assert.equal(h.db.prepare('SELECT COUNT(*) AS count FROM absence_requests').get().count, 1);
});

test('Wer eine Prüfaufgabe von früher hat und gesperrt wird, gibt sie an HR ab', async t => {
  const h = await setup(t);
  const id = (await h.request('anna', '2026-03-09', '2026-03-10')).data.id;
  h.deps.setApprovalRule('absence.approval', 'hr', { id: 1 });
  h.instance.maintenance();
  assert.equal(h.tasksOf(4, 'absence_approval').length, 1);
  h.deps.setUserActive(4, false, { id: 1 });
  h.instance.maintenance();
  assert.equal(h.tasksOf(4, 'absence_approval').length, 0);
  assert.deepEqual(h.tasksOf(1, 'absence_approval').map(task => task.entity_id), [id]);
});

test('Austritt: Was über den letzten Arbeitstag hinausgeht, wird gekürzt, und der Resturlaub stimmt', async t => {
  const h = await setup(t);
  const id = (await h.request('anna', '2026-03-09', '2026-03-20', { endHalf: true })).data.id;
  await h.api('manager', 'POST', `/api/absence/requests/${id}/decision`, { decision: 'approve' });
  assert.equal((await h.account('anna')).restDays, 20.5);
  h.clock.date = '2026-03-11';
  recordExit(h, 5, '2026-03-11');
  const request = (await h.api('hr', 'GET', `/api/absence/requests?scope=all`)).data.requests.find(item => item.id === id);
  assert.equal(request.status, 'approved');
  assert.equal(request.endDate, '2026-03-11');
  assert.equal(request.endHalf, false);
  assert.equal(request.days, 3);
  assert.equal(request.cancelReason, 'Durch den Austritt bis zum letzten Arbeitstag gekürzt.');
  const anna = (await h.api('hr', 'GET', '/api/absence/accounts?year=2026')).data.accounts.find(account => account.userId === 5);
  assert.equal(anna.restDays, 27);
  const lines = (await h.api('hr', 'GET', '/api/absence/export?month=2026-03')).data.trim().split('\r\n');
  assert.match(lines[1], /09\.03\.2026;11\.03\.2026;3$/);
  const logged = h.db.prepare("SELECT old_values FROM audit_log WHERE action = 'absence_request_shortened'").get();
  assert.match(logged.old_values, /2026-03-20/, 'der frühere Zeitraum bleibt nachvollziehbar');
  // Ein zweiter Lauf ändert nichts mehr.
  h.instance.maintenance();
  assert.equal(h.db.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE action = 'absence_request_shortened'").get().count, 1);
});

test('Wiedereintritt: Ein früherer Austritt zählt nicht mehr, wenn das Konto später nur gesperrt wird', async t => {
  const h = await setup(t);
  recordExit(h, 5, '2026-01-30');
  h.deps.setUserActive(5, true, { id: 1 });
  h.db.prepare(`
    INSERT INTO personnel_changes (user_id, kind, old_values, new_values, effective_date, reason, status, created_by, created_at)
    VALUES (5, 'rehire', '{}', '{}', '2026-02-16', 'Test', 'applied', 1, ?)
  `).run(new Date().toISOString());
  const id = (await h.request('anna', '2026-03-16', '2026-03-17')).data.id;
  await h.api('manager', 'POST', `/api/absence/requests/${id}/decision`, { decision: 'approve' });
  h.deps.setUserActive(5, false, { id: 1 });
  h.instance.maintenance();
  assert.equal(h.db.prepare('SELECT status FROM absence_requests WHERE id = ?').get(id).status, 'approved');
  assert.equal((await h.api('hr', 'GET', '/api/absence/accounts?year=2026')).data.accounts.find(account => account.userId === 5).exitDate, null);
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
const CLIENT_TYPES = [
  { id: 1, code: 'vacation', name: 'Urlaub', active: true, requiresApproval: true, confidential: false, countsAgainstBalance: true, canDisable: true },
  { id: 2, code: 'sick', name: 'Krankheit', active: true, requiresApproval: false, confidential: true, countsAgainstBalance: false, canDisable: false },
  { id: 3, code: null, name: 'Kur', active: true, requiresApproval: true, confidential: true, countsAgainstBalance: false, canDisable: true }
];
const clientAccount = (more = {}) => ({
  userId: 5, year: 2026, entitlementDays: 30, carryoverDays: 0, carryoverAutomatic: true, carryoverExpires: '2026-03-31', carryoverExpiredDays: 0,
  carryoverExpiringDays: 0, takenDays: 0, plannedDays: 0, pendingDays: 0, restDays: 30, correction: null, ...more
});
const clientRequest = (more = {}) => ({
  id: 7, userId: 5, userName: 'Tom Köhler', userEmail: 'tom@test.local', personnelNumber: 'P-7', startDate: '2026-03-09', endDate: '2026-03-13', startHalf: false, endHalf: false,
  days: 5, typeId: 1, typeName: 'Urlaub', confidential: false, requiresApproval: true, status: 'pending', comment: null, decisionComment: null, decidedByName: null,
  cancelReason: null, pendingWith: 'Malte Manager', personInactive: false, canCancel: true, canDecide: false, ...more
});
const ownPage = (approval, more = {}) => loadClient('absence.js', {
  me: EMPLOYEE,
  view: 'absenceHome',
  responses: {
    '/api/absence/account': { account: clientAccount(more.account) },
    '/api/absence/requests': { requests: more.requests || [] },
    '/api/absence/types': { types: CLIENT_TYPES, approval }
  }
});

test('Oberfläche: Der Antragstext folgt der Regel und der Art', async () => {
  const hintFor = async (approval, typeId) => {
    const client = ownPage(approval);
    await client.pages.absenceHome();
    const button = client.button('[data-absence-new]');
    client.definition.bind();
    button.onclick();
    const select = client.element('#absenceTypeSelect');
    select.value = String(typeId);
    select.onchange();
    return client.element('#absenceApprovalHint').textContent;
  };
  const toManager = { rule: 'manager', decider: 'manager', name: 'Malte Manager' };
  assert.match(await hintFor(toManager, 1), /Malte Manager, deine direkte Führungskraft/);
  assert.equal(await hintFor({ rule: 'manager', decider: 'hr' }, 1), 'Dein Antrag geht an HR.', 'ohne Führungskraft');
  assert.equal(await hintFor({ rule: 'hr', decider: 'hr' }, 1), 'Dein Antrag geht an HR.');
  assert.match(await hintFor({ rule: 'none', decider: 'none' }, 1), /sofort, ohne Genehmigung/);
  assert.match(await hintFor({ rule: 'manager', decider: 'nobody' }, 1), /niemand außer dir/);

  // Krankheit über „+ Antrag“: nie „geht an die Führungskraft“.
  const sickHint = await hintFor(toManager, 2);
  assert.match(sickHint, /keine Genehmigung/);
  assert.match(sickHint, /Deine Führungskraft erfährt, dass du fehlst/);
  assert.doesNotMatch(sickHint, /Malte Manager|geht an/);
  assert.match(await hintFor(toManager, 3), /nur HR/, 'vertraulich mit Genehmigung');
});

test('Oberfläche: Die Krankmeldung widerspricht sich nicht und bietet die Tageshälfte an', async () => {
  const client = ownPage({ rule: 'manager', decider: 'manager', name: 'Malte Manager' });
  await client.pages.absenceHome();
  const button = client.button('[data-absence-sick]');
  client.definition.bind();
  button.onclick();
  const modal = client.modals.at(-1);
  assert.match(modal.subtitle, /keine Diagnose/);
  assert.doesNotMatch(`${modal.subtitle} ${modal.body}`, /keinen Grund|Den Grund sehen/);
  assert.match(modal.body, /Die Art wird ihr nicht genannt/);
  assert.match(modal.body, /value="morning"/);
  assert.match(modal.body, /value="afternoon"/);
  assert.match(modal.body, /max="\d{4}-\d{2}-\d{2}"/, 'das Datum lässt sich nicht beliebig weit vorn wählen');

  // Beim Absenden wird aus der Auswahl die Hälfte, ohne die Häkchen für mehrere Tage.
  await modal.onSubmit({ typeId: '2', startDate: '2026-03-09', endDate: '2026-03-09', dayScope: 'morning', startHalf: 'on' });
  const sent = client.requests.find(item => item.method === 'POST').body;
  assert.equal(sent.halfDayPart, 'morning');
  assert.equal(sent.startHalf, undefined);
  assert.equal(sent.dayScope, undefined);
  await modal.onSubmit({ typeId: '2', startDate: '2026-03-09', endDate: '2026-03-10', dayScope: 'morning', startHalf: 'on' });
  const severalDays = client.requests.filter(item => item.method === 'POST').at(-1).body;
  assert.equal(severalDays.halfDayPart, undefined);
  assert.equal(severalDays.startHalf, 'on');
});

test('Oberfläche: Konto und eigene Anträge zeigen, was stimmt, auch am Handy', async () => {
  const client = ownPage({ rule: 'manager', decider: 'manager', name: 'Malte Manager' }, {
    requests: [
      clientRequest({ startDate: '2026-03-09', endDate: '2026-03-09', startHalf: true, halfDayPart: 'morning', days: 0.5 }),
      clientRequest({ id: 8, startDate: '2026-03-16', endDate: '2026-03-18', startHalf: true, endHalf: true, days: 2, status: 'approved', decidedByName: 'Malte Manager', pendingWith: null, canCancel: false })
    ]
  });
  const html = await client.pages.absenceHome();
  assert.match(html, /keine Resttage aus dem Vorjahr/);
  assert.doesNotMatch(html, /verfällt am/, 'ohne Übertrag verfällt nichts');
  assert.match(html, /\(vormittags\)/);
  assert.match(html, /erster Tag nur nachmittags, letzter Tag nur vormittags/);
  assert.match(html, /Entscheidet: Malte Manager/);
  assert.match(html, /Genehmigt von Malte Manager/);
  assert.match(html, /<table class="table absence-cards">/);
  assert.match(html, /data-label="Zeitraum"/);

  // Die Rückfrage nennt das Datum.
  const button = client.button('[data-absence-cancel]', { absenceCancel: '7', absenceLabel: '09.03.2026' });
  client.definition.bind();
  await button.onclick();
  assert.match(client.confirmations[0], /09\.03\.2026/);

  const withCarryover = ownPage({ rule: 'manager', decider: 'manager', name: 'M' }, { account: { carryoverDays: 3, carryoverExpiringDays: 3, correction: { reason: 'Vertrag', at: '2026-03-02T10:00:00Z', byName: 'Hanna HR' } } });
  const carryoverHtml = await withCarryover.pages.absenceHome();
  assert.match(carryoverHtml, /gültig bis 31\.03\.2026/);
  assert.match(carryoverHtml, /Zuletzt angepasst von Hanna HR am 02\.03\.2026\. Grund: Vertrag/);
});

test('Oberfläche: Offene Anträge sagen 1 Arbeitstag, nennen Überschneidungen und passen zur Regel', async () => {
  const teamPage = (requests, rule, me = { id: 4, role: 'manager', name: 'Malte Manager' }) => loadClient('absence.js', {
    me,
    view: 'absenceTeam',
    responses: {
      '/api/absence/calendar': { month: '2026-03', firstDay: '2026-03-01', lastDay: '2026-03-31', today: '2026-03-02', holidays: [], entries: [], people: [
        { id: 4, name: 'Malte Manager', relation: 'self', direct: false, viaManagerName: null },
        { id: 5, name: 'Anna Ahrens', relation: 'report', direct: true, viaManagerName: null },
        { id: 8, name: 'Ivo Indirekt', relation: 'report', direct: false, viaManagerName: 'Anna Ahrens' },
        { id: 3, name: 'Dora Direktor', relation: 'colleague', direct: false, viaManagerName: null }
      ] },
      '/api/absence/approvals': { requests, rule }
    }
  }).pages.absenceTeam();
  const html = await teamPage([clientRequest({ days: 1, restDays: 29, canDecide: true, overlaps: [{ userName: 'Ben Berg', startDate: '2026-03-09', endDate: '2026-03-10', pending: true }] })], 'manager');
  assert.match(html, /1 Arbeitstag(?!e)/);
  assert.doesNotMatch(html, /1 Arbeitstage/);
  assert.match(html, /Ben Berg \(beantragt\), 09\.03\.2026 bis 10\.03\.2026/);
  assert.match(html, /Direkt unterstellt/);
  assert.match(html, /Indirekt unterstellt/);
  assert.match(html, /über Anna Ahrens/);
  assert.match(html, /Außerhalb deiner Führung/);
  assert.ok(html.indexOf('Direkt unterstellt') < html.indexOf('Indirekt unterstellt'));
  assert.ok(html.indexOf('Indirekt unterstellt') < html.indexOf('Außerhalb deiner Führung'));
  assert.doesNotMatch(html, /Es kommt nichts mehr/);

  assert.match(await teamPage([], 'manager'), /Gerade wartet kein Antrag/);
  const hrOnly = await teamPage([], 'hr');
  assert.match(hrOnly, /entscheidet bei euch HR/);
  assert.doesNotMatch(hrOnly, /Gerade wartet kein Antrag/);
  assert.match(await teamPage([], 'none'), /gelten bei euch sofort/);
  assert.match(await teamPage([clientRequest({ days: 2, restDays: null, canDecide: true, overlaps: [] })], 'hr'), /noch von früher/);
  assert.match(await teamPage([], 'hr', ADMIN), /Gerade wartet kein Antrag/, 'HR entscheidet ja selbst');
});

test('Oberfläche: Die Sachbearbeitung sieht ihre Bereiche, ohne Genehmigen, Arten und Feiertage', async () => {
  const client = loadClient('absence.js', {
    me: STAFF,
    view: 'absenceHr',
    responses: {
      '/api/absence/requests': { requests: [clientRequest({ canDecide: false }), clientRequest({ id: 9, userName: 'Ayşe Demir', userEmail: 'ayse@test.local', personnelNumber: null })], truncated: false, limit: 1000 },
      '/api/absence/types': { types: CLIENT_TYPES, approval: { rule: 'manager', decider: 'hr' } },
      '/api/absence/accounts': { year: 2026, accounts: [
        { ...clientAccount(), userName: 'Tom Köhler', userEmail: 't@test.local', personnelNumber: null, active: true, exitDate: null, canAdjust: true },
        { ...clientAccount({ userId: 6 }), userName: 'Lea Leaver', userEmail: 'l@test.local', personnelNumber: null, active: false, exitDate: '2026-02-27', canAdjust: true }
      ] }
    }
  });
  assert.ok(client.definition.tabs('absenceHome', STAFF).some(tab => tab.route === 'absenceHr'), 'der Reiter HR ist da');
  const requests = await client.pages.absenceHr();
  assert.match(requests, /data-absence-section="requests"/);
  assert.match(requests, /data-absence-section="accounts"/);
  assert.match(requests, /data-absence-section="export"/);
  assert.doesNotMatch(requests, /data-absence-section="holidays"|data-absence-section="settings"/);
  assert.doesNotMatch(requests, /data-absence-decide/);
  assert.match(requests, /Köhler, Tom/);
  assert.match(requests, /data-absence-hr-new="sick"/);
  assert.match(requests, /data-absence-search="requests"/);

  // Die Suche blendet nur aus, findet Umlaute, E-Mail und Personalnummer und zeichnet nichts neu.
  const rows = [
    { dataset: { search: 'Tom Köhler tom@test.local P-7' } },
    { dataset: { search: 'Ayşe Demir ayse@test.local' } }
  ];
  client.list('[data-absence-row="requests"]', rows);
  const input = client.button('[data-absence-search]', { absenceSearch: 'requests' });
  client.definition.bind();
  const search = async text => {
    input.value = text;
    input.oninput();
    return rows.map(row => !row.hidden);
  };
  assert.deepEqual(await search('koehler'), [true, false]);
  assert.deepEqual(await search('köhler'), [true, false]);
  assert.deepEqual(await search('kohler'), [true, false]);
  assert.deepEqual(await search('ayse'), [false, true]);
  assert.deepEqual(await search('AYŞE'), [false, true]);
  assert.deepEqual(await search('p-7'), [true, false]);
  assert.deepEqual(await search('ayse@test'), [false, true]);
  assert.deepEqual(await search('nichts'), [false, false]);
  assert.deepEqual(await search(''), [true, true]);
  assert.equal(client.navigations.length, 0, 'beim Tippen wird nichts neu gezeichnet');

  // Konten: Ausgetretene sind da, aber erst auf Wunsch zu sehen.
  const section = client.button('[data-absence-section]', { absenceSection: 'accounts' });
  client.definition.bind();
  section.onclick();
  const accounts = await client.pages.absenceHr();
  assert.match(accounts, /letzter Arbeitstag 27\.02\.2026/);
  assert.match(accounts, /data-left="1"/);
  assert.match(accounts, /id="absenceShowLeft"/);
  const accountRows = [{ dataset: { search: 'Tom Köhler', left: '0' } }, { dataset: { search: 'Lea Leaver', left: '1' } }];
  client.list('[data-absence-row="accounts"]', accountRows);
  client.button('[data-absence-search]', { absenceSearch: 'accounts' });
  client.definition.bind();
  assert.deepEqual(accountRows.map(row => Boolean(row.hidden)), [false, true]);
  const toggle = client.element('#absenceShowLeft');
  toggle.checked = true;
  toggle.onchange();
  assert.deepEqual(accountRows.map(row => Boolean(row.hidden)), [false, false]);

  // Die Korrektur verlangt einen Grund.
  const edit = client.button('[data-absence-account-edit]', { absenceAccountEdit: '5' });
  client.definition.bind();
  edit.onclick();
  assert.match(client.modals.at(-1).body, /name="reason"[^>]*required/);
});

test('Oberfläche: HR sieht alle Bereiche, Krankheit lässt sich nicht deaktivieren, andere Arten nur nach Rückfrage', async () => {
  const client = loadClient('absence.js', {
    me: ADMIN,
    view: 'absenceHr',
    responses: {
      '/api/absence/requests': { requests: [], truncated: false, limit: 1000 },
      '/api/absence/types': { types: CLIENT_TYPES, approval: { rule: 'manager', decider: 'hr' } },
      '/api/absence/settings': { settings: { defaultEntitlementDays: 30, carryoverExpiryDay: '03-31', state: 'NW', autoCarryover: true, states: { NW: 'Nordrhein-Westfalen' } } }
    }
  });
  const first = await client.pages.absenceHr();
  assert.match(first, /data-absence-section="holidays"/);
  assert.match(first, /data-absence-section="settings"/);
  const section = client.button('[data-absence-section]', { absenceSection: 'settings' });
  client.definition.bind();
  section.onclick();
  const html = await client.pages.absenceHr();
  assert.match(html, /bleibt immer aktiv/);
  assert.equal((html.match(/data-absence-type-toggle=/g) || []).length, 2, 'nur Urlaub und Kur haben den Knopf');
  assert.doesNotMatch(html, /data-absence-type-toggle="2"/);
  assert.match(html, /value="31\.03\."/, 'der Verfallstag steht deutsch im Feld');

  const toggle = client.button('[data-absence-type-toggle]', { absenceTypeToggle: '1', absenceTypeActive: '1', absenceLabel: 'Urlaub' });
  client.definition.bind();
  await toggle.onclick();
  assert.match(client.confirmations[0], /„Urlaub“ wirklich deaktivieren/);
  assert.deepEqual(client.requests.at(-1).body, { active: false });
});

test('Oberfläche: Der Export ohne Monat erklärt sich, statt still zu scheitern', async () => {
  const client = loadClient('absence.js', { me: STAFF, view: 'absenceHr', responses: {} });
  client.definition.bind();
  const month = client.element('#absenceExportMonth');
  const link = client.element('#absenceExportLink');
  month.value = '';
  month.onchange();
  let prevented = false;
  link.onclick({ preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true);
  assert.match(client.toasts[0].message, /Monat/);
  month.value = '2026-03';
  month.onchange();
  assert.match(link.href, /month=2026-03/);
  prevented = false;
  link.onclick({ preventDefault: () => { prevented = true; } });
  assert.equal(prevented, false);
});

test('Oberfläche: Aufgaben führen zum Vorgang, Hinweise lassen sich erledigen', () => {
  const client = loadClient('absence.js', { me: EMPLOYEE, responses: {} });
  const action = type => client.definition.taskAction({ id: 3, type, entity_id: 7 });
  assert.match(action('absence_approval'), /data-absence-review="7"[^>]*>Prüfen/);
  assert.match(action('absence_decided'), /data-view="absenceHome"/);
  assert.match(action('absence_decided'), /data-absence-task-done="3"/);
  assert.match(action('absence_info'), /data-absence-task-done="3"/);
  assert.match(action('absence_info'), /data-view="absenceTeam"/, 'die Führungskraft plant mit dem Kalender');
  const aboutMe = client.definition.taskAction({ id: 3, type: 'absence_info', entity_id: 7, title: 'Deine Abwesenheit wurde storniert: 09.03.2026. Grund: Messe' });
  assert.match(aboutMe, /data-view="absenceHome"/, 'die Person liest den Grund in ihrer Liste');
  assert.match(action('absence_account_notice'), /data-view="absenceHome"/);
  assert.match(action('absence_account_notice'), /data-task-done="3"/);
  assert.equal(action('etwas_anderes'), '');
});

// ------------------------------------------------------------------ Runde 3

test('Lohnexport: Die Personalnummer steht darin, und wer fehlt, steht in der Datei und auf der Seite', async t => {
  const h = await setup(t);
  const staff = addStaff(h);
  const personnel = createPersonnelModule(h.deps);
  personnel.initialize();
  h.db.prepare("INSERT INTO personnel_records (user_id, personnel_number, created_at, updated_at) VALUES (5, '-P-5', 'x', 'x')").run();
  await h.api('anna', 'POST', '/api/absence/requests', { typeId: h.typeId('sick'), startDate: '2026-03-09', endDate: '2026-03-09' });
  await h.api('ben', 'POST', '/api/absence/requests', { typeId: h.typeId('sick'), startDate: '2026-03-10', endDate: '2026-03-10' });

  // Die HR-Leitung sieht alle. Dann gibt es keinen Hinweis, und die Datei bleibt, wie sie ist.
  const full = (await h.api('hr', 'GET', '/api/absence/export?month=2026-03')).data.trim().split('\r\n');
  assert.equal(full[0], 'Name;Personalnummer;E-Mail;Art;Von;Bis;Arbeitstage im Monat');
  assert.equal(full.length, 3);
  assert.equal(full[1], "Anna Ahrens;'-P-5;anna@test.local;Krankheit;09.03.2026;09.03.2026;1", 'auch die Nummer ist vor Formeln geschützt');
  assert.equal(full[2], 'Ben Berg;;ben@test.local;Krankheit;10.03.2026;10.03.2026;1');
  assert.deepEqual((await h.api('hr', 'GET', '/api/absence/export/scope?month=2026-03')).data, { month: '2026-03', withheldPeople: 0, note: null });

  // Die Sachbearbeitung sieht keine HR-Personen, auch sich selbst nicht: drei fehlen.
  const fromStaff = (await h.api(staff, 'GET', '/api/absence/export?month=2026-03')).data.trim().split('\r\n');
  assert.equal(fromStaff.length, 4);
  assert.match(fromStaff.at(-1), /^Hinweis: In dieser Datei fehlen 3 Personen mit HR-Rolle/);
  assert.equal(fromStaff.at(-1).split(';').length, 7, 'gleich viele Spalten wie die anderen Zeilen');
  const scope = (await h.api(staff, 'GET', '/api/absence/export/scope?month=2026-03')).data;
  assert.equal(scope.withheldPeople, 3);
  assert.match(scope.note, /fehlen 3 Personen/);
  assert.equal(h.db.prepare("SELECT new_values FROM audit_log WHERE action = 'absence_exported' ORDER BY id DESC").get().new_values.includes('"rows":2'), true, 'der Hinweis zählt nicht als Zeile');

  // Der HR Business Partner sieht nur die HR-Leitung nicht: Einzahl stimmt.
  const fromPartner = (await h.api('bp', 'GET', '/api/absence/export?month=2026-03')).data.trim().split('\r\n');
  assert.match(fromPartner.at(-1), /^Hinweis: In dieser Datei fehlt 1 Person mit HR-Rolle/);

  // Ehemalige HR-Personen fehlen nur dort, wo sie Einträge haben.
  const own = (await h.api('bp', 'POST', '/api/absence/requests', { typeId: h.typeId('sick'), startDate: '2026-03-11', endDate: '2026-03-11' })).data.id;
  assert.ok(own);
  h.deps.setUserActive(2, false, { id: 1 });
  assert.equal((await h.api(staff, 'GET', '/api/absence/export/scope?month=2026-03')).data.withheldPeople, 3, 'Boris hat im März einen Eintrag');
  assert.equal((await h.api(staff, 'GET', '/api/absence/export/scope?month=2026-04')).data.withheldPeople, 2, 'im April nicht mehr');

  for (const person of ['anna', 'manager', 'director']) {
    assert.equal((await h.api(person, 'GET', '/api/absence/export/scope?month=2026-03')).status, 403, person);
  }
  assert.equal((await h.api(staff, 'GET', '/api/absence/export/scope')).status, 400);
  assert.equal((await h.api(null, 'GET', '/api/absence/export/scope?month=2026-03')).status, 401);
});

test('Genehmigte Abwesenheit absagen: HR nennt den Grund, und die Person erfährt ihn', async t => {
  const h = await setup(t);
  const staff = addStaff(h);
  const approve = async (person, start, end) => {
    const id = (await h.request(person, start, end)).data.id;
    await h.api('manager', 'POST', `/api/absence/requests/${id}/decision`, { decision: 'approve' });
    return id;
  };
  const id = await approve('anna', '2026-03-09', '2026-03-10');
  const listed = (await h.api('hr', 'GET', `/api/absence/requests/${id}`)).data.request;
  assert.equal(listed.cancelNeedsReason, true);

  const missing = await h.api('hr', 'POST', `/api/absence/requests/${id}/cancel`);
  assert.equal(missing.status, 400);
  assert.match(missing.data.error, /Grund/);
  assert.equal((await h.api('hr', 'POST', `/api/absence/requests/${id}/cancel`, { reason: '   ' })).status, 400);
  assert.equal(h.db.prepare('SELECT status FROM absence_requests WHERE id = ?').get(id).status, 'approved', 'nichts ist passiert');

  assert.equal((await h.api('hr', 'POST', `/api/absence/requests/${id}/cancel`, { reason: 'Betriebsversammlung <b>' })).status, 200);
  const told = h.tasksOf(5, 'absence_info');
  assert.equal(told.length, 1);
  assert.match(told[0].title, /09\.03\.2026 bis 10\.03\.2026\. Grund: Betriebsversammlung/);
  const own = (await h.api('anna', 'GET', `/api/absence/requests/${id}`)).data.request;
  assert.equal(own.status, 'cancelled');
  assert.equal(own.cancelReason, 'Betriebsversammlung b', 'die Person sieht den Grund auch in ihrer Liste');
  assert.match(h.db.prepare("SELECT new_values FROM audit_log WHERE action = 'absence_request_cancelled'").get().new_values, /Betriebsversammlung/);
  assert.doesNotMatch(h.tasksOf(4, 'absence_info')[0].title, /Betriebsversammlung/, 'der Grund geht nur an die Person');

  // Die Sachbearbeitung genauso.
  const second = await approve('ben', '2026-03-16', '2026-03-17');
  assert.equal((await h.api(staff, 'POST', `/api/absence/requests/${second}/cancel`)).status, 400);
  assert.equal((await h.api(staff, 'POST', `/api/absence/requests/${second}/cancel`, { reason: 'Falsch beantragt' })).status, 200);

  // Die eigene Abwesenheit storniert man ohne Grund.
  const mine = await approve('ben', '2026-03-23', '2026-03-24');
  const ownCopy = (await h.api('ben', 'GET', `/api/absence/requests/${mine}`)).data.request;
  assert.equal(ownCopy.cancelNeedsReason, false);
  assert.equal((await h.api('ben', 'POST', `/api/absence/requests/${mine}/cancel`)).status, 200);

  // Ein offener Antrag ist noch nicht fest. Ein Grund ist möglich, aber keine Pflicht.
  const pending = (await h.request('anna', '2026-03-30', '2026-03-31')).data.id;
  assert.equal((await h.api('hr', 'GET', `/api/absence/requests/${pending}`)).data.request.cancelNeedsReason, false);
  assert.equal((await h.api('hr', 'POST', `/api/absence/requests/${pending}/cancel`)).status, 200);

  // Vertrauliche Arten bleiben ohne Freitext: Hier soll keine Gesundheitsangabe landen.
  const sick = (await h.api('clara', 'POST', '/api/absence/requests', { typeId: h.typeId('sick'), startDate: '2026-03-09', endDate: '2026-03-09' })).data.id;
  assert.equal((await h.api('hr', 'GET', `/api/absence/requests/${sick}`)).data.request.cancelNeedsReason, false);
  assert.equal((await h.api('hr', 'POST', `/api/absence/requests/${sick}/cancel`, { reason: 'Grippe' })).status, 200);
  assert.equal(h.db.prepare('SELECT cancel_reason FROM absence_requests WHERE id = ?').get(sick).cancel_reason, null);
  assert.doesNotMatch(JSON.stringify(h.tasksOf(7, 'absence_info')), /Grippe/);
});

test('Ältere Abwesenheit: Die Person bittet HR um Korrektur, ohne Art und ohne Freitext', async t => {
  const h = await setup(t);
  const sick = (await h.api('anna', 'POST', '/api/absence/requests', { typeId: h.typeId('sick'), startDate: '2026-03-02', endDate: '2026-03-03' })).data.id;
  const correct = (person, id = sick) => h.api(person, 'POST', `/api/absence/requests/${id}/correction`, { reason: 'Grippe' });

  // Heute begonnen: selbst stornierbar, also keine Bitte nötig.
  let own = (await h.api('anna', 'GET', `/api/absence/requests/${sick}`)).data.request;
  assert.equal(own.canCancel, true);
  assert.equal(own.canRequestCorrection, false);
  assert.equal((await correct('anna')).status, 409);

  h.clock.date = '2026-03-05';
  own = (await h.api('anna', 'GET', `/api/absence/requests/${sick}`)).data.request;
  assert.equal(own.canCancel, false);
  assert.equal(own.canRequestCorrection, true);
  assert.equal(own.correctionRequested, false);

  assert.equal((await correct('ben')).status, 403);
  assert.equal((await correct('manager')).status, 403);
  assert.equal((await correct('hr')).status, 403, 'HR braucht keine Bitte');
  assert.equal((await h.api('anna', 'POST', '/api/absence/requests/9999/correction')).status, 404);

  assert.equal((await correct('anna')).status, 200);
  const tasks = h.tasksOf(1, 'absence_correction_notice');
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].entity_id, sick);
  assert.equal(tasks[0].title, 'Korrektur gewünscht: Anna Ahrens, Abwesenheit 02.03.2026 bis 03.03.2026');
  assert.doesNotMatch(tasks[0].title, /krank|Grippe/i);
  assert.equal(h.tasksOf(4, 'absence_correction_notice').length, 0, 'die Führungskraft bekommt das nicht');
  assert.doesNotMatch(JSON.stringify(h.db.prepare("SELECT * FROM audit_log WHERE action = 'absence_correction_requested'").all()), /krank|Grippe/i);

  // Zweimal klicken ergibt keine zweite Aufgabe, und die Person sieht, dass es läuft.
  const again = await correct('anna');
  assert.equal(again.status, 200);
  assert.equal(again.data.alreadyRequested, true);
  assert.equal(h.tasksOf(1, 'absence_correction_notice').length, 1);
  assert.equal((await h.api('anna', 'GET', `/api/absence/requests/${sick}`)).data.request.correctionRequested, true);
  assert.equal((await h.api('hr', 'GET', `/api/absence/requests/${sick}`)).data.request.correctionRequested, false, 'das Feld gilt nur für die Person selbst');

  // Korrigiert HR, ist die Aufgabe erledigt.
  assert.equal((await h.api('hr', 'POST', `/api/absence/requests/${sick}/cancel`)).status, 200);
  assert.equal(h.tasksOf(1, 'absence_correction_notice').length, 0);
  assert.equal((await correct('anna')).status, 409, 'schon storniert');

  // Ist niemand da, sagt der Server das.
  const other = (await h.api('hr', 'POST', '/api/absence/requests', { userId: 7, typeId: h.typeId('sick'), startDate: '2026-03-02', endDate: '2026-03-02' })).data.id;
  h.db.prepare("UPDATE users SET active = 0 WHERE id IN (1, 2)").run();
  const nobody = await h.api('clara', 'POST', `/api/absence/requests/${other}/correction`);
  assert.equal(nobody.status, 409);
  assert.match(nobody.data.error, /niemand/);
});

test('Sortierung: Ein Name mit Komma nennt seinen Nachnamen selbst', async t => {
  const h = await setup(t);
  const add = h.db.prepare("INSERT INTO users (id, name, email, password_hash, role, manager_id) VALUES (?, ?, ?, '!', 'employee', 3)");
  add.run(30, 'Müller, Anna', 'mueller@test.local');
  add.run(31, 'Lisa Mahler', 'mahler@test.local');
  const names = (await h.api('hr', 'GET', '/api/absence/accounts?year=2026')).data.accounts.map(account => account.userName);
  assert.ok(names.indexOf('Lisa Mahler') < names.indexOf('Malte Manager'), names.join(', '));
  assert.ok(names.indexOf('Malte Manager') < names.indexOf('Müller, Anna'), 'unter M, nicht unter A');
  assert.ok(names.indexOf('Müller, Anna') < names.indexOf('Boris Partner'), names.join(', '));
});

test('Oberfläche: Namen mit Komma bleiben, wie sie sind, und die Suche findet jedes Wort in jeder Reihenfolge', async () => {
  const account = (more = {}) => ({ ...clientAccount(), userName: 'Tom Köhler', userEmail: 't@test.local', personnelNumber: null, active: true, exitDate: null, canAdjust: true, ...more });
  const client = loadClient('absence.js', {
    me: STAFF,
    view: 'absenceHr',
    responses: {
      '/api/absence/requests': { requests: [], truncated: false, limit: 1000 },
      '/api/absence/types': { types: CLIENT_TYPES, approval: { rule: 'manager', decider: 'hr' } },
      '/api/absence/accounts': { year: 2026, accounts: [
        account({ userId: 30, userName: 'Müller, Anna' }),
        account({ userId: 31, userName: 'Lena Schmitt', userEmail: 'lena.a@test.local' }),
        account({ userId: 32, userName: 'Lena Schmitt', userEmail: 'lena.b@test.local' }),
        account({ userId: 33, userName: 'Einstein' })
      ] }
    }
  });
  await client.pages.absenceHr();
  const section = client.button('[data-absence-section]', { absenceSection: 'accounts' });
  client.definition.bind();
  section.onclick();
  const accounts = await client.pages.absenceHr();
  assert.match(accounts, /<b>Müller, Anna<\/b>/);
  assert.doesNotMatch(accounts, /Anna, Müller/);
  assert.match(accounts, /<b>Einstein<\/b>/);
  assert.match(accounts, /lena\.a@test\.local/, 'gleiche Namen unterscheidet die E-Mail');
  assert.equal(accounts.includes('t@test.local</small>'), false, 'alle anderen bleiben kurz');

  // In der Auswahl beim Erfassen ebenso.
  const newButton = client.button('[data-absence-hr-new]', { absenceHrNew: 'sick' });
  client.definition.bind();
  await newButton.onclick();
  const body = client.modals.at(-1).body;
  assert.match(body, />Schmitt, Lena · lena\.a@test\.local</);
  assert.match(body, />Schmitt, Lena · lena\.b@test\.local</);
  assert.match(body, />Müller, Anna</);

  const rows = [{ dataset: { search: 'Anna Schäfer anna@test.local' } }, { dataset: { search: 'Anna Berg P-7' } }, { dataset: { search: 'Müller, Anna' } }];
  client.list('[data-absence-row="requests"]', rows);
  const input = client.button('[data-absence-search]', { absenceSearch: 'requests' });
  client.definition.bind();
  const search = text => {
    input.value = text;
    input.oninput();
    return rows.map(row => !row.hidden);
  };
  assert.deepEqual(search('Schäfer, Anna'), [true, false, false]);
  assert.deepEqual(search('anna schaefer'), [true, false, false]);
  assert.deepEqual(search('schafer anna'), [true, false, false]);
  assert.deepEqual(search('Anna Müller'), [false, false, true]);
  assert.deepEqual(search('anna p-7'), [false, true, false]);
  assert.deepEqual(search('Anna, Köhler'), [false, false, false], 'jedes Wort muss vorkommen');
  assert.deepEqual(search(' , '), [true, true, true]);
});

test('Oberfläche: Die Krankmeldung sagt ehrlich, was die Führungskraft erfährt', async () => {
  const client = ownPage({ rule: 'manager', decider: 'manager', name: 'Malte Manager' });
  await client.pages.absenceHome();
  const button = client.button('[data-absence-sick]');
  client.definition.bind();
  button.onclick();
  const body = client.modals.at(-1).body;
  assert.match(body, /Deine Führungskraft erfährt, dass du fehlst/);
  assert.match(body, /Die Art wird ihr nicht genannt, sie kann sie sich aber denken/);
  assert.match(body, /Dein Team sieht nur „abwesend“/);
  assert.doesNotMatch(body, /auch deine Führungskraft, sehen nur/);

  const h = await createModuleHarness(createAbsenceModule);
  try {
    const article = h.instance.helpArticles.find(item => item.id === 'absence-sick');
    assert.match(article.answer, /Die Art wird ihr nicht genannt, sie kann sie sich aber denken/);
    assert.doesNotMatch(article.answer, /auch deine Führungskraft, sehen nur/);
  } finally {
    await h.close();
  }
});

test('Oberfläche: Der Kalender öffnet im Monat des Antrags', async () => {
  const pageFor = requests => loadClient('absence.js', {
    me: { id: 4, role: 'manager', name: 'Malte Manager' },
    view: 'absenceTeam',
    responses: {
      '/api/absence/approvals': { requests, rule: 'manager' },
      '/api/absence/calendar': { month: '2027-03', firstDay: '2027-03-01', lastDay: '2027-03-31', today: '2026-11-05', holidays: [], entries: [], people: [{ id: 4, name: 'Malte Manager', relation: 'self' }] },
      '/api/absence/requests/7': { request: clientRequest({ startDate: '2027-05-03', endDate: '2027-05-04' }) }
    }
  });
  const open = clientRequest({ startDate: '2027-03-08', endDate: '2027-03-09', restDays: 28, canDecide: true, overlaps: [] });

  const client = pageFor([open]);
  const html = await client.pages.absenceTeam();
  assert.match(client.requests.find(item => item.url.startsWith('/api/absence/calendar')).url, /month=2027-03/);
  assert.match(html, /data-absence-show-month="2027-03"/);
  assert.match(html, /data-absence-month="2026-11"[^>]*>Aktueller Monat/, 'zurück zum heutigen Monat geht mit einem Klick');

  const empty = pageFor([]);
  await empty.pages.absenceTeam();
  assert.match(empty.requests.find(item => item.url.startsWith('/api/absence/calendar')).url, new RegExp(`month=${new Date().getFullYear()}-`), 'ohne Antrag der aktuelle Monat');

  // „Im Kalender zeigen“ springt dorthin, eine eigene Monatswahl bleibt bestehen.
  const show = client.button('[data-absence-show-month]', { absenceShowMonth: '2027-04' });
  client.definition.bind();
  show.onclick();
  client.definition.bind();
  assert.equal(client.element('#absenceCalendarCard').scrolled, true);
  await client.pages.absenceTeam();
  assert.match(client.requests.filter(item => item.url.startsWith('/api/absence/calendar')).at(-1).url, /month=2027-04/);

  // „Prüfen“ auf der Übersicht zeigt genau den Monat dieses Antrags.
  assert.match(client.definition.taskAction({ id: 3, type: 'absence_approval', entity_id: 7 }), /data-absence-review="7"/);
  const review = client.button('[data-absence-review]', { absenceReview: '7' });
  client.definition.bind();
  await review.onclick();
  assert.equal(client.navigations.at(-1), 'absenceTeam');
  await client.pages.absenceTeam();
  assert.match(client.requests.filter(item => item.url.startsWith('/api/absence/calendar')).at(-1).url, /month=2027-05/);

  // Ist der Antrag nicht mehr zu lesen, führt der Knopf trotzdem zur Liste.
  const gone = pageFor([]);
  const stale = gone.button('[data-absence-review]', { absenceReview: '999' });
  gone.definition.bind();
  await stale.onclick();
  assert.equal(gone.navigations.at(-1), 'absenceTeam');
  assert.equal(gone.toasts.length, 0);
});

test('Oberfläche: Absagen mit Grund, Korrektur bei HR, Hinweis im Export und geschützte Seiten', async () => {
  // HR sagt eine genehmigte Abwesenheit ab: Dialog statt kurzer Rückfrage.
  const hr = loadClient('absence.js', {
    me: ADMIN,
    view: 'absenceHr',
    responses: {
      '/api/absence/requests': { requests: [clientRequest({ status: 'approved', cancelNeedsReason: true, pendingWith: null })], truncated: false, limit: 1000 },
      '/api/absence/types': { types: CLIENT_TYPES, approval: { rule: 'manager', decider: 'hr' } }
    }
  });
  const list = await hr.pages.absenceHr();
  assert.match(list, /data-absence-cancel-reason="1"/);
  const cancel = hr.button('[data-absence-cancel]', { absenceCancel: '7', absenceLabel: 'Tom Köhler: 09.03.2026', absenceCancelReason: '1' });
  hr.definition.bind();
  await cancel.onclick();
  assert.equal(hr.confirmations.length, 0);
  const modal = hr.modals.at(-1);
  assert.match(modal.subtitle, /Tom Köhler: 09\.03\.2026/);
  assert.match(modal.body, /name="reason"[^>]*required/);
  await modal.onSubmit({ reason: 'Betriebsversammlung' });
  assert.deepEqual(hr.requests.at(-1), { url: '/api/absence/requests/7/cancel', method: 'POST', body: { reason: 'Betriebsversammlung' } });

  // Die Person sieht den Grund, und was nur HR ändert, lässt sich dort anfragen.
  const own = ownPage({ rule: 'manager', decider: 'manager', name: 'M' }, {
    requests: [
      clientRequest({ id: 8, status: 'cancelled', cancelReason: 'Betriebsversammlung', pendingWith: null, canCancel: false }),
      clientRequest({ id: 9, status: 'approved', requiresApproval: false, typeName: 'Krankheit', pendingWith: null, canCancel: false, canRequestCorrection: true }),
      clientRequest({ id: 10, status: 'approved', requiresApproval: false, typeName: 'Krankheit', pendingWith: null, canCancel: false, canRequestCorrection: true, correctionRequested: true })
    ]
  });
  const html = await own.pages.absenceHome();
  assert.match(html, /Grund: Betriebsversammlung/);
  assert.match(html, /data-absence-correction="9"/);
  assert.doesNotMatch(html, /data-absence-correction="10"/);
  assert.match(html, /Korrektur bei HR angefragt/);
  const ask = own.button('[data-absence-correction]', { absenceCorrection: '9' });
  own.definition.bind();
  await ask.onclick();
  assert.equal(own.requests.at(-1).url, '/api/absence/requests/9/correction');
  assert.match(own.toasts.at(-1).message, /HR hat deine Bitte/);

  // Die Aufgabe bei HR führt zum Eintrag.
  const task = loadClient('absence.js', { me: ADMIN, view: 'dashboard', responses: { '/api/absence/requests/9': { request: clientRequest({ startDate: '2025-12-29', endDate: '2025-12-30' }) }, '/api/absence/requests': { requests: [], truncated: false, limit: 1000 }, '/api/absence/types': { types: [], approval: {} } } });
  const action = task.definition.taskAction({ id: 3, type: 'absence_correction_notice', entity_id: 9 });
  assert.match(action, /data-absence-correction-open="9"/);
  assert.match(action, /data-task-done="3"/);
  const open = task.button('[data-absence-correction-open]', { absenceCorrectionOpen: '9' });
  task.definition.bind();
  await open.onclick();
  assert.equal(task.navigations.at(-1), 'absenceHr');
  await task.pages.absenceHr();
  assert.match(task.requests.at(-2).url, /year=2025/);

  // Der Export nennt auf der Seite, wer fehlt, passend zum Monat.
  const exporting = loadClient('absence.js', { me: STAFF, view: 'absenceHr', responses: { '/api/absence/export/scope': { note: 'Hinweis: In dieser Datei fehlen 3 Personen mit HR-Rolle.' }, '/api/absence/requests': { requests: [], truncated: false, limit: 1000 }, '/api/absence/types': { types: [], approval: {} } } });
  await exporting.pages.absenceHr();
  const section = exporting.button('[data-absence-section]', { absenceSection: 'export' });
  exporting.definition.bind();
  section.onclick();
  const exportHtml = await exporting.pages.absenceHr();
  assert.match(exportHtml, /id="absenceExportNote">Hinweis: In dieser Datei fehlen 3 Personen/);
  exporting.definition.bind();
  const month = exporting.element('#absenceExportMonth');
  month.value = '2026-02';
  await month.onchange();
  assert.match(exporting.requests.at(-1).url, /scope\?month=2026-02/);
  assert.equal(exporting.element('#absenceExportNote').hidden, false);
  assert.match(exporting.element('#absenceExportNote').textContent, /fehlen 3 Personen/);

  // Seiten nur für bestimmte Rollen.
  const allowed = own.definition.allowed;
  assert.equal(allowed('absenceHr', EMPLOYEE), false);
  assert.equal(allowed('absenceHr', { role: 'manager' }), false);
  assert.equal(allowed('absenceHr', STAFF), true);
  assert.equal(allowed('absenceHr', ADMIN), true);
  assert.equal(allowed('absenceHome', { role: 'super_admin' }), false);
  assert.equal(allowed('absenceHome', EMPLOYEE), true);
  assert.equal(allowed('absenceTeam', EMPLOYEE), true);
  assert.equal(allowed('dashboard', EMPLOYEE), true, 'fremde Seiten gehen dieses Modul nichts an');
});

test('Oberfläche: Die Legende sagt in Worten, was die Farben bedeuten', async () => {
  const html = await loadClient('absence.js', {
    me: EMPLOYEE,
    view: 'absenceTeam',
    responses: {
      '/api/absence/approvals': { requests: [], rule: 'manager' },
      '/api/absence/calendar': { month: '2026-03', firstDay: '2026-03-01', lastDay: '2026-03-31', today: '2026-03-02', holidays: [], entries: [], people: [{ id: 5, name: 'Anna Ahrens', relation: 'self' }] }
    }
  }).pages.absenceTeam();
  assert.doesNotMatch(html, /Mit Art/);
  assert.match(html, /Genehmigt, Art für dich sichtbar/);
});

test('Oberfläche: Die Voreinstellungen lassen sich nicht doppelt absenden', async () => {
  const client = loadClient('absence.js', { me: ADMIN, view: 'absenceHr', responses: {} });
  client.definition.bind();
  const form = client.element('#absenceSettingsForm');
  const submit = { disabled: false };
  form.values = { defaultEntitlementDays: '30', carryoverExpiryDay: '31.03.', state: 'NW' };
  form.elements = { autoCarryover: { checked: true } };
  form.querySelector = selector => (selector === 'button' ? submit : { textContent: '' });
  form.onsubmit({ preventDefault() {} });
  assert.equal(submit.disabled, true, 'läuft: der Knopf ist gesperrt');
  form.onsubmit({ preventDefault() {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(client.requests.filter(item => item.method === 'PUT').length, 1);
  assert.equal(client.requests.find(item => item.method === 'PUT').body.carryoverExpiryDay, '03-31');
  assert.equal(submit.disabled, false, 'danach geht es wieder');
});
