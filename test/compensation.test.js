const assert = require('node:assert/strict');
const { afterEach, beforeEach, test } = require('node:test');
const express = require('express');
const { createModuleHarness } = require('../lib/testing/module-harness');
const { moduleForPath, moduleForTaskType } = require('../lib/module-catalog');
const {
  createCompensationModule,
  csvField,
  mulDivRound,
  parseFteToBasisPoints,
  parseMoneyToCents,
  parsePercentToBasisPoints,
  salaryMetrics
} = require('../routes/compensation');

const SYSTEM_ID = 99;
const PAST = '2020-01-01';
const FUTURE = '2099-01-01';
const TODAY = new Date().toISOString().slice(0, 10);

/** Wie in der echten Laufzeit: Die Systemadministration ist ein technisches Konto mit Rolle super_admin. */
function moduleWithSystemAdmin(deps) {
  deps.db.prepare("INSERT INTO users(id,name,email,password_hash,role,is_system_account) VALUES(?,?,?,'!ENV_MANAGED!','hr_admin',1)")
    .run(SYSTEM_ID, 'Systemadministration', 'system-root@daybreak.internal');
  const current = req => {
    if (Number(req.get('x-test-user')) === SYSTEM_ID) {
      return { id: SYSTEM_ID, name: 'Systemadministration', email: 'root@root.de', role: 'super_admin', title: null, manager_id: null };
    }
    return deps.current(req);
  };
  const auth = (req, res, next) => (current(req) ? next() : res.status(401).json({ error: 'Nicht angemeldet' }));
  return createCompensationModule({ ...deps, current, auth });
}

let h;
beforeEach(async () => {
  h = await createModuleHarness(moduleWithSystemAdmin);
});
afterEach(() => h.close());

function expectStatus(response, status) {
  assert.equal(response.status, status, JSON.stringify(response.data));
  return response.data;
}

function addPerson(id, managerId, role = 'employee') {
  h.db.prepare("INSERT INTO users(id,name,email,password_hash,role,manager_id) VALUES(?,?,?,'!TEST!',?,?)")
    .run(id, `Person ${id}`, `person${id}@test.local`, role, managerId);
}

async function createGrade(overrides = {}) {
  const body = { name: 'Band A', min: '40.000,00', mid: '50.000,00', max: '60.000,00', validFrom: PAST, ...overrides };
  return expectStatus(await h.api('hr', 'POST', '/api/compensation/grades', body), 201).grade;
}

async function addRecord(person, annualSalary, overrides = {}, actor = 'hr') {
  const id = h.people[person]?.id ?? person;
  const body = { effectiveDate: PAST, annualSalary, reason: 'hire', ...overrides };
  return expectStatus(await h.api(actor, 'POST', `/api/compensation/people/${id}/records`, body), 201);
}

async function createCycle(overrides = {}) {
  const body = { name: 'Runde 2030', budgetMode: 'percent', budgetPercent: '3', effectiveDate: '2030-01-01', ...overrides };
  return expectStatus(await h.api('hr', 'POST', '/api/compensation/cycles', body), 201).cycle;
}

async function openCycle(cycleId, body = {}) {
  return expectStatus(await h.api('hr', 'POST', `/api/compensation/cycles/${cycleId}/open`, body), 200);
}

/** Band, Einträge für das Team von manager (anna, ben) und director (manager, clara), Runde offen. */
async function openRoundWithTeam(cycleOverrides = {}) {
  const grade = await createGrade({ max: '90.000,00' });
  await addRecord('anna', '50.000,00', { gradeId: grade.id });
  await addRecord('ben', '60.000,00', { gradeId: grade.id });
  await addRecord('clara', '40.000,00', { gradeId: grade.id });
  await addRecord('manager', '55.000,00', { gradeId: grade.id });
  const cycle = await createCycle(cycleOverrides);
  await openCycle(cycle.id);
  return { grade, cycleId: cycle.id };
}

const proposalUrl = (cycleId, person) => `/api/compensation/team/${cycleId}/proposals/${h.people[person].id}`;
const decisionUrl = (cycleId, person) => `/api/compensation/cycles/${cycleId}/decisions/${h.people[person].id}`;

async function propose(actor, cycleId, person, body) {
  return expectStatus(await h.api(actor, 'PUT', proposalUrl(cycleId, person), body), 200);
}

// ------------------------------------------------------------------------------------------
// Anmeldung und Katalog
// ------------------------------------------------------------------------------------------

test('Ohne Anmeldung gibt es überall 401', async () => {
  const routes = [
    ['GET', '/api/compensation/access'],
    ['GET', '/api/compensation/me'],
    ['GET', '/api/compensation/grades'],
    ['POST', '/api/compensation/grades'],
    ['PATCH', '/api/compensation/grades/1'],
    ['GET', '/api/compensation/people'],
    ['GET', '/api/compensation/people/5'],
    ['POST', '/api/compensation/people/5/records'],
    ['GET', '/api/compensation/cycles'],
    ['POST', '/api/compensation/cycles'],
    ['GET', '/api/compensation/cycles/1'],
    ['POST', '/api/compensation/cycles/1/open'],
    ['POST', '/api/compensation/cycles/1/review'],
    ['POST', '/api/compensation/cycles/1/close'],
    ['POST', '/api/compensation/cycles/1/approve-open'],
    ['POST', '/api/compensation/cycles/1/decisions/5'],
    ['POST', '/api/compensation/cycles/1/participants'],
    ['GET', '/api/compensation/team'],
    ['GET', '/api/compensation/team/results'],
    ['PUT', '/api/compensation/team/1/proposals/5'],
    ['GET', '/api/compensation/area-summary'],
    ['GET', '/api/compensation/analytics'],
    ['GET', '/api/compensation/export.csv']
  ];
  for (const [method, url] of routes) {
    const response = await h.api(null, method, url, method === 'GET' ? undefined : {});
    assert.equal(response.status, 401, `${method} ${url}`);
  }
});

test('Pfade und Aufgaben gehören zum Modul, damit der Modulschalter greift', () => {
  assert.equal(moduleForPath('/compensation/export.csv'), 'compensation');
  assert.equal(moduleForPath('/compensation/team/1/proposals/5'), 'compensation');
  assert.equal(moduleForTaskType('compensation_proposal'), 'compensation');
  assert.equal(moduleForTaskType('compensation_result_notice'), 'compensation');
});

// ------------------------------------------------------------------------------------------
// Rechnen in Cent
// ------------------------------------------------------------------------------------------

test('Beträge werden exakt in Cent umgewandelt', () => {
  const valid = [
    ['0,07', 7],
    ['1,10', 110],
    ['1,1', 110],
    ['19,99', 1999],
    ['52.345,67', 5234567],
    ['1.000.000,00', 100000000],
    ['52345.67', 5234567],
    ['52345', 5234500],
    ['12.345', 1234500],
    ['1.23', 123],
    ['  52 345,67 € ', 5234567],
    [19.99, 1999],
    [4.35, 435],
    [1.1, 110],
    [50000, 5000000],
    ['0', 0]
  ];
  for (const [input, cents] of valid) assert.equal(parseMoneyToCents(input), cents, String(input));

  // 1.005 * 100 ergäbe mit Fließkomma 100.49999, 0.1 + 0.2 ergäbe 0.30000000000000004.
  const invalid = [1.005, 0.1 + 0.2, 1.234, '1,005', '1.2345', '-5', -5, 'abc', '', null, undefined, {}, [], NaN, Infinity, 1e21, '100000000,01', '1,2,3'];
  for (const input of invalid) assert.equal(parseMoneyToCents(input), null, String(input));
});

test('Prozent und Stellenumfang werden ganzzahlig gespeichert', () => {
  assert.equal(parsePercentToBasisPoints('3,5'), 350);
  assert.equal(parsePercentToBasisPoints(3.33), 333);
  assert.equal(parsePercentToBasisPoints('2,75 %'), 275);
  assert.equal(parsePercentToBasisPoints('0'), 0);
  assert.equal(parsePercentToBasisPoints('100'), 10000);
  for (const input of ['3,333', '100,01', '-1', 'x', '', null]) assert.equal(parsePercentToBasisPoints(input), null, String(input));

  assert.equal(parseFteToBasisPoints('0,8'), 8000);
  assert.equal(parseFteToBasisPoints(0.5), 5000);
  assert.equal(parseFteToBasisPoints('0,875'), 8750);
  assert.equal(parseFteToBasisPoints(1), 10000);
  for (const input of [0, '0', '0,0', 1.5, '1,0001', 2, -0.5, 'voll', '', null]) assert.equal(parseFteToBasisPoints(input), null, String(input));
});

test('Rundung ist kaufmännisch und bleibt bei großen Zahlen exakt', () => {
  assert.equal(mulDivRound(5, 5000, 10000), 3);
  assert.equal(mulDivRound(1, 1, 2), 1);
  assert.equal(mulDivRound(1, 1, 3), 0);
  assert.equal(mulDivRound(2, 1, 3), 1);
  assert.equal(mulDivRound(-5, 1, 2), -3);
  // 3,33 % von 50.001,00 sind 1.665,0333 und damit 1.665,03.
  assert.equal(mulDivRound(5000100, 333, 10000), 166503);
  assert.equal(mulDivRound(9_000_000_000_000, 9_999, 10_000), 8_999_100_000_000);
  // Das Zwischenergebnis ist größer als 2^53: Mit Fließkomma käme hier ein Cent zu wenig heraus.
  assert.equal(mulDivRound(7_206_527_975_000, 9_999, 10_000), 7_205_807_322_203);
});

test('Prozentvorschlag wird in Cent gerundet und nicht in Fließkomma gerechnet', async () => {
  const grade = await createGrade({ max: '90.000,00' });
  await addRecord('anna', '33.333,33', { gradeId: grade.id });
  await addRecord('ben', '50.001,00', { gradeId: grade.id });
  const cycle = await createCycle({ budgetPercent: '50' });
  await openCycle(cycle.id);

  const anna = await propose('manager', cycle.id, 'anna', { mode: 'percent', value: '1,1' });
  // 33.333,33 * 1,1 % = 366,66663, also 366,67.
  assert.equal(anna.row.proposal.increaseCents, 36667);
  assert.equal(anna.row.proposal.proposedSalaryCents, 3370000);

  const ben = await propose('manager', cycle.id, 'ben', { mode: 'percent', value: '3,33' });
  assert.equal(ben.row.proposal.increaseCents, 166503);
  assert.equal(ben.row.proposal.proposedSalaryCents, 5166603);

  const stored = h.db.prepare('SELECT increase_cents, proposed_salary_cents FROM compensation_proposals ORDER BY user_id').all();
  for (const row of stored) {
    assert.ok(Number.isInteger(row.increase_cents));
    assert.ok(Number.isInteger(row.proposed_salary_cents));
  }
});

test('Compa-Ratio und Bandposition beziehen sich bei Teilzeit auf Vollzeit', async () => {
  const grade = await createGrade({ min: '50.000,00', mid: '60.000,00', max: '70.000,00' });

  const half = (await addRecord('anna', '30.000,00', { gradeId: grade.id, fte: '0,5' })).record;
  assert.equal(half.metrics.fullTimeCents, 6000000);
  assert.equal(half.metrics.compaRatio, 1);
  assert.equal(half.metrics.rangePositionPercent, 50);
  assert.equal(half.metrics.bandStatus, 'inside');
  assert.deepEqual(half.warnings, []);

  const fourFifths = (await addRecord('ben', '52.800,00', { gradeId: grade.id, fte: 0.8 })).record;
  assert.equal(fourFifths.metrics.fullTimeCents, 6600000);
  assert.equal(fourFifths.metrics.compaRatio, 1.1);
  assert.equal(fourFifths.metrics.rangePositionPercent, 80);

  // Dasselbe Gehalt in Vollzeit läge weit unter dem Band.
  const fullTime = (await addRecord('clara', '30.000,00', { gradeId: grade.id })).record;
  assert.equal(fullTime.metrics.compaRatio, 0.5);
  assert.equal(fullTime.metrics.bandStatus, 'below');

  const noBand = salaryMetrics(3000000, 7500, null);
  assert.equal(noBand.fullTimeCents, 4000000);
  assert.equal(noBand.compaRatio, null);
  assert.equal(noBand.bandStatus, 'no_band');

  const repeating = salaryMetrics(3333333, 7500, { minCents: 1, midCents: 4444444, maxCents: 9999999 });
  assert.equal(repeating.fullTimeCents, 4444444);
  assert.equal(repeating.compaRatio, 1);
});

// ------------------------------------------------------------------------------------------
// Gehaltsbänder
// ------------------------------------------------------------------------------------------

test('Bänder: HR verwaltet, HRBP liest nur, andere sehen nichts', async () => {
  const grade = await createGrade();
  assert.equal(grade.currency, 'EUR');
  assert.equal(grade.minCents, 4000000);
  assert.equal(grade.midCents, 5000000);
  assert.equal(grade.maxCents, 6000000);

  const fromSystem = await h.api(SYSTEM_ID, 'POST', '/api/compensation/grades', { name: 'Band B', min: '1', mid: '2', max: '3', validFrom: PAST });
  expectStatus(fromSystem, 201);

  assert.equal(expectStatus(await h.api('bp', 'GET', '/api/compensation/grades'), 200).grades.length, 2);

  const write = { name: 'Fremd', min: '1', mid: '2', max: '3', validFrom: PAST };
  assert.equal((await h.api('bp', 'POST', '/api/compensation/grades', write)).status, 403);
  assert.equal((await h.api('bp', 'PATCH', `/api/compensation/grades/${grade.id}`, { name: 'X' })).status, 403);
  for (const person of ['director', 'manager', 'anna']) {
    assert.equal((await h.api(person, 'GET', '/api/compensation/grades')).status, 403, person);
    assert.equal((await h.api(person, 'POST', '/api/compensation/grades', write)).status, 403, person);
    assert.equal((await h.api(person, 'PATCH', `/api/compensation/grades/${grade.id}`, { name: 'X' })).status, 403, person);
  }
});

test('Bänder: ungültige Eingaben werden abgewiesen', async () => {
  const valid = { name: 'Band', min: '40.000', mid: '50.000', max: '60.000', validFrom: PAST };
  const invalid = [
    { ...valid, name: '' },
    { ...valid, min: '60.000,00', mid: '50.000,00' },
    { ...valid, mid: '70.000,00' },
    { ...valid, min: '0' },
    { ...valid, min: '-1' },
    { ...valid, max: 'viel' },
    { ...valid, mid: '50.000,001' },
    { ...valid, validFrom: '2026-02-30' },
    { ...valid, validFrom: 'heute' },
    { ...valid, validFrom: undefined },
    { ...valid, currency: 'Euro' },
    { ...valid, active: 'ja' }
  ];
  for (const body of invalid) {
    assert.equal((await h.api('hr', 'POST', '/api/compensation/grades', body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await h.api('hr', 'POST', '/api/compensation/grades')).status, 400);

  expectStatus(await h.api('hr', 'POST', '/api/compensation/grades', valid), 201);
  assert.equal((await h.api('hr', 'POST', '/api/compensation/grades', valid)).status, 409);
  assert.equal(expectStatus(await h.api('hr', 'POST', '/api/compensation/grades', { ...valid, min: '50.000', mid: '50.000', max: '50.000', name: 'Eng' }), 201).grade.minCents, 5000000);
});

test('Bänder ändern: Prüfung bleibt, Währung ist nach Verwendung fest, unbekannte IDs geben 404', async () => {
  const grade = await createGrade();
  assert.equal(expectStatus(await h.api('hr', 'PATCH', `/api/compensation/grades/${grade.id}`, { max: '65.000,00' }), 200).grade.maxCents, 6500000);
  assert.equal((await h.api('hr', 'PATCH', `/api/compensation/grades/${grade.id}`, { min: '70.000,00' })).status, 400);
  assert.equal((await h.api('hr', 'PATCH', '/api/compensation/grades/9999', { name: 'X' })).status, 404);
  assert.equal((await h.api('hr', 'PATCH', '/api/compensation/grades/abc', { name: 'X' })).status, 404);

  assert.equal(expectStatus(await h.api('hr', 'PATCH', `/api/compensation/grades/${grade.id}`, { currency: 'CHF' }), 200).grade.currency, 'CHF');
  await addRecord('anna', '50.000', { gradeId: grade.id, currency: 'CHF' });
  assert.equal((await h.api('hr', 'PATCH', `/api/compensation/grades/${grade.id}`, { currency: 'EUR' })).status, 409);
});

// ------------------------------------------------------------------------------------------
// Vergütungshistorie
// ------------------------------------------------------------------------------------------

test('Historie: nie überschreibend, aktueller Stand ist der jüngste Eintrag bis heute', async () => {
  const grade = await createGrade();
  await addRecord('anna', '40.000,00', { effectiveDate: '2021-01-01' });
  await addRecord('anna', '45.000,00', { effectiveDate: '2023-01-01', reason: 'cycle', gradeId: grade.id });
  // Nachgetragen, aber älter: ändert den aktuellen Stand nicht.
  await addRecord('anna', '42.000,00', { effectiveDate: '2022-01-01', reason: 'correction' });
  await addRecord('anna', '70.000,00', { effectiveDate: FUTURE, reason: 'promotion' });

  const detail = expectStatus(await h.api('hr', 'GET', '/api/compensation/people/5'), 200);
  assert.equal(detail.current.annualSalaryCents, 4500000);
  assert.equal(detail.current.reasonLabel, 'Gehaltsrunde');
  assert.equal(detail.current.createdBy, 'Hanna HR');
  assert.ok(detail.current.createdAt);
  assert.deepEqual(detail.history.map(record => record.effectiveDate), [FUTURE, '2023-01-01', '2022-01-01', '2021-01-01']);
  assert.equal(detail.history[0].future, true);
  assert.equal(detail.history[1].future, false);

  // Gleiches Datum: Der später erfasste Eintrag gilt, der frühere bleibt erhalten.
  await addRecord('anna', '46.000,00', { effectiveDate: '2023-01-01', reason: 'correction' });
  const corrected = expectStatus(await h.api('hr', 'GET', '/api/compensation/people/5'), 200);
  assert.equal(corrected.current.annualSalaryCents, 4600000);
  assert.equal(corrected.history.length, 5);

  // Gültig ab heute zählt schon.
  await addRecord('anna', '47.000,00', { effectiveDate: TODAY, reason: 'other' });
  assert.equal(expectStatus(await h.api('hr', 'GET', '/api/compensation/people/5'), 200).current.annualSalaryCents, 4700000);

  // Es gibt keinen Weg, einen Eintrag zu überschreiben: weder über die Schnittstelle noch direkt.
  const recordId = detail.history[0].id;
  for (const method of ['PUT', 'PATCH', 'DELETE']) {
    assert.equal((await h.api('hr', method, `/api/compensation/people/5/records/${recordId}`, {})).status, 404, method);
  }
  assert.throws(() => h.db.prepare('UPDATE compensation_records SET annual_salary_cents=1 WHERE id=?').run(recordId), /nie überschrieben/);
});

test('Historie: ungültige Eingaben und fremde IDs', async () => {
  const grade = await createGrade();
  const inactive = await createGrade({ name: 'Alt', active: false });
  const later = await createGrade({ name: 'Später', validFrom: FUTURE });
  const usd = await createGrade({ name: 'Dollar', currency: 'USD' });
  const valid = { effectiveDate: PAST, annualSalary: '50.000', reason: 'hire' };
  const invalid = [
    { ...valid, effectiveDate: '' },
    { ...valid, effectiveDate: '2026-13-01' },
    { ...valid, annualSalary: '0' },
    { ...valid, annualSalary: '-100' },
    { ...valid, annualSalary: 'viel' },
    { ...valid, annualSalary: '100.000.000,01' },
    { ...valid, fte: 0 },
    { ...valid, fte: 1.5 },
    { ...valid, fte: 'voll' },
    { ...valid, variableTarget: '-1' },
    { ...valid, reason: 'Bonus' },
    { ...valid, reason: '__proto__' },
    { ...valid, reason: ['hire'] },
    { ...valid, effectiveDate: ['2026-01-01'] },
    { ...valid, reason: undefined },
    { ...valid, currency: 'E' },
    { ...valid, gradeId: 9999 },
    { ...valid, gradeId: inactive.id },
    { ...valid, gradeId: later.id },
    { ...valid, gradeId: usd.id, currency: 'EUR' }
  ];
  for (const body of invalid) {
    assert.equal((await h.api('hr', 'POST', '/api/compensation/people/5/records', body)).status, 400, JSON.stringify(body));
  }
  assert.equal(h.db.prepare('SELECT COUNT(*) count FROM compensation_records').get().count, 0);

  assert.equal((await h.api('hr', 'POST', '/api/compensation/people/9999/records', valid)).status, 404);
  assert.equal((await h.api('hr', 'POST', '/api/compensation/people/abc/records', valid)).status, 404);
  assert.equal((await h.api('hr', 'GET', '/api/compensation/people/9999')).status, 404);
  assert.equal((await h.api('hr', 'GET', '/api/compensation/people/abc')).status, 404);
  // Das technische Konto ist keine Person.
  assert.equal((await h.api('hr', 'POST', `/api/compensation/people/${SYSTEM_ID}/records`, valid)).status, 404);
  assert.equal((await h.api('hr', 'GET', `/api/compensation/people/${SYSTEM_ID}`)).status, 404);
  // Gesperrte Konten bekommen keine neuen Einträge.
  h.db.prepare('UPDATE users SET active=0 WHERE id=7').run();
  assert.equal((await h.api('hr', 'POST', '/api/compensation/people/7/records', valid)).status, 404);

  // Die Währung kommt ohne Angabe aus dem Band, sonst gilt EUR.
  assert.equal((await addRecord('anna', '50.000', { gradeId: usd.id })).record.currency, 'USD');
  assert.equal((await addRecord('ben', '50.000', { gradeId: grade.id })).record.currency, 'EUR');
  assert.equal((await addRecord('manager', '50.000')).record.currency, 'EUR');
});

test('Niemand ändert die eigene Vergütung, die Systemadministration ist davon nicht betroffen', async () => {
  const body = { effectiveDate: PAST, annualSalary: '90.000', reason: 'other' };
  const own = await h.api('hr', 'POST', '/api/compensation/people/1/records', body);
  assert.equal(own.status, 403);
  assert.match(own.data.error, /Vier-Augen/);
  assert.equal(h.db.prepare('SELECT COUNT(*) count FROM compensation_records').get().count, 0);

  // Eine zweite HR-Administration oder die Systemadministration darf das.
  addPerson(8, null, 'hr_admin');
  await addRecord('hr', '90.000', {}, 8);
  await addRecord('hr', '91.000', {}, SYSTEM_ID);
  await addRecord('anna', '50.000', {}, SYSTEM_ID);
  assert.equal(h.db.prepare('SELECT COUNT(*) count FROM compensation_records').get().count, 3);

  for (const person of ['bp', 'director', 'manager', 'anna']) {
    const id = h.people[person].id;
    assert.equal((await h.api(person, 'POST', `/api/compensation/people/${id}/records`, body)).status, 403, person);
  }
});

test('Band-Warnung sperrt nicht', async () => {
  const grade = await createGrade();
  const above = await addRecord('anna', '70.000,00', { gradeId: grade.id });
  assert.equal(above.record.metrics.bandStatus, 'above');
  assert.equal(above.warnings[0].code, 'above_band');
  const below = await addRecord('ben', '30.000,00', { gradeId: grade.id });
  assert.equal(below.warnings[0].code, 'below_band');
  const inside = await addRecord('clara', '60.000,00', { gradeId: grade.id });
  assert.deepEqual(inside.warnings, []);
  assert.equal(h.db.prepare('SELECT COUNT(*) count FROM compensation_records').get().count, 3);
});

// ------------------------------------------------------------------------------------------
// Rollengrenzen beim Lesen
// ------------------------------------------------------------------------------------------

test('Mitarbeitende sehen nur sich, ab Gültig-ab und nur die Spanne des Bandes', async () => {
  const grade = await createGrade();
  await addRecord('anna', '50.000,00', { gradeId: grade.id, variableTarget: '1.000,00' });
  await addRecord('anna', '80.000,00', { effectiveDate: FUTURE, gradeId: grade.id, reason: 'promotion' });
  await addRecord('ben', '60.000,00', { gradeId: grade.id });

  const own = expectStatus(await h.api('anna', 'GET', '/api/compensation/me'), 200);
  assert.equal(own.current.annualSalaryCents, 5000000);
  assert.equal(own.current.variableTargetCents, 100000);
  assert.equal(own.history.length, 1);
  assert.deepEqual(Object.keys(own.current.band).sort(), ['currency', 'maxCents', 'minCents', 'name']);
  assert.equal(own.current.metrics, undefined);
  assert.equal(JSON.stringify(own).includes('8000000'), false);

  assert.deepEqual(expectStatus(await h.api('anna', 'GET', '/api/compensation/people/5'), 200), own);

  const forbidden = [
    '/api/compensation/people/6',
    '/api/compensation/people/4',
    '/api/compensation/people/9999',
    '/api/compensation/people',
    '/api/compensation/grades',
    '/api/compensation/cycles',
    '/api/compensation/cycles/1',
    '/api/compensation/team',
    '/api/compensation/area-summary',
    '/api/compensation/analytics',
    '/api/compensation/export.csv'
  ];
  for (const url of forbidden) assert.equal((await h.api('anna', 'GET', url)).status, 403, url);

  const nothingYet = expectStatus(await h.api('clara', 'GET', '/api/compensation/me'), 200);
  assert.deepEqual(nothingYet, { current: null, history: [] });
});

test('Mitarbeitende sehen Vorschläge nie, auch nicht die eigenen', async () => {
  const { cycleId } = await openRoundWithTeam();
  await propose('manager', cycleId, 'anna', { mode: 'amount', value: '1.234,56' });

  const own = await h.api('anna', 'GET', '/api/compensation/me');
  assert.equal(JSON.stringify(own.data).includes('123456'), false);
  assert.equal(JSON.stringify(own.data).toLowerCase().includes('propos'), false);

  assert.equal((await h.api('anna', 'GET', `/api/compensation/cycles/${cycleId}`)).status, 403);
  assert.equal((await h.api('anna', 'GET', '/api/compensation/team')).status, 403);
  assert.equal((await h.api('anna', 'PUT', proposalUrl(cycleId, 'anna'), { mode: 'amount', value: '100000' })).status, 403);
  assert.equal((await h.api('anna', 'PUT', proposalUrl(cycleId, 'ben'), { mode: 'amount', value: '1' })).status, 403);
  assert.equal(expectStatus(await h.api('anna', 'GET', '/api/compensation/access'), 200).openRounds.length, 0);
});

test('Führungskraft sieht außerhalb einer Runde nichts', async () => {
  const grade = await createGrade();
  await addRecord('anna', '50.000,00', { gradeId: grade.id });
  await addRecord('ben', '60.000,00', { gradeId: grade.id });

  for (const url of ['/api/compensation/people', '/api/compensation/people/5', '/api/compensation/cycles', '/api/compensation/grades', '/api/compensation/analytics', '/api/compensation/export.csv']) {
    assert.equal((await h.api('manager', 'GET', url)).status, 403, url);
  }
  assert.deepEqual(expectStatus(await h.api('manager', 'GET', '/api/compensation/team'), 200), { rounds: [] });
  assert.deepEqual(expectStatus(await h.api('manager', 'GET', '/api/compensation/area-summary'), 200), { minGroupSize: 5, suppressed: true, totals: [], rounds: [] });
  const access = expectStatus(await h.api('manager', 'GET', '/api/compensation/access'), 200);
  assert.deepEqual(access.openRounds, []);
  assert.equal(access.areaSummary, false);

  // Ein Entwurf ist noch keine Runde.
  const draft = await createCycle();
  assert.deepEqual(expectStatus(await h.api('manager', 'GET', '/api/compensation/team'), 200), { rounds: [] });
  assert.equal((await h.api('manager', 'PUT', proposalUrl(draft.id, 'anna'), { mode: 'amount', value: '1' })).status, 403);
});

test('Führungskraft sieht in der offenen Runde nur direkte Teilnehmende, und nur solange sie offen ist', async () => {
  const grade = await createGrade();
  await addRecord('anna', '50.000,00', { gradeId: grade.id, variableTarget: '3.000,00' });
  await addRecord('ben', '59.000,00', { gradeId: grade.id });
  await addRecord('clara', '40.000,00', { gradeId: grade.id });
  await addRecord('manager', '55.000,00', { gradeId: grade.id });
  const cycle = await createCycle();
  // Ben nimmt nicht teil.
  await openCycle(cycle.id, { excludeUserIds: [h.people.ben.id] });

  const team = expectStatus(await h.api('manager', 'GET', '/api/compensation/team'), 200);
  assert.equal(team.rounds.length, 1);
  assert.deepEqual(team.rounds[0].rows.map(row => row.name), ['Anna Ahrens']);
  const row = team.rounds[0].rows[0];
  assert.equal(row.baseSalaryCents, 5000000);
  assert.equal(row.grade.midCents, 5000000);
  assert.equal(row.metrics.compaRatio, 1);
  assert.equal(JSON.stringify(team).includes('Ben Berg'), false);
  assert.equal(JSON.stringify(team).includes('5900000'), false);
  // Die variable Zielvergütung gehört nicht zum Arbeitsblatt.
  assert.equal(row.variableTargetCents, undefined);
  assert.equal(JSON.stringify(team).includes('300000'), false);

  // Der andere Weg bleibt zu, auch für die eigene Mitarbeiterin.
  assert.equal((await h.api('manager', 'GET', '/api/compensation/people/5')).status, 403);
  assert.equal((await h.api('manager', 'GET', '/api/compensation/people/6')).status, 403);
  assert.equal((await h.api('manager', 'GET', `/api/compensation/cycles/${cycle.id}`)).status, 403);
  // Keine Vorschläge für Nicht-Teilnehmende.
  assert.equal((await h.api('manager', 'PUT', proposalUrl(cycle.id, 'ben'), { mode: 'amount', value: '1' })).status, 403);

  // Bereichsleitung: nur ihre direkten Mitarbeitenden, nicht die Ebene darunter.
  const directorTeam = expectStatus(await h.api('director', 'GET', '/api/compensation/team'), 200);
  assert.deepEqual(directorTeam.rounds[0].rows.map(item => item.name), ['Clara Cordes', 'Malte Manager']);
  assert.equal(JSON.stringify(directorTeam).includes('Anna'), false);
  assert.equal((await h.api('director', 'PUT', proposalUrl(cycle.id, 'anna'), { mode: 'amount', value: '1' })).status, 403);
  assert.equal((await h.api('director', 'GET', '/api/compensation/people/5')).status, 403);

  // Die eigene Zeile erscheint nie im eigenen Arbeitsblatt.
  assert.equal(JSON.stringify(team).includes('Malte Manager'), false);

  // Wechselt die Führungskraft, wechselt auch das Recht sofort.
  h.db.prepare('UPDATE users SET manager_id=3 WHERE id=5').run();
  assert.deepEqual(expectStatus(await h.api('manager', 'GET', '/api/compensation/team'), 200), { rounds: [] });
  assert.equal((await h.api('manager', 'PUT', proposalUrl(cycle.id, 'anna'), { mode: 'amount', value: '1' })).status, 403);
  h.db.prepare('UPDATE users SET manager_id=4 WHERE id=5').run();

  // In der Prüfung ist Schluss.
  expectStatus(await h.api('hr', 'POST', `/api/compensation/cycles/${cycle.id}/review`), 200);
  assert.deepEqual(expectStatus(await h.api('manager', 'GET', '/api/compensation/team'), 200), { rounds: [] });
  assert.deepEqual(expectStatus(await h.api('manager', 'GET', '/api/compensation/access'), 200).openRounds, []);
  assert.equal((await h.api('manager', 'PUT', proposalUrl(cycle.id, 'anna'), { mode: 'amount', value: '1' })).status, 403);
  assert.equal((await h.api('manager', 'GET', `/api/compensation/cycles/${cycle.id}`)).status, 403);

  // Und nach dem Abschluss ebenso.
  expectStatus(await h.api('hr', 'POST', `/api/compensation/cycles/${cycle.id}/close`), 200);
  assert.deepEqual(expectStatus(await h.api('manager', 'GET', '/api/compensation/team'), 200), { rounds: [] });
});

test('Eine Führungskraft in der Mitarbeiterrolle bekommt keine Sicht auf das Team', async () => {
  addPerson(8, 5);
  await addRecord(8, '40.000');
  const cycle = await createCycle();
  await openCycle(cycle.id);
  assert.equal((await h.api('anna', 'GET', '/api/compensation/team')).status, 403);
  assert.equal((await h.api('anna', 'PUT', `/api/compensation/team/${cycle.id}/proposals/8`, { mode: 'amount', value: '1' })).status, 403);
  assert.equal(h.db.prepare("SELECT COUNT(*) count FROM tasks WHERE user_id=5").get().count, 0);
});

test('HRBP liest alles, ändert aber nichts', async () => {
  const { grade, cycleId } = await openRoundWithTeam();
  await propose('manager', cycleId, 'anna', { mode: 'amount', value: '1.000' });

  for (const url of ['/api/compensation/grades', '/api/compensation/people', '/api/compensation/people/5', '/api/compensation/cycles', `/api/compensation/cycles/${cycleId}`, '/api/compensation/analytics']) {
    expectStatus(await h.api('bp', 'GET', url), 200);
  }

  const record = { effectiveDate: PAST, annualSalary: '50.000', reason: 'hire' };
  const cycle = { name: 'X', budgetMode: 'percent', budgetPercent: '3', effectiveDate: '2031-01-01' };
  const denied = [
    ['POST', '/api/compensation/grades', { name: 'X', min: '1', mid: '2', max: '3', validFrom: PAST }],
    ['PATCH', `/api/compensation/grades/${grade.id}`, { name: 'X' }],
    ['POST', '/api/compensation/people/5/records', record],
    ['POST', '/api/compensation/cycles', cycle],
    ['PATCH', `/api/compensation/cycles/${cycleId}`, { name: 'X' }],
    ['POST', `/api/compensation/cycles/${cycleId}/open`, {}],
    ['POST', `/api/compensation/cycles/${cycleId}/review`, {}],
    ['POST', `/api/compensation/cycles/${cycleId}/close`, {}],
    ['POST', `/api/compensation/cycles/${cycleId}/approve-open`, {}],
    ['POST', decisionUrl(cycleId, 'anna'), { action: 'approve' }],
    ['PUT', proposalUrl(cycleId, 'anna'), { mode: 'amount', value: '1' }]
  ];
  for (const [method, url, body] of denied) {
    assert.equal((await h.api('bp', method, url, body)).status, 403, `${method} ${url}`);
  }
  assert.equal((await h.api('bp', 'GET', '/api/compensation/export.csv')).status, 403);

  // Auch als direkte Führungskraft bleibt die Rolle lesend; HR Admin setzt den Wert in der Prüfung.
  h.db.prepare('UPDATE users SET manager_id=2 WHERE id=7').run();
  assert.equal((await h.api('bp', 'PUT', proposalUrl(cycleId, 'clara'), { mode: 'amount', value: '1' })).status, 403);
  assert.deepEqual(expectStatus(await h.api('bp', 'GET', '/api/compensation/team'), 200), { rounds: [] });
});

test('Die Systemadministration darf lesen und schreiben, aber nicht exportieren', async () => {
  const grade = expectStatus(await h.api(SYSTEM_ID, 'POST', '/api/compensation/grades', { name: 'S', min: '10', mid: '20', max: '30', validFrom: PAST }), 201).grade;
  await addRecord('anna', '20', { gradeId: grade.id }, SYSTEM_ID);
  const cycle = expectStatus(await h.api(SYSTEM_ID, 'POST', '/api/compensation/cycles', { name: 'S', budgetMode: 'amount', budgetAmount: '100', effectiveDate: '2030-01-01' }), 201).cycle;
  expectStatus(await h.api(SYSTEM_ID, 'POST', `/api/compensation/cycles/${cycle.id}/open`, {}), 200);
  expectStatus(await h.api(SYSTEM_ID, 'POST', `/api/compensation/cycles/${cycle.id}/review`), 200);
  expectStatus(await h.api(SYSTEM_ID, 'POST', decisionUrl(cycle.id, 'anna'), { action: 'change', mode: 'amount', value: '1', reason: 'Support' }), 200);
  const closed = expectStatus(await h.api(SYSTEM_ID, 'POST', `/api/compensation/cycles/${cycle.id}/close`), 200);
  assert.equal(closed.created, 1);
  assert.deepEqual(expectStatus(await h.api(SYSTEM_ID, 'GET', '/api/compensation/me'), 200), { current: null, history: [] });
  assert.equal((await h.api(SYSTEM_ID, 'GET', '/api/compensation/export.csv')).status, 403);
  assert.equal(h.db.prepare('SELECT created_by FROM compensation_records WHERE source_cycle_id=?').get(cycle.id).created_by, SYSTEM_ID);
});

// ------------------------------------------------------------------------------------------
// Summen für Vorgesetzte weiter oben
// ------------------------------------------------------------------------------------------

test('Vorgesetzte weiter oben sehen Summen erst ab fünf Personen und ohne Einzelwerte', async () => {
  const grade = await createGrade();
  // Direkte Mitarbeitende der Bereichsleitung zählen nicht mit: manager und clara.
  await addRecord('manager', '55.000,00', { gradeId: grade.id });
  await addRecord('clara', '40.000,00', { gradeId: grade.id });
  await addRecord('anna', '50.000,00', { gradeId: grade.id, variableTarget: '1.000,00' });
  await addRecord('ben', '60.000,00', { gradeId: grade.id });
  addPerson(8, 4);
  addPerson(9, 4);
  addPerson(10, 4);
  await addRecord(8, '41.000,00', { gradeId: grade.id });
  await addRecord(9, '42.000,00', { gradeId: grade.id });

  // Vier Personen auf der Ebene darunter: nichts.
  const tooFew = expectStatus(await h.api('director', 'GET', '/api/compensation/area-summary'), 200);
  assert.deepEqual(tooFew, { minGroupSize: 5, suppressed: true, totals: [], rounds: [] });
  assert.equal(expectStatus(await h.api('director', 'GET', '/api/compensation/access'), 200).areaSummary, false);

  // Die fünfte Person ohne Eintrag zählt nicht.
  assert.equal(expectStatus(await h.api('director', 'GET', '/api/compensation/area-summary'), 200).suppressed, true);

  await addRecord(10, '43.000,00', { gradeId: grade.id });
  const enough = expectStatus(await h.api('director', 'GET', '/api/compensation/area-summary'), 200);
  assert.equal(enough.suppressed, false);
  assert.deepEqual(enough.totals, [{ currency: 'EUR', people: 5, annualSalaryCents: 23600000, variableTargetCents: 100000 }]);
  assert.equal(expectStatus(await h.api('director', 'GET', '/api/compensation/access'), 200).areaSummary, true);

  // Keine Namen, IDs oder Einzelbeträge.
  const text = JSON.stringify(enough);
  for (const secret of ['Anna', 'Ben', 'Person 8', 'userId', '5000000', '6000000', '4100000']) {
    assert.equal(text.includes(secret), false, secret);
  }

  // Die direkte Führungskraft dieser Personen ist nicht "weiter oben".
  assert.equal(expectStatus(await h.api('manager', 'GET', '/api/compensation/area-summary'), 200).suppressed, true);
  assert.equal((await h.api('anna', 'GET', '/api/compensation/area-summary')).status, 403);
});

test('Summen je Währung und in Runden halten die Mindestgruppe ein', async () => {
  const grade = await createGrade({ max: '90.000,00' });
  for (const id of [8, 9, 10, 11, 12]) {
    addPerson(id, 4);
    await addRecord(id, '50.000,00', { gradeId: grade.id });
  }
  // Eine einzelne Person in anderer Währung darf nicht einzeln sichtbar werden.
  addPerson(13, 4);
  await addRecord(13, '70.000,00', { currency: 'CHF' });
  const summary = expectStatus(await h.api('director', 'GET', '/api/compensation/area-summary'), 200);
  assert.deepEqual(summary.totals.map(total => total.currency), ['EUR']);
  assert.equal(JSON.stringify(summary).includes('7000000'), false);

  // Runde mit allen fünf: Budget sichtbar, Verplantes erst ab fünf Vorschlägen.
  const cycle = await createCycle({ budgetPercent: '10' });
  await openCycle(cycle.id);
  let round = expectStatus(await h.api('director', 'GET', '/api/compensation/area-summary'), 200).rounds[0];
  assert.equal(round.people, 5);
  assert.equal(round.budgetCents, 2500000);
  assert.equal(round.planned, null);

  for (const id of [8, 9, 10, 11]) {
    expectStatus(await h.api('manager', 'PUT', `/api/compensation/team/${cycle.id}/proposals/${id}`, { mode: 'amount', value: '1.000' }), 200);
  }
  round = expectStatus(await h.api('director', 'GET', '/api/compensation/area-summary'), 200).rounds[0];
  assert.equal(round.planned, null);

  expectStatus(await h.api('manager', 'PUT', `/api/compensation/team/${cycle.id}/proposals/12`, { mode: 'amount', value: '1.000' }), 200);
  round = expectStatus(await h.api('director', 'GET', '/api/compensation/area-summary'), 200).rounds[0];
  assert.equal(round.planned.plannedCents, 500000);
  assert.equal(round.planned.overBudget, false);
});

test('Summen der Runde verschwinden, wenn die Differenz zur Gesamtsumme Einzelwerte verraten würde', async () => {
  for (const id of [8, 9, 10, 11, 12, 13]) {
    addPerson(id, 4);
    await addRecord(id, '50.000,00');
  }
  const cycle = await createCycle();
  // Fünf von sechs Personen in der Runde: Gesamtsumme minus Basis wäre genau ein Gehalt.
  await openCycle(cycle.id, { excludeUserIds: [13] });
  const summary = expectStatus(await h.api('director', 'GET', '/api/compensation/area-summary'), 200);
  assert.equal(summary.totals[0].people, 6);
  assert.deepEqual(summary.rounds, []);
});

// ------------------------------------------------------------------------------------------
// Gehaltsrunde
// ------------------------------------------------------------------------------------------

test('Runde: Ablauf von Anfang bis Ende mit genau einmal erzeugten Einträgen', async () => {
  const { grade, cycleId } = await openRoundWithTeam({ effectiveDate: '2020-06-01', budgetPercent: '5' });

  await propose('manager', cycleId, 'anna', { mode: 'amount', value: '1.000,00' });
  await propose('manager', cycleId, 'ben', { mode: 'percent', value: '2' });
  await propose('director', cycleId, 'clara', { mode: 'amount', value: '500,00' });
  await propose('director', cycleId, 'manager', { mode: 'percent', value: '1' });

  expectStatus(await h.api('hr', 'POST', `/api/compensation/cycles/${cycleId}/review`), 200);
  expectStatus(await h.api('hr', 'POST', decisionUrl(cycleId, 'anna'), { action: 'approve' }), 200);
  const changed = expectStatus(await h.api('hr', 'POST', decisionUrl(cycleId, 'ben'), { action: 'change', mode: 'amount', value: '2.500,00', reason: 'Marktanpassung' }), 200);
  assert.equal(changed.participant.proposal.finalSalaryCents, 6250000);
  assert.equal(changed.participant.proposal.proposedSalaryCents, 6120000);
  assert.equal(changed.participant.proposal.changedByHr, true);
  expectStatus(await h.api('hr', 'POST', decisionUrl(cycleId, 'clara'), { action: 'reject', reason: 'Gerade erst erhöht' }), 200);
  expectStatus(await h.api('hr', 'POST', decisionUrl(cycleId, 'manager'), { action: 'approve' }), 200);

  const before = h.db.prepare('SELECT COUNT(*) count FROM compensation_records').get().count;
  const closed = expectStatus(await h.api('hr', 'POST', `/api/compensation/cycles/${cycleId}/close`), 200);
  assert.equal(closed.created, 3);
  assert.equal(closed.cycle.status, 'closed');

  const created = h.db.prepare('SELECT * FROM compensation_records WHERE source_cycle_id=? ORDER BY user_id').all(cycleId);
  assert.equal(created.length, 3);
  assert.equal(h.db.prepare('SELECT COUNT(*) count FROM compensation_records').get().count, before + 3);
  assert.deepEqual(created.map(row => [row.user_id, row.annual_salary_cents]), [[4, 5555000], [5, 5100000], [6, 6250000]]);
  for (const row of created) {
    assert.equal(row.effective_date, '2020-06-01');
    assert.equal(row.reason, 'cycle');
    assert.equal(row.grade_id, grade.id);
    assert.equal(row.created_by, h.people.hr.id);
  }

  // Abgelehnt: Clara bleibt unverändert. Das neue Gehalt ist für Anna ab Gültig-ab sichtbar.
  assert.equal(expectStatus(await h.api('clara', 'GET', '/api/compensation/me'), 200).current.annualSalaryCents, 4000000);
  assert.equal(expectStatus(await h.api('anna', 'GET', '/api/compensation/me'), 200).current.annualSalaryCents, 5100000);
});

test('Abschluss lässt sich nicht doppelt auslösen, auch nicht gleichzeitig', async () => {
  const { cycleId } = await openRoundWithTeam();
  await propose('manager', cycleId, 'anna', { mode: 'amount', value: '100' });
  expectStatus(await h.api('hr', 'POST', `/api/compensation/cycles/${cycleId}/review`), 200);
  expectStatus(await h.api('hr', 'POST', decisionUrl(cycleId, 'anna'), { action: 'approve' }), 200);

  const responses = await Promise.all([
    h.api('hr', 'POST', `/api/compensation/cycles/${cycleId}/close`),
    h.api('hr', 'POST', `/api/compensation/cycles/${cycleId}/close`),
    h.api(SYSTEM_ID, 'POST', `/api/compensation/cycles/${cycleId}/close`)
  ]);
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 409, 409]);

  const again = await h.api('hr', 'POST', `/api/compensation/cycles/${cycleId}/close`);
  assert.equal(again.status, 409);
  assert.equal(h.db.prepare('SELECT COUNT(*) count FROM compensation_records WHERE source_cycle_id=?').get(cycleId).count, 1);
  // Auch die Datenbank schützt davor.
  assert.throws(() => h.db.prepare(`
    INSERT INTO compensation_records(user_id, effective_date, annual_salary_cents, fte_basis_points, reason, source_cycle_id, created_at)
    VALUES(5, '2030-01-01', 1, 10000, 'cycle', ?, '2030-01-01')
  `).run(cycleId), /UNIQUE/);
  // Nach dem Abschluss ist keine Entscheidung mehr möglich.
  assert.equal((await h.api('hr', 'POST', decisionUrl(cycleId, 'anna'), { action: 'reject' })).status, 409);
});

test('Abschluss ist bei offenen Vorschlägen blockiert und nimmt keine Teilergebnisse mit', async () => {
  const { cycleId } = await openRoundWithTeam();
  await propose('manager', cycleId, 'anna', { mode: 'amount', value: '100' });
  await propose('manager', cycleId, 'ben', { mode: 'amount', value: '100' });
  expectStatus(await h.api('hr', 'POST', `/api/compensation/cycles/${cycleId}/review`), 200);
  expectStatus(await h.api('hr', 'POST', decisionUrl(cycleId, 'anna'), { action: 'approve' }), 200);

  const blocked = await h.api('hr', 'POST', `/api/compensation/cycles/${cycleId}/close`);
  assert.equal(blocked.status, 409);
  assert.equal(blocked.data.error, 'Es ist noch 1 Vorschlag ohne Entscheidung.');
  assert.equal(expectStatus(await h.api('hr', 'GET', `/api/compensation/cycles/${cycleId}`), 200).cycle.status, 'review');
  assert.equal(h.db.prepare('SELECT COUNT(*) count FROM compensation_records WHERE source_cycle_id=?').get(cycleId).count, 0);

  const all = expectStatus(await h.api('hr', 'POST', `/api/compensation/cycles/${cycleId}/approve-open`), 200);
  assert.deepEqual(all, { approved: 1, skippedOwn: 0 });
  // Teilnehmende ohne Vorschlag bleiben unverändert und blockieren nicht.
  assert.equal(expectStatus(await h.api('hr', 'POST', `/api/compensation/cycles/${cycleId}/close`), 200).created, 2);
});

test('Statuswechsel gehen nur in der richtigen Reihenfolge', async () => {
  await addRecord('anna', '50.000');
  const cycle = await createCycle();
  const url = `/api/compensation/cycles/${cycle.id}`;

  assert.equal((await h.api('hr', 'POST', `${url}/review`)).status, 409);
  assert.equal((await h.api('hr', 'POST', `${url}/close`)).status, 409);
  assert.equal((await h.api('hr', 'POST', decisionUrl(cycle.id, 'anna'), { action: 'approve' })).status, 409);

  assert.equal(expectStatus(await h.api('hr', 'PATCH', url, { name: 'Neu', budgetMode: 'amount', budgetAmount: '1.000' }), 200).cycle.budgetAmountCents, 100000);

  await openCycle(cycle.id);
  assert.equal((await h.api('hr', 'POST', `${url}/open`, {})).status, 409);
  assert.equal((await h.api('hr', 'PATCH', url, { name: 'Später' })).status, 409);
  assert.equal((await h.api('hr', 'POST', `${url}/close`)).status, 409);
  assert.equal((await h.api('hr', 'POST', decisionUrl(cycle.id, 'anna'), { action: 'approve' })).status, 409);
  assert.equal((await h.api('hr', 'POST', `${url}/approve-open`)).status, 409);

  expectStatus(await h.api('hr', 'POST', `${url}/review`), 200);
  assert.equal((await h.api('hr', 'POST', `${url}/review`)).status, 409);
  assert.equal((await h.api('hr', 'POST', `${url}/open`, {})).status, 409);

  expectStatus(await h.api('hr', 'POST', `${url}/close`), 200);
  for (const step of ['open', 'review', 'close']) {
    assert.equal((await h.api('hr', 'POST', `${url}/${step}`, {})).status, 409, step);
  }

  for (const step of ['open', 'review', 'close', 'approve-open']) {
    assert.equal((await h.api('hr', 'POST', `/api/compensation/cycles/9999/${step}`, {})).status, 404, step);
  }
  assert.equal((await h.api('hr', 'GET', '/api/compensation/cycles/9999')).status, 404);
  assert.equal((await h.api('hr', 'PATCH', '/api/compensation/cycles/9999', {})).status, 404);
  assert.equal((await h.api('hr', 'POST', '/api/compensation/cycles/9999/decisions/5', {})).status, 404);
});

test('Runde: Eingaben prüfen und nur eine laufende Runde je Währung', async () => {
  const valid = { name: 'R', budgetMode: 'percent', budgetPercent: '3', effectiveDate: '2030-01-01' };
  const invalid = [
    { ...valid, name: '' },
    { ...valid, budgetMode: 'gefühl' },
    { ...valid, budgetPercent: '0' },
    { ...valid, budgetPercent: '101' },
    { ...valid, budgetPercent: undefined },
    { ...valid, budgetMode: 'amount', budgetAmount: '0' },
    { ...valid, budgetMode: 'amount', budgetAmount: undefined },
    { ...valid, effectiveDate: '2030-02-31' },
    { ...valid, effectiveDate: undefined },
    { ...valid, currency: 'EURO' }
  ];
  for (const body of invalid) {
    assert.equal((await h.api('hr', 'POST', '/api/compensation/cycles', body)).status, 400, JSON.stringify(body));
  }

  // Ohne Vergütungseinträge gibt es niemanden, der teilnehmen kann.
  const empty = await createCycle();
  assert.equal((await h.api('hr', 'POST', `/api/compensation/cycles/${empty.id}/open`, {})).status, 409);
  assert.equal(expectStatus(await h.api('hr', 'GET', `/api/compensation/cycles/${empty.id}`), 200).cycle.status, 'draft');

  await addRecord('anna', '50.000');
  await addRecord('ben', '50.000', { currency: 'CHF' });
  await addRecord('clara', '50.000', { effectiveDate: FUTURE });
  assert.equal((await h.api('hr', 'POST', `/api/compensation/cycles/${empty.id}/open`, { excludeUserIds: 'alle' })).status, 400);
  assert.equal((await h.api('hr', 'POST', `/api/compensation/cycles/${empty.id}/open`, { excludeUserIds: ['x'] })).status, 400);
  assert.equal((await h.api('hr', 'POST', `/api/compensation/cycles/${empty.id}/open`, { excludeUserIds: [5] })).status, 409);

  const detail = expectStatus(await h.api('hr', 'GET', `/api/compensation/cycles/${empty.id}`), 200);
  assert.deepEqual(detail.eligible.map(person => person.name), ['Anna Ahrens']);

  assert.equal((await openCycle(empty.id)).participants, 1);
  const second = await createCycle();
  assert.equal((await h.api('hr', 'POST', `/api/compensation/cycles/${second.id}/open`, {})).status, 409);
  // Andere Währung, andere Teilnehmende: Das geht parallel und Beträge werden nie vermischt.
  const swiss = await createCycle({ currency: 'CHF' });
  assert.equal((await openCycle(swiss.id)).participants, 1);
  assert.equal(expectStatus(await h.api('hr', 'GET', `/api/compensation/cycles/${swiss.id}`), 200).budget.overall.baseCents, 5000000);
});

test('Ausgangsgehälter sind beim Öffnen festgeschrieben', async () => {
  const { cycleId } = await openRoundWithTeam();
  await addRecord('anna', '99.000,00', { effectiveDate: PAST, reason: 'correction' });

  const detail = expectStatus(await h.api('hr', 'GET', `/api/compensation/cycles/${cycleId}`), 200);
  const anna = detail.participants.find(row => row.name === 'Anna Ahrens');
  const ben = detail.participants.find(row => row.name === 'Ben Berg');
  assert.equal(anna.baseSalaryCents, 5000000);
  assert.equal(anna.newerRecordExists, true);
  assert.equal(ben.newerRecordExists, false);
  assert.equal(detail.cycle.baseTotalCents, 20500000);
  const team = expectStatus(await h.api('manager', 'GET', '/api/compensation/team'), 200);
  assert.equal(team.rounds[0].rows.find(row => row.name === 'Anna Ahrens').baseSalaryCents, 5000000);
});

test('Vorschläge: nur für direkte Mitarbeitende, nicht für sich selbst, Eingaben werden geprüft', async () => {
  const { cycleId } = await openRoundWithTeam();

  // Nicht für sich selbst, auch nicht als HR-Administration mit Team.
  const self = await h.api('manager', 'PUT', proposalUrl(cycleId, 'manager'), { mode: 'amount', value: '1' });
  assert.equal(self.status, 403);
  assert.equal((await h.api('hr', 'PUT', proposalUrl(cycleId, 'hr'), { mode: 'amount', value: '1' })).status, 403);
  assert.equal((await h.api('director', 'PUT', proposalUrl(cycleId, 'director'), { mode: 'amount', value: '1' })).status, 403);

  // HR schlägt während der offenen Phase nicht für fremde Teams vor.
  assert.equal((await h.api('hr', 'PUT', proposalUrl(cycleId, 'anna'), { mode: 'amount', value: '1' })).status, 403);
  assert.equal((await h.api('manager', 'PUT', proposalUrl(cycleId, 'clara'), { mode: 'amount', value: '1' })).status, 403);
  assert.equal((await h.api('manager', 'PUT', `/api/compensation/team/${cycleId}/proposals/9999`, { mode: 'amount', value: '1' })).status, 403);
  assert.equal((await h.api('manager', 'PUT', `/api/compensation/team/9999/proposals/5`, { mode: 'amount', value: '1' })).status, 403);

  const invalid = [
    {},
    { mode: 'amount' },
    { mode: 'amount', value: '-1' },
    { mode: 'amount', value: 'viel' },
    { mode: 'percent', value: '101' },
    { mode: 'percent', value: '1,234' },
    { mode: 'bonus', value: '5' },
    { mode: 'amount', value: '100.000.000,00' }
  ];
  for (const body of invalid) {
    assert.equal((await h.api('manager', 'PUT', proposalUrl(cycleId, 'anna'), body)).status, 400, JSON.stringify(body));
  }
  assert.equal(h.db.prepare('SELECT COUNT(*) count FROM compensation_proposals').get().count, 0);

  // Eine Null-Erhöhung ist eine gültige Aussage. Vorschläge lassen sich bis zur Prüfung ändern.
  assert.equal((await propose('manager', cycleId, 'anna', { mode: 'amount', value: '0' })).row.proposal.increaseCents, 0);
  const updated = await propose('manager', cycleId, 'anna', { mode: 'percent', value: '2' });
  assert.equal(updated.row.proposal.increaseCents, 100000);
  assert.equal(updated.row.proposal.mode, 'percent');
  assert.equal(updated.row.proposal.percent, 2);
  assert.equal(h.db.prepare('SELECT COUNT(*) count FROM compensation_proposals').get().count, 1);
});

test('Eine HR-Administration mit eigenem Team schlägt für dieses Team vor', async () => {
  h.db.prepare('UPDATE users SET manager_id=1 WHERE id=7').run();
  const { cycleId } = await openRoundWithTeam();
  assert.equal(h.db.prepare("SELECT COUNT(*) count FROM tasks WHERE user_id=1 AND type='compensation_proposal'").get().count, 1);
  await propose('hr', cycleId, 'clara', { mode: 'amount', value: '100' });
  assert.equal((await h.api('hr', 'PUT', proposalUrl(cycleId, 'anna'), { mode: 'amount', value: '1' })).status, 403);
});

test('Begründung ist erst ab Überschreitung Pflicht, gesperrt wird trotzdem nicht', async () => {
  // Budget 3 % von 110.000,00 sind 3.300,00 für das Team von manager.
  const { cycleId } = await openRoundWithTeam();

  const within = await propose('manager', cycleId, 'anna', { mode: 'amount', value: '3.000,00' });
  assert.deepEqual(within.warnings, []);
  assert.equal(within.budget.area.budgetCents, 330000);
  assert.equal(within.budget.area.overBudget, false);
  assert.equal(within.budget.area.remainingCents, 30000);

  const missing = await h.api('manager', 'PUT', proposalUrl(cycleId, 'ben'), { mode: 'amount', value: '500,00' });
  assert.equal(missing.status, 400);
  assert.match(missing.data.error, /begründe/);

  const over = await propose('manager', cycleId, 'ben', { mode: 'amount', value: '500,00', reason: 'Sehr gute Leistung' });
  assert.deepEqual(over.warnings.map(item => item.code), ['over_budget']);
  assert.equal(over.budget.area.overBudget, true);
  assert.equal(over.budget.area.overByCents, 20000);
  assert.equal(over.row.proposal.reason, 'Sehr gute Leistung');

  // Wer die Überschreitung verkleinert, muss nichts begründen.
  const smaller = await propose('manager', cycleId, 'ben', { mode: 'amount', value: '400,00' });
  assert.equal(smaller.budget.area.overByCents, 10000);

  // Die Überschreitung ist für HR sichtbar, gespeichert wurde trotzdem.
  const detail = expectStatus(await h.api('hr', 'GET', `/api/compensation/cycles/${cycleId}`), 200);
  assert.equal(detail.budget.areas.find(area => area.managerName === 'Malte Manager').overBudget, true);
  assert.equal(detail.participants.find(row => row.name === 'Ben Berg').proposal.increaseCents, 40000);
});

test('Über dem Bandmaximum braucht auch ein Vorschlag innerhalb des Budgets eine Begründung', async () => {
  const grade = await createGrade({ min: '10.000,00', mid: '20.000,00', max: '30.000,00' });
  await addRecord('anna', '29.000,00', { gradeId: grade.id });
  const cycle = await createCycle({ budgetPercent: '50' });
  await openCycle(cycle.id);

  assert.equal((await h.api('manager', 'PUT', proposalUrl(cycle.id, 'anna'), { mode: 'amount', value: '2.000,00' })).status, 400);
  const withReason = await propose('manager', cycle.id, 'anna', { mode: 'amount', value: '2.000,00', reason: 'Sonderrolle' });
  assert.deepEqual(withReason.warnings.map(item => item.code), ['above_band']);
  assert.equal(withReason.row.warnings[0].code, 'above_band');
});

test('Bei Teilzeit zählt für die Bandprüfung des Vorschlags das Vollzeitgehalt', async () => {
  const grade = await createGrade({ min: '10.000,00', mid: '20.000,00', max: '30.000,00' });
  await addRecord('ben', '14.000,00', { gradeId: grade.id, fte: 0.5 });
  const cycle = await createCycle({ budgetPercent: '50' });
  await openCycle(cycle.id);

  // 14.500 bei halber Stelle sind 29.000 in Vollzeit und damit im Band.
  const inside = await propose('manager', cycle.id, 'ben', { mode: 'amount', value: '500,00' });
  assert.deepEqual(inside.warnings, []);
  assert.equal(inside.row.plannedMetrics.fullTimeCents, 2900000);

  // 15.500 bei halber Stelle sind 31.000 in Vollzeit und liegen darüber.
  assert.equal((await h.api('manager', 'PUT', proposalUrl(cycle.id, 'ben'), { mode: 'amount', value: '1.500,00' })).status, 400);
  const above = await propose('manager', cycle.id, 'ben', { mode: 'amount', value: '1.500,00', reason: 'Sonderrolle' });
  assert.deepEqual(above.warnings.map(item => item.code), ['above_band']);
});

test('Budgetrechnung in Prozent', async () => {
  // Basis: anna 50.000 + ben 60.000 + clara 40.000 + manager 55.000 = 205.000; 3 % sind 6.150.
  const { cycleId } = await openRoundWithTeam();
  await propose('manager', cycleId, 'anna', { mode: 'amount', value: '3.000,00' });
  await propose('manager', cycleId, 'ben', { mode: 'amount', value: '1.000,00', reason: 'Begründet' });

  const detail = expectStatus(await h.api('hr', 'GET', `/api/compensation/cycles/${cycleId}`), 200);
  assert.equal(detail.budget.overall.baseCents, 20500000);
  assert.equal(detail.budget.overall.budgetCents, 615000);
  assert.equal(detail.budget.overall.plannedCents, 400000);
  assert.equal(detail.budget.overall.remainingCents, 215000);
  assert.equal(detail.budget.overall.overBudget, false);
  assert.equal(detail.budget.overall.usedPercent, 65);

  // HR sieht klar, welcher Bereich überzogen ist.
  const managerArea = detail.budget.areas.find(area => area.managerName === 'Malte Manager');
  assert.equal(managerArea.participants, 2);
  assert.equal(managerArea.baseCents, 11000000);
  assert.equal(managerArea.budgetCents, 330000);
  assert.equal(managerArea.plannedCents, 400000);
  assert.equal(managerArea.overBudget, true);
  assert.equal(managerArea.overByCents, 70000);
  const directorArea = detail.budget.areas.find(area => area.managerName === 'Dora Direktor');
  assert.equal(directorArea.baseCents, 9500000);
  assert.equal(directorArea.overBudget, false);
  assert.deepEqual(detail.counts, { participants: 4, missing: 2, submitted: 2, approved: 0, rejected: 0 });
  assert.equal(expectStatus(await h.api('hr', 'GET', '/api/compensation/cycles'), 200).cycles[0].budget.plannedCents, 400000);

  // Entscheidungen von HR zählen: Abgelehnt fällt heraus, geändert zählt mit dem neuen Wert.
  expectStatus(await h.api('hr', 'POST', `/api/compensation/cycles/${cycleId}/review`), 200);
  expectStatus(await h.api('hr', 'POST', decisionUrl(cycleId, 'anna'), { action: 'reject' }), 200);
  expectStatus(await h.api('hr', 'POST', decisionUrl(cycleId, 'ben'), { action: 'change', mode: 'amount', value: '8.000,00', reason: 'Marktanpassung' }), 200);
  const reviewed = expectStatus(await h.api('hr', 'GET', `/api/compensation/cycles/${cycleId}`), 200);
  assert.equal(reviewed.budget.overall.plannedCents, 800000);
  assert.equal(reviewed.budget.overall.overBudget, true);
  assert.equal(reviewed.budget.overall.overByCents, 185000);
});

test('Budgetrechnung als Betrag: Bereiche bekommen ihren Anteil', async () => {
  const { cycleId } = await openRoundWithTeam({ budgetMode: 'amount', budgetAmount: '4.100,00', budgetPercent: undefined });
  const detail = expectStatus(await h.api('hr', 'GET', `/api/compensation/cycles/${cycleId}`), 200);
  assert.equal(detail.cycle.budgetAmountCents, 410000);
  assert.equal(detail.cycle.budgetPercent, null);
  assert.equal(detail.budget.overall.budgetCents, 410000);
  // 110.000 von 205.000 Basis.
  const managerArea = detail.budget.areas.find(area => area.managerName === 'Malte Manager');
  assert.equal(managerArea.budgetCents, 220000);
  const team = expectStatus(await h.api('manager', 'GET', '/api/compensation/team'), 200);
  assert.equal(team.rounds[0].budget.area.budgetCents, 220000);
  // Der Gesamtbetrag gehört nicht in die Sicht der Führungskraft.
  assert.equal(JSON.stringify(team).includes('410000'), false);
  assert.equal(JSON.stringify(team).includes('20500000'), false);
});

test('Führungskraft sieht das Gesamtbudget nur als groben Anteil und erst bei genug fremden Vorschlägen', async () => {
  const { cycleId } = await openRoundWithTeam();
  const small = expectStatus(await h.api('manager', 'GET', '/api/compensation/team'), 200).rounds[0];
  // Außerhalb des Teams liegt noch nichts vor.
  assert.equal(small.budget.overall, null);
  assert.equal(JSON.stringify(small).includes('20500000'), false);

  expectStatus(await h.api('hr', 'POST', `/api/compensation/cycles/${cycleId}/review`), 200);
  expectStatus(await h.api('hr', 'POST', `/api/compensation/cycles/${cycleId}/close`), 200);

  for (const id of [8, 9, 10, 11]) {
    addPerson(id, 3);
    await addRecord(id, '50.000');
  }
  const next = await createCycle({ name: 'Nächste' });
  await openCycle(next.id);
  // Personen gibt es jetzt genug. Der erste fremde Vorschlag wäre aber direkt ablesbar.
  const overallNow = async () => expectStatus(await h.api('manager', 'GET', '/api/compensation/team'), 200).rounds[0].budget.overall;
  assert.equal(await overallNow(), null);
  const proposeFor = id => h.api('director', 'PUT', `/api/compensation/team/${next.id}/proposals/${id}`, { mode: 'amount', value: '137,00' });
  for (const id of [7, 8, 9, 10]) expectStatus(await proposeFor(id), 200);
  assert.equal(await overallNow(), null, 'Vier fremde Vorschläge reichen nicht');
  expectStatus(await proposeFor(11), 200);
  const overall = await overallNow();
  assert.equal(overall.overBudget, false);
  assert.equal(overall.usedPercent % 5, 0, 'Nur grob gerundet');
});

test('HR entscheidet: Regeln für genehmigen, ändern und ablehnen', async () => {
  const { cycleId } = await openRoundWithTeam();
  await propose('manager', cycleId, 'anna', { mode: 'amount', value: '100' });
  expectStatus(await h.api('hr', 'POST', `/api/compensation/cycles/${cycleId}/review`), 200);

  assert.equal((await h.api('hr', 'POST', decisionUrl(cycleId, 'anna'), { action: 'erlauben' })).status, 400);
  assert.equal((await h.api('hr', 'POST', decisionUrl(cycleId, 'anna'), {})).status, 400);
  assert.equal((await h.api('hr', 'POST', decisionUrl(cycleId, 'anna'), { action: 'change', mode: 'amount', value: '200' })).status, 400);
  assert.equal((await h.api('hr', 'POST', decisionUrl(cycleId, 'anna'), { action: 'change', mode: 'amount', value: '-1', reason: 'x' })).status, 400);
  assert.equal((await h.api('hr', 'POST', `/api/compensation/cycles/${cycleId}/decisions/9999`, { action: 'approve' })).status, 404);
  // Ohne Vorschlag gibt es nichts zu genehmigen oder abzulehnen, ändern geht aber.
  assert.equal((await h.api('hr', 'POST', decisionUrl(cycleId, 'ben'), { action: 'approve' })).status, 409);
  assert.equal((await h.api('hr', 'POST', decisionUrl(cycleId, 'ben'), { action: 'reject' })).status, 409);
  const direct = expectStatus(await h.api('hr', 'POST', decisionUrl(cycleId, 'ben'), { action: 'change', mode: 'percent', value: '1', reason: 'Ohne Vorschlag' }), 200);
  assert.equal(direct.participant.proposal.status, 'approved');
  assert.equal(direct.participant.plannedSalaryCents, 6060000);

  // Führungskräfte und Mitarbeitende entscheiden nicht.
  for (const person of ['manager', 'director', 'anna', 'bp']) {
    assert.equal((await h.api(person, 'POST', decisionUrl(cycleId, 'anna'), { action: 'approve' })).status, 403, person);
    assert.equal((await h.api(person, 'POST', `/api/compensation/cycles/${cycleId}/close`)).status, 403, person);
  }

  // Die Entscheidung kann bis zum Abschluss korrigiert werden.
  expectStatus(await h.api('hr', 'POST', decisionUrl(cycleId, 'anna'), { action: 'reject', reason: 'Erstmal nicht' }), 200);
  const approved = expectStatus(await h.api('hr', 'POST', decisionUrl(cycleId, 'anna'), { action: 'approve' }), 200);
  assert.equal(approved.participant.proposal.statusLabel, 'Genehmigt');
  assert.equal(approved.participant.plannedSalaryCents, 5010000);
});

test('Vier Augen in der Runde: über die eigene Vergütung entscheidet jemand anderes', async () => {
  addPerson(8, null, 'hr_admin');
  h.db.prepare('UPDATE users SET manager_id=3 WHERE id=1').run();
  await addRecord('hr', '80.000,00', {}, 8);
  await addRecord('anna', '50.000,00');
  const cycle = await createCycle({ budgetPercent: '10' });
  await openCycle(cycle.id);
  await propose('director', cycle.id, 'hr', { mode: 'amount', value: '1.000,00' });
  await propose('manager', cycle.id, 'anna', { mode: 'amount', value: '1.000,00' });
  expectStatus(await h.api('hr', 'POST', `/api/compensation/cycles/${cycle.id}/review`), 200);

  for (const body of [{ action: 'approve' }, { action: 'reject' }, { action: 'change', mode: 'amount', value: '9.000', reason: 'Ich will mehr' }]) {
    assert.equal((await h.api('hr', 'POST', decisionUrl(cycle.id, 'hr'), body)).status, 403, JSON.stringify(body));
  }
  // Die Sammelgenehmigung überspringt die eigene Zeile.
  assert.deepEqual(expectStatus(await h.api('hr', 'POST', `/api/compensation/cycles/${cycle.id}/approve-open`), 200), { approved: 1, skippedOwn: 1 });
  const own = expectStatus(await h.api('hr', 'GET', `/api/compensation/cycles/${cycle.id}`), 200).participants.find(row => row.isSelf);
  assert.equal(own.proposal.status, 'submitted');
  assert.equal((await h.api('hr', 'POST', `/api/compensation/cycles/${cycle.id}/close`)).status, 409);

  // Jemand anderes darf entscheiden, danach darf auch die betroffene Person abschließen.
  expectStatus(await h.api(8, 'POST', decisionUrl(cycle.id, 'hr'), { action: 'approve' }), 200);
  assert.equal(expectStatus(await h.api('hr', 'POST', `/api/compensation/cycles/${cycle.id}/close`), 200).created, 2);
});

test('Gesperrte Konten bekommen beim Abschluss keinen Eintrag und verschwinden aus dem Arbeitsblatt', async () => {
  const { cycleId } = await openRoundWithTeam();
  await propose('manager', cycleId, 'anna', { mode: 'amount', value: '100' });
  await propose('manager', cycleId, 'ben', { mode: 'amount', value: '100' });
  h.db.prepare('UPDATE users SET active=0 WHERE id=6').run();
  const team = expectStatus(await h.api('manager', 'GET', '/api/compensation/team'), 200);
  assert.deepEqual(team.rounds[0].rows.map(row => row.name), ['Anna Ahrens']);

  expectStatus(await h.api('hr', 'POST', `/api/compensation/cycles/${cycleId}/review`), 200);
  expectStatus(await h.api('hr', 'POST', `/api/compensation/cycles/${cycleId}/approve-open`), 200);
  const closed = expectStatus(await h.api('hr', 'POST', `/api/compensation/cycles/${cycleId}/close`), 200);
  assert.equal(closed.created, 1);
  assert.equal(closed.skippedInactive, 1);
});

test('Ein Abschluss mit Gültig-ab in der Zukunft bleibt für die Person bis dahin unsichtbar', async () => {
  const { cycleId } = await openRoundWithTeam({ effectiveDate: FUTURE });
  await propose('manager', cycleId, 'anna', { mode: 'amount', value: '1.000' });
  expectStatus(await h.api('hr', 'POST', `/api/compensation/cycles/${cycleId}/review`), 200);
  expectStatus(await h.api('hr', 'POST', `/api/compensation/cycles/${cycleId}/approve-open`), 200);
  expectStatus(await h.api('hr', 'POST', `/api/compensation/cycles/${cycleId}/close`), 200);

  const own = expectStatus(await h.api('anna', 'GET', '/api/compensation/me'), 200);
  assert.equal(own.current.annualSalaryCents, 5000000);
  assert.equal(own.history.length, 1);
  const hrView = expectStatus(await h.api('hr', 'GET', '/api/compensation/people/5'), 200);
  assert.equal(hrView.current.annualSalaryCents, 5000000);
  assert.equal(hrView.history[0].annualSalaryCents, 5100000);
  assert.equal(hrView.history[0].future, true);
});

test('Aufgaben: beim Öffnen für Führungskräfte, erledigt wenn alles vorgeschlagen ist, sonst spätestens zur Prüfung', async () => {
  const { cycleId } = await openRoundWithTeam();
  const openTasks = userId => h.db.prepare("SELECT * FROM tasks WHERE type='compensation_proposal' AND user_id=? AND done=0").all(userId);
  assert.equal(openTasks(4).length, 1);
  assert.equal(openTasks(3).length, 1);
  assert.equal(openTasks(4)[0].entity_id, cycleId);
  assert.equal(h.db.prepare("SELECT COUNT(*) count FROM tasks WHERE type='compensation_proposal'").get().count, 2);

  await propose('manager', cycleId, 'anna', { mode: 'amount', value: '100' });
  assert.equal(openTasks(4).length, 1);
  await propose('manager', cycleId, 'ben', { mode: 'amount', value: '100' });
  assert.equal(openTasks(4).length, 0);
  assert.equal(openTasks(3).length, 1);

  expectStatus(await h.api('hr', 'POST', `/api/compensation/cycles/${cycleId}/review`), 200);
  assert.equal(openTasks(3).length, 0);
});

test('Führungskräfte in der Rolle HRBP oder ohne Konto bekommen keine Aufgabe', async () => {
  h.db.prepare('UPDATE users SET manager_id=2 WHERE id=7').run();
  h.db.prepare('UPDATE users SET active=0 WHERE id=4').run();
  await addRecord('clara', '50.000');
  await addRecord('anna', '50.000');
  const cycle = await createCycle();
  await openCycle(cycle.id);
  assert.equal(h.db.prepare("SELECT COUNT(*) count FROM tasks WHERE type='compensation_proposal'").get().count, 0);
});

// ------------------------------------------------------------------------------------------
// Auswertung und Export
// ------------------------------------------------------------------------------------------

test('Auswertung: Verteilung, Personen außerhalb und Durchschnitt erst ab fünf Personen', async () => {
  const large = await createGrade({ name: 'Groß', min: '40.000', mid: '50.000', max: '60.000' });
  const small = await createGrade({ name: 'Klein', min: '40.000', mid: '50.000', max: '60.000' });
  await createGrade({ name: 'Leer' });
  await addRecord('anna', '50.000', { gradeId: large.id });
  await addRecord('ben', '55.000', { gradeId: large.id });
  await addRecord('clara', '45.000', { gradeId: large.id });
  await addRecord('manager', '70.000', { gradeId: large.id });
  await addRecord('director', '30.000', { gradeId: small.id });
  await addRecord('bp', '50.000');

  const fourPeople = expectStatus(await h.api('hr', 'GET', '/api/compensation/analytics'), 200);
  const band = fourPeople.bands.find(item => item.name === 'Groß');
  assert.equal(band.people, 4);
  assert.equal(band.averageCompaRatio, null);
  assert.equal(band.aboveBand, 1);
  assert.equal(fourPeople.bands.find(item => item.name === 'Klein').belowBand, 1);
  assert.equal(fourPeople.bands.find(item => item.name === 'Leer').people, 0);
  assert.equal(fourPeople.withoutBand, 1);
  assert.equal(fourPeople.withoutRecord, 1);
  assert.deepEqual(fourPeople.outside.map(person => [person.name, person.direction]), [['Dora Direktor', 'below'], ['Malte Manager', 'above']]);

  addPerson(8, 4);
  await addRecord(8, '50.000', { gradeId: large.id, fte: 1 });
  const fivePeople = expectStatus(await h.api('hr', 'GET', '/api/compensation/analytics'), 200);
  // (1,0 + 1,1 + 0,9 + 1,4 + 1,0) / 5 = 1,08
  assert.equal(fivePeople.bands.find(item => item.name === 'Groß').averageCompaRatio, 1.08);
  assert.equal(fivePeople.bands.find(item => item.name === 'Klein').averageCompaRatio, null);

  expectStatus(await h.api('bp', 'GET', '/api/compensation/analytics'), 200);
  for (const person of ['director', 'manager', 'anna']) {
    assert.equal((await h.api(person, 'GET', '/api/compensation/analytics')).status, 403, person);
  }
});

test('CSV-Export: nur HR-Administration, Semikolon, BOM und Schutz vor Formeln', async () => {
  const grade = await createGrade();
  await addRecord('anna', '50.000,50', { gradeId: grade.id, fte: 0.5 });
  addPerson(8, 4);
  h.db.prepare('UPDATE users SET name=? WHERE id=8').run('=HYPERLINK("http://boese.example";"Klick")');
  await addRecord(8, '60.000');

  for (const person of ['bp', 'director', 'manager', 'anna', SYSTEM_ID]) {
    assert.equal((await h.api(person, 'GET', '/api/compensation/export.csv')).status, 403, String(person));
  }

  // fetch entfernt beim Lesen als Text das BOM, deshalb hier die rohen Bytes.
  const app = express();
  app.use('/api', h.instance.router);
  const server = await new Promise(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/compensation/export.csv`, { headers: { 'x-test-user': '1' } });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/csv/);
    assert.match(response.headers.get('content-disposition'), /attachment/);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const json = await fetch(`http://127.0.0.1:${server.address().port}/api/compensation/me`, { headers: { 'x-test-user': '5' } });
    assert.equal(json.headers.get('cache-control'), 'no-store');
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);

    const lines = bytes.subarray(3).toString('utf8').trim().split('\r\n');
    assert.equal(lines.length, 3);
    assert.equal(lines[0].split(';')[0], 'Name');
    assert.ok(lines[0].includes('Jahresgehalt'));
    const anna = lines.find(line => line.startsWith('Anna'));
    assert.ok(anna.includes(';50000,50;EUR;0,5;100001,00;'), anna);
    const attacker = lines.find(line => line.includes('HYPERLINK'));
    assert.ok(attacker.startsWith(`"'=HYPERLINK(""http://boese.example"";""Klick"")"`), attacker);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }

  const logged = h.db.prepare("SELECT new_values FROM audit_log WHERE action='compensation_exported'").all();
  assert.deepEqual(logged.map(row => JSON.parse(row.new_values)), [{ rows: 2 }]);
});

test('CSV-Felder: Formeln werden mit einem Hochkomma entschärft', () => {
  for (const start of ['=', '+', '-', '@']) assert.equal(csvField(`${start}1+1`), `'${start}1+1`, start);
  assert.equal(csvField(' =1+1'), "' =1+1");
  assert.equal(csvField('\t=1'), "'\t=1");
  assert.equal(csvField('Anna'), 'Anna');
  assert.equal(csvField(''), '');
  assert.equal(csvField(null), '');
  assert.equal(csvField(50000), '50000');
  assert.equal(csvField('a;b'), '"a;b"');
  assert.equal(csvField('a"b'), '"a""b"');
  assert.equal(csvField('a\nb'), '"a\nb"');
});

// ------------------------------------------------------------------------------------------
// Keine Werte im Protokoll, in Aufgaben und in der Hilfe
// ------------------------------------------------------------------------------------------

test('Protokoll und Aufgaben enthalten keine Gehälter und keine Einstufungen', async () => {
  const grade = await createGrade({ name: 'Geheimband', min: '40.123,45', mid: '50.123,45', max: '91.234,56' });
  await addRecord('anna', '61.234,56', { gradeId: grade.id, variableTarget: '7.654,32', fte: 0.75 });
  await addRecord('ben', '62.345,67', { gradeId: grade.id });
  expectStatus(await h.api('hr', 'PATCH', `/api/compensation/grades/${grade.id}`, { max: '92.345,67' }), 200);
  const cycle = await createCycle({ name: 'Runde', budgetMode: 'amount', budgetPercent: undefined, budgetAmount: '4.444,44' });
  await openCycle(cycle.id);
  await propose('manager', cycle.id, 'anna', { mode: 'amount', value: '1.111,11', reason: 'Vertrauliche Begründung' });
  await propose('manager', cycle.id, 'ben', { mode: 'percent', value: '2,22', reason: 'Vertrauliche Begründung' });
  expectStatus(await h.api('hr', 'POST', `/api/compensation/cycles/${cycle.id}/review`), 200);
  expectStatus(await h.api('hr', 'POST', decisionUrl(cycle.id, 'anna'), { action: 'change', mode: 'amount', value: '2.222,22', reason: 'Vertrauliche Entscheidung' }), 200);
  expectStatus(await h.api('hr', 'POST', decisionUrl(cycle.id, 'ben'), { action: 'approve' }), 200);
  expectStatus(await h.api('hr', 'POST', `/api/compensation/cycles/${cycle.id}/close`), 200);
  expectStatus(await h.api('hr', 'GET', '/api/compensation/export.csv'), 200);

  const audit = h.db.prepare('SELECT * FROM audit_log').all();
  assert.ok(audit.length >= 10);
  const actions = audit.map(row => row.action);
  for (const action of ['compensation_grade_created', 'compensation_grade_updated', 'compensation_record_created', 'compensation_cycle_created', 'compensation_cycle_opened', 'compensation_proposal_saved', 'compensation_cycle_review_started', 'compensation_proposal_approved', 'compensation_cycle_closed', 'compensation_exported']) {
    assert.ok(actions.includes(action), action);
  }
  // Wer, wann und für wen steht im Protokoll.
  const created = audit.find(row => row.action === 'compensation_record_created');
  assert.equal(created.actor_id, 1);
  assert.ok(created.created_at);
  assert.equal(JSON.parse(created.new_values).userId, 5);

  // Es dürfen nur diese Felder vorkommen, und nie ein Vorher-Wert.
  const allowedKeys = new Set(['userId', 'source', 'changedByHr', 'participants', 'recordsCreated', 'rows']);
  for (const row of audit) {
    assert.equal(row.old_values, null, row.action);
    for (const key of Object.keys(JSON.parse(row.new_values || '{}'))) assert.ok(allowedKeys.has(key), `${row.action}: ${key}`);
  }

  const tasks = h.db.prepare('SELECT title FROM tasks').all();
  assert.ok(tasks.length >= 1);
  const texts = [JSON.stringify(audit), JSON.stringify(tasks)];
  const secrets = [
    '6123456', '61234', '61.234', '6234567', '62345', '765432', '7654', '4012345', '5012345', '9123456', '9234567',
    '111111', '1111,11', '222222', '2222,22', '444444', '4444,44', 'Geheimband', 'Vertraulich', 'annual', 'salary', 'grade_id', 'gradeId', 'cents', 'Cents', 'mid', 'percent'
  ];
  for (const text of texts) {
    for (const secret of secrets) assert.equal(text.includes(secret), false, `${secret} in ${text}`);
  }
});

test('Dayo-Hilfe erklärt Abläufe und nennt keine Daten', () => {
  const articles = h.instance.helpArticles;
  assert.ok(articles.length >= 3);
  for (const article of articles) {
    const text = `${article.title} ${article.answer} ${article.steps.join(' ')}`;
    assert.equal(/\d|€|EUR/.test(text), false, article.id);
    assert.ok(article.id.startsWith('compensation-'));
    assert.ok(article.roles.length);
    assert.ok(article.views.length);
    assert.ok(article.keywords.length);
  }
  const leaderOnly = articles.find(article => article.id === 'compensation-round-leader');
  assert.equal(leaderOnly.roles.includes('employee'), false);
  const hrOnly = articles.find(article => article.id === 'compensation-round-hr');
  assert.equal(hrOnly.roles.includes('employee'), false);
  assert.equal(hrOnly.roles.includes('manager'), false);
});

// ------------------------------------------------------------------------------------------
// Demo-Daten
// ------------------------------------------------------------------------------------------

test('Demo-Daten: mehrfach aufrufbar, legen keine Konten an und nutzen nur vorhandene Personen', async () => {
  const usersBefore = h.db.prepare('SELECT COUNT(*) count FROM users').get().count;
  h.instance.seedDemo();
  const count = table => h.db.prepare(`SELECT COUNT(*) count FROM ${table}`).get().count;
  const first = {
    grades: count('compensation_grades'),
    records: count('compensation_records'),
    cycles: count('compensation_cycles'),
    participants: count('compensation_cycle_participants'),
    tasks: count('tasks')
  };
  assert.ok(first.grades >= 3);
  assert.equal(first.records, 14);
  assert.equal(first.cycles, 1);
  assert.equal(first.participants, 7);
  assert.equal(first.tasks, 2);

  h.instance.seedDemo();
  assert.deepEqual({
    grades: count('compensation_grades'),
    records: count('compensation_records'),
    cycles: count('compensation_cycles'),
    participants: count('compensation_cycle_participants'),
    tasks: count('tasks')
  }, first);
  assert.equal(count('users'), usersBefore);

  // Die Demo-Daten laufen durch dieselben Regeln: Die Führungskraft kann direkt loslegen.
  const team = expectStatus(await h.api('manager', 'GET', '/api/compensation/team'), 200);
  assert.deepEqual(team.rounds[0].rows.map(row => row.name), ['Anna Ahrens', 'Ben Berg']);
  const analytics = expectStatus(await h.api('hr', 'GET', '/api/compensation/analytics'), 200);
  assert.ok(analytics.outside.length >= 1);
});

test('Demo-Daten: ohne Personen passiert nichts', () => {
  h.db.prepare('UPDATE users SET active=0').run();
  h.instance.seedDemo();
  assert.equal(h.db.prepare('SELECT COUNT(*) count FROM compensation_grades').get().count, 0);
  assert.equal(h.db.prepare('SELECT COUNT(*) count FROM compensation_records').get().count, 0);
});

test('Das Modul braucht keine anderen Module: Auch wenn alle aus sind, läuft die Runde durch', async () => {
  await h.close();
  h = await createModuleHarness(moduleWithSystemAdmin, { isModuleEnabled: () => false });
  const { cycleId } = await openRoundWithTeam();
  await propose('manager', cycleId, 'anna', { mode: 'amount', value: '100' });
  expectStatus(await h.api('hr', 'POST', `/api/compensation/cycles/${cycleId}/review`), 200);
  expectStatus(await h.api('hr', 'POST', decisionUrl(cycleId, 'anna'), { action: 'approve' }), 200);
  assert.equal(expectStatus(await h.api('hr', 'POST', `/api/compensation/cycles/${cycleId}/close`), 200).created, 1);
});

test('Das Grundgerüst lässt sich mehrfach anlegen, ohne Daten zu verlieren', async () => {
  await createGrade();
  h.instance.initialize();
  assert.equal(h.db.prepare('SELECT COUNT(*) count FROM compensation_grades').get().count, 1);
});

// ------------------------------------------------------------------------------------------
// Entscheidungen: Regel und Rechte
// ------------------------------------------------------------------------------------------

const denyOwnProposals = () => h.deps.setApprovalRule('compensation.self_approval', 'denied', { id: h.people.hr.id });
const moveToReview = async cycleId => expectStatus(await h.api('hr', 'POST', `/api/compensation/cycles/${cycleId}/review`), 200);
const closeRound = async (cycleId, actor = 'hr') => expectStatus(await h.api(actor, 'POST', `/api/compensation/cycles/${cycleId}/close`), 200);
const cycleDetail = async (cycleId, actor = 'hr') => expectStatus(await h.api(actor, 'GET', `/api/compensation/cycles/${cycleId}`), 200);
const participantOf = (detail, name) => detail.participants.find(row => row.name === name);

test('Regel „Eigene Vorschläge: Nein“: Wer einen fremden Vorschlag ändert, braucht eine zweite Person', async () => {
  addPerson(8, null, 'hr_admin');
  const { cycleId } = await openRoundWithTeam();
  await propose('manager', cycleId, 'anna', { mode: 'amount', value: '100,00' });
  await moveToReview(cycleId);
  denyOwnProposals();

  const changed = await h.api('hr', 'POST', decisionUrl(cycleId, 'anna'), { action: 'change', mode: 'amount', value: '9.000,00', reason: 'Deutlich mehr' });
  assert.equal(changed.status, 200, JSON.stringify(changed.data));
  const stored = () => ({ ...h.db.prepare('SELECT status, proposed_by, increase_cents, final_salary_cents, decided_by, changed_by_hr, decision_reason FROM compensation_proposals WHERE user_id=5').get() });
  assert.deepEqual(stored(), { status: 'submitted', proposed_by: 1, increase_cents: 900000, final_salary_cents: null, decided_by: null, changed_by_hr: 1, decision_reason: null });

  for (const body of [{ action: 'approve' }, { action: 'change', mode: 'amount', value: '9.500,00', reason: 'Noch mehr' }]) {
    assert.equal((await h.api('hr', 'POST', decisionUrl(cycleId, 'anna'), body)).status, 403, JSON.stringify(body));
  }
  assert.deepEqual(expectStatus(await h.api('hr', 'POST', `/api/compensation/cycles/${cycleId}/approve-open`), 200).approved, 0);

  // Die zweite Person entscheidet. Die Führungskraft sieht danach, dass HR den Wert geändert hat.
  assert.equal((await h.api(8, 'POST', decisionUrl(cycleId, 'anna'), { action: 'approve' })).status, 200);
  const decided = stored();
  assert.equal(decided.status, 'approved');
  assert.equal(decided.decided_by, 8);
  assert.equal(decided.changed_by_hr, 1);
  assert.equal(decided.decision_reason, 'Deutlich mehr');
  assert.ok(decided.final_salary_cents > 0);
});

test('Ändern und danach den ursprünglichen Vorschlag nehmen: Stand und Begründung passen', async () => {
  const { cycleId } = await openRoundWithTeam();
  await propose('manager', cycleId, 'anna', { mode: 'amount', value: '100,00' });
  await moveToReview(cycleId);
  const stored = () => ({ ...h.db.prepare('SELECT status, final_salary_cents, proposed_salary_cents, changed_by_hr, decision_reason FROM compensation_proposals WHERE user_id=5').get() });
  assert.equal((await h.api('hr', 'POST', decisionUrl(cycleId, 'anna'), { action: 'change', mode: 'amount', value: '900,00', reason: 'Mehr' })).status, 200);
  const changed = stored();
  assert.equal(changed.changed_by_hr, 1);
  assert.equal(changed.final_salary_cents > changed.proposed_salary_cents, true);
  assert.equal(changed.decision_reason, 'Mehr');
  assert.equal((await h.api('hr', 'POST', decisionUrl(cycleId, 'anna'), { action: 'approve' })).status, 200);
  const back = stored();
  assert.equal(back.status, 'approved');
  assert.equal(back.final_salary_cents, back.proposed_salary_cents);
  assert.equal(back.changed_by_hr, 0, 'Der Führungskraft wird nichts als geändert gezeigt, was ihr Wert ist');
  assert.equal(back.decision_reason, null);
});

test('Regel „Eigene Vorschläge: Nein“: Die zweite HR-Administration bekommt eine Aufgabe', async () => {
  addPerson(8, null, 'hr_admin');
  const { cycleId } = await openRoundWithTeam();
  await propose('manager', cycleId, 'anna', { mode: 'amount', value: '100,00' });
  await moveToReview(cycleId);
  denyOwnProposals();
  const openFor = id => h.db.prepare("SELECT COUNT(*) count FROM tasks WHERE user_id=? AND type='compensation_decision' AND entity_id=? AND done=0").get(id, cycleId).count;
  assert.equal(openFor(8), 0);
  assert.equal((await h.api('hr', 'POST', decisionUrl(cycleId, 'anna'), { action: 'change', mode: 'amount', value: '500,00', reason: 'Mehr' })).status, 200);
  assert.equal((await h.api('hr', 'POST', decisionUrl(cycleId, 'ben'), { action: 'change', mode: 'amount', value: '500,00', reason: 'Auch mehr' })).status, 200);
  assert.equal(openFor(8), 1, 'Eine Aufgabe je Runde');
  assert.equal(openFor(1), 0, 'Nicht für die Person, die den Wert vorgeschlagen hat');
  assert.equal((await h.api(8, 'POST', decisionUrl(cycleId, 'anna'), { action: 'approve' })).status, 200);
  assert.equal(openFor(8), 1, 'Ben wartet noch');
  assert.equal((await h.api(8, 'POST', decisionUrl(cycleId, 'ben'), { action: 'approve' })).status, 200);
  assert.equal(openFor(8), 0);
});

test('Regel „Eigene Vorschläge: Nein“ gilt bei jeder Entscheidung, auch beim Ändern', async () => {
  addPerson(8, null, 'hr_admin');
  h.db.prepare('UPDATE users SET manager_id=1 WHERE id=7').run();
  const { cycleId } = await openRoundWithTeam();
  await propose('hr', cycleId, 'clara', { mode: 'amount', value: '500,00' });
  await moveToReview(cycleId);
  denyOwnProposals();

  const attempts = [{ action: 'approve' }, { action: 'reject' }, { action: 'change', mode: 'amount', value: '9.000,00', reason: 'Selbst erhöht' }];
  for (const body of attempts) {
    const response = await h.api('hr', 'POST', decisionUrl(cycleId, 'clara'), body);
    assert.equal(response.status, 403, JSON.stringify(body));
    assert.match(response.data.error, /andere HR-Administration/);
  }
  const stored = h.db.prepare('SELECT status, final_salary_cents, decided_by FROM compensation_proposals WHERE user_id=7').get();
  assert.deepEqual({ ...stored }, { status: 'submitted', final_salary_cents: null, decided_by: null });
  assert.deepEqual(expectStatus(await h.api('hr', 'POST', `/api/compensation/cycles/${cycleId}/approve-open`), 200), { approved: 0, skippedOwn: 1 });

  // Die Oberfläche bekommt dieselbe Antwort und zeigt deshalb keine Knöpfe.
  const detail = await cycleDetail(cycleId);
  const clara = participantOf(detail, 'Clara Cordes');
  assert.equal(clara.decision.approve, false);
  assert.equal(clara.decision.reject, false);
  assert.equal(clara.decision.change, false);
  assert.match(clara.decision.blockedReason, /andere HR-Administration/);
  assert.deepEqual(detail.decisionRule, { ownProposalsDenied: true, otherHrAdministrators: 1 });
  assert.equal(participantOf(detail, 'Anna Ahrens').decision.blockedReason, null);

  // Die zweite HR-Administration entscheidet, beide stehen danach fest.
  const second = expectStatus(await h.api(8, 'POST', decisionUrl(cycleId, 'clara'), { action: 'approve' }), 200);
  assert.equal(second.participant.proposal.status, 'approved');
  assert.equal(second.participant.proposal.proposedBy, 'Hanna HR');
  assert.equal(second.participant.proposal.decidedBy, 'Person 8');
  assert.ok(second.participant.proposal.decidedAt);
});

test('Ohne Vorschlag setzt bei dieser Regel niemand allein eine Erhöhung fest', async () => {
  addPerson(8, null, 'hr_admin');
  const { cycleId } = await openRoundWithTeam();
  await moveToReview(cycleId);
  denyOwnProposals();
  assert.equal(participantOf(await cycleDetail(cycleId), 'Ben Berg').decision.savesProposal, true);

  const alone = expectStatus(await h.api('hr', 'POST', decisionUrl(cycleId, 'ben'), { action: 'change', mode: 'percent', value: '2', reason: 'Marktanpassung' }), 200);
  assert.equal(alone.participant.proposal.status, 'submitted');
  assert.equal(alone.participant.proposal.proposedBy, 'Hanna HR');
  assert.equal(alone.participant.proposal.reason, 'Marktanpassung');
  assert.equal(alone.participant.proposal.decidedBy, null);
  assert.match(alone.participant.decision.blockedReason, /eigener Vorschlag/);

  // Daraus wird kein Eintrag, solange niemand zweites entschieden hat.
  const blocked = await h.api('hr', 'POST', `/api/compensation/cycles/${cycleId}/close`);
  assert.equal(blocked.status, 409);
  assert.equal(blocked.data.error, 'Es ist noch 1 Vorschlag ohne Entscheidung.');
  assert.equal((await h.api('hr', 'POST', decisionUrl(cycleId, 'ben'), { action: 'change', mode: 'percent', value: '50', reason: 'Nochmal' })).status, 403);

  expectStatus(await h.api(8, 'POST', decisionUrl(cycleId, 'ben'), { action: 'approve' }), 200);
  assert.equal((await closeRound(cycleId)).created, 1);
  const record = h.db.prepare('SELECT annual_salary_cents FROM compensation_records WHERE source_cycle_id=?').get(cycleId);
  assert.equal(record.annual_salary_cents, 6120000);
});

test('Knöpfe und Hinweise folgen Regel und Rechten: HRBP entscheidet nicht, eine fehlende zweite Administration wird genannt', async () => {
  h.db.prepare('UPDATE users SET manager_id=1 WHERE id=7').run();
  const { cycleId } = await openRoundWithTeam();
  await propose('hr', cycleId, 'clara', { mode: 'amount', value: '500,00' });
  await moveToReview(cycleId);
  denyOwnProposals();

  const forPartner = await cycleDetail(cycleId, 'bp');
  for (const row of forPartner.participants) {
    assert.deepEqual(row.decision, { approve: false, reject: false, change: false, savesProposal: false, blockedReason: 'Entscheiden und Abschließen darf die HR-Administration.' });
  }
  assert.equal((await h.api('bp', 'POST', decisionUrl(cycleId, 'clara'), { action: 'approve' })).status, 403);

  assert.equal((await cycleDetail(cycleId)).decisionRule.otherHrAdministrators, 0);
  // Die Systemadministration zählt nicht als Person der Organisation, darf aber helfen.
  expectStatus(await h.api(SYSTEM_ID, 'POST', decisionUrl(cycleId, 'clara'), { action: 'approve' }), 200);
});

// ------------------------------------------------------------------------------------------
// Runden nacheinander
// ------------------------------------------------------------------------------------------

test('Zweite Runde: Ausgang ist der Stand zum Gültig-ab-Datum, kein Gehalt sinkt', async () => {
  const { cycleId: first } = await openRoundWithTeam({ name: 'Runde A', effectiveDate: '2090-01-01', budgetPercent: '10' });
  await propose('manager', first, 'anna', { mode: 'amount', value: '1.000,00' });
  await propose('manager', first, 'ben', { mode: 'percent', value: '2' });
  await propose('director', first, 'clara', { mode: 'amount', value: '500,00' });
  await moveToReview(first);
  expectStatus(await h.api('hr', 'POST', decisionUrl(first, 'anna'), { action: 'approve' }), 200);
  expectStatus(await h.api('hr', 'POST', decisionUrl(first, 'ben'), { action: 'approve' }), 200);
  expectStatus(await h.api('hr', 'POST', decisionUrl(first, 'clara'), { action: 'reject' }), 200);
  assert.equal((await closeRound(first)).created, 2);

  const second = await createCycle({ name: 'Runde B', effectiveDate: '2090-04-01' });
  // Heute gilt noch das alte Gehalt, aber die zweite Runde rechnet vom Stand am 01.04.2090 aus.
  await openCycle(second.id);
  const detail = await cycleDetail(second.id);
  assert.equal(participantOf(detail, 'Anna Ahrens').baseSalaryCents, 5100000);
  assert.equal(participantOf(detail, 'Ben Berg').baseSalaryCents, 6120000);
  assert.equal(participantOf(detail, 'Clara Cordes').baseSalaryCents, 4000000);
  assert.equal(participantOf(detail, 'Malte Manager').baseSalaryCents, 5500000);
  // 51.000 + 61.200 + 40.000 + 55.000 = 207.200, davon 3 % sind 6.216.
  assert.equal(detail.cycle.baseTotalCents, 20720000);
  assert.equal(detail.budget.overall.budgetCents, 621600);
  assert.equal(participantOf(detail, 'Anna Ahrens').newerRecordExists, false);

  // Die Führungskraft sieht das Gehalt zum Stichtag, nicht das von heute.
  const team = expectStatus(await h.api('manager', 'GET', '/api/compensation/team'), 200).rounds[0];
  assert.equal(team.cycle.effectiveDate, '2090-04-01');
  assert.deepEqual(team.rows.map(row => row.baseSalaryCents), [5100000, 6120000]);

  // 51.000 + 1 % = 51.510 und 61.200 + 1,5 % = 62.118.
  const anna = await propose('manager', second.id, 'anna', { mode: 'percent', value: '1' });
  assert.equal(anna.row.proposal.increaseCents, 51000);
  assert.equal(anna.row.proposal.proposedSalaryCents, 5151000);
  const ben = await propose('manager', second.id, 'ben', { mode: 'percent', value: '1,5' });
  assert.equal(ben.row.proposal.proposedSalaryCents, 6211800);
  await moveToReview(second.id);
  expectStatus(await h.api('hr', 'POST', `/api/compensation/cycles/${second.id}/approve-open`), 200);
  assert.equal((await closeRound(second.id)).created, 2);

  const created = h.db.prepare('SELECT user_id, annual_salary_cents, effective_date FROM compensation_records WHERE source_cycle_id=? ORDER BY user_id').all(second.id);
  assert.deepEqual(created.map(row => [row.user_id, row.annual_salary_cents, row.effective_date]), [[5, 5151000, '2090-04-01'], [6, 6211800, '2090-04-01']]);

  // Der Verlauf steigt bei allen, und für die Person selbst gilt bis dahin das heutige Gehalt.
  for (const person of ['anna', 'ben', 'clara', 'manager']) {
    const salaries = expectStatus(await h.api('hr', 'GET', `/api/compensation/people/${h.people[person].id}`), 200).history.map(record => record.annualSalaryCents).reverse();
    assert.deepEqual(salaries, [...salaries].sort((left, right) => left - right), person);
  }
  assert.equal(expectStatus(await h.api('anna', 'GET', '/api/compensation/me'), 200).current.annualSalaryCents, 5000000);
});

test('Wer erst zum Gültig-ab-Datum eine Vergütung hat, kann teilnehmen, wer erst danach, nicht', async () => {
  await addRecord('anna', '50.000,00', { effectiveDate: '2090-02-01' });
  await addRecord('ben', '50.000,00', { effectiveDate: '2090-07-01' });
  const cycle = await createCycle({ effectiveDate: '2090-04-01' });
  assert.deepEqual((await cycleDetail(cycle.id)).eligible.map(person => person.name), ['Anna Ahrens']);
});

test('Eine Runde vor einer schon beschlossenen lässt sich nicht öffnen', async () => {
  const { cycleId } = await openRoundWithTeam({ name: 'Runde April', effectiveDate: '2090-04-01' });
  await propose('manager', cycleId, 'anna', { mode: 'amount', value: '1.000,00' });
  await moveToReview(cycleId);
  await h.api('hr', 'POST', `/api/compensation/cycles/${cycleId}/approve-open`);
  await closeRound(cycleId);

  const earlier = await createCycle({ name: 'Runde Januar', effectiveDate: '2090-01-01' });
  const blocked = await h.api('hr', 'POST', `/api/compensation/cycles/${earlier.id}/open`, {});
  assert.equal(blocked.status, 409);
  assert.match(blocked.data.error, /01\.04\.2090/);
  assert.match((await cycleDetail(earlier.id)).openBlockedReason, /Runde April/);

  // Mit einem späteren Datum geht es.
  expectStatus(await h.api('hr', 'PATCH', `/api/compensation/cycles/${earlier.id}`, { effectiveDate: '2090-04-01' }), 200);
  assert.equal((await cycleDetail(earlier.id)).openBlockedReason, null);
  await openCycle(earlier.id);
});

test('Kommt während der Runde ein höherer Eintrag dazu, senkt der Abschluss das Gehalt nicht', async () => {
  const { cycleId } = await openRoundWithTeam({ effectiveDate: '2090-01-01' });
  await propose('manager', cycleId, 'anna', { mode: 'amount', value: '1.000,00' });
  await addRecord('anna', '60.000,00', { effectiveDate: '2089-06-01', reason: 'promotion' });
  await moveToReview(cycleId);
  expectStatus(await h.api('hr', 'POST', decisionUrl(cycleId, 'anna'), { action: 'approve' }), 200);
  assert.equal(participantOf(await cycleDetail(cycleId), 'Anna Ahrens').newerRecordExists, true);

  const blocked = await h.api('hr', 'POST', `/api/compensation/cycles/${cycleId}/close`);
  assert.equal(blocked.status, 409);
  assert.match(blocked.data.error, /Anna Ahrens/);
  assert.equal((await cycleDetail(cycleId)).cycle.status, 'review');
  assert.equal(h.db.prepare('SELECT COUNT(*) count FROM compensation_records WHERE source_cycle_id=?').get(cycleId).count, 0);

  expectStatus(await h.api('hr', 'POST', decisionUrl(cycleId, 'anna'), { action: 'change', mode: 'amount', value: '11.000,00', reason: 'Beförderung berücksichtigt' }), 200);
  assert.equal((await closeRound(cycleId)).created, 1);
  assert.equal(h.db.prepare('SELECT annual_salary_cents FROM compensation_records WHERE source_cycle_id=?').get(cycleId).annual_salary_cents, 6100000);
});

// ------------------------------------------------------------------------------------------
// Neuer Vergütungseintrag
// ------------------------------------------------------------------------------------------

test('Ein neuer Eintrag startet mit dem bisherigen Stand und warnt vor späteren Einträgen', async () => {
  const grade = await createGrade();
  await addRecord('anna', '40.000,00', { gradeId: grade.id, fte: '0,8', variableTarget: '2.000,00' });
  const detail = expectStatus(await h.api('hr', 'GET', '/api/compensation/people/5'), 200);
  assert.deepEqual(detail.entryDefaults, {
    annualSalaryCents: 4000000,
    fteBasisPoints: 8000,
    gradeId: grade.id,
    gradeName: 'Band A',
    gradeActive: true,
    variableTargetCents: 200000,
    currency: 'EUR'
  });
  assert.equal(detail.next, null);

  await addRecord('anna', '45.000,00', { effectiveDate: FUTURE, reason: 'promotion' });
  const withFuture = expectStatus(await h.api('hr', 'GET', '/api/compensation/people/5'), 200);
  // Vorbelegt wird der Stand von heute, der künftige wird genannt.
  assert.equal(withFuture.entryDefaults.annualSalaryCents, 4000000);
  assert.equal(withFuture.next.annualSalaryCents, 4500000);
  assert.equal(withFuture.next.effectiveDate, FUTURE);

  // Das Band ist inzwischen abgeschaltet: Die Oberfläche kann darauf hinweisen.
  expectStatus(await h.api('hr', 'PATCH', `/api/compensation/grades/${grade.id}`, { active: false }), 200);
  assert.equal(expectStatus(await h.api('hr', 'GET', '/api/compensation/people/5'), 200).entryDefaults.gradeActive, false);

  // Ohne Eintrag gibt es nichts vorzubelegen.
  assert.equal(expectStatus(await h.api('hr', 'GET', '/api/compensation/people/6'), 200).entryDefaults, null);

  // Die Liste nennt künftige Änderungen, die Person selbst sieht sie nicht.
  const people = expectStatus(await h.api('hr', 'GET', '/api/compensation/people'), 200).people;
  assert.equal(people.find(person => person.id === 5).next.annualSalaryCents, 4500000);
  assert.equal(people.find(person => person.id === 6).next, null);
  assert.equal(JSON.stringify(expectStatus(await h.api('anna', 'GET', '/api/compensation/people/5'), 200)).includes('4500000'), false);
});

// ------------------------------------------------------------------------------------------
// Ergebnis für Führungskräfte und HR
// ------------------------------------------------------------------------------------------

const resultsOf = async person => expectStatus(await h.api(person, 'GET', '/api/compensation/team/results'), 200).results;
const noticesOf = person => h.db.prepare("SELECT * FROM tasks WHERE type='compensation_result_notice' AND user_id=? AND done=0").all(h.people[person].id);

test('Ergebnis: Die Führungskraft sieht ihre Leute und erfährt, was abgelehnt wurde', async () => {
  const { cycleId } = await openRoundWithTeam({ name: 'Runde 2090', effectiveDate: '2090-01-01' });
  await propose('manager', cycleId, 'anna', { mode: 'amount', value: '1.000,00', reason: 'Gute Arbeit' });
  await propose('manager', cycleId, 'ben', { mode: 'percent', value: '2' });
  await propose('director', cycleId, 'clara', { mode: 'amount', value: '500,00' });
  assert.deepEqual(await resultsOf('manager'), []);
  assert.deepEqual(expectStatus(await h.api('manager', 'GET', '/api/compensation/access'), 200).resultRounds, []);

  // In der Prüfung: eigene Vorschläge ja, Entscheidungen noch nicht. HR kann ja noch umentscheiden.
  await moveToReview(cycleId);
  expectStatus(await h.api('hr', 'POST', decisionUrl(cycleId, 'anna'), { action: 'reject', reason: 'Gerade erst erhöht' }), 200);
  const pending = (await resultsOf('manager'))[0];
  assert.equal(pending.cycle.status, 'review');
  assert.deepEqual(pending.rows.map(row => [row.name, row.result, row.finalSalaryCents, row.decisionReason]), [
    ['Anna Ahrens', 'pending', null, null],
    ['Ben Berg', 'pending', null, null]
  ]);
  assert.equal(pending.rows[0].proposal.increaseCents, 100000);
  assert.equal(JSON.stringify(pending).includes('Gerade erst erhöht'), false);
  assert.equal(expectStatus(await h.api('manager', 'GET', '/api/compensation/access'), 200).resultRounds[0].name, 'Runde 2090');
  assert.deepEqual(noticesOf('manager'), []);

  expectStatus(await h.api('hr', 'POST', decisionUrl(cycleId, 'ben'), { action: 'change', mode: 'amount', value: '2.500,00', reason: 'Marktanpassung' }), 200);
  expectStatus(await h.api('hr', 'POST', decisionUrl(cycleId, 'clara'), { action: 'approve' }), 200);
  await closeRound(cycleId);

  // Nach dem Abschluss: Ergebnis, Betrag, Begründung, und nur für die eigenen Leute.
  const [closed] = await resultsOf('manager');
  assert.equal(closed.cycle.status, 'closed');
  const [anna, ben] = closed.rows;
  assert.deepEqual([anna.result, anna.resultLabel, anna.finalSalaryCents, anna.decisionReason, anna.decidedBy], ['rejected', 'Abgelehnt', 5000000, 'Gerade erst erhöht', 'Hanna HR']);
  assert.deepEqual([ben.result, ben.resultLabel, ben.finalSalaryCents, ben.decisionReason], ['changed', 'Von HR geändert', 6250000, 'Marktanpassung']);
  assert.equal(JSON.stringify(closed).includes('Clara'), false);
  assert.equal(JSON.stringify(closed).includes('4050000'), false);

  const [forDirector] = await resultsOf('director');
  assert.deepEqual(forDirector.rows.map(row => [row.name, row.result, row.finalSalaryCents]), [['Clara Cordes', 'approved', 4050000], ['Malte Manager', 'none', 5500000]]);
  assert.equal(JSON.stringify(forDirector).includes('Anna'), false);

  // Hinweis mit Namen und ohne Beträge. Wer den Abschluss selbst macht, braucht keinen.
  const [notice] = noticesOf('manager');
  assert.equal(notice.title, 'Gehaltsrunde „Runde 2090“ ist entschieden: Vorschlag für Anna Ahrens abgelehnt');
  assert.equal(notice.entity_id, cycleId);
  assert.equal(notice.due_date, null);
  assert.equal(noticesOf('director')[0].title, 'Gehaltsrunde „Runde 2090“ ist entschieden: Ergebnis für Clara Cordes und Malte Manager');
  assert.deepEqual(noticesOf('hr'), []);

  // Andere Rollen sehen nichts.
  assert.equal((await h.api('anna', 'GET', '/api/compensation/team/results')).status, 403);
  assert.deepEqual(await resultsOf('bp'), []);
  assert.deepEqual(await resultsOf('hr'), []);
  assert.equal(JSON.stringify(expectStatus(await h.api('anna', 'GET', '/api/compensation/me'), 200)).includes('Gerade erst'), false);
});

test('Ergebnis: Wer selbst abschließt, braucht keinen Hinweis, die andere HR-Administration mit Team schon', async () => {
  addPerson(8, null, 'hr_admin');
  h.db.prepare('UPDATE users SET manager_id=1 WHERE id=7').run();
  h.db.prepare('UPDATE users SET manager_id=8 WHERE id=6').run();
  const { cycleId } = await openRoundWithTeam();
  await moveToReview(cycleId);
  await closeRound(cycleId);
  assert.deepEqual(noticesOf('hr'), []);
  assert.equal(h.db.prepare("SELECT COUNT(*) count FROM tasks WHERE type='compensation_result_notice' AND user_id=8 AND done=0").get().count, 1);
  // Auch ohne eigenen Vorschlag: Ihr Ergebnis sieht sie als Führungskraft.
  assert.deepEqual((await resultsOf('hr'))[0].rows.map(row => [row.name, row.result]), [['Clara Cordes', 'none']]);
});

test('Ergebnis: Ältere Runden ohne festgehaltene Zuständigkeit zeigen, wer vorgeschlagen hat', async () => {
  const { cycleId } = await openRoundWithTeam();
  await propose('manager', cycleId, 'anna', { mode: 'amount', value: '100' });
  await moveToReview(cycleId);
  await h.api('hr', 'POST', `/api/compensation/cycles/${cycleId}/approve-open`);
  await closeRound(cycleId);
  h.db.prepare('UPDATE compensation_cycle_participants SET result_manager_id=NULL WHERE cycle_id=?').run(cycleId);
  assert.deepEqual((await resultsOf('manager'))[0].rows.map(row => row.name), ['Anna Ahrens']);
});

test('Ergebnis: Es zählt die Führungskraft beim Abschluss, später sieht niemand mehr fremde Runden', async () => {
  const { cycleId } = await openRoundWithTeam({ effectiveDate: '2090-01-01' });
  await propose('manager', cycleId, 'anna', { mode: 'amount', value: '1.000,00' });
  await propose('manager', cycleId, 'ben', { mode: 'amount', value: '1.000,00' });
  await moveToReview(cycleId);

  // Wechsel in der Prüfung: Die neue Führungskraft bekommt Ergebnis und Hinweis.
  h.deps.changeManager(h.people.ben.id, h.people.director.id);
  assert.deepEqual((await resultsOf('manager'))[0].rows.map(row => row.name), ['Anna Ahrens']);
  expectStatus(await h.api('hr', 'POST', `/api/compensation/cycles/${cycleId}/approve-open`), 200);
  await closeRound(cycleId);
  assert.ok((await resultsOf('director'))[0].rows.some(row => row.name === 'Ben Berg'));
  assert.match(noticesOf('director')[0].title, /Ben Berg/);

  // Wechsel nach dem Abschluss: Weder die alte noch die neue Führungskraft liest diese Runde weiter.
  h.deps.changeManager(h.people.anna.id, h.people.director.id);
  assert.deepEqual(await resultsOf('manager'), []);
  assert.equal(JSON.stringify(await resultsOf('director')).includes('Anna'), false);
});

test('HR sieht, wer vorgeschlagen und wer entschieden hat, und der Export nennt künftige Gehälter', async () => {
  const grade = await createGrade();
  await addRecord('anna', '50.000,00', { gradeId: grade.id });
  await addRecord('ben', '60.000,00', { gradeId: grade.id });
  const cycle = await createCycle({ effectiveDate: '2090-01-01' });
  await openCycle(cycle.id);
  await propose('manager', cycle.id, 'anna', { mode: 'amount', value: '1.000,00' });
  await moveToReview(cycle.id);
  expectStatus(await h.api('hr', 'POST', decisionUrl(cycle.id, 'anna'), { action: 'approve' }), 200);
  await closeRound(cycle.id);

  const anna = participantOf(await cycleDetail(cycle.id), 'Anna Ahrens');
  assert.equal(anna.proposal.proposedBy, 'Malte Manager');
  assert.equal(anna.proposal.decidedBy, 'Hanna HR');
  assert.ok(anna.proposal.decidedAt);
  const history = expectStatus(await h.api('hr', 'GET', '/api/compensation/people/5'), 200).history;
  assert.equal(history[0].proposedBy, 'Malte Manager');
  assert.equal(history[0].decidedBy, 'Hanna HR');
  assert.equal(history[1].proposedBy, null);

  const csv = (await h.api('hr', 'GET', '/api/compensation/export.csv')).data;
  const lines = csv.trim().split('\r\n');
  const header = lines[0].split(';');
  for (const column of ['Stand', 'Vorgeschlagen von', 'Entschieden von']) assert.ok(header.includes(column), column);
  assert.equal(lines[0].includes('Compa'), false);
  const annaLines = lines.filter(line => line.startsWith('Anna'));
  assert.equal(annaLines.length, 2);
  assert.ok(annaLines[0].includes(';Aktuell;01.01.2020;50000,00;'), annaLines[0]);
  assert.ok(annaLines[1].includes(';Künftig;01.01.2090;51000,00;'), annaLines[1]);
  assert.ok(annaLines[1].endsWith(';Malte Manager;Hanna HR'), annaLines[1]);
  assert.equal(lines.filter(line => line.startsWith('Ben')).length, 1);
  assert.equal(lines.length, 4);
});

// ------------------------------------------------------------------------------------------
// Aufgaben, Führungswechsel und spätere Aufnahme
// ------------------------------------------------------------------------------------------

const proposalTasksOf = person => h.db.prepare("SELECT * FROM tasks WHERE type='compensation_proposal' AND user_id=? AND done=0").all(h.people[person]?.id ?? person);

test('Aufgabe nennt Runde und Personen, und der Titel folgt dem, was noch fehlt', async () => {
  const { cycleId } = await openRoundWithTeam({ name: 'Runde 2030' });
  assert.equal(proposalTasksOf('manager')[0].title, 'Gehaltsrunde „Runde 2030“: Vorschläge für Anna Ahrens und Ben Berg abgeben');
  assert.equal(proposalTasksOf('manager')[0].due_date, null);
  await propose('manager', cycleId, 'anna', { mode: 'amount', value: '100' });
  assert.equal(proposalTasksOf('manager')[0].title, 'Gehaltsrunde „Runde 2030“: Vorschlag für Ben Berg abgeben');
  await propose('manager', cycleId, 'ben', { mode: 'amount', value: '100' });
  assert.deepEqual(proposalTasksOf('manager'), []);
});

test('Frist: steht in der Aufgabe und lässt sich in der offenen Runde ändern', async () => {
  const invalid = [
    { name: 'R', budgetMode: 'percent', budgetPercent: '3', effectiveDate: '2030-01-01', proposalDeadline: 'bald' },
    { name: 'R', budgetMode: 'percent', budgetPercent: '3', effectiveDate: '2030-01-01', proposalDeadline: '2030-02-30' },
    { name: 'R', budgetMode: 'percent', budgetPercent: '3', effectiveDate: '2030-01-01', proposalDeadline: '2030-01-02' }
  ];
  for (const body of invalid) assert.equal((await h.api('hr', 'POST', '/api/compensation/cycles', body)).status, 400, body.proposalDeadline);

  const { cycleId } = await openRoundWithTeam({ proposalDeadline: '2029-11-30' });
  const url = `/api/compensation/cycles/${cycleId}`;
  assert.equal((await cycleDetail(cycleId)).cycle.proposalDeadline, '2029-11-30');
  assert.equal(proposalTasksOf('manager')[0].due_date, '2029-11-30');
  assert.equal(expectStatus(await h.api('manager', 'GET', '/api/compensation/team'), 200).rounds[0].cycle.proposalDeadline, '2029-11-30');

  expectStatus(await h.api('hr', 'PATCH', url, { proposalDeadline: '2029-12-15' }), 200);
  assert.equal(proposalTasksOf('manager')[0].due_date, '2029-12-15');
  assert.equal((await h.api('hr', 'PATCH', url, { proposalDeadline: '2031-01-01' })).status, 400);
  assert.equal((await h.api('hr', 'PATCH', url, { proposalDeadline: '2029-12-20', name: 'Anders' })).status, 409);
  assert.equal((await h.api('bp', 'PATCH', url, { proposalDeadline: '2029-12-20' })).status, 403);

  expectStatus(await h.api('hr', 'PATCH', url, { proposalDeadline: '' }), 200);
  assert.equal(proposalTasksOf('manager')[0].due_date, null);

  await moveToReview(cycleId);
  assert.equal((await h.api('hr', 'PATCH', url, { proposalDeadline: '2029-12-20' })).status, 409);
});

test('Führungswechsel: Die Aufgabe zieht mit, auch wenn die neue Führungskraft schon fertig war', async () => {
  const { cycleId } = await openRoundWithTeam({ name: 'Runde' });
  await propose('director', cycleId, 'clara', { mode: 'amount', value: '100' });
  await propose('director', cycleId, 'manager', { mode: 'amount', value: '100' });
  assert.deepEqual(proposalTasksOf('director'), []);

  // Ben wechselt zu Dora: Sie muss wieder ran, Malte fehlt nur noch Anna.
  assert.equal(h.deps.changeManager(h.people.ben.id, h.people.director.id), true);
  assert.equal(proposalTasksOf('director')[0].title, 'Gehaltsrunde „Runde“: Vorschlag für Ben Berg abgeben');
  assert.equal(proposalTasksOf('manager')[0].title, 'Gehaltsrunde „Runde“: Vorschlag für Anna Ahrens abgeben');
  assert.deepEqual(expectStatus(await h.api('director', 'GET', '/api/compensation/team'), 200).rounds[0].rows.map(row => row.name), ['Ben Berg', 'Clara Cordes', 'Malte Manager']);
  await propose('director', cycleId, 'ben', { mode: 'amount', value: '100' });
  assert.deepEqual(proposalTasksOf('director'), []);

  // Anna wechselt auch: Malte hat niemanden mehr, seine Aufgabe ist hinfällig.
  h.deps.changeManager(h.people.anna.id, h.people.director.id);
  assert.deepEqual(proposalTasksOf('manager'), []);
  assert.equal(proposalTasksOf('director').length, 1);

  // Ein Vorschlag bleibt beim Wechsel erhalten, und ohne fehlenden Vorschlag entsteht keine Aufgabe.
  await propose('director', cycleId, 'anna', { mode: 'amount', value: '100' });
  h.deps.changeManager(h.people.anna.id, h.people.manager.id);
  assert.deepEqual(proposalTasksOf('manager'), []);
  assert.equal(expectStatus(await h.api('manager', 'GET', '/api/compensation/team'), 200).rounds[0].rows[0].proposal.increaseCents, 10000);

  // Eine Führungskraft in der Rolle HRBP bekommt weiter keine Aufgabe.
  addPerson(8, 4);
  await addRecord(8, '30.000,00', { effectiveDate: PAST });
  expectStatus(await h.api('hr', 'POST', `/api/compensation/cycles/${cycleId}/participants`, { userId: 8 }), 201);
  assert.equal(proposalTasksOf('manager').length, 1);
  h.deps.changeManager(8, h.people.bp.id);
  assert.deepEqual(proposalTasksOf('manager'), []);
  assert.deepEqual(proposalTasksOf('bp'), []);
});

test('In der Prüfung zieht beim Führungswechsel keine Aufgabe mehr mit', async () => {
  const { cycleId } = await openRoundWithTeam();
  await moveToReview(cycleId);
  h.deps.changeManager(h.people.anna.id, h.people.director.id);
  assert.equal(h.db.prepare("SELECT COUNT(*) count FROM tasks WHERE type='compensation_proposal' AND done=0").get().count, 0);
});

test('Wartung holt nach, was am Modul vorbeilief', async () => {
  await openRoundWithTeam({ name: 'Runde' });
  h.db.prepare('UPDATE users SET manager_id=3 WHERE id=5').run();
  h.db.prepare('UPDATE users SET active=0 WHERE id=6').run();
  h.instance.maintenance();
  h.instance.maintenance();
  assert.deepEqual(proposalTasksOf('manager'), []);
  assert.equal(proposalTasksOf('director').length, 1);
  assert.match(proposalTasksOf('director')[0].title, /Anna Ahrens/);
  assert.equal(proposalTasksOf('director')[0].title.includes('Ben Berg'), false);
});

test('HR nimmt jemanden nachträglich in eine offene Runde auf', async () => {
  const { grade, cycleId } = await openRoundWithTeam();
  await propose('manager', cycleId, 'anna', { mode: 'amount', value: '100' });
  await propose('manager', cycleId, 'ben', { mode: 'amount', value: '100' });
  assert.deepEqual(proposalTasksOf('manager'), []);
  addPerson(8, 4);
  const url = `/api/compensation/cycles/${cycleId}/participants`;

  // Ohne Eintrag geht es nicht, und die Runde sagt, wer das betrifft.
  let detail = await cycleDetail(cycleId);
  assert.ok(detail.outside.withoutEntry.some(person => person.name === 'Person 8'));
  assert.equal(detail.outside.addable.length, 0);
  const noEntry = await h.api('hr', 'POST', url, { userId: 8 });
  assert.equal(noEntry.status, 409);
  assert.match(noEntry.data.error, /Vergütungseintrag/);

  await addRecord(8, '30.000,00', { gradeId: grade.id });
  detail = await cycleDetail(cycleId);
  assert.deepEqual(detail.outside.addable.map(person => person.name), ['Person 8']);

  const added = expectStatus(await h.api('hr', 'POST', url, { userId: 8 }), 201);
  assert.equal(added.participant.baseSalaryCents, 3000000);

  // Budget und Aufgabe folgen: 205.000 + 30.000 = 235.000, davon 3 % sind 7.050.
  detail = await cycleDetail(cycleId);
  assert.equal(detail.cycle.baseTotalCents, 23500000);
  assert.equal(detail.budget.overall.budgetCents, 705000);
  assert.equal(detail.counts.participants, 5);
  assert.equal(detail.outside.addable.length, 0);
  assert.equal(proposalTasksOf('manager')[0].title.includes('Person 8'), true);
  assert.ok(expectStatus(await h.api('manager', 'GET', '/api/compensation/team'), 200).rounds[0].rows.some(row => row.name === 'Person 8'));

  // Doppelt, fremde Personen, fehlende Rechte und falscher Stand.
  assert.equal((await h.api('hr', 'POST', url, { userId: 8 })).status, 409);
  assert.equal((await h.api('hr', 'POST', url, { userId: 9999 })).status, 404);
  assert.equal((await h.api('hr', 'POST', url, { userId: SYSTEM_ID })).status, 404);
  assert.equal((await h.api('hr', 'POST', url, {})).status, 404);
  for (const person of ['bp', 'director', 'manager', 'anna']) {
    assert.equal((await h.api(person, 'POST', url, { userId: 2 })).status, 403, person);
  }
  await addRecord('bp', '30.000,00', { currency: 'CHF' });
  assert.equal((await h.api('hr', 'POST', url, { userId: h.people.bp.id })).status, 409);

  const audit = h.db.prepare("SELECT new_values FROM audit_log WHERE action='compensation_cycle_participant_added'").all();
  assert.deepEqual(audit.map(row => JSON.parse(row.new_values)), [{ userId: 8 }]);

  await moveToReview(cycleId);
  await addRecord('director', '30.000,00');
  assert.equal((await h.api('hr', 'POST', url, { userId: h.people.director.id })).status, 409);
});

test('Wer beim Öffnen ausgeschlossen wurde, lässt sich später doch aufnehmen', async () => {
  await addRecord('anna', '50.000,00');
  await addRecord('ben', '60.000,00');
  const cycle = await createCycle();
  await openCycle(cycle.id, { excludeUserIds: [h.people.ben.id] });
  assert.deepEqual((await cycleDetail(cycle.id)).outside.addable.map(person => person.name), ['Ben Berg']);
  expectStatus(await h.api('hr', 'POST', `/api/compensation/cycles/${cycle.id}/participants`, { userId: h.people.ben.id }), 201);
  assert.equal((await cycleDetail(cycle.id)).cycle.baseTotalCents, 11000000);
});

// ------------------------------------------------------------------------------------------
// Rechte einzelner HR-Rollen
// ------------------------------------------------------------------------------------------

test('Der HR Business Partner liest das Gehalt der HR-Leitung nirgends, auch nicht über Summen', async () => {
  const grade = await createGrade({ name: 'Band Leitung', min: '10.000,00', mid: '20.000,00', max: '30.000,00' });
  await addRecord('hr', '123.456,00', { gradeId: grade.id }, SYSTEM_ID);
  await addRecord('anna', '50.000,00');
  await addRecord('bp', '70.000,00');

  // Lesen einzeln und in Listen.
  assert.equal((await h.api('bp', 'GET', '/api/compensation/people/1')).status, 403);
  const secret = '12345600';
  const people = expectStatus(await h.api('bp', 'GET', '/api/compensation/people'), 200).people;
  assert.equal(people.some(person => person.name === 'Hanna HR'), false);
  assert.ok(people.some(person => person.name === 'Anna Ahrens'));
  const analytics = expectStatus(await h.api('bp', 'GET', '/api/compensation/analytics'), 200);
  assert.equal(JSON.stringify(analytics).includes('Hanna HR'), false);
  assert.equal(analytics.bands.find(band => band.name === 'Band Leitung').aboveBand, 0);
  assert.ok(expectStatus(await h.api('hr', 'GET', '/api/compensation/analytics'), 200).outside.some(person => person.name === 'Hanna HR'));
  // Die eigene Vergütung bleibt lesbar, die der anderen auch.
  expectStatus(await h.api('bp', 'GET', '/api/compensation/people/2'), 200);
  expectStatus(await h.api('bp', 'GET', '/api/compensation/people/5'), 200);

  // Runde in Prozent: Summen gelten ohne die HR-Leitung.
  const percentRound = await createCycle({ budgetPercent: '10' });
  const draft = await cycleDetail(percentRound.id, 'bp');
  assert.equal(draft.eligible.some(person => person.name === 'Hanna HR'), false);
  await openCycle(percentRound.id);
  const forPartner = await cycleDetail(percentRound.id, 'bp');
  assert.equal(forPartner.partial, true);
  assert.equal(participantOf(forPartner, 'Hanna HR'), undefined);
  assert.equal(forPartner.cycle.baseTotalCents, 12000000);
  assert.equal(forPartner.budget.overall.baseCents, 12000000);
  assert.equal(forPartner.budget.overall.budgetCents, 1200000);
  assert.equal(forPartner.counts.participants, 2);
  assert.equal(forPartner.budget.areas.some(area => area.baseCents === 12345600), false);
  assert.equal(JSON.stringify(forPartner).includes(secret), false);
  const inList = expectStatus(await h.api('bp', 'GET', '/api/compensation/cycles'), 200).cycles[0];
  assert.equal(inList.baseTotalCents, 12000000);
  assert.equal(inList.budget.baseCents, 12000000);
  assert.equal(JSON.stringify(inList).includes('13545600'), false);
  // Die HR-Administration sieht alles.
  const forAdmin = await cycleDetail(percentRound.id);
  assert.equal(forAdmin.partial, false);
  assert.equal(forAdmin.cycle.baseTotalCents, 24345600);
  await moveToReview(percentRound.id);
  await closeRound(percentRound.id);

  // Fester Betrag: Aus dem Anteil am Budget ließe sich die Summe zurückrechnen, deshalb steht dort nichts.
  const amountRound = await createCycle({ name: 'Betrag', budgetMode: 'amount', budgetPercent: undefined, budgetAmount: '9.000,00' });
  await openCycle(amountRound.id);
  const amountForPartner = await cycleDetail(amountRound.id, 'bp');
  assert.equal(amountForPartner.cycle.budgetAmountCents, null);
  assert.equal(amountForPartner.budget.overall.budgetCents, null);
  assert.equal(amountForPartner.budget.overall.usedPercent, null);
  assert.ok(amountForPartner.budget.areas.every(area => area.budgetCents === null && area.remainingCents === null));
  assert.equal(JSON.stringify(amountForPartner).includes('900000'), false);
  assert.equal(JSON.stringify(expectStatus(await h.api('bp', 'GET', '/api/compensation/cycles'), 200).cycles.find(cycle => cycle.id === amountRound.id)).includes('900000'), false);
  assert.equal((await cycleDetail(amountRound.id)).cycle.budgetAmountCents, 900000);
});

test('Die HR-Sachbearbeitung sieht keine Gehälter außer dem eigenen', async () => {
  const { id: staff } = h.deps.createUserAccount({ name: 'Sach Bearbeiter', email: 'sb@test.local', role: 'hr_staff', actor: { id: 1 } });
  h.db.prepare('UPDATE users SET must_change_password=0 WHERE id=?').run(staff);
  await addRecord(staff, '40.000,00');
  await addRecord('anna', '50.000,00');
  const cycle = await createCycle();
  await openCycle(cycle.id);

  assert.equal(expectStatus(await h.api(staff, 'GET', '/api/compensation/me'), 200).current.annualSalaryCents, 4000000);
  assert.equal(expectStatus(await h.api(staff, 'GET', `/api/compensation/people/${staff}`), 200).current.annualSalaryCents, 4000000);
  const forbidden = ['/api/compensation/people', '/api/compensation/people/5', '/api/compensation/grades', '/api/compensation/cycles', `/api/compensation/cycles/${cycle.id}`, '/api/compensation/analytics', '/api/compensation/export.csv', '/api/compensation/area-summary'];
  for (const url of forbidden) assert.equal((await h.api(staff, 'GET', url)).status, 403, url);
  assert.deepEqual(expectStatus(await h.api(staff, 'GET', '/api/compensation/team'), 200), { rounds: [] });
  assert.deepEqual(expectStatus(await h.api(staff, 'GET', '/api/compensation/team/results'), 200), { results: [] });
  const access = expectStatus(await h.api(staff, 'GET', '/api/compensation/access'), 200);
  assert.deepEqual([access.readAll, access.canWrite, access.canExport], [false, false, false]);

  const writes = [
    ['POST', '/api/compensation/people/5/records', { effectiveDate: PAST, annualSalary: '1', reason: 'other' }],
    ['POST', `/api/compensation/people/${staff}/records`, { effectiveDate: PAST, annualSalary: '90.000', reason: 'other' }],
    ['POST', '/api/compensation/cycles', { name: 'X', budgetMode: 'percent', budgetPercent: '3', effectiveDate: '2031-01-01' }],
    ['POST', `/api/compensation/cycles/${cycle.id}/participants`, { userId: 6 }],
    ['POST', `/api/compensation/cycles/${cycle.id}/review`, {}],
    ['POST', decisionUrl(cycle.id, 'anna'), { action: 'approve' }]
  ];
  for (const [method, url, body] of writes) assert.equal((await h.api(staff, method, url, body)).status, 403, url);
});

test('HR ändert nie das eigene Gehalt, auch wenn die Organisation eigene Stammdaten erlaubt', async () => {
  h.deps.setApprovalRule('personnel.hr_self_edit', 'allowed', { id: 1 });
  addPerson(8, null, 'hr_admin');
  h.db.prepare('UPDATE users SET manager_id=3 WHERE id=1').run();
  const body = { effectiveDate: PAST, annualSalary: '90.000', reason: 'other' };
  assert.equal((await h.api('hr', 'POST', '/api/compensation/people/1/records', body)).status, 403);

  await addRecord('hr', '80.000,00', {}, 8);
  const cycle = await createCycle();
  await openCycle(cycle.id);
  assert.equal((await h.api('hr', 'PUT', proposalUrl(cycle.id, 'hr'), { mode: 'amount', value: '1.000' })).status, 403);
  await moveToReview(cycle.id);
  const change = await h.api('hr', 'POST', decisionUrl(cycle.id, 'hr'), { action: 'change', mode: 'amount', value: '9.000', reason: 'Ich will mehr' });
  assert.equal(change.status, 403);
  assert.match(change.data.error, /Vier-Augen/);
  assert.equal(h.db.prepare('SELECT COUNT(*) count FROM compensation_proposals').get().count, 0);
});

// ------------------------------------------------------------------------------------------
// Sprache
// ------------------------------------------------------------------------------------------

test('Texte kommen ohne Fachjargon und mit deutschen Daten aus', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const page = fs.readFileSync(path.join(__dirname, '../public/compensation.js'), 'utf8');
  for (const word of ['Compa-Ratio', 'Aktuelles Gehalt', 'Bandposition', 'der Basis', 'Teilnehmende, ']) {
    assert.equal(page.includes(word), false, word);
  }
  for (const article of h.instance.helpArticles) {
    const text = `${article.title} ${article.answer} ${article.steps.join(' ')}`;
    assert.equal(/compa/i.test(text), false, article.id);
  }
});
