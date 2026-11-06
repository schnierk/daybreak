'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const os = require('node:os');
const { after, before, test, describe } = require('node:test');
const bcrypt = require('bcryptjs');
const { createDaybreakApp } = require('../lib/create-app');
const { createModuleHarness } = require('../lib/testing/module-harness');
const { createPersonnelModule } = require('../routes/personnel');

const TODAY = '2026-11-05';
const SUPER_ADMIN = { id: 100, name: 'Systemadministration', email: 'system-root@daybreak.internal', role: 'super_admin', title: 'Daybreak Super-Admin', manager_id: null };
const PRIVATE_DATA = {
  birthDate: '1990-03-14',
  privateAddress: 'Geheimweg 7, 10115 Berlin',
  privatePhone: '+49 30 23125 777',
  emergencyContact: 'Vertraute Person, 030 23125 888'
};
const PRIVATE_MARKERS = ['1990-03-14', 'Geheimweg', '23125 777', 'Vertraute Person'];

/** Startet das Modul mit einer verstellbaren Uhr, damit Fristen ohne Warten prüfbar sind. */
async function setup(t, { today = TODAY, withSuperAdmin = false, ...options } = {}) {
  const clock = { today, moment: null };
  const reference = {};
  const extra = { now: () => clock.moment ?? new Date(`${clock.today}T10:00:00Z`) };
  if (withSuperAdmin) {
    extra.current = req => {
      const person = req.get('x-test-user');
      if (person === 'super') return SUPER_ADMIN;
      const id = Number(person);
      if (!id) return null;
      return reference.h.db.prepare('SELECT id,name,email,role,title,manager_id FROM users WHERE id=? AND is_system_account=0 AND active=1').get(id) || null;
    };
    extra.auth = (req, res, next) => (extra.current(req) ? next() : res.status(401).json({ error: 'Nicht angemeldet' }));
  }
  const h = await createModuleHarness(createPersonnelModule, { ...options, extra });
  reference.h = h;
  t.after(() => h.close());
  h.db.prepare("INSERT INTO users(id,name,email,password_hash,role,is_system_account) VALUES(100,'Systemadministration','system-root@daybreak.internal','!ENV_MANAGED!','hr_admin',1)").run();
  return { h, clock };
}

const recordOf = (h, userId) => h.db.prepare('SELECT * FROM personnel_records WHERE user_id=?').get(userId);
const isActive = (h, userId) => h.db.prepare('SELECT active FROM users WHERE id=?').get(userId).active;
const tasksOfType = (h, type) => h.db.prepare('SELECT * FROM tasks WHERE type=? ORDER BY id').all(type);
const openTasksOfType = (h, type) => h.db.prepare('SELECT * FROM tasks WHERE type=? AND done=0 ORDER BY id').all(type);
const countChanges = h => h.db.prepare('SELECT COUNT(*) AS count FROM personnel_changes').get().count;
const auditEntries = (h, action) => h.db.prepare('SELECT * FROM audit_log WHERE action=? ORDER BY id').all(action);
const addDays = (isoDate, days) => {
  const [year, month, day] = isoDate.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
};

async function ok(responsePromise, status = 200) {
  const response = await responsePromise;
  assert.equal(response.status, status, JSON.stringify(response.data));
  return response.data;
}

const fillPrivate = (h, userId) => ok(h.api('hr', 'PATCH', `/api/personnel/${userId}/master`, PRIVATE_DATA));

function recordChange(h, userId, kind, values, effectiveDate, extra = {}, actor = 'hr') {
  return h.api(actor, 'POST', `/api/personnel/${userId}/changes`, { kind, effectiveDate, reason: 'Testgrund', values, ...extra });
}

const contractChange = (h, userId, values, effectiveDate, extra, actor) => recordChange(h, userId, 'contract', values, effectiveDate, extra, actor);
const organizationChange = (h, userId, values, effectiveDate, extra, actor) => recordChange(h, userId, 'organization', values, effectiveDate, extra, actor);
const createUnit = async (h, body) => (await ok(h.api('hr', 'POST', '/api/personnel/org-units', body), 201)).id;
const historyOf = async (h, userId, actor = 'hr') => (await ok(h.api(actor, 'GET', `/api/personnel/${userId}/history`))).changes;

describe('Anmeldung und Rollengrenzen', () => {
  test('ohne Anmeldung liefert jede Schnittstelle 401', async t => {
    const { h } = await setup(t);
    const routes = [
      ['GET', '/api/personnel/me'],
      ['PATCH', '/api/personnel/me/contact'],
      ['GET', '/api/personnel/team'],
      ['GET', '/api/personnel/people'],
      ['GET', '/api/personnel/form-options'],
      ['GET', '/api/personnel/org-units'],
      ['POST', '/api/personnel/org-units'],
      ['PATCH', '/api/personnel/org-units/1'],
      ['DELETE', '/api/personnel/org-units/1'],
      ['GET', '/api/personnel/tasks/1'],
      ['POST', '/api/personnel/tasks/1/done'],
      ['GET', '/api/personnel/5'],
      ['PATCH', '/api/personnel/5/master'],
      ['POST', '/api/personnel/5/changes'],
      ['GET', '/api/personnel/5/history'],
      ['POST', '/api/personnel/5/changes/1/cancel'],
      ['POST', '/api/personnel/5/exit'],
      ['POST', '/api/personnel/5/rehire'],
      ['POST', '/api/personnel/5/reassign-reports'],
      ['GET', '/api/personnel/5/data-export'],
      ['GET', '/api/personnel/5/data-export/readable']
    ];
    for (const [method, url] of routes) {
      const response = await h.api(null, method, url);
      assert.equal(response.status, 401, `${method} ${url}`);
    }
  });

  test('Personen ohne Datensatz lassen sich problemlos anzeigen', async t => {
    const { h } = await setup(t);
    const { sheet } = await ok(h.api('hr', 'GET', '/api/personnel/5'));
    assert.equal(sheet.hasRecord, false);
    assert.equal(sheet.person.name, 'Anna Ahrens');
    assert.equal(sheet.person.status, 'active');
    assert.equal(sheet.business.weeklyHours, null);
    assert.equal(sheet.business.orgUnit, null);
    assert.equal(sheet.private.privateAddress, null);
    const mine = await ok(h.api('anna', 'GET', '/api/personnel/me'));
    assert.equal(mine.sheet.hasRecord, false);
    assert.equal(recordOf(h, 5), undefined, 'Lesen legt keinen Datensatz an');
  });

  test('Führungskräfte bekommen für ihre Führungslinie nur dienstliche Felder', async t => {
    const { h } = await setup(t);
    await fillPrivate(h, 5);
    await ok(contractChange(h, 5, { weeklyHours: 38.5 }, TODAY), 201);
    for (const leader of ['manager', 'director']) {
      const response = await ok(h.api(leader, 'GET', '/api/personnel/5'));
      const raw = JSON.stringify(response);
      assert.equal(response.sheet.access, 'business', leader);
      assert.equal(response.sheet.business.weeklyHours, 38.5, leader);
      assert.equal(Object.hasOwn(response.sheet, 'private'), false, leader);
      assert.equal(Object.hasOwn(response.sheet, 'directReports'), false, leader);
      assert.equal(response.sheet.permissions.editMaster, false, leader);
      for (const marker of PRIVATE_MARKERS) assert.equal(raw.includes(marker), false, `${leader}: ${marker}`);
      assert.equal((await h.api(leader, 'GET', '/api/personnel/5/history')).status, 403, leader);
    }
    const team = await ok(h.api('manager', 'GET', '/api/personnel/team'));
    assert.deepEqual(team.team.map(person => person.id).sort(), [5, 6]);
    assert.equal(team.team.find(person => person.id === 5).weeklyHours, 38.5);
    for (const marker of PRIVATE_MARKERS) assert.equal(JSON.stringify(team).includes(marker), false, marker);
  });

  test('die Person selbst und HR sehen private Felder', async t => {
    const { h } = await setup(t);
    await fillPrivate(h, 5);
    for (const [person, url] of [['anna', '/api/personnel/me'], ['anna', '/api/personnel/5'], ['hr', '/api/personnel/5'], ['bp', '/api/personnel/5']]) {
      const { sheet } = await ok(h.api(person, 'GET', url));
      assert.equal(sheet.access, 'full', person);
      assert.equal(sheet.private.privateAddress, PRIVATE_DATA.privateAddress, person);
      assert.equal(sheet.private.birthDate, PRIVATE_DATA.birthDate, person);
    }
  });

  test('andere Mitarbeitende und fremde Führungskräfte sehen nichts', async t => {
    const { h } = await setup(t);
    await fillPrivate(h, 5);
    const denied = [
      ['ben', 5],
      ['clara', 5],
      ['anna', 4],
      ['anna', 6],
      ['manager', 7],
      ['manager', 3],
      ['manager', 1],
      ['clara', 1]
    ];
    for (const [person, target] of denied) {
      const response = await h.api(person, 'GET', `/api/personnel/${target}`);
      assert.equal(response.status, 403, `${person} -> ${target}`);
      assert.equal(JSON.stringify(response.data).includes('Geheimweg'), false);
    }
    assert.equal((await h.api('ben', 'GET', '/api/personnel/5/history')).status, 403);
    assert.deepEqual((await ok(h.api('anna', 'GET', '/api/personnel/team'))).team, []);
  });

  test('HR-Bereiche bleiben für alle anderen gesperrt', async t => {
    const { h } = await setup(t);
    const hrRoutes = [
      ['GET', '/api/personnel/people'],
      ['GET', '/api/personnel/form-options'],
      ['GET', '/api/personnel/org-units'],
      ['POST', '/api/personnel/org-units', { type: 'department', name: 'Test' }],
      ['PATCH', '/api/personnel/org-units/1', { name: 'Test' }],
      ['DELETE', '/api/personnel/org-units/1'],
      ['GET', '/api/personnel/tasks/1'],
      ['POST', '/api/personnel/tasks/1/done', {}],
      ['PATCH', '/api/personnel/5/master', { personnelNumber: 'X' }],
      ['POST', '/api/personnel/5/changes', { kind: 'contract', effectiveDate: TODAY, reason: 'x', values: { weeklyHours: 10 } }],
      ['POST', '/api/personnel/5/changes/1/cancel', {}],
      ['POST', '/api/personnel/5/exit', { exitDate: TODAY, reason: 'x' }],
      ['POST', '/api/personnel/5/rehire', { rehireDate: TODAY, reason: 'x' }],
      ['POST', '/api/personnel/5/reassign-reports', { managerId: 3 }],
      ['GET', '/api/personnel/5/data-export'],
      ['GET', '/api/personnel/5/data-export/readable']
    ];
    for (const person of ['anna', 'manager', 'director']) {
      for (const [method, url, body] of hrRoutes) {
        const response = await h.api(person, method, url, body);
        assert.equal(response.status, 403, `${person} ${method} ${url}`);
      }
    }
    assert.equal(isActive(h, 5), 1);
    assert.equal(recordOf(h, 5), undefined);
  });

  test('fremde und unsinnige IDs liefern nie Daten', async t => {
    const { h } = await setup(t);
    assert.equal((await h.api('anna', 'GET', '/api/personnel/999')).status, 403, 'Nicht-HR kann keine IDs erraten');
    assert.equal((await h.api('manager', 'GET', '/api/personnel/999')).status, 403);
    assert.equal((await h.api('anna', 'POST', '/api/personnel/999/exit', {})).status, 403);
    assert.equal((await h.api('hr', 'GET', '/api/personnel/999')).status, 404);
    assert.equal((await h.api('hr', 'GET', '/api/personnel/999/history')).status, 404);
    assert.equal((await h.api('hr', 'PATCH', '/api/personnel/999/master', { personnelNumber: 'X' })).status, 404);
    assert.equal((await h.api('hr', 'POST', '/api/personnel/999/exit', { exitDate: TODAY, reason: 'x' })).status, 404);
    for (const id of ['abc', '5abc', '0x5', '1e1', '5%20OR%201=1', '-5', '0']) {
      assert.equal((await h.api('hr', 'GET', `/api/personnel/${id}`)).status, 404, id);
    }
    // Das technische Konto der Systemadministration hat keine Akte.
    assert.equal((await h.api('hr', 'GET', '/api/personnel/100')).status, 404);
    assert.equal((await h.api('hr', 'POST', '/api/personnel/100/exit', { exitDate: TODAY, reason: 'x' })).status, 404);
    assert.equal((await h.api('hr', 'GET', '/api/personnel/100/data-export')).status, 404);
  });

  test('ehemalige Mitarbeitende sieht nur noch HR', async t => {
    const { h } = await setup(t);
    h.deps.setUserActive(5, false, null);
    assert.equal((await h.api('manager', 'GET', '/api/personnel/5')).status, 403);
    assert.deepEqual((await ok(h.api('manager', 'GET', '/api/personnel/team'))).team.map(person => person.id), [6]);
    assert.equal((await ok(h.api('hr', 'GET', '/api/personnel/5'))).sheet.person.status, 'locked');
  });

  test('die Systemadministration wird wie HR behandelt und hat kein eigenes Blatt', async t => {
    const { h } = await setup(t, { withSuperAdmin: true });
    await fillPrivate(h, 5);
    const { sheet } = await ok(h.api('super', 'GET', '/api/personnel/5'));
    assert.equal(sheet.private.privateAddress, PRIVATE_DATA.privateAddress);
    assert.equal(sheet.permissions.dataExport, true);
    assert.equal((await h.api('super', 'GET', '/api/personnel/me')).status, 404);
    assert.equal((await ok(h.api('super', 'GET', '/api/personnel/people'))).people.some(person => person.id === 100), false);
    await ok(contractChange(h, 5, { weeklyHours: 20 }, TODAY, {}, 'super'), 201);
    assert.equal(recordOf(h, 5).weekly_hours, 20);
    assert.equal(h.db.prepare("SELECT created_by FROM personnel_changes WHERE user_id=5").get().created_by, 100);
  });
});

describe('Selbstauskunft und Stammdaten', () => {
  test('jede Person ändert selbst nur ihre Kontaktfelder', async t => {
    const { h } = await setup(t);
    const { sheet } = await ok(h.api('anna', 'PATCH', '/api/personnel/me/contact', {
      privateAddress: 'Neue Straße 1, 20095 Hamburg',
      privatePhone: '040 23125 111',
      emergencyContact: 'Mama, 040 23125 222'
    }));
    assert.equal(sheet.private.privateAddress, 'Neue Straße 1, 20095 Hamburg');
    assert.equal(recordOf(h, 5).private_phone, '040 23125 111');

    await ok(h.api('hr', 'PATCH', '/api/personnel/5/master', { personnelNumber: 'P-1', birthDate: '1990-01-01' }));
    await ok(contractChange(h, 5, { weeklyHours: 40 }, TODAY), 201);
    const forbiddenFields = [
      { personnelNumber: 'P-2' },
      { birthDate: '2000-01-01' },
      { entryDate: '2000-01-01' },
      { weeklyHours: 10 },
      { weekly_hours: 10 },
      { orgUnitId: 1 },
      { privateAddress: 'Erlaubt', weeklyHours: 10 }
    ];
    for (const body of forbiddenFields) {
      const response = await h.api('anna', 'PATCH', '/api/personnel/me/contact', body);
      assert.equal(response.status, 403, JSON.stringify(body));
    }
    const record = recordOf(h, 5);
    assert.equal(record.personnel_number, 'P-1');
    assert.equal(record.birth_date, '1990-01-01');
    assert.equal(record.weekly_hours, 40);
    assert.equal(record.private_address, 'Neue Straße 1, 20095 Hamburg');
    assert.equal((await h.api('anna', 'PATCH', '/api/personnel/5/master', { privateAddress: 'X' })).status, 403);
    assert.equal((await contractChange(h, 5, { weeklyHours: 10 }, TODAY, {}, 'anna')).status, 403);
  });

  test('Kontaktdaten lassen sich leeren und werden geprüft', async t => {
    const { h } = await setup(t);
    await ok(h.api('anna', 'PATCH', '/api/personnel/me/contact', { privatePhone: '030 123456' }));
    await ok(h.api('anna', 'PATCH', '/api/personnel/me/contact', { privatePhone: '' }));
    assert.equal(recordOf(h, 5).private_phone, null);
    for (const body of [{ privatePhone: 'kein Telefon' }, { privatePhone: 12345 }, { privateAddress: { a: 1 } }, {}]) {
      assert.equal((await h.api('anna', 'PATCH', '/api/personnel/me/contact', body)).status, 400, JSON.stringify(body));
    }
    await ok(h.api('anna', 'PATCH', '/api/personnel/me/contact', { privateAddress: '<script>alert(1)</script>Weg 1' }));
    assert.equal(recordOf(h, 5).private_address.includes('<'), false);
  });

  test('HR pflegt Stammdaten, die Personalnummer bleibt eindeutig', async t => {
    const { h } = await setup(t);
    await ok(h.api('hr', 'PATCH', '/api/personnel/5/master', { personnelNumber: 'A-100', entryDate: '2020-02-01', ...PRIVATE_DATA }));
    const record = recordOf(h, 5);
    assert.equal(record.personnel_number, 'A-100');
    assert.equal(record.entry_date, '2020-02-01');
    assert.equal(record.private_address, PRIVATE_DATA.privateAddress);

    assert.equal((await h.api('bp', 'PATCH', '/api/personnel/6/master', { personnelNumber: 'A-100' })).status, 409);
    assert.equal((await h.api('bp', 'PATCH', '/api/personnel/6/master', { personnelNumber: 'a-100' })).status, 409, 'Groß und klein gelten als gleich');
    assert.equal(recordOf(h, 6), undefined, 'Abgelehnte Eingabe legt nichts an');
    await ok(h.api('bp', 'PATCH', '/api/personnel/5/master', { personnelNumber: 'A-100' }), 200);
    await ok(h.api('bp', 'PATCH', '/api/personnel/6/master', { personnelNumber: 'B-200' }));
    await ok(h.api('bp', 'PATCH', '/api/personnel/7/master', { personnelNumber: '' }));
    await ok(h.api('bp', 'PATCH', '/api/personnel/4/master', { personnelNumber: null }));
  });

  test('ungültige Stammdaten werden abgelehnt', async t => {
    const { h } = await setup(t);
    const invalid = [
      { birthDate: '2026-02-31' },
      { birthDate: '9999-99-99' },
      { birthDate: '14.03.1990' },
      { birthDate: ['1990-03-14'] },
      { birthDate: 19900314 },
      { birthDate: '2030-01-01' },
      { birthDate: '1800-01-01' },
      { entryDate: 'gestern' },
      { personnelNumber: 42 },
      { weeklyHours: 20 },
      { orgUnitId: 1 },
      { fixedTermEnd: TODAY },
      { unbekannt: 'x' },
      { __proto__: null, ['__proto__']: 'x' }
    ];
    for (const body of invalid) {
      assert.equal((await h.api('hr', 'PATCH', '/api/personnel/5/master', body)).status, 400, JSON.stringify(body));
    }
    assert.equal((await h.api('hr', 'PATCH', '/api/personnel/5/master', [])).status, 400);
    assert.equal(recordOf(h, 5), undefined);
  });

  test('niemand ändert die eigenen Personaldaten über den HR-Weg', async t => {
    const { h } = await setup(t);
    for (const person of ['hr', 'bp']) {
      const id = h.people[person].id;
      assert.equal((await h.api(person, 'PATCH', `/api/personnel/${id}/master`, { personnelNumber: 'SELBST' })).status, 403, person);
      assert.equal((await contractChange(h, id, { weeklyHours: 60 }, TODAY, {}, person)).status, 403, person);
      assert.equal(recordOf(h, id), undefined, person);
      const { sheet } = await ok(h.api(person, 'GET', `/api/personnel/${id}`));
      assert.equal(sheet.permissions.editMaster, false);
      assert.equal(sheet.permissions.recordChange, false);
      assert.equal(sheet.permissions.recordExit, false);
    }
    await ok(h.api('hr', 'PATCH', '/api/personnel/me/contact', { privatePhone: '030 111' }));
    assert.equal(recordOf(h, 1).private_phone, '030 111');
  });

  test('private Inhalte, Gründe und Austrittsgründe landen nicht im Protokoll', async t => {
    const { h } = await setup(t);
    await fillPrivate(h, 5);
    await ok(h.api('anna', 'PATCH', '/api/personnel/me/contact', { privateAddress: 'Geheimweg 8' }));
    await ok(contractChange(h, 5, { weeklyHours: 20 }, TODAY, { reason: 'Vertraulicher Änderungsgrund' }), 201);
    await ok(h.api('hr', 'POST', '/api/personnel/5/exit', { exitDate: addDays(TODAY, 5), reason: 'Vertraulicher Austrittsgrund' }), 201);
    const allEntries = JSON.stringify(h.db.prepare('SELECT * FROM audit_log').all());
    for (const secret of [...PRIVATE_MARKERS, 'Vertraulich']) assert.equal(allEntries.includes(secret), false, secret);
    assert.deepEqual(JSON.parse(auditEntries(h, 'personnel_contact_updated')[0].new_values).fields, ['private_address']);
    assert.equal(auditEntries(h, 'personnel_master_updated').length, 1);
    const recorded = auditEntries(h, 'personnel_change_recorded')[0];
    assert.deepEqual(JSON.parse(recorded.old_values), { weekly_hours: null });
    assert.deepEqual(JSON.parse(recorded.new_values).values, { weekly_hours: 20 });
    const titles = tasksOfType(h, 'personnel_offboarding').map(task => task.title).join(' ');
    assert.equal(titles.includes('Vertraulich'), false);
  });
});

describe('Organisationseinheiten', () => {
  test('HR legt Einheiten an und bearbeitet sie', async t => {
    const { h } = await setup(t);
    const company = await createUnit(h, { type: 'legal_entity', name: 'Muster GmbH', code: 'MG' });
    const department = await ok(h.api('bp', 'POST', '/api/personnel/org-units', { type: 'department', name: 'Technik', code: 'TECH', parentId: company, leaderUserId: 4 }), 201);
    await ok(h.api('hr', 'PATCH', `/api/personnel/org-units/${department.id}`, { name: 'Technik & Daten', code: 'TD' }));
    const { units } = await ok(h.api('hr', 'GET', '/api/personnel/org-units'));
    const stored = units.find(unit => unit.id === department.id);
    assert.equal(stored.name, 'Technik & Daten');
    assert.equal(stored.parentId, company);
    assert.equal(stored.leader.name, 'Malte Manager');
    assert.equal(stored.typeLabel, 'Abteilung');
    assert.equal(auditEntries(h, 'personnel_org_unit_created').length, 2);
    assert.equal(auditEntries(h, 'personnel_org_unit_updated').length, 1);
  });

  test('ungültige Einheiten werden abgelehnt', async t => {
    const { h } = await setup(t);
    const location = await createUnit(h, { type: 'location', name: 'Berlin', code: 'BER' });
    const invalid = [
      { name: 'Ohne Typ' },
      { type: 'team', name: 'Falscher Typ' },
      { type: 'department' },
      { type: 'department', name: '   ' },
      { type: 'department', name: 'X', parentId: 999 },
      { type: 'department', name: 'X', parentId: 'abc' },
      { type: 'department', name: 'X', parentId: location },
      { type: 'department', name: 'X', leaderUserId: 999 },
      { type: 'department', name: 'X', leaderUserId: 100 }
    ];
    for (const body of invalid) {
      assert.equal((await h.api('hr', 'POST', '/api/personnel/org-units', body)).status, 400, JSON.stringify(body));
    }
    assert.equal((await h.api('hr', 'POST', '/api/personnel/org-units', { type: 'location', name: 'Zweimal', code: 'ber' })).status, 409);
    await ok(h.api('hr', 'POST', '/api/personnel/org-units', { type: 'cost_center', name: 'Gleicher Code, anderer Typ', code: 'BER' }), 201);
    assert.equal((await h.api('hr', 'PATCH', '/api/personnel/org-units/999', { name: 'X' })).status, 404);
    assert.equal((await h.api('hr', 'DELETE', '/api/personnel/org-units/abc')).status, 404);
    assert.equal((await h.api('hr', 'PATCH', `/api/personnel/org-units/${location}`, { type: 'department' })).status, 400, 'Der Typ bleibt fest');
    assert.equal((await h.api('hr', 'PATCH', `/api/personnel/org-units/${location}`, { active: 'nein' })).status, 400);
    assert.equal((await h.api('hr', 'PATCH', `/api/personnel/org-units/${location}`, { name: '' })).status, 400);
  });

  test('Zyklen im Baum werden verhindert', async t => {
    const { h } = await setup(t);
    const top = await createUnit(h, { type: 'department', name: 'Oben' });
    const middle = await createUnit(h, { type: 'department', name: 'Mitte', parentId: top });
    const bottom = await createUnit(h, { type: 'department', name: 'Unten', parentId: middle });
    for (const [unit, parentId] of [[top, bottom], [top, middle], [middle, bottom], [top, top]]) {
      const response = await h.api('hr', 'PATCH', `/api/personnel/org-units/${unit}`, { parentId });
      assert.equal(response.status, 400, `${unit} unter ${parentId}`);
    }
    assert.equal(h.db.prepare('SELECT parent_id FROM personnel_org_units WHERE id=?').get(top).parent_id, null);
    await ok(h.api('hr', 'PATCH', `/api/personnel/org-units/${bottom}`, { parentId: top }));
    await ok(h.api('hr', 'PATCH', `/api/personnel/org-units/${bottom}`, { parentId: null }));
  });

  test('Einheiten mit Personen lassen sich nur deaktivieren, nicht löschen', async t => {
    const { h } = await setup(t);
    const department = await createUnit(h, { type: 'department', name: 'Vertrieb' });
    const other = await createUnit(h, { type: 'department', name: 'Andere' });
    await ok(organizationChange(h, 5, { orgUnitId: department }, TODAY), 201);

    const refused = await h.api('hr', 'DELETE', `/api/personnel/org-units/${department}`);
    assert.equal(refused.status, 409);
    assert.match(refused.data.error, /Personen zugeordnet/);
    assert.ok(h.db.prepare('SELECT id FROM personnel_org_units WHERE id=?').get(department));
    await ok(h.api('hr', 'PATCH', `/api/personnel/org-units/${department}`, { active: false }));
    assert.equal(recordOf(h, 5).org_unit_id, department, 'Die Zuordnung bleibt bestehen');
    assert.equal((await ok(h.api('hr', 'GET', '/api/personnel/5'))).sheet.business.orgUnit.active, false);

    // Eine deaktivierte Einheit nimmt niemanden mehr auf, und die Person bleibt änderbar.
    assert.equal((await organizationChange(h, 6, { orgUnitId: department }, TODAY)).status, 400);
    await ok(contractChange(h, 5, { weeklyHours: 30 }, TODAY), 201);
    await ok(organizationChange(h, 5, { orgUnitId: other }, TODAY), 201);
    // Die Einheit steht jetzt in der Historie von Anna und bleibt deshalb erhalten.
    assert.equal((await h.api('hr', 'DELETE', `/api/personnel/org-units/${department}`)).status, 409);

    await ok(h.api('hr', 'DELETE', `/api/personnel/org-units/${await createUnit(h, { type: 'department', name: 'Leer' })}`));
    assert.equal(auditEntries(h, 'personnel_org_unit_deleted').length, 1);
  });

  test('Abhängigkeiten im Baum und geplante Änderungen schützen Einheiten', async t => {
    const { h } = await setup(t);
    const parent = await createUnit(h, { type: 'department', name: 'Eltern' });
    const child = await createUnit(h, { type: 'department', name: 'Kind', parentId: parent });
    assert.equal((await h.api('hr', 'DELETE', `/api/personnel/org-units/${parent}`)).status, 409);
    assert.equal((await h.api('hr', 'PATCH', `/api/personnel/org-units/${parent}`, { active: false })).status, 409);
    await ok(h.api('hr', 'PATCH', `/api/personnel/org-units/${child}`, { active: false }));
    await ok(h.api('hr', 'PATCH', `/api/personnel/org-units/${parent}`, { active: false }));
    assert.equal((await h.api('hr', 'PATCH', `/api/personnel/org-units/${child}`, { active: true })).status, 409, 'Das Kind kann nicht ohne Eltern aktiv werden');
    await ok(h.api('hr', 'PATCH', `/api/personnel/org-units/${parent}`, { active: true }));
    await ok(h.api('hr', 'PATCH', `/api/personnel/org-units/${child}`, { active: true }));

    const planned = await ok(organizationChange(h, 5, { orgUnitId: child }, addDays(TODAY, 10)), 201);
    assert.equal((await h.api('hr', 'PATCH', `/api/personnel/org-units/${child}`, { active: false })).status, 409);
    assert.equal((await h.api('hr', 'DELETE', `/api/personnel/org-units/${child}`)).status, 409);
    await ok(h.api('hr', 'POST', `/api/personnel/5/changes/${planned.change.id}/cancel`, {}));
    await ok(h.api('hr', 'PATCH', `/api/personnel/org-units/${child}`, { active: false }));
  });
});

describe('Änderungen mit Wirksamkeitsdatum', () => {
  test('heute und Vergangenheit wirken sofort und stehen in der Historie', async t => {
    const { h } = await setup(t);
    const today = await ok(contractChange(h, 5, { weeklyHours: 38.5, employmentType: 'employee' }, TODAY, { reason: 'Einstellung' }), 201);
    assert.equal(today.status, 'applied');
    assert.equal(recordOf(h, 5).weekly_hours, 38.5);
    assert.equal(recordOf(h, 5).employment_type, 'employee');
    const past = await ok(contractChange(h, 6, { weeklyHours: 20 }, '2026-01-01'), 201);
    assert.equal(past.status, 'applied');
    assert.equal(recordOf(h, 6).weekly_hours, 20);

    const [entry] = await historyOf(h, 5);
    assert.equal(entry.status, 'applied');
    assert.equal(entry.effectiveDate, TODAY);
    assert.equal(entry.reason, 'Einstellung');
    assert.equal(entry.recordedBy, 'Hanna HR');
    assert.ok(entry.recordedAt.startsWith(TODAY));
    const hours = entry.fields.find(field => field.column === 'weekly_hours');
    assert.equal(hours.oldText, '–');
    assert.equal(hours.newText, '38,5');
    assert.equal(entry.fields.find(field => field.column === 'employment_type').newText, 'Angestellt');

    const row = h.db.prepare('SELECT * FROM personnel_changes WHERE user_id=5').get();
    assert.deepEqual(JSON.parse(row.old_values), { weekly_hours: null, employment_type: null });
    assert.deepEqual(JSON.parse(row.new_values), { weekly_hours: 38.5, employment_type: 'employee' });
    assert.equal(row.created_by, 1);
    assert.ok(row.created_at);
  });

  test('die Wochenstunden sind eine Kommazahl in der vereinbarten Spalte', async t => {
    const { h } = await setup(t);
    const column = h.db.prepare('PRAGMA table_info(personnel_records)').all().find(item => item.name === 'weekly_hours');
    assert.match(column.type, /^(REAL|double precision)$/);
    await ok(contractChange(h, 5, { weeklyHours: '38,5' }, TODAY), 201);
    assert.strictEqual(h.db.prepare('SELECT weekly_hours FROM personnel_records WHERE user_id=?').get(5).weekly_hours, 38.5);
    await ok(contractChange(h, 5, { weeklyHours: 40 }, TODAY), 201);
    assert.strictEqual(recordOf(h, 5).weekly_hours, 40);
  });

  test('eine zukünftige Änderung wartet und wird von maintenance am Datum wirksam', async t => {
    const { h, clock } = await setup(t);
    await ok(contractChange(h, 5, { weeklyHours: 40 }, TODAY), 201);
    const effectiveDate = addDays(TODAY, 7);
    const planned = await ok(contractChange(h, 5, { weeklyHours: 30 }, effectiveDate), 201);
    assert.equal(planned.status, 'scheduled');
    assert.equal(planned.change.canCancel, true);
    assert.equal(recordOf(h, 5).weekly_hours, 40);

    clock.today = addDays(effectiveDate, -1);
    h.instance.maintenance();
    assert.equal(recordOf(h, 5).weekly_hours, 40);
    assert.equal(h.db.prepare('SELECT status FROM personnel_changes WHERE id=?').get(planned.change.id).status, 'scheduled');

    clock.today = effectiveDate;
    h.instance.maintenance();
    assert.equal(recordOf(h, 5).weekly_hours, 30);
    const applied = h.db.prepare('SELECT * FROM personnel_changes WHERE id=?').get(planned.change.id);
    assert.equal(applied.status, 'applied');
    assert.ok(applied.applied_at);
    assert.deepEqual(JSON.parse(applied.old_values), { weekly_hours: 40 });

    const logged = auditEntries(h, 'personnel_change_applied').length;
    h.instance.maintenance();
    assert.equal(auditEntries(h, 'personnel_change_applied').length, logged, 'Ein zweiter Lauf ändert nichts');
    assert.equal((await ok(h.api('anna', 'GET', '/api/personnel/me'))).sheet.business.weeklyHours, 30);
  });

  test('„heute“ richtet sich nach der deutschen Uhrzeit, nicht nach der Weltzeit', async t => {
    const { h, clock } = await setup(t);
    const germanTomorrow = '2026-11-06';
    clock.moment = new Date('2026-11-05T22:30:00Z'); // 23:30 Uhr in Deutschland, also noch der 5.
    assert.equal((await ok(contractChange(h, 5, { weeklyHours: 20 }, germanTomorrow), 201)).status, 'scheduled');
    clock.moment = new Date('2026-11-05T23:30:00Z'); // 00:30 Uhr in Deutschland, also schon der 6.
    assert.equal((await ok(contractChange(h, 6, { weeklyHours: 20 }, germanTomorrow), 201)).status, 'applied');
    h.instance.maintenance();
    assert.equal(recordOf(h, 5).weekly_hours, 20);
  });

  test('mehrere geplante Änderungen wirken in Datumsreihenfolge', async t => {
    const { h, clock } = await setup(t);
    await ok(contractChange(h, 5, { weeklyHours: 40 }, TODAY), 201);
    await ok(contractChange(h, 5, { weeklyHours: 20 }, '2026-12-01'), 201);
    await ok(contractChange(h, 5, { weeklyHours: 30 }, '2026-11-20'), 201);
    clock.today = '2026-12-05';
    h.instance.maintenance();
    assert.equal(recordOf(h, 5).weekly_hours, 20);
    const history = await historyOf(h, 5);
    assert.deepEqual(history.map(entry => entry.effectiveDate), ['2026-12-01', '2026-11-20', TODAY]);
    assert.equal(history[0].fields[0].oldText, '30');
    assert.equal(history[1].fields[0].oldText, '40');
  });

  test('eine noch nicht wirksame Änderung kann HR zurücknehmen', async t => {
    const { h, clock } = await setup(t);
    await ok(contractChange(h, 5, { weeklyHours: 40 }, TODAY), 201);
    const effectiveDate = addDays(TODAY, 7);
    const planned = await ok(contractChange(h, 5, { weeklyHours: 30 }, effectiveDate), 201);
    const cancelUrl = `/api/personnel/5/changes/${planned.change.id}/cancel`;

    assert.equal((await h.api('anna', 'POST', cancelUrl, {})).status, 403);
    assert.equal((await h.api('manager', 'POST', cancelUrl, {})).status, 403);
    assert.equal((await h.api('hr', 'POST', `/api/personnel/6/changes/${planned.change.id}/cancel`, {})).status, 404, 'Fremde Person');
    assert.equal((await h.api('hr', 'POST', '/api/personnel/5/changes/999/cancel', {})).status, 404);
    assert.equal((await h.api('hr', 'POST', '/api/personnel/5/changes/abc/cancel', {})).status, 404);

    await ok(h.api('bp', 'POST', cancelUrl, {}));
    const row = h.db.prepare('SELECT * FROM personnel_changes WHERE id=?').get(planned.change.id);
    assert.equal(row.status, 'cancelled');
    assert.equal(row.cancelled_by, 2);
    assert.ok(row.cancelled_at);
    assert.equal((await h.api('hr', 'POST', cancelUrl, {})).status, 409, 'Nicht zweimal');
    clock.today = effectiveDate;
    h.instance.maintenance();
    assert.equal(recordOf(h, 5).weekly_hours, 40);
    assert.equal((await historyOf(h, 5)).find(entry => entry.id === planned.change.id).status, 'cancelled', 'Zurückgenommenes bleibt sichtbar');
    assert.equal(auditEntries(h, 'personnel_change_cancelled').length, 1);
  });

  test('eine wirksame Änderung lässt sich nicht mehr zurücknehmen, auch wenn sie erst heute fällig wurde', async t => {
    const { h, clock } = await setup(t);
    const applied = await ok(contractChange(h, 5, { weeklyHours: 40 }, TODAY), 201);
    assert.equal(applied.change.canCancel, false);
    assert.equal((await h.api('hr', 'POST', `/api/personnel/5/changes/${applied.change.id}/cancel`, {})).status, 409);

    const planned = await ok(contractChange(h, 5, { weeklyHours: 30 }, addDays(TODAY, 2)), 201);
    clock.today = addDays(TODAY, 2);
    // Die stündliche Wartung lief noch nicht. Fällig ist fällig.
    assert.equal((await h.api('hr', 'POST', `/api/personnel/5/changes/${planned.change.id}/cancel`, {})).status, 409);
    assert.equal(recordOf(h, 5).weekly_hours, 30);
  });

  test('eine Rückdatierung überschreibt keine jüngere wirksame Änderung', async t => {
    const { h } = await setup(t);
    await ok(contractChange(h, 5, { weeklyHours: 40 }, '2026-01-01'), 201);
    const younger = await ok(contractChange(h, 5, { weeklyHours: 30 }, '2026-10-01'), 201);
    assert.equal(recordOf(h, 5).weekly_hours, 30);

    // Ohne Bestätigung passiert gar nichts, und HR erfährt, was dagegen steht.
    const refused = await contractChange(h, 5, { weeklyHours: 35 }, '2026-09-01');
    assert.equal(refused.status, 409);
    assert.equal(refused.data.code, 'younger_change_exists');
    assert.deepEqual(refused.data.conflicts, [{ changeId: younger.change.id, effectiveDate: '2026-10-01', fields: ['Wochenstunden'] }]);
    assert.match(refused.data.error, /01\.10\.2026/);
    assert.equal(recordOf(h, 5).weekly_hours, 30);
    assert.equal(countChanges(h), 2);

    // Mit Bestätigung steht sie an ihrer Stelle in der Historie, der aktuelle Wert bleibt.
    const confirmed = await ok(contractChange(h, 5, { weeklyHours: 35 }, '2026-09-01', { confirmBackdate: true }), 201);
    assert.equal(confirmed.status, 'applied');
    assert.deepEqual(confirmed.historyOnlyFields, ['Wochenstunden']);
    assert.equal(recordOf(h, 5).weekly_hours, 30);

    const history = await historyOf(h, 5);
    assert.deepEqual(history.map(entry => entry.effectiveDate), ['2026-10-01', '2026-09-01', '2026-01-01']);
    assert.deepEqual([history[0].fields[0].oldText, history[0].fields[0].newText, history[0].fields[0].replacedOn], ['35', '30', null]);
    assert.deepEqual([history[1].fields[0].oldText, history[1].fields[0].newText, history[1].fields[0].replacedOn], ['40', '35', '2026-10-01']);
    assert.deepEqual([history[2].fields[0].oldText, history[2].fields[0].newText], ['–', '40']);

    // Der angepasste Vorgänger der jüngeren Änderung bleibt nachvollziehbar.
    const [adjusted] = auditEntries(h, 'personnel_change_predecessor_updated');
    assert.equal(adjusted.entity_id, younger.change.id);
    assert.deepEqual(JSON.parse(adjusted.old_values), { weekly_hours: 40 });
    assert.deepEqual(JSON.parse(adjusted.new_values), { weekly_hours: 35, causedByChange: confirmed.change.id });
  });

  test('die Rückfrage nennt je Feld die nächste jüngere Änderung', async t => {
    const { h } = await setup(t);
    await ok(contractChange(h, 5, { weeklyHours: 30 }, '2026-08-01'), 201);
    await ok(contractChange(h, 5, { weeklyHours: 32, probationEnd: '2026-12-31' }, '2026-10-01'), 201);
    const refused = await contractChange(h, 5, { weeklyHours: 35, probationEnd: '2026-11-30' }, '2026-06-01');
    assert.equal(refused.status, 409);
    assert.match(refused.data.error, /Wochenstunden \(ab 01\.08\.2026\), Probezeitende \(ab 01\.10\.2026\)/);
    assert.equal(refused.data.conflicts.length, 2);
  });

  test('eine Rückdatierung wirkt auf Felder ohne jüngere Änderung sofort', async t => {
    const { h } = await setup(t);
    const firstUnit = await createUnit(h, { type: 'department', name: 'Eins' });
    const secondUnit = await createUnit(h, { type: 'department', name: 'Zwei' });
    const location = await createUnit(h, { type: 'location', name: 'Berlin' });
    await ok(organizationChange(h, 5, { orgUnitId: firstUnit }, '2026-10-01'), 201);

    // Anderes Feld: kein Konflikt, keine Rückfrage.
    const unrelated = await ok(organizationChange(h, 5, { locationId: location }, '2026-09-01'), 201);
    assert.deepEqual(unrelated.historyOnlyFields, []);
    assert.equal(recordOf(h, 5).location_id, location);

    // Gemischt: nur das Feld ohne jüngere Änderung erreicht das Stammdatenblatt.
    await ok(contractChange(h, 6, { weeklyHours: 30 }, '2026-10-01'), 201);
    const mixed = await ok(contractChange(h, 6, { weeklyHours: 35, probationEnd: '2026-12-31' }, '2026-09-01', { confirmBackdate: true }), 201);
    assert.deepEqual(mixed.historyOnlyFields, ['Wochenstunden']);
    assert.equal(recordOf(h, 6).weekly_hours, 30);
    assert.equal(recordOf(h, 6).probation_end, '2026-12-31');

    // Gleiches Datum: die spätere Erfassung korrigiert, das ist keine Rückdatierung.
    const sameDay = await ok(organizationChange(h, 5, { orgUnitId: secondUnit }, '2026-10-01'), 201);
    assert.deepEqual(sameDay.historyOnlyFields, []);
    assert.equal(recordOf(h, 5).org_unit_id, secondUnit);
  });

  test('eine überfällige geplante Änderung überschreibt keine neuere Eingabe', async t => {
    const { h, clock } = await setup(t);
    await ok(contractChange(h, 5, { weeklyHours: 40 }, TODAY), 201);
    const overdue = await ok(contractChange(h, 5, { weeklyHours: 30 }, '2026-11-10'), 201);
    clock.today = '2026-11-12';
    // Die Wartung lief seit dem 10. nicht. Trotzdem gilt am Ende die Eingabe vom 12.
    await ok(contractChange(h, 5, { weeklyHours: 25 }, '2026-11-12'), 201);
    h.instance.maintenance();
    assert.equal(recordOf(h, 5).weekly_hours, 25);
    assert.equal(h.db.prepare('SELECT status FROM personnel_changes WHERE id=?').get(overdue.change.id).status, 'applied');
    const history = await historyOf(h, 5);
    assert.deepEqual(history.map(entry => entry.fields[0].newText), ['25', '30', '40']);
    assert.deepEqual(history.map(entry => entry.fields[0].oldText), ['30', '40', '–']);
  });

  test('Änderungen werden gegen den Stand zum Wirksamkeitsdatum geprüft', async t => {
    const { h } = await setup(t);
    await ok(contractChange(h, 5, { weeklyHours: 40 }, TODAY), 201);
    assert.equal((await contractChange(h, 5, { weeklyHours: 40 }, TODAY)).status, 400, 'Nichts geändert');
    await ok(contractChange(h, 5, { weeklyHours: 30 }, '2026-12-01'), 201);
    // Zum 1. Januar wäre 40 wieder eine echte Änderung, obwohl heute 40 gilt.
    const back = await ok(contractChange(h, 5, { weeklyHours: 40 }, '2027-01-01'), 201);
    assert.equal(back.status, 'scheduled');
    assert.equal((await contractChange(h, 5, { weeklyHours: 30 }, '2026-12-15')).status, 400, 'Zum 15.12. gelten ohnehin 30');
  });

  test('ungültige Änderungen werden abgelehnt', async t => {
    const { h } = await setup(t);
    const location = await createUnit(h, { type: 'location', name: 'Berlin' });
    const costCenter = await createUnit(h, { type: 'cost_center', name: '4100' });
    const inactive = await createUnit(h, { type: 'department', name: 'Alt' });
    await ok(h.api('hr', 'PATCH', `/api/personnel/org-units/${inactive}`, { active: false }));
    const base = { kind: 'contract', effectiveDate: TODAY, reason: 'Grund', values: { weeklyHours: 20 } };
    const invalid = [
      { ...base, kind: 'gehalt' },
      { ...base, kind: undefined },
      { ...base, kind: 'constructor' },
      { ...base, effectiveDate: undefined },
      { ...base, effectiveDate: '2026-02-31' },
      { ...base, effectiveDate: ['2026-11-05'] },
      { ...base, effectiveDate: '' },
      { ...base, reason: '' },
      { ...base, reason: '   ' },
      { ...base, reason: 123 },
      { ...base, values: undefined },
      { ...base, values: {} },
      { ...base, values: [] },
      { ...base, values: { unbekannt: 1 } },
      { ...base, values: { orgUnitId: location } },
      { ...base, values: { weekly_hours: 20 } },
      { ...base, values: { birthDate: '1990-01-01' } },
      { ...base, values: { weeklyHours: 0 } },
      { ...base, values: { weeklyHours: -5 } },
      { ...base, values: { weeklyHours: 61 } },
      { ...base, values: { weeklyHours: 'viel' } },
      { ...base, values: { weeklyHours: '0x10' } },
      { ...base, values: { weeklyHours: '1e1' } },
      { ...base, values: { weeklyHours: true } },
      { ...base, values: { employmentType: 'chef' } },
      { ...base, values: { contractType: 'mündlich' } },
      { ...base, kind: 'organization', values: { weeklyHours: 20 } },
      { ...base, kind: 'organization', values: { orgUnitId: 999 } },
      { ...base, kind: 'organization', values: { orgUnitId: 'abc' } },
      { ...base, kind: 'organization', values: { orgUnitId: location } },
      { ...base, kind: 'organization', values: { locationId: costCenter } },
      { ...base, kind: 'organization', values: { costCenterId: location } },
      { ...base, kind: 'organization', values: { orgUnitId: inactive } }
    ];
    for (const body of invalid) {
      assert.equal((await h.api('hr', 'POST', '/api/personnel/5/changes', body)).status, 400, JSON.stringify(body));
    }
    assert.equal(countChanges(h), 0);
    assert.equal(recordOf(h, 5), undefined);
  });

  test('Befristung und Vertragsart passen immer zusammen', async t => {
    const { h, clock } = await setup(t);
    assert.equal((await contractChange(h, 5, { contractType: 'fixed_term' }, TODAY)).status, 400, 'Befristung braucht ein Enddatum');
    assert.equal((await contractChange(h, 5, { fixedTermEnd: '2027-06-30' }, TODAY)).status, 400, 'Enddatum braucht eine Befristung');
    assert.equal((await contractChange(h, 5, { contractType: 'permanent', fixedTermEnd: '2027-06-30' }, TODAY)).status, 400);
    await ok(contractChange(h, 5, { contractType: 'fixed_term', fixedTermEnd: '2027-06-30' }, TODAY), 201);
    assert.equal(recordOf(h, 5).contract_type, 'fixed_term');

    await ok(contractChange(h, 5, { contractType: 'permanent' }, TODAY), 201);
    assert.equal(recordOf(h, 5).contract_type, 'permanent');
    assert.equal(recordOf(h, 5).fixed_term_end, null, 'Entfristung entfernt das Enddatum');
    const [entry] = await historyOf(h, 5);
    assert.deepEqual(entry.fields.map(field => field.column).sort(), ['contract_type', 'fixed_term_end']);

    await ok(h.api('hr', 'PATCH', '/api/personnel/6/master', { entryDate: '2026-06-01' }));
    assert.equal((await contractChange(h, 6, { contractType: 'fixed_term', fixedTermEnd: '2026-05-31' }, TODAY)).status, 400);
    assert.equal((await contractChange(h, 6, { probationEnd: '2026-05-31' }, TODAY)).status, 400);

    // Eine geplante Verlängerung trifft später auf einen inzwischen unbefristeten Vertrag.
    await ok(contractChange(h, 7, { contractType: 'fixed_term', fixedTermEnd: '2027-06-30' }, TODAY), 201);
    await ok(contractChange(h, 7, { fixedTermEnd: '2027-12-31' }, '2026-12-01'), 201);
    await ok(contractChange(h, 7, { contractType: 'permanent' }, TODAY), 201);
    clock.today = '2026-12-01';
    h.instance.maintenance();
    assert.equal(recordOf(h, 7).contract_type, 'permanent');
    assert.equal(recordOf(h, 7).fixed_term_end, null);
  });

  test('die Person selbst sieht wirksame Änderungen, aber keine Gründe und nichts Geplantes', async t => {
    const { h } = await setup(t);
    await ok(contractChange(h, 5, { weeklyHours: 30 }, TODAY, { reason: 'Vertrauliche Notiz' }), 201);
    await ok(contractChange(h, 5, { weeklyHours: 20 }, addDays(TODAY, 30), { reason: 'Noch geheim' }), 201);
    const own = await historyOf(h, 5, 'anna');
    assert.equal(own.length, 1);
    assert.equal(own[0].fields[0].newText, '30');
    assert.equal(Object.hasOwn(own[0], 'reason'), false);
    assert.equal(Object.hasOwn(own[0], 'recordedBy'), false);
    assert.equal(JSON.stringify(own).includes('Vertrauliche'), false);
    assert.equal(JSON.stringify(own).includes('geheim'), false);
    assert.equal((await historyOf(h, 5, 'bp')).length, 2);
  });
});

describe('Austritt und Wiedereintritt', () => {
  test('das Austrittsdatum ist der letzte Arbeitstag: Ein Austritt heute sperrt erst morgen und lässt sich bis dahin zurücknehmen', async t => {
    const { h, clock } = await setup(t);
    const result = await ok(h.api('hr', 'POST', '/api/personnel/5/exit', { exitDate: TODAY, reason: 'Versehen' }), 201);
    assert.equal(result.status, 'exit_planned');
    assert.match(result.message, /Letzter Arbeitstag ist der 05\.11\.2026, am 06\.11\.2026 wird das Konto gesperrt/);
    assert.equal(isActive(h, 5), 1, 'Am letzten Arbeitstag hat die Person noch Zugang');
    await ok(h.api('anna', 'GET', '/api/personnel/me'));
    h.instance.maintenance();
    assert.equal(isActive(h, 5), 1, 'Auch die Wartung lässt den letzten Arbeitstag in Ruhe');

    const { sheet } = await ok(h.api('hr', 'GET', '/api/personnel/5'));
    assert.equal(sheet.person.status, 'exit_planned');
    assert.equal(sheet.permissions.cancelExit, true);
    await ok(h.api('hr', 'POST', `/api/personnel/5/changes/${sheet.exit.changeId}/cancel`, {}));
    assert.equal((await ok(h.api('hr', 'GET', '/api/personnel/5'))).sheet.person.status, 'active');
    assert.equal(openTasksOfType(h, 'personnel_offboarding').length, 0);

    await ok(h.api('hr', 'POST', '/api/personnel/5/exit', { exitDate: TODAY, reason: 'Kündigung' }), 201);
    clock.today = addDays(TODAY, 1);
    h.instance.maintenance();
    assert.equal(isActive(h, 5), 0, 'Am Tag danach ist das Konto gesperrt');
    assert.equal((await h.api('anna', 'GET', '/api/personnel/me')).status, 401);
  });

  test('ein vergangenes Datum und „Zugang sofort sperren“ wirken sofort, nur ein Datum in der Zukunft passt nicht dazu', async t => {
    const { h } = await setup(t);
    const future = await h.api('hr', 'POST', '/api/personnel/6/exit', { exitDate: addDays(TODAY, 3), reason: 'x', lockNow: true });
    assert.equal(future.status, 400);
    assert.match(future.data.error, /Sofort sperren geht nur bei einem Austritt heute/);
    assert.equal(isActive(h, 6), 1);
    assert.equal(countChanges(h), 0);
    assert.equal((await ok(h.api('hr', 'POST', '/api/personnel/6/exit', { exitDate: addDays(TODAY, -1), reason: 'Nachgetragen' }), 201)).status, 'left');
    assert.equal(isActive(h, 6), 0);
  });

  test('„Zugang sofort sperren“ sperrt sofort und löscht nichts', async t => {
    const { h } = await setup(t);
    await fillPrivate(h, 5);
    await ok(contractChange(h, 5, { weeklyHours: 40 }, '2026-01-01'), 201);
    const result = await ok(h.api('hr', 'POST', '/api/personnel/5/exit', { exitDate: TODAY, reason: 'Eigene Kündigung', lockNow: true }), 201);
    assert.equal(result.status, 'left');
    assert.equal(isActive(h, 5), 0, 'Das Konto ist wirklich gesperrt');
    assert.equal((await h.api('anna', 'GET', '/api/personnel/me')).status, 401);

    const record = recordOf(h, 5);
    assert.equal(record.private_address, PRIVATE_DATA.privateAddress, 'Daten bleiben erhalten');
    assert.equal(record.weekly_hours, 40);
    assert.equal(auditEntries(h, 'user_deactivated').length, 1);
    assert.equal(auditEntries(h, 'user_deactivated')[0].actor_id, 1);

    const tasks = tasksOfType(h, 'personnel_offboarding');
    assert.deepEqual(tasks.map(task => task.user_id).sort(), [1, 2]);
    assert.match(tasks[0].title, /Anna Ahrens/);
    assert.equal(tasks[0].due_date, TODAY);

    const { sheet } = await ok(h.api('hr', 'GET', '/api/personnel/5'));
    assert.equal(sheet.person.status, 'left');
    assert.equal(sheet.exit.reason, 'Eigene Kündigung');
    assert.equal(sheet.permissions.rehire, true);
    assert.equal(sheet.permissions.recordExit, false);
    const history = await historyOf(h, 5);
    assert.equal(history[0].kind, 'exit');
    assert.equal(history[0].status, 'applied');
  });

  test('ein Austritt in der Vergangenheit sperrt ebenfalls sofort', async t => {
    const { h } = await setup(t);
    const result = await ok(h.api('hr', 'POST', '/api/personnel/6/exit', { exitDate: '2026-10-01', reason: 'Nachgetragen' }), 201);
    assert.equal(result.status, 'left');
    assert.equal(isActive(h, 6), 0);
  });

  test('ein zukünftiger Austritt sperrt erst nach dem letzten Arbeitstag über maintenance', async t => {
    const { h, clock } = await setup(t);
    const exitDate = addDays(TODAY, 10);
    const result = await ok(h.api('bp', 'POST', '/api/personnel/5/exit', { exitDate, reason: 'Kündigung' }), 201);
    assert.equal(result.status, 'exit_planned');
    assert.equal(isActive(h, 5), 1);
    await ok(h.api('anna', 'GET', '/api/personnel/me'));

    clock.today = exitDate;
    h.instance.maintenance();
    assert.equal(isActive(h, 5), 1, 'Am letzten Arbeitstag noch aktiv');

    clock.today = addDays(exitDate, 1);
    h.instance.maintenance();
    assert.equal(isActive(h, 5), 0, 'Am Tag danach gesperrt');
    assert.equal((await h.api('anna', 'GET', '/api/personnel/me')).status, 401);
    assert.equal(auditEntries(h, 'user_deactivated').length, 1);
    assert.equal(auditEntries(h, 'user_deactivated')[0].actor_id, null, 'Die Automatik sperrt, nicht HR');

    h.instance.maintenance();
    assert.equal(auditEntries(h, 'user_deactivated').length, 1, 'Ein zweiter Lauf sperrt nicht erneut');
    assert.equal(tasksOfType(h, 'personnel_offboarding').length, 2);
  });

  test('ein geplanter Austritt lässt sich vor dem Datum zurücknehmen', async t => {
    const { h, clock } = await setup(t);
    const exitDate = addDays(TODAY, 10);
    await ok(h.api('hr', 'POST', '/api/personnel/5/exit', { exitDate, reason: 'Kündigung' }), 201);
    const { sheet } = await ok(h.api('hr', 'GET', '/api/personnel/5'));
    assert.equal(sheet.person.status, 'exit_planned');
    assert.equal(sheet.permissions.cancelExit, true);
    assert.equal(openTasksOfType(h, 'personnel_offboarding').length, 2);

    await ok(h.api('hr', 'POST', `/api/personnel/5/changes/${sheet.exit.changeId}/cancel`, {}));
    assert.equal(openTasksOfType(h, 'personnel_offboarding').length, 0, 'Die Aufgabe ist erledigt');
    assert.equal((await ok(h.api('hr', 'GET', '/api/personnel/5'))).sheet.person.status, 'active');

    clock.today = addDays(exitDate, 1);
    h.instance.maintenance();
    assert.equal(isActive(h, 5), 1, 'Zurückgenommen heißt: keine Sperre');
    await ok(h.api('hr', 'POST', '/api/personnel/5/exit', { exitDate: addDays(exitDate, 5), reason: 'Neuer Termin' }), 201);
  });

  test('nach dem letzten Arbeitstag ist ein Zurücknehmen nicht mehr möglich', async t => {
    const { h, clock } = await setup(t);
    const exitDate = addDays(TODAY, 10);
    await ok(h.api('hr', 'POST', '/api/personnel/5/exit', { exitDate, reason: 'Kündigung' }), 201);
    const changeId = (await ok(h.api('hr', 'GET', '/api/personnel/5'))).sheet.exit.changeId;
    clock.today = addDays(exitDate, 1);
    // Die stündliche Wartung lief noch nicht. Der Austritt wirkt trotzdem.
    const response = await h.api('hr', 'POST', `/api/personnel/5/changes/${changeId}/cancel`, {});
    assert.equal(response.status, 409);
    assert.match(response.data.error, /Wiedereintritt/);
    assert.equal(isActive(h, 5), 0);
  });

  test('die Antwort nennt direkte Mitarbeitende und geführte Einheiten', async t => {
    const { h } = await setup(t);
    const department = await createUnit(h, { type: 'department', name: 'Team Manager', leaderUserId: 4 });
    const result = await ok(h.api('hr', 'POST', '/api/personnel/4/exit', { exitDate: addDays(TODAY, 3), reason: 'Wechsel' }), 201);
    assert.deepEqual(result.directReports.map(person => person.name), ['Anna Ahrens', 'Ben Berg']);
    assert.deepEqual(Object.keys(result.directReports[0]).sort(), ['id', 'name', 'title']);
    assert.deepEqual(result.ledUnits, [{ id: department, name: 'Team Manager', typeLabel: 'Abteilung' }]);
    assert.deepEqual((await ok(h.api('hr', 'GET', '/api/personnel/4'))).sheet.directReports.map(person => person.id), [5, 6]);
    const without = await ok(h.api('hr', 'POST', '/api/personnel/5/exit', { exitDate: addDays(TODAY, 3), reason: 'Wechsel' }), 201);
    assert.deepEqual(without.directReports, []);
    assert.equal((await h.api('manager', 'POST', '/api/personnel/6/exit', { exitDate: TODAY, reason: 'x' })).status, 403);
  });

  test('niemand kann das eigene Konto so sperren', async t => {
    const { h, clock } = await setup(t);
    for (const person of ['hr', 'bp']) {
      const id = h.people[person].id;
      for (const exitDate of [TODAY, addDays(TODAY, 30)]) {
        const response = await h.api(person, 'POST', `/api/personnel/${id}/exit`, { exitDate, reason: 'Selbst' });
        assert.equal(response.status, 403, `${person} ${exitDate}`);
      }
      assert.equal(isActive(h, id), 1);
    }
    assert.equal(countChanges(h), 0);
    clock.today = addDays(TODAY, 31);
    h.instance.maintenance();
    assert.equal(isActive(h, 1), 1);
    assert.equal(isActive(h, 2), 1);
  });

  test('ein eigener geplanter Austritt lässt sich nicht selbst zurücknehmen', async t => {
    const { h } = await setup(t);
    await ok(h.api('hr', 'POST', '/api/personnel/2/exit', { exitDate: addDays(TODAY, 3), reason: 'Kündigung' }), 201);
    const changeId = h.db.prepare("SELECT id FROM personnel_changes WHERE user_id=2 AND kind='exit'").get().id;
    assert.equal((await h.api('bp', 'POST', `/api/personnel/2/changes/${changeId}/cancel`, {})).status, 403);
    assert.equal((await ok(h.api('bp', 'GET', '/api/personnel/2'))).sheet.exit.date, addDays(TODAY, 3));
  });

  test('ein HR Business Partner darf keine HR-Administration sperren', async t => {
    const { h, clock } = await setup(t);
    const secondAdmin = h.deps.createUserAccount({ name: 'Zweite Admin', email: 'zweite@test.local', role: 'hr_admin', actor: { id: 1 } }).id;
    h.db.prepare('UPDATE users SET must_change_password=0 WHERE id=?').run(secondAdmin);
    for (const exitDate of [TODAY, addDays(TODAY, 3)]) {
      const refused = await h.api('bp', 'POST', `/api/personnel/${secondAdmin}/exit`, { exitDate, reason: 'x' });
      assert.equal(refused.status, 403);
      assert.equal(JSON.stringify(refused.data).includes('Zweite'), false);
    }
    assert.equal(isActive(h, secondAdmin), 1);

    const scheduled = await ok(h.api('hr', 'POST', `/api/personnel/${secondAdmin}/exit`, { exitDate: addDays(TODAY, 3), reason: 'Kündigung' }), 201);
    assert.equal(scheduled.status, 'exit_planned');
    assert.equal((await h.api('bp', 'GET', `/api/personnel/${secondAdmin}`)).status, 403, 'Die Akte der HR-Leitung bleibt für HRBP zu');
    const { sheet } = await ok(h.api('hr', 'GET', `/api/personnel/${secondAdmin}`));
    assert.equal((await h.api('bp', 'POST', `/api/personnel/${secondAdmin}/changes/${sheet.exit.changeId}/cancel`, {})).status, 403);

    clock.today = addDays(TODAY, 4);
    h.instance.maintenance();
    assert.equal(isActive(h, secondAdmin), 0);
    assert.equal((await h.api('bp', 'POST', `/api/personnel/${secondAdmin}/rehire`, { rehireDate: clock.today, reason: 'x' })).status, 403);
    await ok(h.api('hr', 'POST', `/api/personnel/${secondAdmin}/rehire`, { rehireDate: clock.today, reason: 'Rückkehr' }), 201);
    assert.equal(isActive(h, secondAdmin), 1);
    // Eine HR-Administration darf einen HR Business Partner sperren.
    assert.equal((await ok(h.api('hr', 'POST', '/api/personnel/2/exit', { exitDate: clock.today, reason: 'x', lockNow: true }), 201)).status, 'left');
  });

  test('die letzte aktive HR-Administration wird nie gesperrt', async t => {
    const { h, clock } = await setup(t, { withSuperAdmin: true });
    // Sofort: abgelehnt, auch für die Systemadministration.
    const direct = await h.api('super', 'POST', '/api/personnel/1/exit', { exitDate: TODAY, reason: 'x', lockNow: true });
    assert.equal(direct.status, 409);
    assert.equal(isActive(h, 1), 1);

    // Über Kreuz geplant: Die erste Sperre läuft, die zweite bleibt offen und meldet sich genau einmal.
    const secondAdmin = h.deps.createUserAccount({ name: 'Zweite Admin', email: 'zweite@test.local', role: 'hr_admin', actor: { id: 1 } }).id;
    const exitDate = addDays(TODAY, 5);
    await ok(h.api('hr', 'POST', `/api/personnel/${secondAdmin}/exit`, { exitDate, reason: 'a' }), 201);
    await ok(h.api(secondAdmin, 'POST', '/api/personnel/1/exit', { exitDate, reason: 'b' }), 201);
    clock.today = addDays(exitDate, 1);
    h.instance.maintenance();
    h.instance.maintenance();
    const activeAdmins = h.db.prepare("SELECT id FROM users WHERE role='hr_admin' AND active=1 AND is_system_account=0").all();
    assert.equal(activeAdmins.length, 1);
    const stillOpen = activeAdmins[0].id;
    assert.equal(h.db.prepare("SELECT status FROM personnel_changes WHERE user_id=? AND kind='exit'").get(stillOpen).status, 'scheduled');
    const warnings = tasksOfType(h, 'personnel_offboarding').filter(task => /nicht ausgeführt/.test(task.title));
    assert.equal(warnings.length, 1, 'Die Warnung kommt genau einmal');
    assert.equal(warnings[0].user_id, stillOpen, 'Sie geht an die Person, die handeln kann. HRBP erfährt nichts über die HR-Leitung');

    // Sobald es eine weitere HR-Administration gibt, wird der Austritt nachgeholt.
    h.deps.createUserAccount({ name: 'Neue Admin', email: 'neue@test.local', role: 'hr_admin', actor: { id: 1 } });
    h.instance.maintenance();
    assert.equal(isActive(h, stillOpen), 0);
    assert.equal(openTasksOfType(h, 'personnel_offboarding').filter(task => /nicht ausgeführt/.test(task.title)).length, 0, 'Die Warnung schließt sich');
  });

  test('doppelte und ungültige Austritte werden abgelehnt', async t => {
    const { h } = await setup(t);
    const url = '/api/personnel/5/exit';
    const invalid = [
      {},
      { exitDate: TODAY },
      { reason: 'x' },
      { exitDate: '2026-02-31', reason: 'x' },
      { exitDate: [TODAY], reason: 'x' },
      { exitDate: TODAY, reason: '  ' },
      { exitDate: TODAY, reason: 42 }
    ];
    for (const body of invalid) assert.equal((await h.api('hr', 'POST', url, body)).status, 400, JSON.stringify(body));
    assert.equal(isActive(h, 5), 1);

    await ok(h.api('hr', 'PATCH', '/api/personnel/5/master', { entryDate: '2026-06-01' }));
    assert.equal((await h.api('hr', 'POST', url, { exitDate: '2026-05-31', reason: 'x' })).status, 400, 'Vor dem Eintritt');

    await ok(h.api('hr', 'POST', url, { exitDate: addDays(TODAY, 3), reason: 'x' }), 201);
    assert.equal((await h.api('hr', 'POST', url, { exitDate: addDays(TODAY, 4), reason: 'y' })).status, 409, 'Schon geplant');
    await ok(h.api('hr', 'POST', '/api/personnel/6/exit', { exitDate: TODAY, reason: 'x', lockNow: true }), 201);
    assert.equal((await h.api('hr', 'POST', '/api/personnel/6/exit', { exitDate: TODAY, reason: 'y' })).status, 409, 'Schon ausgetreten');
    assert.equal(tasksOfType(h, 'personnel_offboarding').length, 4, 'Abgelehnte Anfragen legen keine Aufgaben an');
  });

  test('der Wiedereintritt reaktiviert das Konto, das Eintrittsdatum bleibt, und der Verlauf nennt ihn', async t => {
    const { h, clock } = await setup(t);
    await fillPrivate(h, 5);
    await ok(h.api('hr', 'PATCH', '/api/personnel/5/master', { entryDate: '2020-01-01' }));
    await ok(contractChange(h, 5, { weeklyHours: 40 }, '2026-01-01'), 201);
    await ok(h.api('hr', 'POST', '/api/personnel/5/exit', { exitDate: TODAY, reason: 'Kündigung', lockNow: true }), 201);
    assert.equal(isActive(h, 5), 0);
    assert.equal(openTasksOfType(h, 'personnel_offboarding').length, 2);

    clock.today = addDays(TODAY, 30);
    const url = '/api/personnel/5/rehire';
    assert.equal((await h.api('anna', 'POST', url, { rehireDate: clock.today, reason: 'x' })).status, 401, 'Gesperrt');
    assert.equal((await h.api('manager', 'POST', url, { rehireDate: clock.today, reason: 'x' })).status, 403);
    assert.equal((await h.api('hr', 'POST', url, { rehireDate: addDays(clock.today, 1), reason: 'x' })).status, 400, 'Nicht in der Zukunft');
    assert.equal((await h.api('hr', 'POST', url, { rehireDate: addDays(TODAY, -1), reason: 'x' })).status, 400, 'Nicht vor dem Austritt');
    assert.equal((await h.api('hr', 'POST', url, { rehireDate: clock.today })).status, 400, 'Grund fehlt');
    assert.equal((await h.api('hr', 'POST', '/api/personnel/6/rehire', { rehireDate: clock.today, reason: 'x' })).status, 409, 'Nicht ausgetreten');
    assert.equal(isActive(h, 5), 0);

    const result = await ok(h.api('hr', 'POST', url, { rehireDate: clock.today, reason: 'Rückkehr' }), 201);
    assert.equal(result.status, 'active');
    assert.equal(isActive(h, 5), 1);
    assert.equal(auditEntries(h, 'user_reactivated').length, 1);
    assert.equal(openTasksOfType(h, 'personnel_offboarding').length, 0);

    const record = recordOf(h, 5);
    assert.equal(record.entry_date, '2020-01-01', 'Das Eintrittsdatum bleibt der erste Tag im Unternehmen');
    assert.equal(record.private_address, PRIVATE_DATA.privateAddress);
    assert.equal(record.weekly_hours, 40);
    const history = await historyOf(h, 5);
    assert.deepEqual(history.map(entry => entry.kind), ['rehire', 'exit', 'contract']);
    assert.equal(history[0].effectiveDate, clock.today, 'Der Wiedereintritt steht mit seinem Datum im Verlauf');
    assert.deepEqual(history[0].fields, [], 'Kein Feld hat sich geändert');
    const mine = await ok(h.api('anna', 'GET', '/api/personnel/me'));
    assert.equal(mine.sheet.business.entryDate, '2020-01-01');
    assert.equal(mine.sheet.business.rehireDate, clock.today, 'Das Datenblatt nennt beide Tage');

    assert.equal((await h.api('hr', 'POST', url, { rehireDate: clock.today, reason: 'nochmal' })).status, 409);
    // Der nächste Austritt liegt nicht vor dem Wiedereintritt. Er ist danach wieder möglich.
    assert.equal((await h.api('hr', 'POST', '/api/personnel/5/exit', { exitDate: addDays(clock.today, -1), reason: 'x' })).status, 400);
    await ok(h.api('hr', 'POST', '/api/personnel/5/exit', { exitDate: clock.today, reason: 'Zweiter Austritt', lockNow: true }), 201);
    assert.equal(isActive(h, 5), 0);
  });

  test('ältere Wiedereintritte mit überschriebenem Eintrittsdatum bleiben lesbar', async t => {
    const { h } = await setup(t);
    await ok(h.api('hr', 'POST', '/api/personnel/5/exit', { exitDate: '2026-10-01', reason: 'x' }), 201);
    h.db.prepare(`
      INSERT INTO personnel_changes(user_id, kind, old_values, new_values, effective_date, reason, status, created_by, created_at, applied_at)
      VALUES(5, 'rehire', ?, ?, '2026-10-15', 'Alt', 'applied', 1, '2026-10-15T08:00:00.000Z', '2026-10-15T08:00:00.000Z')
    `).run(JSON.stringify({ active: 0, entry_date: '2023-08-01' }), JSON.stringify({ active: 1, entry_date: '2026-10-15' }));
    const [rehire] = await historyOf(h, 5);
    assert.deepEqual([rehire.fields[0].label, rehire.fields[0].oldText, rehire.fields[0].newText], ['Eintrittsdatum', '01.08.2023', '15.10.2026']);
  });

  test('geplante Änderungen vor dem Austritt wirken, spätere werden hinfällig', async t => {
    const { h, clock } = await setup(t);
    await ok(contractChange(h, 5, { weeklyHours: 40 }, TODAY), 201);
    await ok(contractChange(h, 5, { weeklyHours: 30 }, '2026-11-10'), 201);
    const later = await ok(contractChange(h, 5, { weeklyHours: 20 }, '2026-12-10'), 201);
    await ok(h.api('hr', 'POST', '/api/personnel/5/exit', { exitDate: '2026-12-01', reason: 'x' }), 201);

    clock.today = '2026-12-20';
    h.instance.maintenance();
    assert.equal(isActive(h, 5), 0);
    assert.equal(recordOf(h, 5).weekly_hours, 30);
    const row = h.db.prepare('SELECT * FROM personnel_changes WHERE id=?').get(later.change.id);
    assert.equal(row.status, 'cancelled');
    assert.match(row.cancel_note, /hinfällig/);

    assert.equal((await contractChange(h, 5, { weeklyHours: 25 }, '2027-02-01')).status, 409, 'Keine Planung für Ausgetretene');
    await ok(contractChange(h, 5, { probationEnd: '2026-06-30' }, '2026-06-01'), 201);
  });

  test('ein geplanter Austritt und sein Grund bleiben bei HR', async t => {
    const { h } = await setup(t);
    const exitDate = addDays(TODAY, 10);
    await ok(h.api('hr', 'POST', '/api/personnel/5/exit', { exitDate, reason: 'Streng vertraulich' }), 201);
    const views = [
      await ok(h.api('manager', 'GET', '/api/personnel/5')),
      await ok(h.api('anna', 'GET', '/api/personnel/me')),
      await ok(h.api('anna', 'GET', '/api/personnel/5/history')),
      await ok(h.api('manager', 'GET', '/api/personnel/team'))
    ];
    for (const view of views) {
      const raw = JSON.stringify(view);
      assert.equal(raw.includes('vertraulich'), false);
      assert.equal(raw.includes(exitDate), false);
      assert.equal(raw.includes('exit_planned'), false);
      assert.equal(raw.includes('Austritt geplant'), false);
    }
    assert.equal(views[0].sheet.person.status, 'active');
    assert.equal(views[1].sheet.person.status, 'active');
    assert.equal(Object.hasOwn(views[0].sheet, 'exit'), false);
    assert.equal(Object.hasOwn(views[1].sheet, 'exit'), false);
    const { sheet } = await ok(h.api('bp', 'GET', '/api/personnel/5'));
    assert.equal(sheet.exit.reason, 'Streng vertraulich');
    assert.equal(sheet.exit.date, exitDate);
    assert.equal(sheet.person.status, 'exit_planned');
  });

  test('Sperren über das Grundsystem und Austritt vertragen sich', async t => {
    const { h } = await setup(t);
    // Erst im Grundsystem gesperrt, dann der Austritt nachgetragen.
    h.deps.setUserActive(5, false, { id: 1 });
    assert.equal((await ok(h.api('hr', 'GET', '/api/personnel/5'))).sheet.person.status, 'locked');
    assert.equal((await h.api('hr', 'POST', '/api/personnel/5/rehire', { rehireDate: TODAY, reason: 'x' })).status, 409, 'Ohne Austritt kein Wiedereintritt');
    await ok(h.api('hr', 'POST', '/api/personnel/5/exit', { exitDate: TODAY, reason: 'x', lockNow: true }), 201);
    assert.equal((await ok(h.api('hr', 'GET', '/api/personnel/5'))).sheet.person.status, 'left');

    // Im Grundsystem wieder entsperrt: Die Person zählt als aktiv und kann erneut austreten.
    h.deps.setUserActive(5, true, { id: 1 });
    assert.equal((await ok(h.api('hr', 'GET', '/api/personnel/5'))).sheet.person.status, 'active');
    await ok(h.api('hr', 'POST', '/api/personnel/5/exit', { exitDate: TODAY, reason: 'y', lockNow: true }), 201);
    assert.equal(isActive(h, 5), 0);
  });
});

describe('Datenauskunft', () => {
  function seedOtherModules(h) {
    h.db.prepare("INSERT INTO goals(user_id,title,created_by) VALUES(5,'Annas Ziel',4),(6,'Bens Ziel',4)").run();
    h.db.prepare("INSERT INTO checkins(employee_id,manager_id,period,summary,performance,on_track) VALUES(5,4,'2026-10','Annas Gespräch',4,'on_track'),(6,4,'2026-10','Bens Gespräch',4,'on_track')").run();
    h.deps.createTask(5, 'Annas Aufgabe', 'goal', 1);
    h.deps.createTask(6, 'Bens Aufgabe', 'goal', 2);
  }

  test('nur hr_admin und super_admin dürfen exportieren', async t => {
    const { h } = await setup(t, { withSuperAdmin: true });
    await ok(h.api('hr', 'GET', '/api/personnel/5/data-export'));
    await ok(h.api('super', 'GET', '/api/personnel/5/data-export'));
    for (const person of ['bp', 'director', 'manager', 'anna', 'ben', 'clara']) {
      const response = await h.api(person, 'GET', '/api/personnel/5/data-export');
      assert.equal(response.status, 403, person);
      assert.equal(JSON.stringify(response.data).includes('Anna'), false, person);
    }
    assert.equal((await h.api('anna', 'GET', '/api/personnel/5/data-export')).status, 403, 'Auch nicht für sich selbst');
    assert.equal((await h.api('bp', 'GET', '/api/personnel/2/data-export')).status, 403, 'Auch nicht für sich selbst');
    assert.equal((await h.api('bp', 'GET', '/api/personnel/999/data-export')).status, 403, 'Keine Rückschlüsse auf IDs');
    assert.equal((await h.api('hr', 'GET', '/api/personnel/999/data-export')).status, 404);
    assert.equal((await h.api('hr', 'GET', '/api/personnel/5%20OR%201=1/data-export')).status, 404);
    assert.equal((await ok(h.api('hr', 'GET', '/api/personnel/2'))).sheet.permissions.dataExport, true);
    assert.equal((await ok(h.api('bp', 'GET', '/api/personnel/5'))).sheet.permissions.dataExport, false);
  });

  test('der Export enthält alle Tabellen der Person, aber keine Passwörter und nichts von anderen', async t => {
    const { h } = await setup(t);
    await fillPrivate(h, 5);
    await ok(contractChange(h, 5, { weeklyHours: 30 }, TODAY), 201);
    seedOtherModules(h);
    const report = await ok(h.api('hr', 'GET', '/api/personnel/5/data-export'));
    const raw = JSON.stringify(report);

    assert.equal(report.tables.users.length, 1);
    assert.equal(report.tables.users[0].email, 'anna@test.local');
    assert.equal(Object.hasOwn(report.tables.users[0], 'password_hash'), false);
    assert.equal(raw.includes('password_hash'), false);
    assert.equal(raw.includes('!TEST!'), false);
    assert.equal(raw.includes('must_change_password'), false);

    assert.equal(report.tables.personnel_records[0].private_address, PRIVATE_DATA.privateAddress);
    assert.equal(report.tables.personnel_changes.length, 1);
    assert.deepEqual(report.tables.goals.map(goal => goal.title), ['Annas Ziel']);
    assert.deepEqual(report.tables.checkins.map(checkin => checkin.summary), ['Annas Gespräch']);
    assert.deepEqual(report.tables.tasks.map(task => task.title), ['Annas Aufgabe']);
    for (const foreign of ['Bens Ziel', 'Bens Gespräch', 'Bens Aufgabe', 'ben@test.local']) {
      assert.equal(raw.includes(foreign), false, foreign);
    }

    assert.ok(report.meta.tablesChecked.includes('goals'));
    assert.equal(report.meta.person.id, 5);
    assert.equal(report.meta.exportedBy.name, 'Hanna HR');
    assert.match(report.meta.notice, /Daten anderer Personen/);
    assert.deepEqual(report.meta.columnsReferringToOtherPeople.goals, ['created_by']);
    assert.deepEqual(report.meta.columnsReferringToOtherPeople.checkins, ['manager_id']);
    assert.deepEqual(report.meta.columnsReferringToOtherPeople.users, ['manager_id']);
    assert.equal(Object.hasOwn(report.tables, 'audit_log'), false);
  });

  test('Sitzungen, geheime Spalten, Sichten und seltsame Tabellennamen sind abgesichert', async t => {
    const { h } = await setup(t);
    const isPostgres = h.db.dialect === 'postgres';
    h.db.exec(`
      CREATE TABLE app_sessions (sid TEXT PRIMARY KEY, user_id INTEGER, data TEXT);
      INSERT INTO app_sessions VALUES ('sitzung-geheim', 5, 'sitzungsdaten');
      CREATE TABLE extra_data (id INTEGER PRIMARY KEY, USER_ID INTEGER, note TEXT, password TEXT, token_hash TEXT, api_token TEXT, client_secret TEXT, password_salt TEXT, session_id INTEGER);
      INSERT INTO extra_data(USER_ID,note,password,token_hash,api_token,client_secret,password_salt,session_id) VALUES (5,'sichtbar','pw-geheim','hash-geheim','token-geheim','secret-geheim','salt-geheim',42);
      CREATE TABLE "seltsam ""name; DROP TABLE users; --" ("employee_id" INTEGER, "order" TEXT, "user_id" INTEGER, payload BLOB);
      INSERT INTO "seltsam ""name; DROP TABLE users; --" VALUES (5,'erste Zeile',NULL,${isPostgres ? "'\\x00ff'" : "x'00ff'"});
      INSERT INTO "seltsam ""name; DROP TABLE users; --" VALUES (NULL,'zweite Zeile',5,NULL);
      INSERT INTO "seltsam ""name; DROP TABLE users; --" VALUES (6,'fremd',NULL,NULL);
      CREATE VIEW personen_sicht AS SELECT id AS user_id, password_hash FROM users;
      CREATE TABLE keine_person (id INTEGER PRIMARY KEY, owner_id INTEGER);
      INSERT INTO keine_person(owner_id) VALUES (5);
    `);
    const report = await ok(h.api('hr', 'GET', '/api/personnel/5/data-export'));
    const raw = JSON.stringify(report);
    assert.equal(Object.hasOwn(report.tables, 'app_sessions'), false);
    assert.equal(report.meta.tablesChecked.includes('app_sessions'), false);
    assert.equal(raw.includes('sitzung'), false);
    // PostgreSQL schreibt Spaltennamen ohne Anführungszeichen klein.
    assert.deepEqual(report.tables.extra_data, [{ id: 1, [isPostgres ? 'user_id' : 'USER_ID']: 5, note: 'sichtbar', session_id: 42 }]);
    assert.equal(raw.includes('-geheim'), false);
    const odd = report.tables['seltsam "name; DROP TABLE users; --'];
    assert.deepEqual(odd.map(row => row.order), ['erste Zeile', 'zweite Zeile']);
    assert.equal(odd[0].payload, '[Binärdaten, 2 Bytes]');
    assert.equal(raw.includes('fremd'), false);
    assert.equal(Object.hasOwn(report.tables, 'personen_sicht'), false);
    assert.equal(Object.hasOwn(report.tables, 'keine_person'), false);
    assert.equal(raw.includes('!TEST!'), false);
    assert.ok(h.db.prepare('SELECT COUNT(*) AS count FROM users').get().count > 0);
  });

  test('jeder Export wird protokolliert, abgelehnte nicht', async t => {
    const { h } = await setup(t, { withSuperAdmin: true });
    seedOtherModules(h);
    await h.api('bp', 'GET', '/api/personnel/5/data-export');
    assert.equal(auditEntries(h, 'personnel_data_exported').length, 0);
    await ok(h.api('hr', 'GET', '/api/personnel/5/data-export'));
    await ok(h.api('super', 'GET', '/api/personnel/6/data-export'));
    const entries = auditEntries(h, 'personnel_data_exported');
    assert.equal(entries.length, 2);
    assert.equal(entries[0].actor_id, 1);
    assert.equal(entries[0].entity_id, 5);
    assert.equal(JSON.parse(entries[0].new_values).tables.goals, 1);
    assert.equal(entries[1].actor_id, 100);
    assert.equal(entries[1].entity_id, 6);
    assert.equal(JSON.stringify(entries).includes('Annas'), false, 'Inhalte stehen nicht im Protokoll');
  });

  test('auch ausgetretene Personen bekommen eine Auskunft', async t => {
    const { h } = await setup(t);
    await fillPrivate(h, 5);
    await ok(h.api('hr', 'POST', '/api/personnel/5/exit', { exitDate: TODAY, reason: 'x', lockNow: true }), 201);
    const report = await ok(h.api('hr', 'GET', '/api/personnel/5/data-export'));
    assert.equal(report.tables.users[0].active, 0);
    assert.equal(report.tables.personnel_records[0].private_address, PRIVATE_DATA.privateAddress);
    assert.equal(report.tables.personnel_changes[0].kind, 'exit');
  });
});

describe('HR-Übersicht', () => {
  async function organization(h) {
    const company = await createUnit(h, { type: 'legal_entity', name: 'Muster GmbH' });
    const department = await createUnit(h, { type: 'department', name: 'Technik', parentId: company });
    const team = await createUnit(h, { type: 'department', name: 'Plattform', parentId: department });
    const sales = await createUnit(h, { type: 'department', name: 'Vertrieb', parentId: company });
    const location = await createUnit(h, { type: 'location', name: 'Berlin', parentId: company });
    await ok(organizationChange(h, 5, { orgUnitId: team, locationId: location }, TODAY), 201);
    await ok(organizationChange(h, 6, { orgUnitId: department }, TODAY), 201);
    await ok(organizationChange(h, 7, { orgUnitId: sales }, TODAY), 201);
    return { company, department, team, sales, location };
  }
  const idsOf = response => response.people.map(person => person.id).sort((first, second) => first - second);

  test('zeigt alle aktiven Personen ohne private Felder und ohne technische Konten', async t => {
    const { h } = await setup(t);
    await fillPrivate(h, 5);
    const response = await ok(h.api('hr', 'GET', '/api/personnel/people'));
    assert.deepEqual(idsOf(response), [1, 2, 3, 4, 5, 6, 7]);
    const anna = response.people.find(person => person.id === 5);
    assert.equal(anna.hasRecord, true);
    assert.equal(response.people.find(person => person.id === 6).hasRecord, false);
    const raw = JSON.stringify(response);
    for (const marker of PRIVATE_MARKERS) assert.equal(raw.includes(marker), false, marker);
    for (const key of ['birthDate', 'privateAddress', 'privatePhone', 'emergencyContact', 'birth_date', 'private_address']) {
      assert.equal(raw.includes(key), false, key);
    }
  });

  test('der Filter nach Organisationseinheit umfasst untergeordnete Einheiten', async t => {
    const { h } = await setup(t);
    const units = await organization(h);
    const list = async orgUnitId => idsOf(await ok(h.api('hr', 'GET', `/api/personnel/people?orgUnitId=${orgUnitId}`)));
    assert.deepEqual(await list(units.team), [5]);
    assert.deepEqual(await list(units.department), [5, 6]);
    assert.deepEqual(await list(units.company), [5, 6, 7]);
    assert.deepEqual(await list(units.location), [5]);
    assert.equal((await h.api('hr', 'GET', '/api/personnel/people?orgUnitId=999')).status, 404);
    assert.equal((await h.api('hr', 'GET', '/api/personnel/people?orgUnitId=abc')).status, 400);
  });

  test('Fristenfilter beachten genau 90 und 30 Tage', async t => {
    const { h } = await setup(t);
    const fixedTerm = (userId, end) => contractChange(h, userId, { contractType: 'fixed_term', fixedTermEnd: end }, TODAY);
    await ok(fixedTerm(5, addDays(TODAY, 90)), 201);
    await ok(fixedTerm(6, addDays(TODAY, 91)), 201);
    await ok(fixedTerm(7, TODAY), 201);
    await ok(fixedTerm(4, addDays(TODAY, -1)), 201);
    await ok(contractChange(h, 3, { probationEnd: addDays(TODAY, 30) }, TODAY), 201);
    await ok(contractChange(h, 2, { probationEnd: addDays(TODAY, 31) }, TODAY), 201);
    await ok(contractChange(h, 5, { probationEnd: addDays(TODAY, -1) }, TODAY), 201);

    const fixedTermList = await ok(h.api('hr', 'GET', '/api/personnel/people?deadline=fixed_term_90'));
    assert.deepEqual(idsOf(fixedTermList), [5, 7]);
    assert.deepEqual(fixedTermList.people.find(person => person.id === 5).deadlines, [{ kind: 'fixed_term', date: addDays(TODAY, 90) }]);
    const probationList = await ok(h.api('hr', 'GET', '/api/personnel/people?deadline=probation_30'));
    assert.deepEqual(idsOf(probationList), [3]);
    assert.equal(probationList.summary.fixedTermEnding, 2);
    assert.equal(probationList.summary.probationEnding, 1);
  });

  test('Status und Austritte lassen sich filtern', async t => {
    const { h } = await setup(t);
    await ok(h.api('hr', 'POST', '/api/personnel/5/exit', { exitDate: addDays(TODAY, 10), reason: 'x' }), 201);
    await ok(h.api('hr', 'POST', '/api/personnel/6/exit', { exitDate: addDays(TODAY, -1), reason: 'x' }), 201);
    h.deps.setUserActive(7, false, { id: 1 });

    const list = async query => idsOf(await ok(h.api('hr', 'GET', `/api/personnel/people${query}`)));
    assert.deepEqual(await list(''), [1, 2, 3, 4, 5]);
    assert.deepEqual(await list('?status=active'), [1, 2, 3, 4, 5]);
    assert.deepEqual(await list('?status=exit_planned'), [5]);
    assert.deepEqual(await list('?status=left'), [6]);
    assert.deepEqual(await list('?status=locked'), [7]);
    assert.deepEqual(await list('?status=all'), [1, 2, 3, 4, 5, 6, 7]);
    assert.deepEqual(await list('?deadline=exits'), [5, 6]);
    assert.deepEqual(await list('?deadline=exits&status=left'), [6]);

    const { people, summary } = await ok(h.api('hr', 'GET', '/api/personnel/people?deadline=exits'));
    assert.equal(people.find(person => person.id === 5).exitDate, addDays(TODAY, 10));
    assert.equal(people.find(person => person.id === 6).exitDate, addDays(TODAY, -1));
    assert.deepEqual(summary, { active: 5, withoutRecord: 5, fixedTermEnding: 0, probationEnding: 0, exitsPlanned: 1, left: 1 });

    for (const query of ['?status=foo', '?deadline=foo', '?status=active&status=left', "?status=active'--"]) {
      assert.equal((await h.api('hr', 'GET', `/api/personnel/people${query}`)).status, 400, query);
    }
  });
});

describe('Fristen und Aufgaben', () => {
  test('maintenance legt Fristen-Aufgaben genau einmal an', async t => {
    const { h, clock } = await setup(t);
    await ok(contractChange(h, 5, { contractType: 'fixed_term', fixedTermEnd: addDays(TODAY, 60) }, TODAY), 201);
    await ok(contractChange(h, 6, { probationEnd: addDays(TODAY, 20) }, TODAY), 201);
    assert.equal(tasksOfType(h, 'personnel_deadline').length, 0, 'Nur die Wartung legt an');

    h.instance.maintenance();
    const first = tasksOfType(h, 'personnel_deadline');
    assert.equal(first.length, 4, 'Zwei Fristen für je zwei HR-Personen');
    assert.deepEqual(first.filter(task => /Anna/.test(task.title)).map(task => task.user_id).sort(), [1, 2]);
    assert.ok(first.some(task => task.title === `Befristung von Anna Ahrens endet am 04.01.2027`));
    assert.ok(first.some(task => task.title === `Probezeit von Ben Berg endet am 25.11.2026`));
    assert.equal(first.find(task => /Anna/.test(task.title)).due_date, addDays(TODAY, 60), 'Fällig ist die Aufgabe zum Fristende');

    for (let run = 0; run < 3; run += 1) h.instance.maintenance();
    assert.equal(tasksOfType(h, 'personnel_deadline').length, 4, 'Mehrfacher Aufruf legt nichts Neues an');
    clock.today = addDays(TODAY, 5);
    h.instance.maintenance();
    assert.equal(tasksOfType(h, 'personnel_deadline').length, 4, 'Auch an späteren Tagen nicht');
    clock.today = addDays(TODAY, 100);
    h.instance.maintenance();
    assert.equal(tasksOfType(h, 'personnel_deadline').length, 4, 'Auch nach Ablauf der Frist nicht');
    assert.equal(openTasksOfType(h, 'personnel_deadline').length, 4, 'Eine verstrichene Frist bleibt offen, bis HR sie erledigt');
  });

  test('Aufgaben entstehen erst im Fristenfenster und nur für echte, aktive HR-Personen', async t => {
    const { h, clock } = await setup(t);
    await ok(contractChange(h, 5, { contractType: 'fixed_term', fixedTermEnd: addDays(TODAY, 91) }, TODAY), 201);
    await ok(contractChange(h, 6, { probationEnd: addDays(TODAY, 31) }, TODAY), 201);
    await ok(contractChange(h, 7, { probationEnd: addDays(TODAY, -1) }, TODAY), 201);
    h.instance.maintenance();
    assert.equal(tasksOfType(h, 'personnel_deadline').length, 0);

    clock.today = addDays(TODAY, 1);
    h.deps.setUserActive(2, false, null);
    h.instance.maintenance();
    const tasks = tasksOfType(h, 'personnel_deadline');
    assert.deepEqual(tasks.map(task => task.user_id), [1, 1], 'Weder die gesperrte HR-Person noch das technische Konto');
  });

  test('die betroffene Person bekommt keine Aufgabe über sich selbst, solange es andere gibt', async t => {
    const { h } = await setup(t);
    const secondAdmin = h.deps.createUserAccount({ name: 'Zweite Admin', email: 'zweite@test.local', role: 'hr_admin', actor: { id: 1 } }).id;
    await ok(contractChange(h, 2, { probationEnd: addDays(TODAY, 10) }, TODAY), 201);
    await ok(contractChange(h, 1, { probationEnd: addDays(TODAY, 10) }, TODAY, {}, secondAdmin), 201);
    h.instance.maintenance();
    const tasks = tasksOfType(h, 'personnel_deadline');
    assert.deepEqual(tasks.filter(task => /Boris/.test(task.title)).map(task => task.user_id), [1, secondAdmin]);
    assert.deepEqual(tasks.filter(task => /Hanna/.test(task.title)).map(task => task.user_id), [secondAdmin], 'HRBP erfährt nichts über die HR-Leitung');
  });

  test('gibt es außer der Person niemanden mit Zugriff, geht die Aufgabe an sie selbst', async t => {
    const { h } = await setup(t);
    h.deps.setApprovalRule('personnel.hr_self_edit', 'allowed', { id: 1 });
    await ok(contractChange(h, 1, { probationEnd: addDays(TODAY, 10) }, TODAY), 201);
    h.instance.maintenance();
    assert.deepEqual(tasksOfType(h, 'personnel_deadline').map(task => task.user_id), [1]);
  });

  test('ohne HR-Person geht die Erinnerung nicht verloren', async t => {
    const { h } = await setup(t);
    await ok(contractChange(h, 5, { probationEnd: addDays(TODAY, 10) }, TODAY), 201);
    h.db.prepare("UPDATE users SET active=0 WHERE role IN ('hr_admin','hrbp')").run();
    h.instance.maintenance();
    assert.equal(tasksOfType(h, 'personnel_deadline').length, 0);
    h.db.prepare('UPDATE users SET active=1 WHERE id=1').run();
    h.instance.maintenance();
    assert.deepEqual(tasksOfType(h, 'personnel_deadline').map(task => task.user_id), [1]);
  });

  test('eine verschobene Frist schließt die alte Aufgabe und erinnert neu', async t => {
    const { h } = await setup(t);
    await ok(contractChange(h, 5, { contractType: 'fixed_term', fixedTermEnd: addDays(TODAY, 60) }, TODAY), 201);
    h.instance.maintenance();
    assert.equal(openTasksOfType(h, 'personnel_deadline').length, 2);

    await ok(contractChange(h, 5, { fixedTermEnd: addDays(TODAY, 80) }, TODAY), 201);
    assert.equal(openTasksOfType(h, 'personnel_deadline').length, 0, 'Die alte Frist gilt nicht mehr');
    h.instance.maintenance();
    assert.equal(openTasksOfType(h, 'personnel_deadline').length, 2);
    assert.ok(openTasksOfType(h, 'personnel_deadline')[0].title.includes('24.01.2027'));

    // Zurück auf das alte Datum: wieder genau eine neue Erinnerung.
    await ok(contractChange(h, 5, { fixedTermEnd: addDays(TODAY, 60) }, TODAY), 201);
    h.instance.maintenance();
    h.instance.maintenance();
    assert.equal(openTasksOfType(h, 'personnel_deadline').length, 2);
    assert.equal(tasksOfType(h, 'personnel_deadline').length, 6);

    // Verlängert über das Fenster hinaus: keine offene Aufgabe mehr.
    await ok(contractChange(h, 5, { fixedTermEnd: addDays(TODAY, 300) }, TODAY), 201);
    h.instance.maintenance();
    assert.equal(openTasksOfType(h, 'personnel_deadline').length, 0);

    // Entfristung schließt ebenfalls.
    await ok(contractChange(h, 6, { contractType: 'fixed_term', fixedTermEnd: addDays(TODAY, 60) }, TODAY), 201);
    h.instance.maintenance();
    assert.equal(openTasksOfType(h, 'personnel_deadline').length, 2);
    await ok(contractChange(h, 6, { contractType: 'permanent' }, TODAY), 201);
    assert.equal(openTasksOfType(h, 'personnel_deadline').length, 0);
  });

  test('ein Austritt vor der Frist ersetzt die Erinnerung, das Zurücknehmen bringt sie zurück', async t => {
    const { h } = await setup(t);
    await ok(contractChange(h, 5, { contractType: 'fixed_term', fixedTermEnd: addDays(TODAY, 60) }, TODAY), 201);
    h.instance.maintenance();
    assert.equal(openTasksOfType(h, 'personnel_deadline').length, 2);

    await ok(h.api('hr', 'POST', '/api/personnel/5/exit', { exitDate: addDays(TODAY, 30), reason: 'x' }), 201);
    assert.equal(openTasksOfType(h, 'personnel_deadline').length, 0);
    h.instance.maintenance();
    assert.equal(openTasksOfType(h, 'personnel_deadline').length, 0, 'Nicht neu anlegen, solange der Austritt früher liegt');

    const changeId = (await ok(h.api('hr', 'GET', '/api/personnel/5'))).sheet.exit.changeId;
    await ok(h.api('hr', 'POST', `/api/personnel/5/changes/${changeId}/cancel`, {}));
    h.instance.maintenance();
    assert.equal(openTasksOfType(h, 'personnel_deadline').length, 2);

    await ok(h.api('hr', 'POST', '/api/personnel/5/exit', { exitDate: TODAY, reason: 'x', lockNow: true }), 201);
    assert.equal(openTasksOfType(h, 'personnel_deadline').length, 0, 'Nach dem Austritt ist die Frist hinfällig');
  });

  test('HR öffnet und erledigt Aufgaben, für alle HR-Personen zugleich', async t => {
    const { h } = await setup(t);
    await ok(contractChange(h, 5, { probationEnd: addDays(TODAY, 10) }, TODAY), 201);
    await ok(contractChange(h, 6, { probationEnd: addDays(TODAY, 10) }, TODAY), 201);
    await ok(h.api('hr', 'POST', '/api/personnel/7/exit', { exitDate: addDays(TODAY, 10), reason: 'x' }), 201);
    h.instance.maintenance();

    const deadlineTask = tasksOfType(h, 'personnel_deadline').find(task => /Anna/.test(task.title));
    const exitTask = tasksOfType(h, 'personnel_offboarding')[0];
    assert.deepEqual(await ok(h.api('hr', 'GET', `/api/personnel/tasks/${deadlineTask.id}`)), { userId: 5 });
    assert.deepEqual(await ok(h.api('bp', 'GET', `/api/personnel/tasks/${exitTask.id}`)), { userId: 7 });

    // Fremde Aufgaben sind tabu.
    h.deps.createTask(5, 'Ziel prüfen', 'goal_approval', 1);
    const foreign = tasksOfType(h, 'goal_approval')[0];
    assert.equal((await h.api('hr', 'GET', `/api/personnel/tasks/${foreign.id}`)).status, 404);
    assert.equal((await h.api('hr', 'POST', `/api/personnel/tasks/${foreign.id}/done`, {})).status, 404);
    assert.equal(openTasksOfType(h, 'goal_approval').length, 1);
    assert.equal((await h.api('hr', 'POST', '/api/personnel/tasks/9999/done', {})).status, 404);
    assert.equal((await h.api('hr', 'GET', '/api/personnel/tasks/abc')).status, 404);

    await ok(h.api('bp', 'POST', `/api/personnel/tasks/${deadlineTask.id}/done`, {}));
    const open = openTasksOfType(h, 'personnel_deadline');
    assert.equal(open.length, 2, 'Nur Annas Frist ist erledigt');
    assert.ok(open.every(task => /Ben/.test(task.title)));

    h.instance.maintenance();
    assert.equal(tasksOfType(h, 'personnel_deadline').length, 4, 'Erledigtes kommt nicht zurück');
    await ok(h.api('hr', 'POST', `/api/personnel/tasks/${exitTask.id}/done`, {}));
    assert.equal(openTasksOfType(h, 'personnel_offboarding').length, 0);
    assert.equal(isActive(h, 7), 1, 'Erledigen ändert nichts am Austritt');
  });
});

describe('Beispieldaten, Hilfe und Unabhängigkeit', () => {
  test('seedDemo ist wiederholbar, legt keine Konten an und nutzt nur vorhandene Personen', async t => {
    const { h } = await setup(t);
    const usersBefore = h.db.prepare('SELECT COUNT(*) AS count FROM users').get().count;
    h.instance.seedDemo();
    const count = table => h.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count;
    const first = [count('personnel_org_units'), count('personnel_records'), count('personnel_changes')];
    assert.ok(first[0] >= 5);
    assert.equal(first[1], 7);
    assert.ok(first[2] >= 2);
    assert.equal(h.db.prepare('SELECT COUNT(*) AS count FROM personnel_records WHERE user_id=100').get().count, 0, 'Kein technisches Konto');
    h.instance.seedDemo();
    h.instance.seedDemo();
    assert.deepEqual([count('personnel_org_units'), count('personnel_records'), count('personnel_changes')], first);
    assert.equal(h.db.prepare('SELECT COUNT(*) AS count FROM users').get().count, usersBefore);
    assert.equal(h.db.prepare("SELECT COUNT(*) AS count FROM personnel_changes WHERE kind='exit'").get().count, 0, 'Beispieldaten sperren niemanden');

    // Die Beispieldaten zeigen den Ablauf: Fristen melden sich, Geplantes bleibt geplant.
    h.instance.maintenance();
    assert.ok(tasksOfType(h, 'personnel_deadline').length > 0);
    assert.equal(h.db.prepare("SELECT COUNT(*) AS count FROM personnel_changes WHERE status='scheduled'").get().count, 1);
    const { people } = await ok(h.api('hr', 'GET', '/api/personnel/people'));
    assert.ok(people.every(person => person.personnelNumber && person.orgUnit && person.location));
    const scheduled = h.db.prepare("SELECT * FROM personnel_changes WHERE status='scheduled'").get();
    await ok(h.api('hr', 'POST', `/api/personnel/${scheduled.user_id}/changes/${scheduled.id}/cancel`, {}));
  });

  test('seedDemo tut ohne Personen nichts', async t => {
    const { h } = await setup(t);
    h.db.prepare('UPDATE users SET active=0').run();
    h.instance.seedDemo();
    assert.equal(h.db.prepare('SELECT COUNT(*) AS count FROM personnel_org_units').get().count, 0);
    assert.equal(h.db.prepare('SELECT COUNT(*) AS count FROM personnel_records').get().count, 0);
  });

  test('initialize legt keine Beispieldaten an und ist wiederholbar', async t => {
    const { h } = await setup(t);
    h.instance.initialize();
    await fillPrivate(h, 5);
    h.instance.initialize();
    assert.equal(recordOf(h, 5).private_address, PRIVATE_DATA.privateAddress);
    assert.equal(h.db.prepare('SELECT COUNT(*) AS count FROM personnel_org_units').get().count, 0);
    h.instance.maintenance();
  });

  test('die Hilfeartikel haben die vereinbarte Form', async t => {
    const { h } = await setup(t);
    const validRoles = ['employee', 'manager', 'director', 'hr_staff', 'hr_admin', 'hrbp', 'super_admin'];
    const validViews = ['personnelMe', 'personnelPeople', 'personnelPerson', 'personnelUnits'];
    assert.ok(h.instance.helpArticles.length >= 4);
    const ids = new Set();
    for (const article of h.instance.helpArticles) {
      assert.ok(article.id.startsWith('personnel-'), article.id);
      assert.equal(ids.has(article.id), false, article.id);
      ids.add(article.id);
      assert.ok(article.title && article.answer);
      assert.ok(article.roles.length && article.roles.every(role => validRoles.includes(role)), article.id);
      assert.ok(article.views.length && article.views.every(view => validViews.includes(view)), article.id);
      assert.ok(article.keywords.length && article.keywords.every(word => word === word.toLowerCase()), article.id);
      assert.ok(article.steps.length, article.id);
      assert.ok(article.actions.every(action => action.label && validViews.includes(action.view)), article.id);
      assert.equal(/workday/i.test(JSON.stringify(article)), false, article.id);
    }
    const roleOnly = h.instance.helpArticles.filter(article => article.id !== 'personnel-my-data' && article.id !== 'personnel-team-data');
    assert.ok(roleOnly.every(article => !article.roles.includes('employee')), 'HR-Abläufe sind für Mitarbeitende nicht auffindbar');
    const articlesForStaff = h.instance.helpArticles.filter(article => article.roles.includes('hr_staff')).map(article => article.id).sort();
    assert.deepEqual(articlesForStaff, ['personnel-change', 'personnel-exit', 'personnel-my-data'], 'Die Sachbearbeitung findet genau ihre Abläufe');
    const answers = h.instance.helpArticles.map(article => article.answer).join(' ');
    assert.equal(/Stammdatenblatt|Wirksamkeitsdatum|Organisationseinheit/.test(answers), false, 'Keine Fachbegriffe in den Antworten');
    assert.match(h.instance.helpArticles.find(article => article.id === 'personnel-exit').answer, /letzte Arbeitstag/);
  });

  test('das Modul funktioniert ohne jedes andere Modul', async t => {
    const { h, clock } = await setup(t, { isModuleEnabled: key => key === 'personnel' });
    const department = await createUnit(h, { type: 'department', name: 'Technik' });
    await fillPrivate(h, 5);
    await ok(organizationChange(h, 5, { orgUnitId: department }, TODAY), 201);
    await ok(contractChange(h, 5, { contractType: 'fixed_term', fixedTermEnd: addDays(TODAY, 50), weeklyHours: 30 }, TODAY), 201);
    await ok(h.api('hr', 'POST', '/api/personnel/5/exit', { exitDate: addDays(TODAY, 10), reason: 'x' }), 201);
    h.db.prepare("INSERT INTO goals(user_id,title,created_by) VALUES(5,'Ziel im abgeschalteten Modul',4)").run();
    // Die Auskunft muss auch Daten abgeschalteter Module enthalten, denn die Daten bleiben ja gespeichert.
    const report = await ok(h.api('hr', 'GET', '/api/personnel/5/data-export'));
    assert.equal(report.tables.goals[0].title, 'Ziel im abgeschalteten Modul');
    clock.today = addDays(TODAY, 11);
    h.instance.maintenance();
    assert.equal(isActive(h, 5), 0);
  });

  test('zwei Organisationen teilen nichts miteinander', async t => {
    const { h: first } = await setup(t);
    const { h: second, clock: secondClock } = await setup(t);
    await fillPrivate(first, 5);
    const unit = await createUnit(first, { type: 'department', name: 'Nur bei der ersten' });
    await ok(contractChange(first, 5, { weeklyHours: 20 }, addDays(TODAY, 2)), 201);
    assert.equal(recordOf(second, 5), undefined);
    assert.equal((await ok(second.api('hr', 'GET', '/api/personnel/5'))).sheet.private.privateAddress, null);
    assert.deepEqual((await ok(second.api('hr', 'GET', '/api/personnel/org-units'))).units, []);
    assert.equal((await second.api('hr', 'PATCH', `/api/personnel/org-units/${unit}`, { name: 'X' })).status, 404);
    secondClock.today = addDays(TODAY, 5);
    second.instance.maintenance();
    assert.equal(recordOf(first, 5).weekly_hours, null, 'Die Wartung der einen betrifft die andere nicht');
  });
});

describe('HR-Sachbearbeitung und Grenzen zwischen HR-Rollen', () => {
  function addAccount(h, { name = 'Sach Bearbeiter', email = 'sb@test.local', role = 'hr_staff', managerId = null } = {}) {
    const { id } = h.deps.createUserAccount({ name, email, role, managerId, actor: { id: 1 } });
    h.db.prepare('UPDATE users SET must_change_password=0 WHERE id=?').run(id);
    return id;
  }

  test('die Sachbearbeitung pflegt die Akten von Personen ohne HR-Rolle, auch von Führungskräften', async t => {
    const { h, clock } = await setup(t);
    const staff = addAccount(h);
    await fillPrivate(h, 5);
    const { sheet } = await ok(h.api(staff, 'GET', '/api/personnel/5'));
    assert.equal(sheet.access, 'full');
    assert.equal(sheet.private.privateAddress, PRIVATE_DATA.privateAddress);
    assert.deepEqual(plainPermissions(sheet), { editMaster: true, recordChange: true, recordExit: true, exitNow: true, cancelExit: false, rehire: false, viewHistory: true, dataExport: false, manageUnits: false });

    await ok(h.api(staff, 'PATCH', '/api/personnel/5/master', { personnelNumber: 'S-1' }));
    assert.equal(recordOf(h, 5).personnel_number, 'S-1');
    await ok(contractChange(h, 5, { weeklyHours: 30 }, TODAY, {}, staff), 201);
    const unit = await createUnit(h, { type: 'department', name: 'Technik' });
    await ok(organizationChange(h, 5, { orgUnitId: unit }, TODAY, {}, staff), 201);
    const planned = await ok(contractChange(h, 5, { weeklyHours: 20 }, addDays(TODAY, 5), {}, staff), 201);
    await ok(h.api(staff, 'POST', `/api/personnel/5/changes/${planned.change.id}/cancel`, {}));
    assert.ok((await historyOf(h, 5, staff)).length >= 3);

    assert.equal((await ok(h.api(staff, 'POST', '/api/personnel/6/exit', { exitDate: addDays(TODAY, 2), reason: 'Wechsel' }), 201)).status, 'exit_planned');
    assert.equal((await ok(h.api(staff, 'GET', '/api/personnel/6'))).sheet.permissions.cancelExit, true);
    clock.today = addDays(TODAY, 3);
    h.instance.maintenance();
    await ok(h.api(staff, 'POST', '/api/personnel/6/rehire', { rehireDate: clock.today, reason: 'Rückkehr' }), 201);
    assert.equal(isActive(h, 6), 1);
  });

  test('die Sachbearbeitung macht niemanden zur Führungskraft und sperrt Führungskräfte nicht sofort', async t => {
    const { h, clock } = await setup(t);
    const staff = addAccount(h);
    const roleOf = id => h.db.prepare('SELECT role FROM users WHERE id=?').get(id).role;
    const managerOf = id => h.db.prepare('SELECT manager_id FROM users WHERE id=?').get(id).manager_id;

    // Über das gesammelte Umhängen geht es genauso wenig wie über die Zuordnung im Grundsystem.
    assert.equal((await h.api(staff, 'POST', '/api/personnel/4/reassign-reports', { managerId: 7, promoteManager: true })).status, 403);
    assert.equal(roleOf(7), 'employee');
    assert.equal((await h.api(staff, 'POST', '/api/personnel/4/reassign-reports', { managerId: staff })).status, 403, 'Nicht sich selbst');
    assert.equal(managerOf(5), 4);
    assert.equal((await h.api(staff, 'POST', '/api/personnel/4/exit', { exitDate: addDays(TODAY, 3), reason: 'x', successorManagerId: 7, promoteManager: true })).status, 403);
    assert.equal((await h.api(staff, 'POST', '/api/personnel/4/exit', { exitDate: addDays(TODAY, 3), reason: 'x', successorManagerId: staff })).status, 403);

    // Sofort sperren darf nur, wer das Konto auch direkt sperren dürfte.
    assert.equal((await ok(h.api(staff, 'GET', '/api/personnel/4'))).sheet.permissions.exitNow, false);
    assert.equal((await h.api(staff, 'POST', '/api/personnel/4/exit', { exitDate: TODAY, reason: 'x', lockNow: true })).status, 403);
    assert.equal((await h.api(staff, 'POST', '/api/personnel/4/exit', { exitDate: addDays(TODAY, -1), reason: 'x' })).status, 403);
    assert.equal(isActive(h, 4), 1);

    // Ein Austritt mit Datum bleibt ihr Tagesgeschäft. Wieder freigeben muss ihn eine andere Rolle.
    await ok(h.api(staff, 'POST', '/api/personnel/4/exit', { exitDate: addDays(TODAY, 2), reason: 'Wechsel' }), 201);
    clock.today = addDays(TODAY, 3);
    h.instance.maintenance();
    assert.equal(isActive(h, 4), 0);
    assert.equal((await ok(h.api(staff, 'GET', '/api/personnel/4'))).sheet.permissions.rehire, false);
    assert.equal((await h.api(staff, 'POST', '/api/personnel/4/rehire', { rehireDate: clock.today, reason: 'Rückkehr' })).status, 403);
    assert.equal(isActive(h, 4), 0);
    await ok(h.api('bp', 'POST', '/api/personnel/4/rehire', { rehireDate: clock.today, reason: 'Rückkehr' }), 201);
    assert.equal(isActive(h, 4), 1);
  });

  const plainPermissions = sheet => JSON.parse(JSON.stringify(sheet.permissions));

  test('die Sachbearbeitung kommt nicht an HR-Kolleg:innen, die HR-Leitung, die Auskunft und die Einheiten', async t => {
    const { h } = await setup(t);
    const staff = addAccount(h);
    const colleague = addAccount(h, { name: 'Andere Bearbeiterin', email: 'ab@test.local' });
    const unit = await createUnit(h, { type: 'department', name: 'Technik' });
    await ok(contractChange(h, 2, { weeklyHours: 40 }, TODAY), 201);
    const changeOfBp = h.db.prepare('SELECT id FROM personnel_changes WHERE user_id=2').get().id;
    for (const target of [1, 2, colleague]) {
      const calls = [
        ['GET', `/api/personnel/${target}`],
        ['GET', `/api/personnel/${target}/history`],
        ['PATCH', `/api/personnel/${target}/master`, { personnelNumber: 'X' }],
        ['POST', `/api/personnel/${target}/changes`, { kind: 'contract', effectiveDate: TODAY, reason: 'x', values: { weeklyHours: 10 } }],
        ['POST', `/api/personnel/${target}/changes/${changeOfBp}/cancel`, {}],
        ['POST', `/api/personnel/${target}/exit`, { exitDate: TODAY, reason: 'x' }],
        ['POST', `/api/personnel/${target}/rehire`, { rehireDate: TODAY, reason: 'x' }],
        ['POST', `/api/personnel/${target}/reassign-reports`, { managerId: 3 }],
        ['GET', `/api/personnel/${target}/data-export`],
        ['GET', `/api/personnel/${target}/data-export/readable`]
      ];
      for (const [method, url, body] of calls) {
        const response = await h.api(staff, method, url, body);
        assert.equal(response.status, 403, `${method} ${url}`);
      }
    }
    for (const url of ['/api/personnel/5/data-export', '/api/personnel/5/data-export/readable']) {
      assert.equal((await h.api(staff, 'GET', url)).status, 403, url);
    }
    assert.equal((await h.api(staff, 'POST', '/api/personnel/org-units', { type: 'department', name: 'Neu' })).status, 403);
    assert.equal((await h.api(staff, 'PATCH', `/api/personnel/org-units/${unit}`, { name: 'Neu' })).status, 403);
    assert.equal((await h.api(staff, 'DELETE', `/api/personnel/org-units/${unit}`)).status, 403);
    assert.equal((await ok(h.api(staff, 'GET', '/api/personnel/org-units'))).units.length, 1, 'Lesen darf sie, sie braucht die Auswahl');
    assert.equal(isActive(h, 1), 1);
    assert.equal(countChanges(h), 1);
  });

  test('die eigene Akte bleibt der Sachbearbeitung zu, auch wenn die Organisation HR sie erlaubt', async t => {
    const { h } = await setup(t);
    const staff = addAccount(h);
    h.deps.setApprovalRule('personnel.hr_self_edit', 'allowed', { id: 1 });
    assert.equal((await h.api(staff, 'PATCH', `/api/personnel/${staff}/master`, { personnelNumber: 'SELBST' })).status, 403);
    assert.equal((await contractChange(h, staff, { weeklyHours: 60 }, TODAY, {}, staff)).status, 403);
    assert.equal((await h.api(staff, 'POST', `/api/personnel/${staff}/exit`, { exitDate: TODAY, reason: 'x' })).status, 403);

    await ok(h.api('hr', 'POST', `/api/personnel/${staff}/exit`, { exitDate: addDays(TODAY, 9), reason: 'Vertraulich' }), 201);
    const own = await ok(h.api(staff, 'GET', '/api/personnel/me'));
    assert.equal(own.sheet.access, 'full', 'Die eigenen Daten sieht sie wie jede Person');
    assert.equal(own.sheet.person.status, 'active', 'Ein geplanter Austritt bleibt auch ihr verborgen');
    assert.equal(JSON.stringify(own).includes('Vertraulich'), false);
    assert.deepEqual(plainPermissions(own.sheet), { editMaster: false, recordChange: false, recordExit: false, exitNow: false, cancelExit: false, rehire: false, viewHistory: true, dataExport: false, manageUnits: false });
    await ok(h.api(staff, 'PATCH', '/api/personnel/me/contact', { privatePhone: '030 111' }));
    assert.equal((await historyOf(h, staff, staff)).length, 0, 'Der geplante Austritt steht nicht im eigenen Verlauf');
  });

  test('die Listen zeigen der Sachbearbeitung nur Personen ohne HR-Rolle, auch in den Zahlen', async t => {
    const { h } = await setup(t);
    const staff = addAccount(h);
    await ok(contractChange(h, 2, { probationEnd: addDays(TODAY, 10) }, TODAY), 201);
    await ok(contractChange(h, 5, { probationEnd: addDays(TODAY, 10) }, TODAY), 201);
    const list = await ok(h.api(staff, 'GET', '/api/personnel/people?status=all'));
    assert.deepEqual(list.people.map(person => person.id).sort((a, b) => a - b), [3, 4, 5, 6, 7]);
    assert.equal(list.summary.active, 5, 'Die Zahlen zählen niemanden mit, den sie nicht sehen darf');
    assert.equal(list.summary.probationEnding, 1);
    assert.equal(JSON.stringify(list).includes('Hanna HR'), false);
  });

  test('HR Business Partner lesen und ändern nichts von der HR-Leitung, auch nicht über Listen', async t => {
    const { h } = await setup(t);
    h.deps.setApprovalRule('personnel.hr_self_edit', 'allowed', { id: 1 });
    await ok(h.api('hr', 'PATCH', '/api/personnel/1/master', { ...PRIVATE_DATA, personnelNumber: 'CHEFIN' }));
    await ok(contractChange(h, 1, { weeklyHours: 40 }, TODAY), 201);
    const changeId = h.db.prepare('SELECT id FROM personnel_changes WHERE user_id=1').get().id;
    const calls = [
      ['GET', '/api/personnel/1'],
      ['GET', '/api/personnel/1/history'],
      ['PATCH', '/api/personnel/1/master', { privateAddress: 'Gefälscht' }],
      ['POST', '/api/personnel/1/changes', { kind: 'contract', effectiveDate: TODAY, reason: 'x', values: { weeklyHours: 1 } }],
      ['POST', `/api/personnel/1/changes/${changeId}/cancel`, {}],
      ['POST', '/api/personnel/1/exit', { exitDate: TODAY, reason: 'x' }],
      ['POST', '/api/personnel/1/rehire', { rehireDate: TODAY, reason: 'x' }],
      ['POST', '/api/personnel/1/reassign-reports', { managerId: 3 }]
    ];
    for (const [method, url, body] of calls) {
      const response = await h.api('bp', method, url, body);
      assert.equal(response.status, 403, `${method} ${url}`);
      for (const marker of [...PRIVATE_MARKERS, 'CHEFIN']) assert.equal(JSON.stringify(response.data).includes(marker), false, marker);
    }
    const list = await ok(h.api('bp', 'GET', '/api/personnel/people?status=all'));
    assert.equal(list.people.some(person => person.id === 1), false);
    assert.equal(JSON.stringify(list).includes('CHEFIN'), false);
    assert.equal(list.summary.active, 6, 'Auch in den Zahlen nicht');
    assert.equal(recordOf(h, 1).private_address, PRIVATE_DATA.privateAddress);
    assert.equal(recordOf(h, 1).weekly_hours, 40);
  });

  test('Konten von HR-Personen sperrt nur die HR-Administration, auch über den Austritt', async t => {
    const { h } = await setup(t);
    const staff = addAccount(h);
    const otherPartner = addAccount(h, { name: 'Zweiter Partner', email: 'zp@test.local', role: 'hrbp' });
    for (const target of [staff, otherPartner]) {
      const refused = await h.api('bp', 'POST', `/api/personnel/${target}/exit`, { exitDate: TODAY, reason: 'x' });
      assert.equal(refused.status, 403);
      assert.match(refused.data.error, /nur die HR-Administration/);
      const { sheet } = await ok(h.api('bp', 'GET', `/api/personnel/${target}`));
      assert.equal(sheet.permissions.recordExit, false);
      assert.equal(sheet.permissions.editMaster, true, 'Die Akte selbst darf HRBP pflegen');
    }
    await ok(h.api('hr', 'POST', `/api/personnel/${staff}/exit`, { exitDate: addDays(TODAY, 1), reason: 'x' }), 201);
    const { sheet } = await ok(h.api('hr', 'GET', `/api/personnel/${staff}`));
    assert.equal((await h.api('bp', 'POST', `/api/personnel/${staff}/changes/${sheet.exit.changeId}/cancel`, {})).status, 403);
  });

  test('die Regel „eigene Akte“ gilt überall gleich und öffnet die Knöpfe', async t => {
    const { h } = await setup(t);
    for (const person of ['hr', 'bp']) {
      const id = h.people[person].id;
      assert.equal((await h.api(person, 'PATCH', `/api/personnel/${id}/master`, { personnelNumber: 'X' })).status, 403);
    }
    h.deps.setApprovalRule('personnel.hr_self_edit', 'allowed', { id: 1 });
    for (const person of ['hr', 'bp']) {
      const id = h.people[person].id;
      const { sheet } = await ok(h.api(person, 'GET', `/api/personnel/${id}`));
      assert.equal(sheet.permissions.editMaster, true, person);
      assert.equal(sheet.permissions.recordChange, true, person);
      assert.equal(sheet.permissions.recordExit, false, 'Sperren lässt sich das eigene Konto weiterhin nicht');
      await ok(h.api(person, 'PATCH', `/api/personnel/${id}/master`, { personnelNumber: `SELBST-${id}` }));
      await ok(contractChange(h, id, { weeklyHours: 39 }, TODAY, {}, person), 201);
      assert.equal(recordOf(h, id).weekly_hours, 39);
      const me = await ok(h.api(person, 'GET', '/api/personnel/me'));
      assert.equal(me.sheet.permissions.editMaster, true, person);
    }
  });

  test('Aufgaben gehen nur an HR-Personen, die die Akte öffnen dürfen', async t => {
    const { h } = await setup(t);
    const staff = addAccount(h);
    await ok(contractChange(h, 5, { probationEnd: addDays(TODAY, 10) }, TODAY), 201);
    await ok(contractChange(h, 2, { probationEnd: addDays(TODAY, 10) }, TODAY), 201);
    await ok(contractChange(h, staff, { probationEnd: addDays(TODAY, 10) }, TODAY), 201);
    h.instance.maintenance();
    const receiversOf = name => tasksOfType(h, 'personnel_deadline').filter(task => task.title.includes(name)).map(task => task.user_id).sort((a, b) => a - b);
    assert.deepEqual(receiversOf('Anna'), [1, 2, staff]);
    assert.deepEqual(receiversOf('Boris'), [1], 'Nicht an die Sachbearbeitung und nicht an sich selbst');
    assert.deepEqual(receiversOf('Sach Bearbeiter'), [1, 2]);

    const annaTask = tasksOfType(h, 'personnel_deadline').find(task => task.user_id === staff);
    assert.deepEqual(await ok(h.api(staff, 'GET', `/api/personnel/tasks/${annaTask.id}`)), { userId: 5 });
    const boris = tasksOfType(h, 'personnel_deadline').find(task => task.title.includes('Boris'));
    assert.equal((await h.api(staff, 'GET', `/api/personnel/tasks/${boris.id}`)).status, 403, 'Keine fremde Aufgabe');
    assert.equal((await h.api(staff, 'POST', `/api/personnel/tasks/${boris.id}/done`, {})).status, 403);
    await ok(h.api(staff, 'POST', `/api/personnel/tasks/${annaTask.id}/done`, {}));
    assert.equal(openTasksOfType(h, 'personnel_deadline').filter(task => task.title.includes('Anna')).length, 0);
  });

  test('eine ältere Aufgabe über die HR-Leitung lässt sich schließen, aber nicht mehr öffnen', async t => {
    const { h } = await setup(t);
    await ok(contractChange(h, 2, { probationEnd: addDays(TODAY, 10) }, TODAY), 201);
    const secondAdmin = addAccount(h, { name: 'Zweite Admin', email: 'zweite@test.local', role: 'hr_admin' });
    const noticeId = h.db.prepare("INSERT INTO personnel_deadline_notices(user_id, kind, deadline_date, created_at) VALUES(1, 'probation', ?, ?)").run(addDays(TODAY, 10), TODAY).lastInsertRowid;
    h.deps.createTask(2, 'Probezeit von Hanna HR endet', 'personnel_deadline', noticeId, addDays(TODAY, 10));
    h.deps.createTask(secondAdmin, 'Probezeit von Hanna HR endet', 'personnel_deadline', noticeId, addDays(TODAY, 10));
    const [own, other] = tasksOfType(h, 'personnel_deadline');
    assert.equal((await h.api('bp', 'GET', `/api/personnel/tasks/${own.id}`)).status, 403);
    await ok(h.api('bp', 'POST', `/api/personnel/tasks/${own.id}/done`, {}));
    assert.equal(openTasksOfType(h, 'personnel_deadline').some(task => task.id === own.id), false);
    assert.equal(openTasksOfType(h, 'personnel_deadline').some(task => task.id === other.id), true, 'Die Aufgabe der HR-Administration bleibt offen');
    assert.equal((await h.api('bp', 'POST', `/api/personnel/tasks/${other.id}/done`, {})).status, 403);
  });
});

describe('Stammdaten: Verlauf und Plausibilität', () => {
  const entries = async (h, userId, actor = 'hr') => (await ok(h.api(actor, 'GET', `/api/personnel/${userId}/history`))).masterChanges;

  test('der Verlauf nennt, welches Feld wann von wem geändert wurde, für HR und die Person selbst', async t => {
    const { h, clock } = await setup(t);
    clock.moment = new Date('2026-11-05T09:30:00.000Z');
    await ok(h.api('hr', 'PATCH', '/api/personnel/5/master', { privateAddress: 'Geheimweg 7', birthDate: '1990-03-14', entryDate: '2023-08-01', personnelNumber: 'A-1' }));
    clock.moment = new Date('2026-11-05T10:30:00.000Z');
    await ok(h.api('anna', 'PATCH', '/api/personnel/me/contact', { privatePhone: '030 23125 777' }));

    for (const viewer of ['hr', 'bp', 'anna']) {
      const [second, first] = await entries(h, 5, viewer);
      assert.equal(first.changedBy, 'Hanna HR', viewer);
      assert.equal(first.bySelf, false, viewer);
      assert.equal(first.changedAt, '2026-11-05T09:30:00.000Z', viewer);
      assert.deepEqual(first.fields.map(field => field.label).sort(), ['Eintrittsdatum', 'Geburtsdatum', 'Personalnummer', 'Private Anschrift'], viewer);
      assert.equal(second.bySelf, true, viewer);
      assert.deepEqual(second.fields.map(field => field.label), ['Private Telefonnummer'], viewer);
      assert.equal(first.fields.find(field => field.label === 'Eintrittsdatum').newText, '01.08.2023', 'Dienstliche Felder mit Wert');
      assert.equal(Object.hasOwn(first.fields.find(field => field.label === 'Private Anschrift'), 'newText'), false, 'Private Felder ohne Wert');
    }
    const raw = JSON.stringify(await ok(h.api('anna', 'GET', '/api/personnel/5/history')));
    for (const secret of ['Geheimweg', '1990-03-14', '14.03.1990', '23125 777']) assert.equal(raw.includes(secret), false, secret);
    const stored = JSON.stringify(h.db.prepare('SELECT * FROM personnel_master_changes').all());
    for (const secret of ['Geheimweg', '1990-03-14', '23125 777']) assert.equal(stored.includes(secret), false, secret);
    const log = JSON.stringify(h.db.prepare("SELECT * FROM audit_log WHERE action LIKE 'personnel_%'").all());
    for (const secret of ['Geheimweg', '1990-03-14', '23125 777']) assert.equal(log.includes(secret), false, `Protokoll: ${secret}`);

    assert.equal((await h.api('manager', 'GET', '/api/personnel/5/history')).status, 403, 'Die Führungskraft sieht das nicht');
    assert.equal((await h.api('ben', 'GET', '/api/personnel/5/history')).status, 403);
  });

  test('Unverändertes erscheint nicht im Verlauf und legt kein leeres Datenblatt an', async t => {
    const { h } = await setup(t);
    await ok(h.api('hr', 'PATCH', '/api/personnel/5/master', { personnelNumber: '', birthDate: '', entryDate: '', privateAddress: '', privatePhone: '', emergencyContact: '' }));
    assert.equal(recordOf(h, 5), undefined);
    assert.deepEqual(await entries(h, 5), []);
    await ok(h.api('hr', 'PATCH', '/api/personnel/5/master', PRIVATE_DATA));
    await ok(h.api('hr', 'PATCH', '/api/personnel/5/master', PRIVATE_DATA));
    assert.equal((await entries(h, 5)).length, 1, 'Das Formular schickt immer alle Felder');
    assert.equal(auditEntries(h, 'personnel_master_updated').length, 1);
  });

  test('der Export nennt die Stammdatenänderungen mit', async t => {
    const { h } = await setup(t);
    await ok(h.api('hr', 'PATCH', '/api/personnel/5/master', PRIVATE_DATA));
    const report = await ok(h.api('hr', 'GET', '/api/personnel/5/data-export'));
    assert.equal(report.tables.personnel_master_changes.length, 1);
    assert.deepEqual(report.meta.columnsReferringToOtherPeople.personnel_master_changes, ['changed_by']);
  });

  test('Geburt nach Eintritt und zu junge Personen werden abgelehnt, in beiden Reihenfolgen', async t => {
    const { h } = await setup(t);
    const master = (body, userId = 5) => h.api('hr', 'PATCH', `/api/personnel/${userId}/master`, body);
    const together = await master({ birthDate: '2020-05-05', entryDate: '1999-01-01' });
    assert.equal(together.status, 400);
    assert.match(together.data.error, /05\.05\.2020/);
    assert.match(together.data.error, /Bitte prüfe beide Daten/);
    assert.equal(recordOf(h, 5), undefined, 'Abgelehnt heißt: nichts gespeichert');

    await ok(master({ entryDate: '1999-01-01' }));
    assert.equal((await master({ birthDate: '2020-05-05' })).status, 400, 'Geburtsdatum passt nicht zum gespeicherten Eintritt');
    await ok(master({ birthDate: '1970-05-05' }));
    assert.equal((await master({ entryDate: '1960-01-01' })).status, 400, 'Eintritt passt nicht zum gespeicherten Geburtsdatum');
    const tooYoung = await master({ entryDate: '1980-01-01' });
    assert.equal(tooYoung.status, 400);
    assert.match(tooYoung.data.error, /jünger als 13 Jahre/);
    await ok(master({ entryDate: '1983-05-05' }), 200);
    await ok(master({ birthDate: '', entryDate: '1960-01-01' }), 200);
    assert.equal(recordOf(h, 5).birth_date, null);
    assert.equal(recordOf(h, 5).entry_date, '1960-01-01');
  });

  test('das Eintrittsdatum passt zu Probezeit, Befristung und Austritt', async t => {
    const { h } = await setup(t);
    await ok(contractChange(h, 5, { probationEnd: '2026-03-31' }, TODAY), 201);
    const late = await h.api('hr', 'PATCH', '/api/personnel/5/master', { entryDate: '2026-04-01' });
    assert.equal(late.status, 400);
    assert.match(late.data.error, /Probezeitende 31\.03\.2026/);
    await ok(contractChange(h, 6, { contractType: 'fixed_term', fixedTermEnd: '2027-06-30' }, TODAY), 201);
    assert.equal((await h.api('hr', 'PATCH', '/api/personnel/6/master', { entryDate: '2027-07-01' })).status, 400);
    await ok(h.api('hr', 'POST', '/api/personnel/7/exit', { exitDate: addDays(TODAY, 5), reason: 'x' }), 201);
    assert.equal((await h.api('hr', 'PATCH', '/api/personnel/7/master', { entryDate: addDays(TODAY, 6) })).status, 400);
  });

  test('ein alter, schiefer Eintrag hindert niemanden daran, die Anschrift zu ändern', async t => {
    const { h } = await setup(t);
    await ok(h.api('hr', 'PATCH', '/api/personnel/5/master', { entryDate: '2020-01-01' }));
    h.db.prepare("UPDATE personnel_records SET birth_date='2021-01-01' WHERE user_id=5").run();
    await ok(h.api('anna', 'PATCH', '/api/personnel/me/contact', { privateAddress: 'Neu 1' }));
    await ok(h.api('hr', 'PATCH', '/api/personnel/5/master', { birthDate: '2021-01-01', entryDate: '2020-01-01', privateAddress: 'Neu 2' }));
    assert.equal(recordOf(h, 5).private_address, 'Neu 2');
  });
});

describe('Personenliste: Suche und Sortierung', () => {
  async function namedPeople(h) {
    const add = (name, email) => h.deps.createUserAccount({ name, email, role: 'employee', actor: { id: 1 } }).id;
    return {
      ayse: add('Ayşe Demir', 'ayse.demir@test.local'),
      tom: add('Tom Köhler', 'tom@test.local'),
      joerg: add('Jörg Maier', 'j.maier@test.local'),
      julia: add('Julia Mayer', 'julia@test.local'),
      uemit: add('Ümit Yilmaz', 'u.yilmaz@test.local'),
      anke: add('Anke Überall', 'anke@test.local'),
      zoe: add('Zoë von der Heide', 'zoe@test.local')
    };
  }
  const search = async (h, text, actor = 'hr') => (await ok(h.api(actor, 'GET', `/api/personnel/people?q=${encodeURIComponent(text)}`))).people.map(person => person.name);

  test('die Suche findet Name, E-Mail und Personalnummer, auch ohne Sonderzeichen', async t => {
    const { h } = await setup(t);
    const people = await namedPeople(h);
    await ok(h.api('hr', 'PATCH', `/api/personnel/${people.tom}/master`, { personnelNumber: 'B-1007' }));
    assert.deepEqual(await search(h, 'ayse'), ['Ayşe Demir']);
    assert.deepEqual(await search(h, 'AYŞE'), ['Ayşe Demir']);
    assert.deepEqual(await search(h, 'koehler'), ['Tom Köhler']);
    assert.deepEqual(await search(h, 'kohler'), ['Tom Köhler']);
    assert.deepEqual(await search(h, 'köhler'), ['Tom Köhler']);
    assert.deepEqual(await search(h, 'joerg'), ['Jörg Maier']);
    assert.deepEqual(await search(h, 'j.maier@test'), ['Jörg Maier']);
    assert.deepEqual(await search(h, 'b-1007'), ['Tom Köhler']);
    assert.deepEqual(await search(h, '1007'), ['Tom Köhler']);
    assert.deepEqual(await search(h, 'koehler tom'), ['Tom Köhler'], 'Mehrere Wörter, in beliebiger Reihenfolge');
    assert.deepEqual(await search(h, 'tom maier'), []);
    assert.equal((await h.api('hr', 'GET', '/api/personnel/people?q=a&q=b')).status, 400);
  });

  test('die Suche findet nichts, was die Person nicht sehen darf', async t => {
    const { h } = await setup(t);
    await ok(h.api('hr', 'PATCH', '/api/personnel/me/contact', { privatePhone: '030 111' }));
    h.db.prepare("UPDATE personnel_records SET personnel_number='CHEFIN' WHERE user_id=1").run();
    assert.deepEqual(await search(h, 'CHEFIN', 'hr'), ['Hanna HR']);
    assert.deepEqual(await search(h, 'CHEFIN', 'bp'), []);
    assert.deepEqual(await search(h, 'hanna', 'bp'), []);
  });

  test('die Liste ist nach Nachnamen sortiert, mit deutscher Sortierung', async t => {
    const { h } = await setup(t);
    await namedPeople(h);
    const { people } = await ok(h.api('hr', 'GET', '/api/personnel/people'));
    const names = people.map(person => person.lastName);
    assert.ok(names.indexOf('Köhler') < names.indexOf('Maier'), names.join());
    assert.ok(names.indexOf('Maier') < names.indexOf('Mayer'), names.join());
    assert.ok(names.indexOf('Überall') < names.indexOf('Yilmaz'), 'Ü steht bei U, nicht hinter Z');
    assert.ok(names.indexOf('Heide') < names.indexOf('Köhler'), '„von der Heide“ steht unter H');
    assert.equal(people.find(person => person.lastName === 'Heide').name, 'Zoë von der Heide');
    const options = (await ok(h.api('hr', 'GET', '/api/personnel/form-options'))).people.map(person => person.name);
    assert.ok(options.indexOf('Anke Überall') < options.indexOf('Ümit Yilmaz'), 'Auch die Auswahl in Formularen');
  });

  test('der Filter „ohne Datenblatt“ zeigt, wo noch nichts erfasst ist', async t => {
    const { h } = await setup(t);
    await fillPrivate(h, 5);
    await ok(contractChange(h, 6, { weeklyHours: 20 }, TODAY), 201);
    const { people, summary } = await ok(h.api('hr', 'GET', '/api/personnel/people?datasheet=missing'));
    assert.deepEqual(people.map(person => person.id).sort((a, b) => a - b), [1, 2, 3, 4, 7]);
    assert.ok(people.every(person => person.hasRecord === false));
    assert.equal(summary.withoutRecord, 5);
    assert.equal((await h.api('hr', 'GET', '/api/personnel/people?datasheet=foo')).status, 400);
  });
});

describe('Austritt einer Führungskraft', () => {
  const managerOf = (h, userId) => h.db.prepare('SELECT manager_id FROM users WHERE id=?').get(userId).manager_id;
  const exitOf = (h, userId, body, actor = 'hr') => h.api(actor, 'POST', `/api/personnel/${userId}/exit`, { reason: 'Wechsel', ...body });

  test('die Nachfolge gilt erst nach dem letzten Arbeitstag, und die anderen Module erfahren davon', async t => {
    const { h, clock } = await setup(t);
    const seen = [];
    h.deps.onManagerChanged(change => seen.push(change));
    const exitDate = addDays(TODAY, 5);
    const result = await ok(exitOf(h, 4, { exitDate, successorManagerId: 3 }), 201);
    assert.deepEqual(result.directReports.map(person => person.id), [5, 6], 'Bis zum letzten Arbeitstag führt die Person weiter');
    assert.equal(managerOf(h, 5), 4);
    const { sheet } = await ok(h.api('hr', 'GET', '/api/personnel/4'));
    assert.equal(sheet.exit.successor.name, 'Dora Direktor');
    assert.ok(sheet.directReports.every(report => report.canReassign === true));

    clock.today = exitDate;
    h.instance.maintenance();
    assert.equal(managerOf(h, 5), 4, 'Am letzten Arbeitstag noch nicht');

    clock.today = addDays(exitDate, 1);
    h.instance.maintenance();
    assert.equal(isActive(h, 4), 0);
    assert.equal(managerOf(h, 5), 3);
    assert.equal(managerOf(h, 6), 3);
    assert.deepEqual(JSON.parse(JSON.stringify(seen)), [
      { userId: 5, previousManagerId: 4, managerId: 3, actorId: null },
      { userId: 6, previousManagerId: 4, managerId: 3, actorId: null }
    ]);
    assert.equal(auditEntries(h, 'manager_assigned').length, 2);
    assert.equal(auditEntries(h, 'manager_assigned')[0].actor_id, null, 'Die Automatik hat umgehängt');
    assert.deepEqual((await ok(h.api('hr', 'GET', '/api/personnel/4'))).sheet.directReports, []);
  });

  test('bei sofortiger Sperre übernimmt die Nachfolge sofort', async t => {
    const { h } = await setup(t);
    const result = await ok(exitOf(h, 4, { exitDate: TODAY, lockNow: true, successorManagerId: 3 }), 201);
    assert.equal(result.status, 'left');
    assert.deepEqual(result.directReports, []);
    assert.equal(managerOf(h, 5), 3);
    assert.equal(managerOf(h, 6), 3);
  });

  test('ein zurückgenommener Austritt ändert nichts an der Führung', async t => {
    const { h, clock } = await setup(t);
    await ok(exitOf(h, 4, { exitDate: addDays(TODAY, 2), successorManagerId: 3 }), 201);
    const { sheet } = await ok(h.api('hr', 'GET', '/api/personnel/4'));
    await ok(h.api('hr', 'POST', `/api/personnel/4/changes/${sheet.exit.changeId}/cancel`, {}));
    clock.today = addDays(TODAY, 3);
    h.instance.maintenance();
    assert.equal(managerOf(h, 5), 4);
  });

  test('ungeeignete Nachfolgen werden abgelehnt', async t => {
    const { h } = await setup(t);
    const exitDate = addDays(TODAY, 5);
    assert.equal((await exitOf(h, 4, { exitDate, successorManagerId: 4 })).status, 400, 'Nicht die Person selbst');
    assert.equal((await exitOf(h, 4, { exitDate, successorManagerId: 999 })).status, 400);
    assert.equal((await exitOf(h, 4, { exitDate, successorManagerId: 'abc' })).status, 400);
    h.deps.setUserActive(3, false, null);
    assert.equal((await exitOf(h, 4, { exitDate, successorManagerId: 3 })).status, 400, 'Nicht gesperrt');
    h.deps.setUserActive(3, true, null);

    const employee = await exitOf(h, 4, { exitDate, successorManagerId: 7 });
    assert.equal(employee.status, 409);
    assert.equal(employee.data.code, 'manager_role_required');
    assert.equal(employee.data.managerName, 'Clara Cordes');

    await ok(exitOf(h, 3, { exitDate: addDays(TODAY, 2) }), 201);
    const leaving = await exitOf(h, 4, { exitDate, successorManagerId: 3 });
    assert.equal(leaving.status, 409, 'Nicht jemand, der selbst bald geht');
    assert.match(leaving.data.error, /tritt selbst am/);
    assert.equal(h.db.prepare("SELECT COUNT(*) AS count FROM personnel_changes WHERE user_id=4").get().count, 0, 'Abgelehnt heißt: nichts erfasst');
  });

  test('rückt jemand aus dem Team nach, kommt die Person auf den frei werdenden Platz', async t => {
    const { h, clock } = await setup(t);
    await ok(exitOf(h, 4, { exitDate: addDays(TODAY, 2), successorManagerId: 5, promoteManager: true }), 201);
    assert.equal(h.db.prepare('SELECT role FROM users WHERE id=5').get().role, 'employee', 'Die Rolle ändert sich erst, wenn sie übernimmt');
    clock.today = addDays(TODAY, 3);
    h.instance.maintenance();
    assert.equal(managerOf(h, 5), 3, 'Anna rückt auf den Platz von Malte');
    assert.equal(managerOf(h, 6), 5, 'Ben berichtet jetzt an Anna');
    assert.equal(h.db.prepare('SELECT role FROM users WHERE id=5').get().role, 'manager');
    assert.deepEqual(JSON.parse(auditEntries(h, 'user_updated')[0].new_values), { role: 'manager' });
  });

  test('wer die Führungslinie im Kreis führen würde, bleibt zur Neuzuordnung stehen', async t => {
    const { h } = await setup(t);
    h.db.prepare('UPDATE users SET manager_id=6 WHERE id=7').run();
    h.db.prepare("UPDATE users SET role='manager' WHERE id=7").run();
    const { moved, skipped } = await ok(h.api('hr', 'POST', '/api/personnel/4/reassign-reports', { managerId: 7 }));
    assert.deepEqual(moved.map(person => person.id), [5], 'Anna zu Clara geht');
    assert.deepEqual(skipped.map(person => person.id), [6], 'Ben führt Clara, das wäre ein Kreis');
    assert.equal(managerOf(h, 6), 4);
  });

  test('„alle zuordnen“ gibt es für alle HR-Rollen, aber nur mit Zugriff auf die Person', async t => {
    const { h } = await setup(t);
    const staff = h.deps.createUserAccount({ name: 'Sach Bearbeiter', email: 'sb@test.local', role: 'hr_staff', actor: { id: 1 } }).id;
    h.db.prepare('UPDATE users SET manager_id=4 WHERE id=2').run();
    const { sheet } = await ok(h.api(staff, 'GET', '/api/personnel/4'));
    assert.deepEqual(sheet.directReports.map(report => [report.name, report.canReassign]), [['Anna Ahrens', true], ['Ben Berg', true], ['Boris Partner', false]]);
    const { moved, skipped } = await ok(h.api(staff, 'POST', '/api/personnel/4/reassign-reports', { managerId: 3 }));
    assert.deepEqual(moved.map(person => person.id).sort(), [5, 6]);
    assert.deepEqual(skipped.map(person => person.id), [2], 'HR-Kolleg:innen ordnet die Sachbearbeitung nicht neu zu');
    assert.equal(managerOf(h, 2), 4);
    assert.equal((await h.api(staff, 'POST', '/api/personnel/4/reassign-reports', {})).status, 400);
    assert.equal((await h.api('bp', 'POST', '/api/personnel/4/reassign-reports', { managerId: 4 })).status, 400);
  });

  test('was bei der Erfassung nicht erlaubt war, wird auch später nicht umgehängt', async t => {
    const { h, clock } = await setup(t);
    const staff = h.deps.createUserAccount({ name: 'Sach Bearbeiter', email: 'sb@test.local', role: 'hr_staff', actor: { id: 1 } }).id;
    h.db.prepare('UPDATE users SET manager_id=4 WHERE id=2').run();
    await ok(exitOf(h, 4, { exitDate: addDays(TODAY, 1), successorManagerId: 3 }, staff), 201);
    clock.today = addDays(TODAY, 2);
    h.instance.maintenance();
    assert.equal(isActive(h, 4), 0);
    assert.equal(managerOf(h, 5), 3);
    assert.equal(managerOf(h, 2), 4, 'Boris bleibt stehen und ist in der Akte sichtbar');
    assert.deepEqual((await ok(h.api('hr', 'GET', '/api/personnel/4'))).sheet.directReports.map(report => report.id), [2]);
  });

  test('scheitert ein anderes Modul beim Umhängen, gilt der Austritt trotzdem', async t => {
    const { h, clock } = await setup(t);
    h.deps.onManagerChanged(({ userId }) => {
      if (userId === 5) throw new Error('Testfehler im anderen Modul');
    });
    await ok(exitOf(h, 4, { exitDate: addDays(TODAY, 1), successorManagerId: 3 }), 201);
    clock.today = addDays(TODAY, 2);
    const original = console.error;
    console.error = () => {};
    t.after(() => { console.error = original; });
    h.instance.maintenance();
    assert.equal(isActive(h, 4), 0, 'Der Austritt ist durch');
    assert.equal(managerOf(h, 5), 4, 'Anna bleibt zur Neuzuordnung stehen');
    assert.equal(managerOf(h, 6), 3, 'Ben ist umgehängt');
    assert.deepEqual((await ok(h.api('hr', 'GET', '/api/personnel/4'))).sheet.directReports.map(report => report.id), [5]);
  });
});

describe('Lesbare Datenauskunft', () => {
  const readable = (h, userId, actor = 'hr') => ok(h.api(actor, 'GET', `/api/personnel/${userId}/data-export/readable`));
  const section = (report, table) => report.sections.find(item => item.table === table);
  const fieldsOf = entry => Object.fromEntries(entry.map(field => [field.label, field.value]));

  test('nur die HR-Administration ruft sie ab, und jeder Abruf steht im Protokoll', async t => {
    const { h } = await setup(t, { withSuperAdmin: true });
    await readable(h, 5);
    await readable(h, 5, 'super');
    for (const person of ['bp', 'director', 'manager', 'anna', 'ben']) {
      const response = await h.api(person, 'GET', '/api/personnel/5/data-export/readable');
      assert.equal(response.status, 403, person);
      assert.equal(JSON.stringify(response.data).includes('Anna'), false, person);
    }
    assert.equal((await h.api('hr', 'GET', '/api/personnel/999/data-export/readable')).status, 404);
    const entries = auditEntries(h, 'personnel_data_exported');
    assert.equal(entries.length, 2);
    assert.equal(JSON.parse(entries[0].new_values).format, 'readable');
  });

  test('sie nennt Felder verständlich und zeigt deutsche Daten und Zahlen', async t => {
    const { h } = await setup(t);
    const unit = await createUnit(h, { type: 'department', name: 'Technik' });
    await ok(h.api('hr', 'PATCH', '/api/personnel/5/master', { ...PRIVATE_DATA, entryDate: '2023-08-01', personnelNumber: 'A-1' }));
    await ok(contractChange(h, 5, { weeklyHours: 38.5, contractType: 'permanent', employmentType: 'employee' }, TODAY), 201);
    await ok(organizationChange(h, 5, { orgUnitId: unit }, TODAY), 201);
    await ok(h.api('hr', 'PATCH', '/api/personnel/5/master', { privatePhone: '030 111' }));
    const report = await readable(h, 5);

    assert.equal(report.meta.person.name, 'Anna Ahrens');
    assert.equal(report.meta.exportedBy.name, 'Hanna HR');
    assert.match(report.meta.notice, /im Einzelfall prüfen: Daybreak ersetzt keine Rechtsberatung/);
    assert.match(report.meta.exportedAtText, /^05\.11\.2026, \d{2}:\d{2}$/);
    assert.equal(report.sections[0].title, 'Benutzerkonto', 'Das Wichtigste zuerst');

    const record = fieldsOf(section(report, 'personnel_records').entries[0]);
    assert.equal(section(report, 'personnel_records').title, 'Personaldaten');
    assert.equal(record['Private Anschrift'], PRIVATE_DATA.privateAddress);
    assert.equal(record.Geburtsdatum, '14.03.1990');
    assert.equal(record.Wochenstunden, '38,5');
    assert.equal(record.Vertragsart, 'Unbefristet');
    assert.equal(record.Abteilung, 'Technik', 'Name statt laufender Nummer');

    const account = fieldsOf(section(report, 'users').entries[0]);
    assert.equal(account.Rolle, 'Mitarbeiter:in');
    assert.equal(account.Führungskraft, 'Malte Manager');
    assert.equal(account.Aktiv, 'Ja');
    assert.equal(Object.hasOwn(account, 'Is system account'), false);

    const change = section(report, 'personnel_changes').entries.map(fieldsOf).find(entry => entry.Art === 'Vertrag');
    assert.equal(change.Stand, 'Wirksam');
    assert.equal(change['Angelegt von'], 'Hanna HR');
    assert.match(change.Neu, /Wochenstunden: 38,5/);
    assert.match(change.Neu, /Vertragsart: Unbefristet/);
    const masterEntries = section(report, 'personnel_master_changes').entries.map(fieldsOf);
    assert.equal(masterEntries.at(-1)['Geänderte Felder'], 'Private Telefonnummer');
    assert.equal(Object.hasOwn(masterEntries.at(-1), 'Neu'), false, 'Bei privaten Feldern steht kein Wert im Verlauf, also auch hier nicht');
    assert.equal(JSON.stringify(report).includes('{}'), false, 'Keine leeren Klammern');

    const raw = JSON.stringify(report);
    for (const technical of ['personnel_number', 'private_address', 'weekly_hours', 'password', 'employment_type"', '"applied"']) {
      assert.equal(raw.replace(/"table":"[a-z_]+"/g, '').includes(technical), false, technical);
    }
  });

  test('Beträge erscheinen in Euro, und ein neues Feld fehlt nicht, nur weil es noch keinen Namen hat', async t => {
    const { h } = await setup(t);
    h.db.exec("CREATE TABLE compensation_records (id INTEGER PRIMARY KEY, user_id INTEGER, annual_salary_cents INTEGER, fte_basis_points INTEGER, currency TEXT, reason TEXT, brand_new_column TEXT)");
    h.db.prepare("INSERT INTO compensation_records(user_id, annual_salary_cents, fte_basis_points, currency, reason, brand_new_column) VALUES(5, 7802250, 8000, 'EUR', 'promotion', 'Wert')").run();
    h.db.exec('CREATE TABLE succession_candidates (id INTEGER PRIMARY KEY, user_id INTEGER, readiness TEXT)');
    h.db.prepare("INSERT INTO succession_candidates(user_id, readiness) VALUES(5, 'ready_now')").run();
    const report = await readable(h, 5);
    const salary = fieldsOf(section(report, 'compensation_records').entries[0]);
    assert.equal(salary.Jahresgehalt, '78.022,50 €');
    assert.equal(salary.Beschäftigungsumfang, '80 %');
    assert.equal(salary.Grund, 'Beförderung');
    assert.equal(salary['Brand new column'], 'Wert');
    assert.equal(JSON.stringify(report).includes('annual_salary_cents'), false);
    assert.equal(section(report, 'succession_candidates').reviewBeforeRelease, true, 'Planungsdaten sind gekennzeichnet');
    assert.equal(section(report, 'compensation_records').reviewBeforeRelease, false);
    assert.equal(fieldsOf(section(report, 'succession_candidates').entries[0]).Bereitschaft, 'Sofort bereit');
  });

  test('sie verrät so wenig wie die Datei: nichts über Befragungen, keine Passwörter', async t => {
    const { h } = await setup(t);
    h.db.exec('CREATE TABLE surveys_participation (survey_id INTEGER, user_id INTEGER)');
    h.db.prepare('INSERT INTO surveys_participation VALUES (1, 5)').run();
    h.deps.createTask(5, 'Befragung ausfüllen', 'surveys_participate', 1);
    h.deps.createTask(5, 'Andere Aufgabe', 'personnel_deadline', 1);
    const raw = JSON.stringify(await readable(h, 5));
    assert.equal(raw.includes('surveys'), false);
    assert.equal(raw.includes('Befragung ausfüllen'), false);
    assert.equal(raw.includes('Andere Aufgabe'), true);
    assert.equal(raw.includes('!TEST!'), false);
    assert.match(raw, /anonymen Befragungen/);
  });
});

describe('Im echten Mandantenbetrieb', () => {
  const ROOT_PASSWORD = 'SuperRoot!Personalakte2026';
  const ADMIN_PASSWORD = 'NeuesPasswortAcme!2026';
  let directory;
  let daybreak;
  let server;
  let baseUrl;

  before(async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'daybreak-personalakte-test-'));
    daybreak = createDaybreakApp({
      env: {
        DAYBREAK_DB_PATH: path.join(directory, 'primary.db'),
        DAYBREAK_PRIMARY_DEMO: 'true',
        DAYBREAK_SUPERADMIN_PASSWORD_HASH: bcrypt.hashSync(ROOT_PASSWORD, 4),
        SESSION_COOKIE_SECURE: 'false',
        SESSION_SECRET: 'nur-fuer-den-test'
      },
      projectRoot: path.resolve(__dirname, '..')
    });
    await new Promise(resolve => {
      server = daybreak.app.listen(0, '127.0.0.1', resolve);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    await new Promise(resolve => server.close(resolve));
    daybreak.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  async function call(method, url, { cookie, body } = {}) {
    const headers = {};
    if (cookie) headers.cookie = cookie;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const response = await fetch(`${baseUrl}${url}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    return { status: response.status, data, headers: response.headers, cookie: response.headers.getSetCookie()[0]?.split(';', 1)[0] ?? null };
  }

  async function signIn(email, password = 'demo1234', tenant = undefined) {
    const response = await call('POST', '/api/auth/login', { body: { email, password, ...(tenant ? { tenant } : {}) } });
    assert.equal(response.status, 200, JSON.stringify(response.data));
    return response.cookie;
  }

  test('das Modul wird über die Dateikonvention geladen und bringt seine Oberfläche mit', async () => {
    const hr = await signIn('elena@loop.local');
    const config = await call('GET', '/api/app/config', { cookie: hr });
    assert.ok(config.data.modules.includes('personnel'));
    assert.ok(config.data.assets.js.includes('/personnel.js'));
    assert.ok(config.data.assets.css.includes('/personnel.css'));
    const script = await call('GET', '/personnel.js');
    assert.equal(script.status, 200);
    assert.match(script.data, /registerModule/);
    assert.equal((await call('GET', '/personnel.css')).status, 200);

    const overview = await call('GET', '/api/personnel/people', { cookie: hr });
    assert.equal(overview.status, 200);
    assert.ok(overview.data.people.length >= 6, 'Die Beispieldaten sind da');
    assert.ok(overview.data.people.every(person => person.hasRecord));
    assert.equal(overview.headers.get('cache-control'), 'no-store');
  });

  test('die Wartung läuft über normale Anfragen, und die Aufgaben landen auf dem Dashboard', async () => {
    const hr = await signIn('elena@loop.local');
    const dashboard = await call('GET', '/api/dashboard', { cookie: hr });
    const titles = dashboard.data.tasks.filter(task => task.type === 'personnel_deadline').map(task => task.title);
    assert.ok(titles.some(title => title.startsWith('Befristung von')), titles.join(' | '));
    assert.ok(titles.some(title => title.startsWith('Probezeit von')), titles.join(' | '));
  });

  test('die Hilfe findet die Artikel und beachtet Rollen', async () => {
    const hr = await signIn('elena@loop.local');
    const employee = await signIn('lena@loop.local');
    const ask = (cookie, message, view = 'dashboard') => call('POST', '/api/assistant/chat', { cookie, body: { message, context: { view } } });
    const exit = await ask(hr, 'wie erfasse ich einen austritt');
    assert.equal(exit.data.title, 'Austritt und Wiedereintritt erfassen', JSON.stringify(exit.data).slice(0, 200));
    assert.deepEqual(exit.data.actions, [{ label: 'Personalakte öffnen', view: 'personnelPeople' }]);
    const contact = await ask(employee, 'wo ändere ich meine adresse');
    assert.equal(contact.data.title, 'Meine Daten ansehen und ändern');
    const forbiddenTopic = await ask(employee, 'wie mache ich eine datenauskunft');
    assert.notEqual(forbiddenTopic.data.title, 'Datenauskunft erstellen');
  });

  test('ein Austritt beendet laufende Sitzungen, ein Wiedereintritt öffnet das Konto wieder', async () => {
    const hr = await signIn('elena@loop.local');
    const leaving = await signIn('julia@loop.local');
    const { sheet } = (await call('GET', '/api/personnel/me', { cookie: leaving })).data;
    const userId = sheet.person.id;
    const today = (await call('GET', '/api/personnel/form-options', { cookie: hr })).data.today;

    const exit = await call('POST', `/api/personnel/${userId}/exit`, { cookie: hr, body: { exitDate: today, reason: 'Test', lockNow: true } });
    assert.equal(exit.status, 201, JSON.stringify(exit.data));
    assert.equal((await call('GET', '/api/personnel/me', { cookie: leaving })).status, 401, 'Die Sitzung ist beendet');
    assert.equal((await call('POST', '/api/auth/login', { body: { email: 'julia@loop.local', password: 'demo1234' } })).status, 401);
    assert.equal((await call('GET', '/api/users?includeInactive=true', { cookie: hr })).data.users.find(user => user.id === userId).active, 0);

    const rehire = await call('POST', `/api/personnel/${userId}/rehire`, { cookie: hr, body: { rehireDate: today, reason: 'Test' } });
    assert.equal(rehire.status, 201, JSON.stringify(rehire.data));
    await signIn('julia@loop.local');
  });

  test('die Neuzuordnung nach einem Austritt läuft über die Grundfunktion', async t => {
    const hr = await signIn('elena@loop.local');
    const people = (await call('GET', '/api/personnel/people', { cookie: hr })).data.people;
    const leader = people.find(person => person.name === 'Maria Keller');
    const successor = people.find(person => person.name === 'David Brandt');
    // Im Demo-Modus sind die Zugänge der Anmeldeseite vor dem Austritt geschützt.
    const primaryId = daybreak.platform.primaryTenant().id;
    const blocked = await call('POST', `/api/personnel/${leader.id}/exit`, { cookie: hr, body: { exitDate: '2099-12-31', reason: 'Test' } });
    assert.equal(blocked.status, 409, JSON.stringify(blocked.data));
    daybreak.platform.updateTenant(primaryId, { demoMode: false }, 'test');
    t.after(() => daybreak.platform.updateTenant(primaryId, { demoMode: true }, 'test'));
    const exit = await call('POST', `/api/personnel/${leader.id}/exit`, { cookie: hr, body: { exitDate: '2099-12-31', reason: 'Test' } });
    assert.equal(exit.status, 201, JSON.stringify(exit.data));
    assert.ok(exit.data.directReports.length > 0);
    const [report] = exit.data.directReports;
    const reassigned = await call('PATCH', `/api/users/${report.id}/manager`, { cookie: hr, body: { managerId: successor.id } });
    assert.equal(reassigned.status, 200, JSON.stringify(reassigned.data));
    const { sheet } = (await call('GET', `/api/personnel/${leader.id}`, { cookie: hr })).data;
    assert.equal(sheet.directReports.some(person => person.id === report.id), false);
    const cancelled = await call('POST', `/api/personnel/${leader.id}/changes/${sheet.exit.changeId}/cancel`, { cookie: hr, body: {} });
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled.data));
  });

  test('Hanna, David und die echte Schnittstelle halten die Grenzen ein', async () => {
    const staff = await signIn('hanna@loop.local');
    const partner = await signIn('david@loop.local');
    const admin = await signIn('elena@loop.local');
    const everyone = (await call('GET', '/api/personnel/people?status=all', { cookie: admin })).data.people;
    const idOf = name => everyone.find(person => person.name === name).id;

    const staffList = (await call('GET', '/api/personnel/people?status=all', { cookie: staff })).data.people.map(person => person.name);
    assert.ok(staffList.includes('Lena Schmitt') && staffList.includes('Maria Keller'));
    for (const name of ['Elena Hoffmann', 'David Brandt', 'Hanna Vogt']) assert.equal(staffList.includes(name), false, name);
    const partnerList = (await call('GET', '/api/personnel/people?status=all', { cookie: partner })).data.people.map(person => person.name);
    assert.equal(partnerList.includes('Elena Hoffmann'), false);
    assert.ok(partnerList.includes('Hanna Vogt'));

    assert.equal((await call('GET', `/api/personnel/${idOf('Elena Hoffmann')}`, { cookie: partner })).status, 403);
    assert.equal((await call('GET', `/api/personnel/${idOf('Elena Hoffmann')}`, { cookie: staff })).status, 403);
    assert.equal((await call('GET', `/api/personnel/${idOf('David Brandt')}`, { cookie: staff })).status, 403);
    assert.equal((await call('GET', `/api/personnel/${idOf('Lena Schmitt')}`, { cookie: staff })).status, 200);
    const own = await call('GET', '/api/personnel/me', { cookie: staff });
    assert.equal(own.status, 200);
    assert.equal(own.data.sheet.permissions.editMaster, false);
  });

  test('die lesbare Datenauskunft kennt die Tabellen aller Module', async () => {
    const hr = await signIn('elena@loop.local');
    const people = (await call('GET', '/api/personnel/people', { cookie: hr })).data.people;
    const target = people.find(person => person.name === 'Lena Schmitt');
    const runtime = daybreak.runtimeFor(daybreak.platform.primaryTenant());
    const today = (await call('GET', '/api/personnel/form-options', { cookie: hr })).data.today;
    runtime.db.prepare("INSERT INTO compensation_records(user_id, effective_date, annual_salary_cents, currency, fte_basis_points, reason, created_by, created_at) VALUES(?, ?, 7802250, 'EUR', 10000, 'promotion', ?, ?)")
      .run(target.id, today, target.id, `${today}T08:00:00.000Z`);
    const report = await call('GET', `/api/personnel/${target.id}/data-export/readable`, { cookie: hr });
    assert.equal(report.status, 200, JSON.stringify(report.data).slice(0, 300));
    const raw = JSON.stringify(report.data.sections.map(({ title, entries }) => ({ title, entries })));
    assert.equal(raw.includes('annual_salary_cents'), false);
    assert.match(raw, /"label":"Jahresgehalt","value":"78\.022,50 €"/);
    assert.equal(/\$2[aby]\$/.test(raw), false, 'Kein Passwort-Hash');
    const titles = report.data.sections.map(item => item.title);
    assert.ok(titles.includes('Personaldaten'));
    assert.ok(titles.includes('Vergütung'));
    assert.ok(titles.includes('Ziele'));
    assert.equal(titles.some(title => /_/.test(title)), false, titles.join(', '));
    const rawValues = report.data.sections.flatMap(item => item.entries.flat()).map(field => field.value).filter(value => /^[a-z]+(_[a-z0-9]+)+$/.test(value));
    assert.deepEqual(rawValues, [], 'Keine rohen Werte wie manager_draft');
    for (const table of ['personnel_records', 'compensation_records', 'goals', 'users']) {
      const labels = report.data.sections.find(item => item.table === table).entries.flat().map(field => field.label);
      assert.equal(labels.some(label => /_/.test(label) || /^[A-Z][a-z]+ [a-z]+/.test(label) && /\b(id|at|by|cents)\b/.test(label)), false, `${table}: ${labels.join(', ')}`);
    }
  });

  test('ein abgeschaltetes Modul ist serverseitig zu und seine Aufgaben verschwinden', async () => {
    const hr = await signIn('elena@loop.local');
    const switchModule = enabled => call('PATCH', '/api/organization/modules/personnel', { cookie: hr, body: { enabled } });
    assert.equal((await switchModule(false)).status, 200);
    const blocked = await call('GET', '/api/personnel/people', { cookie: hr });
    assert.equal(blocked.status, 403);
    assert.equal(blocked.data.code, 'module_disabled');
    assert.equal((await call('GET', '/api/PERSONNEL/1/data-export', { cookie: hr })).status, 403, 'Auch bei anderer Schreibweise');
    const dashboard = await call('GET', '/api/dashboard', { cookie: hr });
    assert.equal(dashboard.data.tasks.some(task => task.type.startsWith('personnel_')), false);
    assert.equal((await call('GET', '/api/app/config', { cookie: hr })).data.assets.js.includes('/personnel.js'), false);
    assert.equal((await switchModule(true)).status, 200);
    assert.equal((await call('GET', '/api/personnel/people', { cookie: hr })).status, 200);
  });

  test('die echte Systemadministration exportiert und wird mit ihrem technischen Konto protokolliert', async () => {
    const root = await signIn('root@root.de', ROOT_PASSWORD);
    assert.equal((await call('GET', '/api/personnel/me', { cookie: root })).status, 404);
    const overview = await call('GET', '/api/personnel/people', { cookie: root });
    assert.equal(overview.status, 200);
    assert.equal(overview.data.people.some(person => person.email === 'system-root@daybreak.internal'), false);
    const target = overview.data.people.find(person => person.name === 'Lena Schmitt');
    const report = await call('GET', `/api/personnel/${target.id}/data-export`, { cookie: root });
    assert.equal(report.status, 200, JSON.stringify(report.data));
    assert.match(report.headers.get('content-disposition'), /^attachment; filename="datenauskunft-\d+-\d{4}-\d{2}-\d{2}\.json"$/);
    assert.equal(report.headers.get('cache-control'), 'no-store');
    assert.equal(JSON.stringify(report.data).includes('password_hash'), false);
    assert.equal(/\$2[aby]\$/.test(JSON.stringify(report.data)), false, 'Kein Passwort-Hash im Export');
    assert.equal(report.data.meta.exportedBy.name, 'Systemadministration');

    const runtime = daybreak.runtimeFor(daybreak.platform.primaryTenant());
    const entry = runtime.db.prepare("SELECT a.actor_id, u.is_system_account FROM audit_log a JOIN users u ON u.id = a.actor_id WHERE a.action = 'personnel_data_exported' ORDER BY a.id DESC LIMIT 1").get();
    assert.equal(entry.is_system_account, 1);
  });

  test('ein zweiter Mandant sieht nichts vom ersten und bekommt keine Beispieldaten', async () => {
    const root = await signIn('root@root.de', ROOT_PASSWORD);
    const created = await call('POST', '/api/platform/tenants', {
      cookie: root,
      body: { slug: 'acme', name: 'Acme GmbH', adminName: 'Acme Admin', adminEmail: 'chef@example.test', adminPassword: ADMIN_PASSWORD, modules: ['personnel'] }
    });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    const firstSession = await signIn('chef@example.test', ADMIN_PASSWORD, 'acme');
    assert.equal((await call('GET', '/api/personnel/people', { cookie: firstSession })).data.code, 'password_change_required');
    const changed = await call('POST', '/api/auth/password', { cookie: firstSession, body: { currentPassword: ADMIN_PASSWORD, newPassword: `${ADMIN_PASSWORD}x` } });
    assert.equal(changed.status, 200, JSON.stringify(changed.data));
    const acmeCookie = await signIn('chef@example.test', `${ADMIN_PASSWORD}x`, 'acme');

    const overview = await call('GET', '/api/personnel/people', { cookie: acmeCookie });
    assert.equal(overview.status, 200, JSON.stringify(overview.data));
    assert.deepEqual(overview.data.people.map(person => person.name), ['Acme Admin']);
    assert.deepEqual((await call('GET', '/api/personnel/org-units', { cookie: acmeCookie })).data.units, [], 'Stammdaten sind leer, keine Beispieldaten');
    const adminId = overview.data.people[0].id;
    assert.equal((await call('GET', `/api/personnel/${adminId}`, { cookie: acmeCookie })).data.sheet.hasRecord, false);
    assert.equal((await call('GET', `/api/personnel/${adminId + 500}`, { cookie: acmeCookie })).status, 404, 'IDs des Hauptmandanten gibt es hier nicht');

    const created2 = await call('POST', '/api/personnel/org-units', { cookie: acmeCookie, body: { type: 'department', name: 'Nur bei Acme' } });
    assert.equal(created2.status, 201);
    const hr = await signIn('elena@loop.local');
    const primaryUnits = (await call('GET', '/api/personnel/org-units', { cookie: hr })).data.units;
    assert.equal(primaryUnits.some(unit => unit.name === 'Nur bei Acme'), false);
  });
});

describe('Oberfläche', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'personnel.js'), 'utf8');

  // Echte Escape-Regel aus public/app.js, damit der Test weder strenger noch lascher ist als die Anwendung.
  const esc = value => String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
  const plain = value => JSON.parse(JSON.stringify(value));

  /**
   * Lädt die echte Oberfläche ohne Browser und verbindet sie mit dem echten Modul. Klicks laufen
   * über bind(), Formulare über onSubmit, die Anfragen also wirklich bis zum Server.
   */
  function loadClient(h, person, { enabledModules = [] } = {}) {
    const definitions = [];
    const modals = [];
    const toasts = [];
    const coreCalls = [];
    const downloads = [];
    const timers = [];
    const elements = new Map();
    const me = typeof person === 'object' ? person : { ...h.people[person] };
    const actor = typeof person === 'object' ? person.id : person;

    const api = async (url, options = {}) => {
      const body = options.body ? JSON.parse(options.body) : undefined;
      // Die Grundfunktion /api/users läuft nicht im Testgerüst des Moduls.
      if (url.startsWith('/api/users/')) {
        coreCalls.push({ url, method: options.method, body });
        return { ok: true };
      }
      const response = await h.api(actor, options.method || 'GET', url, body);
      if (response.status >= 400) {
        const error = new Error(response.data.error);
        error.status = response.status;
        error.code = response.data.code;
        throw error;
      }
      return response.data;
    };
    const ui = {
      esc,
      header: (title, subtitle = '', actions = '') => `<header class="top"><h1>${esc(title)}</h1><p>${esc(subtitle)}</p>${actions}</header>`,
      stat: (label, value, sub = '') => `<article class="card stat"><small>${esc(label)}</small><strong>${esc(value)}</strong><span>${esc(sub)}</span></article>`,
      empty: message => `<p class="muted">${esc(message)}</p>`,
      plural: (count, one, many) => `${count} ${count === 1 ? one : many}`,
      toast: (message, type = 'success') => toasts.push({ message, type }),
      modal: config => modals.push(config)
    };
    const window = {
      confirm: () => true,
      loop: {
        api,
        ui,
        me,
        view: 'personnelPeople',
        isModuleEnabled: key => enabledModules.includes(key),
        navigate(next) { window.loop.view = next; },
        registerModule: definition => definitions.push(definition)
      }
    };
    const document = {
      querySelectorAll: selector => elements.get(selector) || [],
      querySelector: selector => (elements.get(selector) || [])[0] || null,
      createElement: () => ({
        click() { downloads.push(this.download); },
        remove() {}
      }),
      body: { appendChild() {} }
    };
    const URLStub = { createObjectURL: () => 'blob:test', revokeObjectURL() {} };
    const context = {
      window, document, URLSearchParams, Intl, Date, encodeURIComponent, String, Number, Object, Set, Map, Promise, JSON, URL: URLStub, Blob,
      CSS: { escape: value => value },
      setTimeout: action => timers.push(action),
      clearTimeout() {}
    };
    vm.runInNewContext(source, context);
    const definition = definitions[0];

    function attach(selector, element) {
      elements.clear();
      elements.set(selector, [element]);
      definition.bind();
    }

    /** Löst einen Klick auf ein Element mit diesem Selektor aus. */
    async function click(selector, dataset = {}) {
      const element = { dataset };
      attach(selector, element);
      await element.onclick();
    }

    async function changeFilter(name, value) {
      const select = { dataset: { personnelFilter: name }, value };
      attach('[data-personnel-filter]', select);
      select.onchange();
    }

    return { definition, pages: definition.pages, click, changeFilter, modals, toasts, coreCalls, downloads, timers, window, elements };
  }

  async function openSheet(client, userId) {
    await client.click('[data-personnel-open]', { personnelOpen: String(userId) });
    assert.equal(client.window.loop.view, 'personnelPerson');
    return client.pages.personnelPerson();
  }

  const lastModal = client => client.modals.at(-1);
  const lastToast = client => client.toasts.at(-1);

  const HOSTILE = '"><img src=x onerror=alert(1)>\'&';

  /** Schreibt feindliche Texte direkt in die Datenbank, also an cleanText vorbei. */
  async function hostileData(h) {
    h.db.prepare('UPDATE users SET name=?, title=? WHERE id IN (4,5)').run(`Eve ${HOSTILE}`, `Titel ${HOSTILE}`);
    const unit = await createUnit(h, { type: 'department', name: 'Einheit', code: 'E1' });
    const location = await createUnit(h, { type: 'location', name: 'Ort', code: 'O1' });
    const costCenter = await createUnit(h, { type: 'cost_center', name: 'Kosten', code: 'K1' });
    await ok(organizationChange(h, 5, { orgUnitId: unit, locationId: location, costCenterId: costCenter }, TODAY), 201);
    await ok(contractChange(h, 5, { contractType: 'fixed_term', fixedTermEnd: addDays(TODAY, 20), weeklyHours: 38.5, employmentType: 'employee' }, TODAY), 201);
    await ok(contractChange(h, 5, { weeklyHours: 30 }, addDays(TODAY, 30)), 201);
    await ok(h.api('hr', 'POST', '/api/personnel/4/exit', { exitDate: addDays(TODAY, 40), reason: 'x' }), 201);
    h.db.prepare('UPDATE personnel_org_units SET name=?, code=?, leader_user_id=4').run(`Einheit ${HOSTILE}`, `C${HOSTILE}`);
    h.db.prepare('UPDATE personnel_records SET personnel_number=?, private_address=?, private_phone=?, emergency_contact=? WHERE user_id=5').run(`N${HOSTILE}`, `A${HOSTILE}`, `T${HOSTILE}`, `K${HOSTILE}`);
    h.db.prepare('UPDATE personnel_changes SET reason=?').run(`Grund ${HOSTILE}`);
    h.instance.maintenance();
  }

  function assertCleanHtml(html, label) {
    assert.equal(html.includes('<img'), false, `${label}: unmaskiertes HTML`);
    assert.equal(html.includes('undefined'), false, `${label}: undefined in der Ausgabe`);
    assert.equal(html.includes('[object Object]'), false, `${label}: Objekt in der Ausgabe`);
    assert.equal(html.includes('NaN'), false, `${label}: NaN in der Ausgabe`);
    // Ein Anführungszeichen aus den Daten darf kein Attribut beenden: Die Werte stehen maskiert in der Ausgabe.
    assert.equal(html.includes(HOSTILE), false, `${label}: Daten stehen roh in der Ausgabe`);
  }

  test('Kein Inline-Code, keine fremden Skripte, kein fremder Produktname', () => {
    assert.equal(/\son[a-z]+\s*=\s*["'`]/i.test(source), false, 'Inline-Ereignisse verbietet die CSP');
    assert.equal(/<script/i.test(source), false);
    assert.equal(/workday/i.test(source), false);
  });

  test('Navigation und Reiter passen zur Rolle', async t => {
    const { h } = await setup(t);
    const { definition } = loadClient(h, 'anna');
    const navOf = role => plain(definition.nav({ role }));
    assert.deepEqual(navOf('employee').map(item => [item.route, item.label, item.group]), [['personnelMe', 'Meine Daten', 'myWork']]);
    assert.deepEqual(navOf('manager').map(item => item.route), ['personnelMe']);
    assert.deepEqual(navOf('director').map(item => item.route), ['personnelMe']);
    for (const role of ['hr_admin', 'hrbp', 'hr_staff']) {
      assert.deepEqual(navOf(role).map(item => [item.route, item.label, item.group]), [
        ['personnelMe', 'Meine Daten', 'myWork'],
        ['personnelPeople', 'Personalakte', 'hr']
      ]);
    }
    assert.deepEqual(navOf('super_admin').map(item => item.route), ['personnelPeople']);
    assert.deepEqual(plain(definition.tabs('personnelMe', { role: 'hr_admin' })), []);
    assert.deepEqual(plain(definition.tabs('personnelPeople', { role: 'employee' })), []);
    assert.deepEqual(plain(definition.tabs('personnelUnits', { role: 'hr_admin' })).map(tab => [tab.label, tab.active]), [['Personen', false], ['Abteilungen und Standorte', true]]);
    assert.deepEqual(plain(definition.tabs('personnelPerson', { role: 'hrbp' })).map(tab => [tab.label, tab.active]), [['Personen', true], ['Abteilungen und Standorte', false]]);
    assert.deepEqual(plain(definition.tabs('personnelPeople', { role: 'hr_staff' })), [], 'Die Sachbearbeitung hat nur die Personenliste');
    assert.deepEqual(plain(definition.tabs('personnelUnits', { role: 'hr_staff' })), []);
  });

  test('alle Seiten rendern echte Serverdaten und maskieren jeden Wert', async t => {
    const { h } = await setup(t);
    await hostileData(h);

    const hrClient = loadClient(h, 'hr');
    const overview = await hrClient.pages.personnelPeople();
    assertCleanHtml(overview, 'Übersicht');
    assert.match(overview, /&lt;img/);
    assert.match(overview, /data-personnel-open="5"/);

    assertCleanHtml(await hrClient.pages.personnelUnits(), 'Einheiten');
    assertCleanHtml(await hrClient.pages.personnelMe(), 'Eigene Daten von HR');
    const withoutSelection = await hrClient.pages.personnelPerson();
    assertCleanHtml(withoutSelection, 'Akte ohne Auswahl');
    assert.match(withoutSelection, /Bitte wähle/);

    const sheet = await openSheet(hrClient, 5);
    assertCleanHtml(sheet, 'Akte');
    assert.match(sheet, /Grund &quot;&gt;&lt;img/, 'HR sieht den Grund maskiert');
    assert.match(sheet, /Gilt nur|Zurücknehmen/);
    const leaving = await openSheet(hrClient, 4);
    assertCleanHtml(leaving, 'Akte mit Neuzuordnung');
    assert.match(leaving, /data-personnel-reassign="5"/);
    assert.match(leaving, /data-personnel-reassign-select="6"/);
    assert.match(leaving, /Leitung ändern/);

    const annaPage = await loadClient(h, 'anna').pages.personnelMe();
    assertCleanHtml(annaPage, 'Meine Daten');
    assert.match(annaPage, /data-personnel-edit-contact/);
    assert.equal(annaPage.includes('Grund '), false, 'Keine Gründe im eigenen Verlauf');
    for (const action of ['data-personnel-export', 'data-personnel-change', 'data-personnel-exit', 'data-personnel-edit-master']) {
      assert.equal(annaPage.includes(action), false, action);
    }

    const directorClient = loadClient(h, 'director');
    const directorPage = await directorClient.pages.personnelMe();
    assertCleanHtml(directorPage, 'Teamliste');
    assert.match(directorPage, /Mein Team/);
    const teamSheet = await openSheet(directorClient, 5);
    assertCleanHtml(teamSheet, 'Teamakte');
    assert.equal(teamSheet.includes('A&quot;'), false, 'Keine Anschrift');
    assert.match(teamSheet, /nur die Person selbst und HR/);
    for (const action of ['data-personnel-export', 'data-personnel-change', 'data-personnel-exit', 'data-personnel-edit-master', 'data-personnel-cancel-change']) {
      assert.equal(teamSheet.includes(action), false, action);
    }
    assert.equal(plain(directorClient.definition.tabs('personnelPerson', { role: 'director' })).length, 0);
  });

  test('Personen ohne Datensatz erscheinen als leeres Blatt', async t => {
    const { h } = await setup(t);
    const annaPage = await loadClient(h, 'anna').pages.personnelMe();
    assertCleanHtml(annaPage, 'Leeres eigenes Blatt');
    assert.match(annaPage, /noch keine Daten hinterlegt/);
    const client = loadClient(h, 'hr');
    const sheet = await openSheet(client, 5);
    assertCleanHtml(sheet, 'Leere Akte');
    assert.match(sheet, /noch kein Datenblatt/);
    const overview = await client.pages.personnelPeople();
    assertCleanHtml(overview, 'Leere Übersicht');
    assert.match(overview, /Noch kein Datenblatt/);
    assert.match(await client.pages.personnelUnits(), /Noch keine Einheiten/);
  });

  test('die Knöpfe folgen den Rechten des Servers', async t => {
    const { h } = await setup(t);
    const hrSheet = await openSheet(loadClient(h, 'hr'), 5);
    for (const action of ['data-personnel-export', 'data-personnel-exit', 'data-personnel-edit-master']) assert.ok(hrSheet.includes(action), action);
    const bpSheet = await openSheet(loadClient(h, 'bp'), 5);
    assert.equal(bpSheet.includes('data-personnel-export'), false, 'HRBP bekommt keine Datenauskunft angeboten');
    assert.ok(bpSheet.includes('data-personnel-exit'));
    assert.equal((await h.api('bp', 'GET', '/api/personnel/1')).status, 403, 'Die Akte der HR-Leitung bleibt für HRBP zu');
    const hrOwn = await openSheet(loadClient(h, 'hr'), 1);
    for (const action of ['data-personnel-exit', 'data-personnel-edit-master', 'data-personnel-change']) assert.equal(hrOwn.includes(action), false, action);
    assert.match(hrOwn, /deine eigene Akte/);
  });

  test('der Hinweis auf Austrittsabläufe erscheint nur, wenn das Modul an ist', async t => {
    const { h } = await setup(t);
    await ok(h.api('hr', 'POST', '/api/personnel/5/exit', { exitDate: addDays(TODAY, 5), reason: 'x' }), 201);
    const withModule = await openSheet(loadClient(h, 'hr', { enabledModules: ['onboarding'] }), 5);
    assert.match(withModule, /data-view="onboardingHome"/);
    const withoutModule = await openSheet(loadClient(h, 'hr'), 5);
    assert.equal(withoutModule.includes('onboardingHome'), false);
    const withoutExit = await openSheet(loadClient(h, 'hr', { enabledModules: ['onboarding'] }), 6);
    assert.equal(withoutExit.includes('onboardingHome'), false);
  });

  test('der Filter schickt die Auswahl an den Server', async t => {
    const { h } = await setup(t);
    await ok(h.api('hr', 'POST', '/api/personnel/5/exit', { exitDate: addDays(TODAY, 5), reason: 'x' }), 201);
    const client = loadClient(h, 'hr');
    assert.match(await client.pages.personnelPeople(), /Clara/);
    await client.changeFilter('deadline', 'exits');
    const page = await client.pages.personnelPeople();
    assert.match(page, /Anna/);
    assert.equal(page.includes('Clara'), false);
    assert.match(page, /value="exits" selected/);
    await client.changeFilter('deadline', '');
    await client.changeFilter('status', 'left');
    assert.match(await client.pages.personnelPeople(), /keine Personen/);
  });

  test('Kontaktdaten: Formular und Speichern für die eigene Person', async t => {
    const { h } = await setup(t);
    const client = loadClient(h, 'anna');
    await client.pages.personnelMe();
    await client.click('[data-personnel-edit-contact]');
    const modal = lastModal(client);
    assert.match(modal.body, /name="privateAddress"/);
    assert.equal(/personnelNumber|weeklyHours|birthDate/.test(modal.body), false, 'Nur Kontaktfelder');
    await modal.onSubmit({ privateAddress: 'Weg 1', privatePhone: '030 1234', emergencyContact: 'Mama' });
    assert.equal(recordOf(h, 5).private_address, 'Weg 1');
    assert.equal(recordOf(h, 5).private_phone, '030 1234');
    await assert.rejects(modal.onSubmit({ privateAddress: 'Weg 1', privatePhone: 'falsch', emergencyContact: '' }), /Telefonnummer/);
  });

  test('Stammdaten, Vertrag und Organisation über die Formulare', async t => {
    const { h } = await setup(t);
    const department = await createUnit(h, { type: 'department', name: 'Technik', code: 'T1' });
    const hidden = await createUnit(h, { type: 'department', name: 'Abgeschaltet' });
    await ok(h.api('hr', 'PATCH', `/api/personnel/org-units/${hidden}`, { active: false }));
    const location = await createUnit(h, { type: 'location', name: 'Berlin' });
    const client = loadClient(h, 'hr');
    await openSheet(client, 5);

    await client.click('[data-personnel-edit-master]');
    await lastModal(client).onSubmit({ personnelNumber: 'P-7', entryDate: '2026-01-01', birthDate: '1990-05-05', privateAddress: 'A', privatePhone: '', emergencyContact: '' });
    assert.equal(recordOf(h, 5).personnel_number, 'P-7');
    assert.equal(recordOf(h, 5).birth_date, '1990-05-05');
    await openSheet(client, 5);

    await client.click('[data-personnel-change]', { personnelChange: 'contract' });
    let modal = lastModal(client);
    assert.equal(modal.title, 'Vertrag ändern');
    assert.match(modal.body, /name="fixedTermEnd"[^>]*disabled/, 'Ohne Befristung ist das Enddatum gesperrt');
    assertCleanHtml(modal.body, 'Vertragsformular');
    const blank = { employmentType: '', contractType: '', probationEnd: '', weeklyHours: '', effectiveDate: TODAY, reason: 'Grund' };
    await assert.rejects(modal.onSubmit(blank), /nichts geändert/);
    await assert.rejects(modal.onSubmit({ ...blank, weeklyHours: '99' }), /Wochenstunden/);
    assert.equal(await modal.onSubmit({ ...blank, weeklyHours: '40', employmentType: 'employee' }), false);
    assert.equal(recordOf(h, 5).weekly_hours, 40);
    assert.equal(recordOf(h, 5).employment_type, 'employee');
    assert.equal(lastToast(client).message, 'Die Änderung ist wirksam.');

    await openSheet(client, 5);
    await client.click('[data-personnel-change]', { personnelChange: 'organization' });
    modal = lastModal(client);
    assert.equal(modal.title, 'Organisation ändern');
    assert.match(modal.body, /Technik \(T1\)/);
    assert.equal(modal.body.includes('Abgeschaltet'), false, 'Deaktivierte Einheiten stehen nicht zur Wahl');
    assertCleanHtml(modal.body, 'Organisationsformular');
    await modal.onSubmit({ orgUnitId: String(department), locationId: String(location), costCenterId: '', effectiveDate: addDays(TODAY, 3), reason: 'Versetzung' });
    assert.equal(recordOf(h, 5).org_unit_id, null, 'Geplant, noch nicht wirksam');
    assert.match(lastToast(client).message, /08\.11\.2026/);

    // Nur Geändertes wird gesendet: Ein späterer Eintrag setzt geplante Werte nicht versehentlich zurück.
    await ok(contractChange(h, 5, { weeklyHours: 20 }, addDays(TODAY, 10)), 201);
    await openSheet(client, 5);
    await client.click('[data-personnel-change]', { personnelChange: 'contract' });
    await lastModal(client).onSubmit({ employmentType: 'employee', contractType: '', probationEnd: '2027-01-31', weeklyHours: '40', effectiveDate: addDays(TODAY, 20), reason: 'Probezeit' });
    const newest = h.db.prepare('SELECT new_values FROM personnel_changes ORDER BY id DESC LIMIT 1').get();
    assert.deepEqual(JSON.parse(newest.new_values), { probation_end: '2027-01-31' });
  });

  test('das Formular fragt bei einer Rückdatierung nach und speichert erst nach Bestätigung', async t => {
    const { h } = await setup(t);
    await ok(contractChange(h, 5, { weeklyHours: 30 }, '2026-10-01'), 201);
    const client = loadClient(h, 'hr');
    await openSheet(client, 5);
    await client.click('[data-personnel-change]', { personnelChange: 'contract' });
    const modal = lastModal(client);
    const box = { hidden: true };
    const text = { textContent: '' };
    const formElement = { querySelector: selector => (selector.includes('box') ? box : text) };
    const form = { employmentType: '', contractType: '', probationEnd: '', weeklyHours: '35', effectiveDate: '2026-09-01', reason: 'Nachtrag' };

    assert.equal(await modal.onSubmit(form, formElement), true, 'Der Dialog bleibt offen');
    assert.equal(box.hidden, false);
    assert.match(text.textContent, /01\.10\.2026/);
    assert.equal(countChanges(h), 1);

    assert.equal(await modal.onSubmit({ ...form, confirmBackdate: 'on' }, formElement), false);
    assert.equal(countChanges(h), 2);
    assert.equal(recordOf(h, 5).weekly_hours, 30);
    assert.match(lastToast(client).message, /jüngeren Änderung/);
    const page = await openSheet(client, 5);
    assert.match(page, /Gilt nur bis zur jüngeren Änderung vom 01\.10\.2026/);
  });

  test('geplante Änderungen, Austritt und Wiedereintritt über die Oberfläche', async t => {
    const { h, clock } = await setup(t);
    const client = loadClient(h, 'hr');
    const planned = await ok(contractChange(h, 4, { weeklyHours: 20 }, addDays(TODAY, 5)), 201);
    let page = await openSheet(client, 4);
    assert.match(page, new RegExp(`data-personnel-cancel-change="${planned.change.id}"`));
    await client.click('[data-personnel-cancel-change]', { personnelCancelChange: String(planned.change.id) });
    assert.equal(h.db.prepare('SELECT status FROM personnel_changes WHERE id=?').get(planned.change.id).status, 'cancelled');

    // Bei „Abbrechen“ im Rückfragedialog passiert nichts.
    await openSheet(client, 4);
    await client.click('[data-personnel-exit]');
    let modal = lastModal(client);
    assert.match(modal.body, /Austrittsdatum \(letzter Arbeitstag\)/);
    assert.match(modal.body, /Das Austrittsdatum ist der letzte Arbeitstag/);
    assert.equal(/ersten Tag|erster Tag/.test(modal.body), false, 'Nur noch eine Erklärung des Datums');
    assert.match(modal.body, /value="" required/, 'Kein vorbelegtes Datum, das aus Versehen sofort sperrt');
    assert.match(modal.body, /name="lockNow"/);
    client.window.confirm = () => false;
    assert.equal(await modal.onSubmit({ exitDate: TODAY, reason: 'Kündigung', lockNow: 'on' }), true, 'Sofort sperren fragt nach');
    assert.equal(await modal.onSubmit({ exitDate: addDays(TODAY, -1), reason: 'Kündigung' }), true, 'Ein vergangenes Datum auch');
    assert.equal(isActive(h, 4), 1);
    client.window.confirm = () => true;

    await modal.onSubmit({ exitDate: addDays(TODAY, 5), reason: 'Kündigung', successorManagerId: 'later' });
    assert.match(lastToast(client).message, /2 direkt unterstellte Personen brauchen eine neue Führungskraft/);
    page = await openSheet(client, 4);
    assert.match(page, /Austritt zurücknehmen/);
    assert.match(page, /Kündigung/);

    const reassign = async newManager => {
      const button = { dataset: { personnelReassign: '5' } };
      client.elements.clear();
      client.elements.set('[data-personnel-reassign]', [button]);
      client.elements.set('[data-personnel-reassign-select="5"]', [{ value: newManager }]);
      client.definition.bind();
      await button.onclick();
    };
    await reassign('');
    assert.match(lastToast(client).message, /wähle eine neue Führungskraft/);
    assert.equal(lastToast(client).type, 'error');
    assert.deepEqual(plain(client.coreCalls), []);
    await reassign('3');
    assert.deepEqual(plain(client.coreCalls), [{ url: '/api/users/5/manager', method: 'PATCH', body: { managerId: 3 } }]);

    clock.today = addDays(TODAY, 6);
    h.instance.maintenance();
    assert.equal(isActive(h, 4), 0);
    page = await openSheet(client, 4);
    assert.match(page, /Wiedereintritt erfassen/);
    assert.equal(page.includes('Austritt erfassen'), false);
    assert.match(page, /War der Austritt ein Versehen/);
    await client.click('[data-personnel-rehire]');
    modal = lastModal(client);
    assert.match(modal.body, /Das Eintrittsdatum bleibt der erste Tag im Unternehmen/);
    await modal.onSubmit({ rehireDate: clock.today, reason: 'Rückkehr' });
    assert.equal(isActive(h, 4), 1);
  });

  test('der Austrittsdialog fragt bei Führungskräften, wer übernimmt, und holt die Zustimmung zur Rolle ein', async t => {
    const { h, clock } = await setup(t);
    const client = loadClient(h, 'hr');
    await openSheet(client, 4);
    await client.click('[data-personnel-exit]');
    const modal = lastModal(client);
    assert.match(modal.body, /Wer übernimmt/);
    assert.match(modal.body, /Anna Ahrens, Ben Berg/);
    assert.match(modal.body, /<select[^>]*name="successorManagerId"[^>]*required/, 'Die Entscheidung lässt sich nicht übergehen');
    assert.match(modal.body, /value="later"/);
    assert.equal(/value="4"/.test(modal.body), false, 'Die austretende Person steht nicht zur Wahl');

    client.window.confirm = () => false;
    assert.equal(await modal.onSubmit({ exitDate: addDays(TODAY, 5), reason: 'x', successorManagerId: '7' }), true, 'Ohne Zustimmung bleibt der Dialog offen');
    assert.equal(countChanges(h), 0);
    client.window.confirm = () => true;
    assert.equal(await modal.onSubmit({ exitDate: addDays(TODAY, 5), reason: 'x', successorManagerId: '7' }), false);
    assert.equal(lastToast(client).message.includes('brauchen'), false, 'Es ist ja geregelt');

    const page = await openSheet(client, 4);
    assert.match(page, /Neue Führungskraft danach/);
    assert.match(page, /Vorgemerkt: Clara Cordes übernimmt/);
    assert.match(page, /data-personnel-reassign-all/);
    clock.today = addDays(TODAY, 6);
    h.instance.maintenance();
    assert.equal(h.db.prepare('SELECT manager_id FROM users WHERE id=5').get().manager_id, 7);
    assert.equal(h.db.prepare('SELECT role FROM users WHERE id=7').get().role, 'manager', 'Mit ihrer Zustimmung bekam Clara die Rolle');
  });

  test('„Alle zuordnen“ hängt alle um und meldet, was nicht ging', async t => {
    const { h } = await setup(t);
    const client = loadClient(h, 'hr');
    await ok(h.api('hr', 'POST', '/api/personnel/4/exit', { exitDate: addDays(TODAY, 5), reason: 'x' }), 201);
    await openSheet(client, 4);
    const button = { dataset: {} };
    client.elements.clear();
    client.elements.set('[data-personnel-reassign-all]', [button]);
    client.elements.set('[data-personnel-reassign-all-select]', [{ value: '' }]);
    client.definition.bind();
    await button.onclick();
    assert.equal(lastToast(client).type, 'error');
    client.elements.set('[data-personnel-reassign-all-select]', [{ value: '3' }]);
    await button.onclick();
    assert.match(lastToast(client).message, /2 Personen zugeordnet/);
    assert.equal(h.db.prepare('SELECT manager_id FROM users WHERE id=6').get().manager_id, 3);
  });

  test('die Suche zeichnet nur die Ergebnisse neu, damit das Feld den Fokus behält', async t => {
    const { h } = await setup(t);
    h.db.prepare("UPDATE users SET name='Tom Köhler' WHERE id=5").run();
    const client = loadClient(h, 'hr');
    const page = await client.pages.personnelPeople();
    assert.match(page, /data-personnel-search/);
    assert.match(page, /placeholder="Name, E-Mail oder Personalnummer"/);
    assert.match(page, /Köhler, Tom/, 'Der Nachname steht vorn, weil danach sortiert ist');
    assert.match(page, /value="missing"/, 'Der Filter „Ohne Datenblatt“ ist da');

    let navigations = 0;
    const navigate = client.window.loop.navigate;
    client.window.loop.navigate = next => { navigations += 1; navigate(next); };
    const results = { innerHTML: '' };
    const input = { dataset: {}, value: 'koehler' };
    client.elements.clear();
    client.elements.set('[data-personnel-search]', [input]);
    client.elements.set('[data-personnel-results]', [results]);
    client.definition.bind();
    input.oninput();
    assert.equal(client.timers.length, 1, 'Erst nach einer kurzen Pause wird gesucht');
    await client.timers[0]();
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.match(results.innerHTML, /Köhler/);
    assert.equal(results.innerHTML.includes('Clara'), false);
    assert.match(results.innerHTML, /1 Person, sortiert/);
    assert.equal(navigations, 0, 'Die Seite wird nicht neu aufgebaut');
    assert.match(await client.pages.personnelPeople(), /value="koehler"/, 'Der Suchbegriff bleibt beim Zurückkommen stehen');
  });

  test('der Verlauf nennt Stammdatenänderungen ohne private Inhalte', async t => {
    const { h } = await setup(t);
    await ok(h.api('hr', 'PATCH', '/api/personnel/5/master', { privateAddress: 'Geheimweg 7', entryDate: '2020-02-01' }));
    await ok(h.api('anna', 'PATCH', '/api/personnel/me/contact', { privatePhone: '030 23125 777' }));
    const annaPage = await loadClient(h, 'anna').pages.personnelMe();
    assert.match(annaPage, /Angaben geändert/);
    assert.match(annaPage, /Private Anschrift<\/b> wurde geändert/);
    assert.match(annaPage, /Eintrittsdatum:<\/b> – → 01\.02\.2020/);
    assert.match(annaPage, /von Hanna HR/);
    assert.match(annaPage, /von dir/);
    const verlauf = annaPage.slice(annaPage.indexOf('<h2>Verlauf</h2>'));
    assert.equal(verlauf.includes('Geheimweg'), false);
    assert.equal(verlauf.includes('23125 777'), false);
    const hrPage = await openSheet(loadClient(h, 'hr'), 5);
    assert.match(hrPage, /von der Person selbst/);
  });

  test('die eigene Akte: Ohne Freigabe nur Hinweis, mit Freigabe Knöpfe statt „ändert eine andere HR-Person“', async t => {
    const { h } = await setup(t);
    const denied = await openSheet(loadClient(h, 'bp'), 2);
    assert.match(denied, /ändert eine andere HR-Person/);
    assert.equal(denied.includes('data-personnel-edit-master'), false);
    assert.equal((await loadClient(h, 'bp').pages.personnelMe()).includes('Eigene Akte bearbeiten'), false);

    h.deps.setApprovalRule('personnel.hr_self_edit', 'allowed', { id: 1 });
    for (const person of ['hr', 'bp']) {
      const client = loadClient(h, person);
      const page = await openSheet(client, h.people[person].id);
      assert.equal(page.includes('ändert eine andere HR-Person'), false, person);
      assert.match(page, /Deine Organisation erlaubt dir/, person);
      for (const action of ['data-personnel-edit-master', 'data-personnel-change']) assert.ok(page.includes(action), `${person} ${action}`);
      assert.equal(page.includes('data-personnel-exit'), false, 'Das eigene Konto sperrt niemand');
      assert.match(await client.pages.personnelMe(), /Eigene Akte bearbeiten/, person);
    }
  });

  test('die Sachbearbeitung sieht nur, was sie darf, und bekommt nur passende Knöpfe', async t => {
    const { h } = await setup(t);
    const staffId = h.deps.createUserAccount({ name: 'Sach Bearbeiter', email: 'sb@test.local', role: 'hr_staff', actor: { id: 1 } }).id;
    const staff = { id: staffId, name: 'Sach Bearbeiter', role: 'hr_staff' };
    const department = await createUnit(h, { type: 'department', name: 'Technik', leaderUserId: 4 });
    await ok(h.api('hr', 'POST', '/api/personnel/4/exit', { exitDate: addDays(TODAY, 5), reason: 'x' }), 201);
    const client = loadClient(h, staff);
    const overview = await client.pages.personnelPeople();
    assert.match(overview, /Anna/);
    for (const hidden of ['Hanna HR', 'HR, Hanna', 'Partner, Boris', 'Bearbeiter, Sach']) assert.equal(overview.includes(hidden), false, hidden);

    const sheet = await openSheet(client, 5);
    for (const action of ['data-personnel-edit-master', 'data-personnel-change', 'data-personnel-exit']) assert.ok(sheet.includes(action), action);
    assert.equal(sheet.includes('data-personnel-export'), false, 'Keine Datenauskunft');

    const leader = await openSheet(client, 4);
    assert.match(leader, /Die Leitung ändert die HR-Administration/);
    assert.equal(leader.includes('Leitung ändern'), false, 'Die Einheiten pflegt sie nicht');
    assert.match(leader, new RegExp('Technik'));
    assert.ok(department);

    const units = await client.pages.personnelUnits();
    for (const action of ['data-personnel-unit-new', 'data-personnel-unit-edit', 'data-personnel-unit-toggle', 'data-personnel-unit-delete']) {
      assert.equal(units.includes(action), false, action);
    }
    const mine = await client.pages.personnelMe();
    assert.match(mine, /Private Angaben/);
    assert.equal(mine.includes('Eigene Akte bearbeiten'), false);
    assert.equal(/Austritt und Auskunft/.test(mine), false);
  });

  test('alle Texte kommen ohne die Fachbegriffe aus, die Einsteiger nicht kennen', () => {
    const screenTexts = source.replace(/^\s*\/\/.*$/gm, '');
    for (const word of ['Stammdatenblatt', 'Organisationseinheit', 'Wirksamkeitsdatum', 'Stichtag', 'Historie', 'direkte Mitarbeitende', 'reaktivieren']) {
      assert.equal(screenTexts.includes(word), false, word);
    }
  });

  test('die Datenauskunft zeigt den Hinweis, öffnet die lesbare Fassung und protokolliert jeden Abruf', async t => {
    const { h } = await setup(t);
    await fillPrivate(h, 5);
    h.db.prepare('UPDATE personnel_records SET private_address=? WHERE user_id=5').run(`A${HOSTILE}`);
    const client = loadClient(h, 'hr');
    await openSheet(client, 5);
    const fileButton = {};
    client.elements.set('[data-personnel-export-file]', [fileButton]);
    await client.click('[data-personnel-export]');
    const modal = lastModal(client);
    assert.match(modal.body, /Daten anderer Personen/);
    assert.match(modal.body, /im Einzelfall prüfen/);
    assert.match(modal.body, /keine Rechtsberatung/, 'Der Hinweis erklärt sich selbst');
    assert.equal(/reviewBeforeRelease/.test(modal.body), false, 'Keine technischen Namen');
    assert.equal(auditEntries(h, 'personnel_data_exported').length, 0, 'Erst der Klick ruft ab');
    await modal.onSubmit({});
    assert.equal(client.window.loop.view, 'personnelExport');

    const page = await client.pages.personnelExport();
    assertCleanHtml(page, 'Lesbare Datenauskunft');
    assert.equal(auditEntries(h, 'personnel_data_exported').length, 1);
    assert.match(page, /Datenauskunft: Anna Ahrens/);
    assert.match(page, /Private Anschrift/);
    assert.match(page, /14\.03\.1990/, 'Datum auf Deutsch');
    assert.equal(/private_address|birth_date|personnel_records/.test(page), false, 'Keine technischen Namen');
    assert.match(page, /data-personnel-print/);
    assert.match(page, /keine Rechtsberatung/);
    assert.match(page, /personnel-no-print/);
  });

  test('die technische Datei gibt es weiterhin, sie wird heruntergeladen und protokolliert', async t => {
    const { h } = await setup(t);
    const client = loadClient(h, 'hr');
    await openSheet(client, 5);
    const fileButton = {};
    client.elements.clear();
    client.elements.set('[data-personnel-export]', [{ dataset: {} }]);
    const original = client.elements.get.bind(client.elements);
    // Der Dialog sucht den Knopf direkt nach dem Öffnen im Dokument.
    client.elements.get = selector => (selector === '[data-personnel-export-file]' ? [fileButton] : original(selector));
    client.definition.bind();
    await client.elements.get('[data-personnel-export]')[0].onclick();
    assert.match(lastModal(client).body, /data-personnel-export-file/);
    await fileButton.onclick();
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(auditEntries(h, 'personnel_data_exported').length, 1);
    assert.match(client.downloads[0], /^datenauskunft-5-\d{4}-\d{2}-\d{2}\.json$/);
    assert.equal(lastToast(client).type, 'success');
  });

  test('die lesbare Datenauskunft ohne Auswahl fragt nicht ab', async t => {
    const { h } = await setup(t);
    const page = await loadClient(h, 'hr').pages.personnelExport();
    assert.match(page, /Bitte wähle zuerst eine Person aus/);
    assert.equal(auditEntries(h, 'personnel_data_exported').length, 0);
  });

  test('Organisationseinheiten über die Oberfläche', async t => {
    const { h } = await setup(t);
    const client = loadClient(h, 'hr');
    await client.click('[data-personnel-unit-new]');
    let modal = lastModal(client);
    assert.match(modal.body, /name="type"/);
    assertCleanHtml(modal.body, 'Neue Einheit');
    await modal.onSubmit({ type: 'legal_entity', name: 'Muster GmbH', code: 'MG', parentId: '', leaderUserId: '' });
    await client.pages.personnelUnits();
    const company = h.db.prepare("SELECT id FROM personnel_org_units WHERE name='Muster GmbH'").get().id;

    await client.click('[data-personnel-unit-new]');
    await lastModal(client).onSubmit({ type: 'department', name: 'Technik', code: '', parentId: String(company), leaderUserId: '4' });
    const department = h.db.prepare("SELECT * FROM personnel_org_units WHERE name='Technik'").get();
    assert.equal(department.parent_id, company);
    assert.equal(department.leader_user_id, 4);

    const page = await client.pages.personnelUnits();
    assert.ok(page.indexOf('Muster GmbH') < page.indexOf('Technik'), 'Die übergeordnete Einheit steht zuerst');
    assert.match(page, /padding-left:18px/, 'Untereinheiten sind eingerückt');

    await client.click('[data-personnel-unit-edit]', { personnelUnitEdit: String(department.id) });
    modal = lastModal(client);
    assert.match(modal.body, /value="Technik"/);
    assert.equal(/name="type"/.test(modal.body), false, 'Der Typ bleibt fest');
    await modal.onSubmit({ name: 'Technik und Daten', code: 'TD', parentId: '', leaderUserId: '' });
    const edited = h.db.prepare('SELECT * FROM personnel_org_units WHERE id=?').get(department.id);
    assert.equal(edited.name, 'Technik und Daten');
    assert.equal(edited.parent_id, null);
    assert.equal(edited.leader_user_id, null);

    await client.pages.personnelUnits();
    await client.click('[data-personnel-unit-toggle]', { personnelUnitToggle: String(department.id) });
    assert.equal(h.db.prepare('SELECT active FROM personnel_org_units WHERE id=?').get(department.id).active, 0);
    await client.pages.personnelUnits();
    await client.click('[data-personnel-unit-toggle]', { personnelUnitToggle: String(department.id) });
    assert.equal(h.db.prepare('SELECT active FROM personnel_org_units WHERE id=?').get(department.id).active, 1);

    await client.pages.personnelUnits();
    await client.click('[data-personnel-unit-delete]', { personnelUnitDelete: String(department.id) });
    assert.equal(h.db.prepare('SELECT id FROM personnel_org_units WHERE id=?').get(department.id), undefined);
  });

  test('taskAction bedient genau die eigenen Aufgabentypen und führt zur Akte', async t => {
    const { h } = await setup(t);
    const client = loadClient(h, 'hr');
    assert.equal(client.definition.taskAction({ id: 7, type: 'goal_approval' }), '');
    for (const type of ['personnel_offboarding', 'personnel_deadline']) {
      const html = client.definition.taskAction({ id: 7, type });
      assert.match(html, /data-personnel-task-open="7"/);
      assert.match(html, /data-personnel-task-done="7"/);
    }

    await ok(contractChange(h, 5, { probationEnd: addDays(TODAY, 10) }, TODAY), 201);
    h.instance.maintenance();
    const [task] = tasksOfType(h, 'personnel_deadline');
    await client.click('[data-personnel-task-open]', { personnelTaskOpen: String(task.id) });
    assert.equal(client.window.loop.view, 'personnelPerson');
    assert.match(await client.pages.personnelPerson(), /Anna Ahrens/);
    await client.click('[data-personnel-task-done]', { personnelTaskDone: String(task.id) });
    assert.equal(openTasksOfType(h, 'personnel_deadline').length, 0);
  });

  test('Fehler aus Klicks erscheinen als Hinweis und reißen nichts ab', async t => {
    const { h } = await setup(t);
    const client = loadClient(h, 'hr');
    await client.click('[data-personnel-task-done]', { personnelTaskDone: '999' });
    assert.equal(lastToast(client).type, 'error');
    assert.match(lastToast(client).message, /nicht gefunden/);
  });
});

test('Die Datenauskunft verrät nicht, ob jemand an einer Befragung teilgenommen hat', async () => {
  const harness = await createModuleHarness(createPersonnelModule);
  try {
    harness.db.exec('CREATE TABLE surveys_participation (survey_id INTEGER, user_id INTEGER)');
    harness.db.prepare('INSERT INTO surveys_participation VALUES (1, 5)').run();
    harness.deps.createTask(5, 'Befragung ausfüllen', 'surveys_participate', 1);
    harness.deps.createTask(5, 'Andere Aufgabe', 'personnel_deadline', 1);
    const response = await harness.api('hr', 'GET', '/api/personnel/5/data-export');
    assert.equal(response.status, 200);
    const text = JSON.stringify(response.data);
    assert.equal(text.includes('surveys_participation'), false);
    assert.equal(text.includes('surveys_participate'), false);
    assert.equal(text.includes('Andere Aufgabe'), true);
    assert.match(text, /anonymen Befragungen/);
    assert.deepEqual(response.data.meta.reviewBeforeRelease, []);
    harness.db.exec('CREATE TABLE succession_candidates (id INTEGER PRIMARY KEY, user_id INTEGER, readiness TEXT)');
    harness.db.prepare("INSERT INTO succession_candidates(user_id,readiness) VALUES (5,'ready_now')").run();
    const marked = await harness.api('hr', 'GET', '/api/personnel/5/data-export');
    assert.deepEqual(marked.data.meta.reviewBeforeRelease, ['succession_candidates']);
  } finally {
    await harness.close();
  }
});
