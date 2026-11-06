const assert = require('node:assert/strict');
const { afterEach, beforeEach, test } = require('node:test');
const { createModuleHarness } = require('../lib/testing/module-harness');
const { moduleForPath, moduleForTaskType } = require('../lib/module-catalog');
const { createSuccessionModule } = require('../routes/succession');
const { createTalentReviewModule } = require('../routes/talentReview');

const SYSTEM_ID = 99;

let h;
let enabledModules;
let now;

/** Wie in der echten Laufzeit: Die Systemadministration ist ein technisches Konto mit Rolle super_admin. */
function withSystemAdmin(deps) {
  deps.db.prepare("INSERT INTO users(id,name,email,password_hash,role,is_system_account) VALUES(?,?,?,'!ENV_MANAGED!','hr_admin',1)")
    .run(SYSTEM_ID, 'Systemadministration', 'system-root@daybreak.internal');
  const current = req => {
    if (Number(req.get('x-test-user')) === SYSTEM_ID) {
      return { id: SYSTEM_ID, name: 'Systemadministration', email: 'root@root.de', role: 'super_admin', title: null, manager_id: null };
    }
    return deps.current(req);
  };
  const auth = (req, res, next) => (current(req) ? next() : res.status(401).json({ error: 'Nicht angemeldet' }));
  return { ...deps, current, auth };
}

async function startHarness({ talentReviewTables = true } = {}) {
  return createModuleHarness(deps => {
    if (talentReviewTables) createTalentReviewModule(deps).initialize();
    return createSuccessionModule(withSystemAdmin(deps));
  }, {
    isModuleEnabled: key => enabledModules.has(key),
    extra: { clock: () => now }
  });
}

beforeEach(async () => {
  enabledModules = new Set(['talent', 'talent_review', 'succession']);
  now = new Date('2030-03-15T10:00:00Z');
  h = await startHarness();
});
afterEach(() => h.close());

function expectStatus(response, status) {
  assert.equal(response.status, status, JSON.stringify(response.data));
  return response.data;
}

async function createPlan(overrides = {}, actor = 'hr') {
  const body = { roleName: 'Leitung Technik', holderId: h.people.manager.id, criticality: 'high', risk: 'medium', riskReason: 'Viel Wissen bei einer Person', ...overrides };
  return expectStatus(await h.api(actor, 'POST', '/api/succession/plans', body), 201).plan;
}

async function addCandidate(planId, person, overrides = {}, actor = 'hr') {
  const body = { userId: h.people[person]?.id ?? person, readiness: 'ready_1_2_years', ...overrides };
  return expectStatus(await h.api(actor, 'POST', `/api/succession/plans/${planId}/candidates`, body), 201).candidate;
}

const getPlan = async (planId, actor = 'hr') => expectStatus(await h.api(actor, 'GET', `/api/succession/plans/${planId}`), 200);

function candidateOf(detail, name) {
  return detail.candidates.find(candidate => candidate.name === name);
}

function addPerson(id, managerId, role = 'employee') {
  h.db.prepare("INSERT INTO users(id,name,email,password_hash,role,manager_id) VALUES(?,?,?,'!TEST!',?,?)")
    .run(id, `Person ${id}`, `person${id}@test.local`, role, managerId);
}

/** Sammelt alle Schlüssel einer Antwort, auch verschachtelte. */
function allKeys(value, found = new Set()) {
  if (Array.isArray(value)) value.forEach(item => allKeys(item, found));
  else if (value && typeof value === 'object') {
    for (const [key, inner] of Object.entries(value)) {
      found.add(key);
      allKeys(inner, found);
    }
  }
  return found;
}

const openReviewTasks = () => h.db.prepare("SELECT * FROM tasks WHERE type='succession_review' AND done=0 ORDER BY id").all();

// ------------------------------------------------------------------------------------------
// Grenzen
// ------------------------------------------------------------------------------------------

test('Ohne Anmeldung gibt es überall 401', async () => {
  const routes = [
    ['GET', '/api/succession/options'],
    ['GET', '/api/succession/plans'],
    ['POST', '/api/succession/plans'],
    ['GET', '/api/succession/plans/1'],
    ['PATCH', '/api/succession/plans/1'],
    ['POST', '/api/succession/plans/1/reviewed'],
    ['POST', '/api/succession/plans/1/candidates'],
    ['PATCH', '/api/succession/candidates/1'],
    ['GET', '/api/succession/metrics']
  ];
  for (const [method, url] of routes) {
    assert.equal((await h.api(null, method, url, method === 'GET' ? undefined : {})).status, 401, `${method} ${url}`);
  }
});

test('Pfade und Aufgaben gehören zum Modul, damit der Modulschalter greift', () => {
  assert.equal(moduleForPath('/succession/plans/1'), 'succession');
  assert.equal(moduleForTaskType('succession_review'), 'succession');
  assert.equal(moduleForTaskType('succession_candidate_proposal'), 'succession');
});

test('Führungskräfte und Beschäftigte sehen nichts, auch nicht, ob sie selbst Kandidat sind', async () => {
  const plan = await createPlan({ holderId: h.people.manager.id });
  const candidate = await addCandidate(plan.id, 'anna');
  await addCandidate(plan.id, 'ben');

  const requests = [
    ['GET', '/api/succession/options'],
    ['GET', '/api/succession/plans'],
    ['GET', `/api/succession/plans/${plan.id}`],
    ['GET', '/api/succession/plans/9999'],
    ['GET', '/api/succession/metrics'],
    ['POST', '/api/succession/plans', { roleName: 'X', criticality: 'high', risk: 'high', riskReason: 'X' }],
    ['PATCH', `/api/succession/plans/${plan.id}`, { riskReason: 'X' }],
    ['POST', `/api/succession/plans/${plan.id}/reviewed`, {}],
    ['POST', `/api/succession/plans/${plan.id}/candidates`, { userId: 6, readiness: 'ready_now' }],
    ['PATCH', `/api/succession/candidates/${candidate.id}`, { readiness: 'ready_now' }]
  ];
  for (const person of ['manager', 'anna', 'ben', 'clara']) {
    for (const [method, url, body] of requests) {
      const response = await h.api(person, method, url, body);
      assert.equal(response.status, 403, `${person} ${method} ${url}`);
      const text = JSON.stringify(response.data);
      assert.equal(text.includes('Leitung Technik'), false);
      assert.equal(text.toLowerCase().includes('kandidat '), false);
    }
  }

  // Es gibt auch keine Mitteilung an Kandidaten oder die Stelleninhaberin.
  h.instance.maintenance();
  for (const person of ['manager', 'anna', 'ben']) {
    assert.equal(h.db.prepare('SELECT COUNT(*) count FROM tasks WHERE user_id=?').get(h.people[person].id).count, 0, person);
  }
});

test('HR-Rollen und Systemadministration pflegen Pläne', async () => {
  const forBp = await createPlan({}, 'bp');
  assert.equal(forBp.title, 'Leitung Technik');
  assert.equal(forBp.canEdit, true);
  const forSystem = await createPlan({ roleName: 'Leitung Support' }, SYSTEM_ID);
  assert.equal(forSystem.canEdit, true);

  await addCandidate(forBp.id, 'anna', {}, 'bp');
  await addCandidate(forSystem.id, 'anna', {}, SYSTEM_ID);
  assert.equal(expectStatus(await h.api(SYSTEM_ID, 'GET', '/api/succession/plans'), 200).plans.length, 2);
  expectStatus(await h.api('bp', 'PATCH', `/api/succession/plans/${forBp.id}`, { risk: 'low' }), 200);
  expectStatus(await h.api('bp', 'POST', `/api/succession/plans/${forBp.id}/reviewed`), 200);
  assert.ok(expectStatus(await h.api(SYSTEM_ID, 'GET', '/api/succession/metrics'), 200).plans.length);
});

test('Bereichsleitung sieht nur Pläne aus der eigenen Führungslinie', async () => {
  const ownLineDirect = await createPlan({ roleName: 'Plan direkt', holderId: h.people.manager.id });
  const ownLineDeep = await createPlan({ roleName: 'Plan tiefer', holderId: h.people.anna.id });
  const foreign = await createPlan({ roleName: 'Plan HR', holderId: h.people.bp.id });
  const vacant = await createPlan({ roleName: 'Plan unbesetzt', holderId: null });

  const list = expectStatus(await h.api('director', 'GET', '/api/succession/plans'), 200).plans;
  assert.deepEqual(list.map(plan => plan.title), ['Plan direkt', 'Plan tiefer']);

  await getPlan(ownLineDirect.id, 'director');
  await getPlan(ownLineDeep.id, 'director');
  for (const id of [foreign.id, vacant.id, 9999]) {
    const response = await h.api('director', 'GET', `/api/succession/plans/${id}`);
    assert.equal(response.status, 403, String(id));
    // Ein unbekannter und ein fremder Plan sind für die Bereichsleitung nicht zu unterscheiden.
    assert.equal(response.data.error, 'Diesen Plan darfst du nicht sehen.');
  }
  assert.equal(expectStatus(await h.api('director', 'GET', '/api/succession/metrics'), 200).plans.length, 2);
  assert.equal(expectStatus(await h.api('hr', 'GET', '/api/succession/metrics'), 200).plans.length, 4);
  assert.equal(JSON.stringify(expectStatus(await h.api('director', 'GET', '/api/succession/metrics'), 200)).includes('Plan HR'), false);

  // Archivierte Pläne sieht die Bereichsleitung nicht mehr.
  expectStatus(await h.api('hr', 'PATCH', `/api/succession/plans/${ownLineDeep.id}`, { status: 'archived' }), 200);
  assert.equal((await h.api('director', 'GET', `/api/succession/plans/${ownLineDeep.id}`)).status, 403);
  assert.equal(expectStatus(await h.api('director', 'GET', '/api/succession/plans?status=all'), 200).plans.length, 1);
});

test('Niemand sieht einen Plan, in dem er selbst Stelleninhaber oder Kandidat ist', async () => {
  const asHolder = await createPlan({ roleName: 'Eigene Stelle', holderId: h.people.director.id });
  const asCandidate = await createPlan({ roleName: 'Eigene Kandidatur', holderId: h.people.manager.id });
  await addCandidate(asCandidate.id, 'director');
  const removed = await createPlan({ roleName: 'Früher Kandidat', holderId: h.people.anna.id });
  const removedCandidate = await addCandidate(removed.id, 'director');
  expectStatus(await h.api('hr', 'PATCH', `/api/succession/candidates/${removedCandidate.id}`, { status: 'removed' }), 200);
  const visible = await createPlan({ roleName: 'Sichtbar', holderId: h.people.clara.id });

  const list = expectStatus(await h.api('director', 'GET', '/api/succession/plans'), 200).plans;
  assert.deepEqual(list.map(plan => plan.title), ['Sichtbar']);
  for (const plan of [asHolder, asCandidate, removed]) {
    assert.equal((await h.api('director', 'GET', `/api/succession/plans/${plan.id}`)).status, 403, plan.title);
    assert.equal((await h.api('director', 'POST', `/api/succession/plans/${plan.id}/candidates`, { userId: 7, readiness: 'ready_now' })).status, 403, plan.title);
  }
  const metrics = expectStatus(await h.api('director', 'GET', '/api/succession/metrics'), 200);
  assert.deepEqual(metrics.plans.map(plan => plan.planId), [visible.id]);
});

test('Auch HR-Personen sehen und ändern keinen Plan, von dem sie selbst betroffen sind', async () => {
  // Stelleninhaberin ist die HR-Administration: Den Plan pflegt der HR Business Partner.
  const asHolder = await createPlan({ roleName: 'HR-Leitung', holderId: h.people.hr.id, riskReason: 'Geheime Einschätzung zur Leitung' }, 'bp');
  const asHolderCandidate = await addCandidate(asHolder.id, 'anna', { strengths: 'Geheime Stärke' }, 'bp');

  const hidden = [
    ['GET', `/api/succession/plans/${asHolder.id}`],
    ['PATCH', `/api/succession/plans/${asHolder.id}`, { riskReason: 'Geändert' }],
    ['PATCH', `/api/succession/plans/${asHolder.id}`, { holderId: h.people.anna.id }],
    ['PATCH', `/api/succession/plans/${asHolder.id}`, { status: 'archived' }],
    ['POST', `/api/succession/plans/${asHolder.id}/reviewed`, {}],
    ['POST', `/api/succession/plans/${asHolder.id}/candidates`, { userId: h.people.ben.id, readiness: 'ready_now' }],
    ['PATCH', `/api/succession/candidates/${asHolderCandidate.id}`, { readiness: 'ready_now' }],
    ['PATCH', `/api/succession/candidates/${asHolderCandidate.id}`, { status: 'removed' }]
  ];
  // Die Antwort gleicht der für einen unbekannten Plan: Sie verrät nicht, dass es einen gibt.
  const unknown = await h.api('hr', 'GET', '/api/succession/plans/9999');
  for (const [method, url, body] of hidden) {
    const response = await h.api('hr', method, url, body);
    assert.equal(response.status, 404, `${method} ${url}`);
    assert.equal(response.data.error, unknown.data.error, `${method} ${url}`);
  }
  assert.equal(h.db.prepare('SELECT readiness FROM succession_candidates WHERE id=?').get(asHolderCandidate.id).readiness, 'ready_1_2_years');
  assert.equal((await getPlan(asHolder.id, 'bp')).plan.riskReason, 'Geheime Einschätzung zur Leitung');

  // HR Business Partner als Kandidat: Er liest die eigene Einstufung nicht, die andere HR-Person arbeitet weiter.
  const asCandidate = await createPlan({ roleName: 'Personalbetreuung', holderId: h.people.clara.id });
  const bpCandidate = await addCandidate(asCandidate.id, 'bp', { strengths: 'Geheime Stärke', note: 'Geheime Notiz' });
  const forCandidate = await h.api('bp', 'GET', `/api/succession/plans/${asCandidate.id}`);
  assert.equal(forCandidate.status, 404);
  assert.equal(JSON.stringify(forCandidate.data).includes('Geheim'), false);
  assert.equal((await h.api('bp', 'PATCH', `/api/succession/candidates/${bpCandidate.id}`, { readiness: 'ready_now' })).status, 404);
  assert.equal((await h.api('bp', 'PATCH', `/api/succession/plans/${asCandidate.id}`, { risk: 'low' })).status, 404);
  assert.equal(expectStatus(await h.api('bp', 'GET', '/api/succession/plans?status=all'), 200).plans.some(plan => plan.id === asCandidate.id), false);
  const partnerMetrics = expectStatus(await h.api('bp', 'GET', '/api/succession/metrics'), 200);
  assert.equal(partnerMetrics.plans.some(plan => plan.planId === asCandidate.id), false);
  assert.equal(JSON.stringify(partnerMetrics).includes('Personalbetreuung'), false);
  expectStatus(await h.api('hr', 'PATCH', `/api/succession/candidates/${bpCandidate.id}`, { readiness: 'ready_now' }), 200);

  // Auch nach dem Entfernen bleibt die Person betroffen.
  expectStatus(await h.api('hr', 'PATCH', `/api/succession/candidates/${bpCandidate.id}`, { status: 'removed' }), 200);
  assert.equal((await h.api('bp', 'GET', `/api/succession/plans/${asCandidate.id}`)).status, 404);
  assert.equal((await h.api('bp', 'PATCH', `/api/succession/plans/${asCandidate.id}`, { risk: 'low' })).status, 404);

  // In den Listen fehlen die Pläne, an denen jemand selbst hängt. Andere sehen sie.
  const forAdmin = expectStatus(await h.api('hr', 'GET', '/api/succession/plans'), 200).plans;
  assert.deepEqual(forAdmin.map(plan => plan.id), [asCandidate.id]);
  assert.equal(forAdmin[0].canEdit, true);
  assert.equal('selfAffected' in forAdmin[0], false);
  assert.equal((await getPlan(asHolder.id, SYSTEM_ID)).plan.canEdit, true);
});

test('Zu Personen außerhalb der Führungslinie gibt es nur Name und Bereitschaft', async () => {
  const plan = await createPlan({ holderId: h.people.manager.id });
  const secrets = { strengths: 'Geheime Stärke', gaps: 'Geheime Lücke', developmentActions: 'Geheime Maßnahme', note: 'Geheime Notiz' };
  const outside = await addCandidate(plan.id, 'bp', { readiness: 'ready_now', ...secrets });
  await addCandidate(plan.id, 'anna', { readiness: 'ready_1_2_years', strengths: 'Sichtbare Stärke' });

  const detail = await getPlan(plan.id, 'director');
  const partner = candidateOf(detail, 'Boris Partner');
  assert.deepEqual(Object.keys(partner).sort(), ['currentPosition', 'limited', 'name', 'readiness', 'readinessLabel', 'status', 'statusLabel', 'targetProfile']);
  assert.equal(partner.readinessLabel, 'Sofort bereit');
  assert.equal(partner.limited, true);
  assert.equal(JSON.stringify(partner).includes('Geheim'), false);
  assert.equal(JSON.stringify(detail).includes('Geheim'), false);
  // In der eigenen Linie bleibt alles sichtbar.
  const anna = candidateOf(detail, 'Anna Ahrens');
  assert.equal(anna.limited, false);
  assert.equal(anna.strengths, 'Sichtbare Stärke');
  assert.equal(anna.history.length, 1);

  // HR sieht alles.
  assert.equal(candidateOf(await getPlan(plan.id), 'Boris Partner').note, 'Geheime Notiz');

  // Wer außerhalb der Linie vom Plan genommen wurde, erscheint dort gar nicht.
  expectStatus(await h.api('hr', 'PATCH', `/api/succession/candidates/${outside.id}`, { status: 'removed' }), 200);
  assert.equal(candidateOf(await getPlan(plan.id, 'director'), 'Boris Partner'), undefined);
  assert.equal(candidateOf(await getPlan(plan.id), 'Boris Partner').status, 'removed');
});

test('Der HR Business Partner beurteilt die HR-Leitung nicht', async () => {
  const plan = await createPlan({ holderId: h.people.manager.id });
  const lead = await addCandidate(plan.id, 'hr', { note: 'Geheime Notiz' }, SYSTEM_ID);

  const detail = await getPlan(plan.id, 'bp');
  assert.equal(JSON.stringify(detail).includes('Geheim'), false);
  assert.equal(candidateOf(detail, 'Hanna HR').limited, true);
  assert.equal('nineBox' in candidateOf(detail, 'Hanna HR'), false);
  assert.equal((await h.api('bp', 'PATCH', `/api/succession/candidates/${lead.id}`, { note: 'Geändert' })).status, 403);

  const other = await createPlan({ roleName: 'Andere Stelle', holderId: h.people.clara.id }, 'bp');
  assert.equal((await h.api('bp', 'POST', `/api/succession/plans/${other.id}/candidates`, { userId: h.people.hr.id, readiness: 'ready_now' })).status, 403);

  // Für die Stelle der HR-Leitung bleibt die Auswahl offen, als mögliche Nachfolge steht sie nicht zur Wahl.
  const options = expectStatus(await h.api('bp', 'GET', '/api/succession/options'), 200);
  assert.equal(options.people.some(person => person.name === 'Hanna HR'), true);
  assert.equal(options.candidates.some(person => person.name === 'Hanna HR'), false);
  assert.equal('role' in options.people[0], false);
  assert.equal(expectStatus(await h.api('hr', 'GET', '/api/succession/options'), 200).candidates.some(person => person.name === 'Boris Partner'), true);
  assert.deepEqual(expectStatus(await h.api('director', 'GET', '/api/succession/options'), 200).candidates.map(person => person.name), ['Anna Ahrens', 'Ben Berg', 'Clara Cordes', 'Malte Manager']);
});

test('Die HR-Sachbearbeitung kommt nicht an die Nachfolgeplanung', async () => {
  const plan = await createPlan();
  const { id: staff } = h.deps.createUserAccount({ name: 'Sach Bearbeiter', email: 'sb@test.local', role: 'hr_staff', actor: { id: 1 } });
  h.db.prepare('UPDATE users SET must_change_password=0 WHERE id=?').run(staff);
  for (const url of ['/api/succession/options', '/api/succession/plans', `/api/succession/plans/${plan.id}`, '/api/succession/metrics']) {
    assert.equal((await h.api(staff, 'GET', url)).status, 403, url);
  }
});

test('Niemand macht sich selbst zum Betroffenen', async () => {
  const selfHolder = await h.api('hr', 'POST', '/api/succession/plans', { roleName: 'X', holderId: h.people.hr.id, criticality: 'high', risk: 'high', riskReason: 'X' });
  assert.equal(selfHolder.status, 403);
  const plan = await createPlan();
  assert.equal((await h.api('hr', 'PATCH', `/api/succession/plans/${plan.id}`, { holderId: h.people.hr.id })).status, 403);
  assert.equal((await h.api('hr', 'POST', `/api/succession/plans/${plan.id}/candidates`, { userId: h.people.hr.id, readiness: 'ready_now' })).status, 403);
  assert.equal((await h.api('director', 'POST', `/api/succession/plans/${plan.id}/candidates`, { userId: h.people.director.id, readiness: 'ready_now' })).status, 403);
  assert.equal((await getPlan(plan.id)).candidates.length, 0);
});

test('Bereichsleitung schlägt vor, HR entscheidet', async () => {
  const plan = await createPlan({ holderId: h.people.manager.id });
  const foreign = await createPlan({ roleName: 'Fremd', holderId: h.people.bp.id });

  // Nur eigene Führungslinie, keine Inhaberin, nur sichtbare Pläne.
  assert.equal((await h.api('director', 'POST', `/api/succession/plans/${plan.id}/candidates`, { userId: h.people.bp.id, readiness: 'ready_now' })).status, 403);
  assert.equal((await h.api('director', 'POST', `/api/succession/plans/${plan.id}/candidates`, { userId: h.people.manager.id, readiness: 'ready_now' })).status, 400);
  assert.equal((await h.api('director', 'POST', `/api/succession/plans/${foreign.id}/candidates`, { userId: h.people.anna.id, readiness: 'ready_now' })).status, 403);
  assert.equal((await h.api('director', 'POST', '/api/succession/plans/9999/candidates', { userId: h.people.anna.id, readiness: 'ready_now' })).status, 403);

  const proposed = await addCandidate(plan.id, 'anna', { readiness: 'ready_now', strengths: 'Viel Erfahrung' }, 'director');
  assert.equal(proposed.status, 'proposed');
  assert.equal(proposed.statusLabel, 'Vorgeschlagen');

  // Ein Vorschlag zählt noch nicht, HR bekommt eine Aufgabe ohne Namen.
  const detail = await getPlan(plan.id);
  assert.deepEqual(detail.plan.bench, { ready_now: 0, ready_1_2_years: 0, ready_3_plus_years: 0, proposed: 1 });
  const task = h.db.prepare("SELECT * FROM tasks WHERE type='succession_candidate_proposal' AND done=0").get();
  assert.equal(task.user_id, h.people.hr.id);
  assert.equal(task.entity_id, plan.id);
  assert.equal(task.title.includes('Anna'), false);

  // Die Bereichsleitung ändert nichts weiter.
  const denied = [
    ['PATCH', `/api/succession/candidates/${proposed.id}`, { status: 'confirmed' }],
    ['PATCH', `/api/succession/plans/${plan.id}`, { risk: 'low' }],
    ['POST', `/api/succession/plans/${plan.id}/reviewed`, {}],
    ['POST', '/api/succession/plans', { roleName: 'X', criticality: 'high', risk: 'high', riskReason: 'X' }]
  ];
  for (const [method, url, body] of denied) {
    assert.equal((await h.api('director', method, url, body)).status, 403, `${method} ${url}`);
  }

  expectStatus(await h.api('hr', 'PATCH', `/api/succession/candidates/${proposed.id}`, { status: 'confirmed' }), 200);
  assert.equal((await getPlan(plan.id)).plan.bench.ready_now, 1);
  assert.equal(h.db.prepare("SELECT COUNT(*) count FROM tasks WHERE type='succession_candidate_proposal' AND done=0").get().count, 0);
});

test('Auswahl: Bereichsleitung bekommt nur die eigene Führungslinie', async () => {
  const forDirector = expectStatus(await h.api('director', 'GET', '/api/succession/options'), 200);
  assert.deepEqual(forDirector.people.map(person => person.name), ['Anna Ahrens', 'Ben Berg', 'Clara Cordes', 'Malte Manager']);
  assert.deepEqual(forDirector.profiles, []);
  assert.equal(forDirector.readiness.ready_now, 'Sofort bereit');

  const forHr = expectStatus(await h.api('hr', 'GET', '/api/succession/options'), 200);
  assert.equal(forHr.people.some(person => person.name === 'Hanna HR'), false);
  assert.equal(forHr.people.some(person => person.name === 'Systemadministration'), false);
  assert.equal(forHr.people.length, 6);
});

// ------------------------------------------------------------------------------------------
// Eingaben
// ------------------------------------------------------------------------------------------

test('Pläne: Eingaben werden geprüft', async () => {
  const valid = { roleName: 'Rolle', holderId: h.people.manager.id, criticality: 'high', risk: 'low', riskReason: 'Weil' };
  const invalid = [
    {},
    { ...valid, roleName: '' },
    { ...valid, roleName: undefined },
    { ...valid, positionProfileId: 9999 },
    { ...valid, positionProfileId: 'abc' },
    { ...valid, holderId: 9999 },
    { ...valid, holderId: 'abc' },
    { ...valid, holderId: SYSTEM_ID },
    { ...valid, criticality: 'kritisch' },
    { ...valid, criticality: undefined },
    { ...valid, risk: 'egal' },
    { ...valid, riskReason: '' },
    { ...valid, riskReason: undefined },
    { ...valid, plannedDeparture: '2030-02-31' },
    { ...valid, plannedDeparture: 'bald' },
    { ...valid, status: 'gelöscht' },
    { ...valid, status: ['active'] },
    { ...valid, criticality: ['high'] },
    { ...valid, plannedDeparture: ['2099-01-01'] }
  ];
  for (const body of invalid) {
    assert.equal((await h.api('hr', 'POST', '/api/succession/plans', body)).status, 400, JSON.stringify(body));
  }
  h.db.prepare('UPDATE users SET active=0 WHERE id=7').run();
  assert.equal((await h.api('hr', 'POST', '/api/succession/plans', { ...valid, holderId: 7 })).status, 400);
  assert.equal((await h.api('hr', 'POST', '/api/succession/plans')).status, 400);

  const plan = await createPlan({ plannedDeparture: '2099-06-30' });
  assert.equal(plan.plannedDeparture, '2099-06-30');
  assert.equal(plan.criticalityLabel, 'Hoch');
  assert.equal(plan.riskLabel, 'Mittel');

  assert.equal((await h.api('hr', 'GET', '/api/succession/plans/9999')).status, 404);
  assert.equal((await h.api('hr', 'GET', '/api/succession/plans/abc')).status, 404);
  assert.equal((await h.api('hr', 'PATCH', '/api/succession/plans/9999', {})).status, 404);
  assert.equal((await h.api('hr', 'POST', '/api/succession/plans/9999/reviewed')).status, 404);
  assert.equal((await h.api('hr', 'POST', '/api/succession/plans/9999/candidates', {})).status, 404);
  assert.equal((await h.api('hr', 'PATCH', '/api/succession/candidates/9999', {})).status, 404);
});

test('Pläne: Positionsprofil oder frei benannte Rolle, unbesetzte Stelle ist möglich', async () => {
  const profile = h.db.prepare("INSERT INTO position_profiles(title,title_normalized) VALUES('Abteilungsleitung','abteilungsleitung')").run().lastInsertRowid;
  const withProfile = await createPlan({ positionProfileId: profile, roleName: undefined });
  assert.equal(withProfile.title, 'Abteilungsleitung');
  assert.equal(withProfile.positionProfileId, profile);

  const vacant = await createPlan({ holderId: null, roleName: 'Unbesetzt' });
  assert.equal(vacant.holder, null);

  // Wechsel von Profil zu Rolle.
  const changed = expectStatus(await h.api('hr', 'PATCH', `/api/succession/plans/${withProfile.id}`, { positionProfileId: '', roleName: 'Neue Rolle' }), 200).plan;
  assert.equal(changed.title, 'Neue Rolle');
  assert.equal(changed.positionProfileId, null);
  // Beides leer geht nicht.
  assert.equal((await h.api('hr', 'PATCH', `/api/succession/plans/${withProfile.id}`, { positionProfileId: '', roleName: '' })).status, 400);
  // Inaktive Profile lassen sich nicht neu wählen, ein schon zugeordnetes bleibt aber beim Speichern erhalten.
  const keeping = await createPlan({ positionProfileId: profile, roleName: undefined });
  h.db.prepare('UPDATE position_profiles SET active=0 WHERE id=?').run(profile);
  assert.equal((await h.api('hr', 'POST', '/api/succession/plans', { positionProfileId: profile, criticality: 'high', risk: 'high', riskReason: 'X' })).status, 400);
  const kept = expectStatus(await h.api('hr', 'PATCH', `/api/succession/plans/${keeping.id}`, { positionProfileId: String(profile), roleName: '', risk: 'low' }), 200).plan;
  assert.equal(kept.positionProfileId, profile);
  assert.equal(kept.riskLabel, 'Niedrig');
});

test('Kandidaten: je Plan einmal, nicht die Stelleninhaberin, nur mit Bereitschaft', async () => {
  const plan = await createPlan({ holderId: h.people.manager.id });
  const invalid = [
    [{ readiness: 'ready_now' }, 400],
    [{ userId: 'abc', readiness: 'ready_now' }, 400],
    [{ userId: 9999, readiness: 'ready_now' }, 400],
    [{ userId: SYSTEM_ID, readiness: 'ready_now' }, 400],
    [{ userId: h.people.anna.id }, 400],
    [{ userId: h.people.anna.id, readiness: 'irgendwann' }, 400],
    [{ userId: h.people.anna.id, readiness: '__proto__' }, 400],
    [{ userId: h.people.anna.id, readiness: ['ready_now'] }, 400]
  ];
  for (const [body, status] of invalid) {
    assert.equal((await h.api('hr', 'POST', `/api/succession/plans/${plan.id}/candidates`, body)).status, status, JSON.stringify(body));
  }

  // Die Inhaberin selbst nicht.
  const holder = await h.api('hr', 'POST', `/api/succession/plans/${plan.id}/candidates`, { userId: h.people.manager.id, readiness: 'ready_now' });
  assert.equal(holder.status, 400);
  assert.match(holder.data.error, /eigene Nachfolge/);

  const anna = await addCandidate(plan.id, 'anna', { readiness: 'ready_3_plus_years' });
  assert.equal(anna.readinessLabel, 'In 3 oder mehr Jahren bereit');
  assert.equal(anna.status, 'confirmed');

  // Doppelt nicht, auch nicht nach dem Entfernen.
  assert.equal((await h.api('hr', 'POST', `/api/succession/plans/${plan.id}/candidates`, { userId: h.people.anna.id, readiness: 'ready_now' })).status, 409);
  expectStatus(await h.api('hr', 'PATCH', `/api/succession/candidates/${anna.id}`, { status: 'removed' }), 200);
  assert.equal((await h.api('hr', 'POST', `/api/succession/plans/${plan.id}/candidates`, { userId: h.people.anna.id, readiness: 'ready_now' })).status, 409);
  assert.equal(h.db.prepare('SELECT COUNT(*) count FROM succession_candidates WHERE plan_id=?').get(plan.id).count, 1);
  assert.equal(expectStatus(await h.api('hr', 'PATCH', `/api/succession/candidates/${anna.id}`, { status: 'confirmed' }), 200).candidate.status, 'confirmed');

  // Ungültige Änderungen.
  assert.equal((await h.api('hr', 'PATCH', `/api/succession/candidates/${anna.id}`, { readiness: 'bald' })).status, 400);
  assert.equal((await h.api('hr', 'PATCH', `/api/succession/candidates/${anna.id}`, { status: 'befördert' })).status, 400);
  assert.equal((await h.api('hr', 'PATCH', `/api/succession/candidates/${anna.id}`, { status: ['confirmed'] })).status, 400);
  assert.equal((await h.api('hr', 'PATCH', `/api/succession/candidates/${anna.id}`, { readiness: ['ready_now'] })).status, 400);

  // Texte werden gespeichert und gefiltert.
  const edited = expectStatus(await h.api('hr', 'PATCH', `/api/succession/candidates/${anna.id}`, {
    strengths: 'Führt <b>gut</b>', gaps: 'Budget', developmentActions: 'Projekt leiten', note: 'Notiz'
  }), 200).candidate;
  assert.equal(edited.strengths, 'Führt bgut/b');
  assert.equal(edited.gaps, 'Budget');
  assert.equal(edited.developmentActions, 'Projekt leiten');
  assert.equal(edited.note, 'Notiz');
});

test('Wer Kandidat ist, wird nicht Stelleninhaberin, und umgekehrt', async () => {
  const plan = await createPlan({ holderId: h.people.manager.id });
  const anna = await addCandidate(plan.id, 'anna');

  const blocked = await h.api('hr', 'PATCH', `/api/succession/plans/${plan.id}`, { holderId: h.people.anna.id });
  assert.equal(blocked.status, 400);
  assert.match(blocked.data.error, /mögliche Nachfolge/);

  // Der übliche Weg: erst entfernen, dann die Stelle übergeben.
  expectStatus(await h.api('hr', 'PATCH', `/api/succession/candidates/${anna.id}`, { status: 'removed' }), 200);
  assert.equal(expectStatus(await h.api('hr', 'PATCH', `/api/succession/plans/${plan.id}`, { holderId: h.people.anna.id }), 200).plan.holder.name, 'Anna Ahrens');

  // Die neue Inhaberin lässt sich nicht wieder als Kandidatin aufnehmen.
  assert.equal((await h.api('hr', 'PATCH', `/api/succession/candidates/${anna.id}`, { status: 'confirmed' })).status, 400);
});

test('Archivierte Pläne sind nur lesbar, bis sie zurückgeholt werden', async () => {
  const plan = await createPlan();
  const anna = await addCandidate(plan.id, 'anna');
  h.instance.maintenance();
  assert.equal(openReviewTasks().length, 1);

  assert.equal(expectStatus(await h.api('hr', 'PATCH', `/api/succession/plans/${plan.id}`, { status: 'archived' }), 200).plan.statusLabel, 'Archiviert');
  assert.equal(openReviewTasks().length, 0);

  assert.equal((await h.api('hr', 'POST', `/api/succession/plans/${plan.id}/candidates`, { userId: 6, readiness: 'ready_now' })).status, 409);
  assert.equal((await h.api('hr', 'PATCH', `/api/succession/candidates/${anna.id}`, { readiness: 'ready_now' })).status, 409);
  assert.equal((await h.api('hr', 'POST', `/api/succession/plans/${plan.id}/reviewed`)).status, 409);

  assert.equal(expectStatus(await h.api('hr', 'GET', '/api/succession/plans'), 200).plans.length, 0);
  assert.equal(expectStatus(await h.api('hr', 'GET', '/api/succession/plans?status=archived'), 200).plans.length, 1);
  assert.equal(expectStatus(await h.api('hr', 'GET', '/api/succession/plans?status=all'), 200).plans.length, 1);
  assert.equal(expectStatus(await h.api('hr', 'GET', '/api/succession/plans?status=quatsch'), 200).plans.length, 0);
  await getPlan(plan.id);

  expectStatus(await h.api('hr', 'PATCH', `/api/succession/plans/${plan.id}`, { status: 'active' }), 200);
  expectStatus(await h.api('hr', 'PATCH', `/api/succession/candidates/${anna.id}`, { readiness: 'ready_now' }), 200);
});

// ------------------------------------------------------------------------------------------
// Mehrfach-Nominierung und Historie
// ------------------------------------------------------------------------------------------

test('Mehrfach-Nominierungen werden sichtbar, aber nur innerhalb der sichtbaren Pläne', async () => {
  const first = await createPlan({ roleName: 'Plan A', holderId: h.people.manager.id });
  const second = await createPlan({ roleName: 'Plan B', holderId: h.people.clara.id });
  const third = await createPlan({ roleName: 'Plan C', holderId: h.people.bp.id });
  await addCandidate(first.id, 'anna');
  assert.equal(candidateOf(await getPlan(first.id), 'Anna Ahrens').nominationCount, 1);
  assert.equal(candidateOf(await getPlan(first.id), 'Anna Ahrens').nominationText, null);

  await addCandidate(second.id, 'anna');
  const thirdAnna = await addCandidate(third.id, 'anna');
  const forHr = candidateOf(await getPlan(first.id), 'Anna Ahrens');
  assert.equal(forHr.nominationCount, 3);
  assert.equal(forHr.nominationText, 'für 3 Pläne vorgesehen');

  // Der dritte Plan liegt außerhalb der Führungslinie und darf nicht mitzählen.
  const forDirector = candidateOf(await getPlan(first.id, 'director'), 'Anna Ahrens');
  assert.equal(forDirector.nominationCount, 2);
  assert.equal(forDirector.nominationText, 'für 2 Pläne vorgesehen');

  expectStatus(await h.api('hr', 'PATCH', `/api/succession/candidates/${thirdAnna.id}`, { status: 'removed' }), 200);
  assert.equal(candidateOf(await getPlan(first.id), 'Anna Ahrens').nominationCount, 2);
  expectStatus(await h.api('hr', 'PATCH', `/api/succession/plans/${second.id}`, { status: 'archived' }), 200);
  assert.equal(candidateOf(await getPlan(first.id), 'Anna Ahrens').nominationText, null);
});

test('Historie: Bereitschaft wird bei jeder Änderung festgehalten', async () => {
  const plan = await createPlan();
  const anna = await addCandidate(plan.id, 'anna', { readiness: 'ready_3_plus_years' });
  assert.equal(anna.history.length, 1);
  assert.equal(anna.history[0].oldReadiness, null);
  assert.equal(anna.history[0].newReadiness, 'ready_3_plus_years');

  // Keine Änderung der Bereitschaft: kein neuer Eintrag.
  expectStatus(await h.api('hr', 'PATCH', `/api/succession/candidates/${anna.id}`, { note: 'Nur eine Notiz', readiness: 'ready_3_plus_years' }), 200);
  assert.equal(h.db.prepare('SELECT COUNT(*) count FROM succession_history WHERE candidate_id=?').get(anna.id).count, 1);

  now = new Date('2030-06-01T10:00:00Z');
  expectStatus(await h.api('bp', 'PATCH', `/api/succession/candidates/${anna.id}`, { readiness: 'ready_1_2_years' }), 200);
  now = new Date('2099-06-01T10:00:00Z');
  expectStatus(await h.api('hr', 'PATCH', `/api/succession/candidates/${anna.id}`, { readiness: 'ready_now' }), 200);

  const history = candidateOf(await getPlan(plan.id), 'Anna Ahrens').history;
  assert.deepEqual(history.map(entry => [entry.oldReadiness, entry.newReadiness, entry.changedBy, entry.changedAt.slice(0, 10)]), [
    ['ready_1_2_years', 'ready_now', 'Hanna HR', '2099-06-01'],
    ['ready_3_plus_years', 'ready_1_2_years', 'Boris Partner', '2030-06-01'],
    [null, 'ready_3_plus_years', 'Hanna HR', '2030-03-15']
  ]);
  assert.equal(history[0].newReadinessLabel, 'Sofort bereit');
  assert.equal(history[0].oldReadinessLabel, 'In 1 bis 2 Jahren bereit');
});

// ------------------------------------------------------------------------------------------
// Kennzahlen
// ------------------------------------------------------------------------------------------

test('Bankstärke, Pläne ohne bereiten Kandidaten und Risiko-Matrix', async () => {
  const full = await createPlan({ roleName: 'Plan Voll', holderId: h.people.manager.id, criticality: 'high', risk: 'high' });
  const noReady = await createPlan({ roleName: 'Plan Ohne', holderId: h.people.clara.id, criticality: 'high', risk: 'high' });
  const empty = await createPlan({ roleName: 'Plan Leer', holderId: null, criticality: 'low', risk: 'medium' });
  const archived = await createPlan({ roleName: 'Plan Archiv', holderId: null, criticality: 'medium', risk: 'low' });

  await addCandidate(full.id, 'anna', { readiness: 'ready_now' });
  await addCandidate(full.id, 'ben', { readiness: 'ready_now' });
  await addCandidate(full.id, 'clara', { readiness: 'ready_1_2_years' });
  await addCandidate(full.id, 'bp', { readiness: 'ready_3_plus_years' });
  await addCandidate(noReady.id, 'anna', { readiness: 'ready_1_2_years' });
  addPerson(8, 4);
  await addCandidate(noReady.id, 8, { readiness: 'ready_now' });
  const removed = await addCandidate(noReady.id, 'ben', { readiness: 'ready_now' });
  expectStatus(await h.api('hr', 'PATCH', `/api/succession/candidates/${removed.id}`, { status: 'removed' }), 200);
  expectStatus(await h.api('hr', 'PATCH', `/api/succession/plans/${archived.id}`, { status: 'archived' }), 200);
  // Ausgeschiedene Personen zählen nicht mehr.
  h.db.prepare('UPDATE users SET active=0 WHERE id=8').run();

  const metrics = expectStatus(await h.api('hr', 'GET', '/api/succession/metrics'), 200);
  assert.deepEqual(metrics.plans.map(plan => plan.title), ['Plan Leer', 'Plan Ohne', 'Plan Voll']);
  assert.deepEqual(metrics.plans.find(plan => plan.planId === full.id).bench, { ready_now: 2, ready_1_2_years: 1, ready_3_plus_years: 1, proposed: 0 });
  assert.deepEqual(metrics.plans.find(plan => plan.planId === noReady.id).bench, { ready_now: 0, ready_1_2_years: 1, ready_3_plus_years: 0, proposed: 0 });
  assert.deepEqual(metrics.plans.find(plan => plan.planId === empty.id).bench, { ready_now: 0, ready_1_2_years: 0, ready_3_plus_years: 0, proposed: 0 });
  assert.deepEqual(metrics.plansWithoutReadyCandidate.map(plan => plan.title), ['Plan Leer', 'Plan Ohne']);
  assert.deepEqual(metrics.riskMatrix, {
    high: { high: 2, medium: 0, low: 0 },
    medium: { high: 0, medium: 0, low: 0 },
    low: { high: 0, medium: 1, low: 0 }
  });
  // Anna steht in zwei Plänen und zählt netto nur einmal.
  assert.deepEqual(metrics.nominations, { gross: 5, net: 4 });
});

// ------------------------------------------------------------------------------------------
// Aufgaben
// ------------------------------------------------------------------------------------------

test('Wartung legt genau eine Überprüfung je Plan und Jahr an', async () => {
  const first = await createPlan({ roleName: 'Plan A' });
  const second = await createPlan({ roleName: 'Plan B' }, 'bp');
  const archived = await createPlan({ roleName: 'Plan C' });
  expectStatus(await h.api('hr', 'PATCH', `/api/succession/plans/${archived.id}`, { status: 'archived' }), 200);
  await addCandidate(first.id, 'anna');

  h.instance.maintenance();
  h.instance.maintenance();
  h.instance.maintenance();
  let tasks = h.db.prepare("SELECT * FROM tasks WHERE type='succession_review' ORDER BY entity_id").all();
  assert.deepEqual(tasks.map(task => task.entity_id), [first.id, second.id]);
  // Bevorzugt, wer den Plan angelegt hat.
  assert.equal(tasks[0].user_id, h.people.hr.id);
  assert.equal(tasks[1].user_id, h.people.bp.id);
  // Der Plan steht im Titel, damit klar ist, worum es geht. Keine Personen, keine Einstufungen.
  assert.deepEqual(tasks.map(task => task.title), ['Nachfolgeplan „Plan A“: jährliche Überprüfung', 'Nachfolgeplan „Plan B“: jährliche Überprüfung']);
  // Die Frist ist das Ende des Jahres, für das die Überprüfung gilt.
  assert.deepEqual(tasks.map(task => task.due_date), ['2030-12-31', '2030-12-31']);

  // Auch eine erledigte Aufgabe kommt im selben Jahr nicht wieder.
  expectStatus(await h.api('hr', 'POST', `/api/succession/plans/${first.id}/reviewed`), 200);
  assert.equal(openReviewTasks().length, 1);
  assert.ok((await getPlan(first.id)).plan.lastReviewedAt);
  h.instance.maintenance();
  assert.equal(h.db.prepare("SELECT COUNT(*) count FROM tasks WHERE type='succession_review'").get().count, 2);

  // Im neuen Jahr gibt es wieder genau eine.
  now = new Date('2099-01-02T08:00:00Z');
  h.instance.maintenance();
  h.instance.maintenance();
  tasks = h.db.prepare("SELECT * FROM tasks WHERE type='succession_review'").all();
  assert.equal(tasks.length, 4);
  assert.equal(tasks.filter(task => task.entity_id === first.id).length, 2);
  assert.equal(tasks.some(task => task.entity_id === archived.id), false);
});

test('Wartung gibt die Überprüfung nie an betroffene Personen', async () => {
  // Angelegt von der HR-Administration, die dann Kandidatin wird: Die Aufgabe geht an HRBP.
  const candidatePlan = await createPlan({ roleName: 'A', holderId: h.people.manager.id });
  await addCandidate(candidatePlan.id, 'hr', {}, SYSTEM_ID);
  // Beide HR-Personen betroffen: keine Aufgabe, später nachholen.
  const blocked = await createPlan({ roleName: 'B', holderId: h.people.hr.id }, 'bp');
  await addCandidate(blocked.id, 'bp', {}, SYSTEM_ID);

  h.instance.maintenance();
  const tasks = h.db.prepare("SELECT * FROM tasks WHERE type='succession_review'").all();
  assert.deepEqual(tasks.map(task => [task.entity_id, task.user_id]), [[candidatePlan.id, h.people.bp.id]]);

  // Sobald es jemanden gibt, der nicht betroffen ist, wird die Aufgabe nachgeholt.
  addPerson(8, null, 'hr_admin');
  h.instance.maintenance();
  h.instance.maintenance();
  const later = h.db.prepare("SELECT * FROM tasks WHERE type='succession_review' AND entity_id=?").all(blocked.id);
  assert.deepEqual(later.map(task => task.user_id), [8]);
});

test('Wartung ohne Pläne oder HR-Personen macht nichts und bricht nicht ab', async () => {
  h.instance.maintenance();
  await createPlan();
  h.db.prepare("UPDATE users SET active=0 WHERE role IN ('hr_admin','hrbp')").run();
  h.instance.maintenance();
  assert.equal(h.db.prepare("SELECT COUNT(*) count FROM tasks WHERE type='succession_review'").get().count, 0);
});

// ------------------------------------------------------------------------------------------
// Unterstützung: anzeigen, nicht empfehlen
// ------------------------------------------------------------------------------------------

function addCompetency(name, positionId, requiredLevel) {
  const id = h.db.prepare("INSERT INTO competencies(name,name_normalized,category) VALUES(?,?,'technical')").run(name, name.toLowerCase()).lastInsertRowid;
  if (positionId) h.db.prepare('INSERT INTO position_requirements(position_profile_id,competency_id,required_level) VALUES(?,?,?)').run(positionId, id, requiredLevel);
  return id;
}

function addProfile(title) {
  return h.db.prepare('INSERT INTO position_profiles(title,title_normalized) VALUES(?,?)').run(title, title.toLowerCase()).lastInsertRowid;
}

function assess(userId, competencyId, type, rating, assessorId = 4) {
  h.db.prepare('INSERT INTO competency_assessments(user_id,competency_id,assessor_id,assessment_type,rating) VALUES(?,?,?,?,?)').run(userId, competencyId, assessorId, type, rating);
}

test('Abdeckung bezieht sich auf die aktuelle Position, ohne Punktzahl und ohne Empfehlung', async () => {
  const current = addProfile('Sachbearbeitung');
  const java = addCompetency('Java', current, 3);
  const sql = addCompetency('SQL', current, 4);
  addCompetency('Python', current, 2);
  h.db.prepare('UPDATE users SET position_profile_id=? WHERE id=5').run(current);
  assess(5, java, 'manager', 4);
  assess(5, sql, 'manager', 3);

  const plan = await createPlan({ holderId: h.people.manager.id });
  await addCandidate(plan.id, 'anna');
  await addCandidate(plan.id, 'ben');

  const detail = await getPlan(plan.id);
  const anna = candidateOf(detail, 'Anna Ahrens');
  assert.equal(anna.currentPosition.positionTitle, 'Sachbearbeitung');
  assert.equal(anna.currentPosition.rated, true);
  assert.equal(anna.currentPosition.total, 3);
  assert.equal(anna.currentPosition.fulfilled, 1);
  assert.equal(anna.currentPosition.notRated, 1);
  assert.deepEqual(anna.currentPosition.items.map(item => [item.competency, item.status, item.statusLabel]), [
    ['Java', 'fulfilled', 'Erfüllt'],
    ['Python', 'not_rated', 'Nicht bewertet'],
    ['SQL', 'partial', 'Eine Stufe fehlt']
  ]);

  // Ben hat keine Position: nicht bewertet.
  const ben = candidateOf(detail, 'Ben Berg');
  assert.equal(ben.currentPosition.rated, false);
  assert.equal(ben.currentPosition.total, 0);
  assert.equal(ben.targetProfile.rated, false);

  // Nirgends eine Punktzahl, Rangfolge oder Empfehlung.
  const forbidden = /score|rank|recommend|fit|punkt|empfehl|position_order|order/i;
  for (const key of allKeys(detail)) assert.equal(forbidden.test(key), false, key);
  assert.equal(JSON.stringify(detail).includes('Mentoring'), false);
  assert.equal(JSON.stringify(detail).includes('Entwicklungsziel'), false);
});

test('Kandidaten stehen immer alphabetisch, nicht nach Bereitschaft oder Abdeckung', async () => {
  const plan = await createPlan({ holderId: h.people.director.id });
  await addCandidate(plan.id, 'manager', { readiness: 'ready_3_plus_years' });
  await addCandidate(plan.id, 'clara', { readiness: 'ready_1_2_years' });
  await addCandidate(plan.id, 'anna', { readiness: 'ready_3_plus_years' });
  await addCandidate(plan.id, 'ben', { readiness: 'ready_now' });
  const detail = await getPlan(plan.id);
  assert.deepEqual(detail.candidates.map(candidate => candidate.name), ['Anna Ahrens', 'Ben Berg', 'Clara Cordes', 'Malte Manager']);
});

test('Vergleich mit dem Zielprofil: Führungskraft vor Selbsteinschätzung, sonst nicht bewertet', async () => {
  const target = addProfile('Abteilungsleitung');
  const lead = addCompetency('Führung', target, 4);
  const budget = addCompetency('Budget', target, 3);
  const plan = await createPlan({ positionProfileId: target, roleName: undefined, holderId: h.people.manager.id });
  await addCandidate(plan.id, 'anna');
  await addCandidate(plan.id, 'ben');

  assess(5, lead, 'self', 5, 5);
  assess(5, lead, 'manager', 2);
  assess(5, budget, 'self', 3, 5);

  const detail = await getPlan(plan.id);
  const anna = candidateOf(detail, 'Anna Ahrens').targetProfile;
  assert.equal(anna.rated, true);
  assert.equal(anna.total, 2);
  assert.equal(anna.fulfilled, 1);
  assert.deepEqual(anna.items.map(item => [item.competency, item.requiredLevel, item.availableLevel, item.status]), [
    ['Budget', 3, 3, 'fulfilled'],
    ['Führung', 4, 2, 'development_needed']
  ]);

  const ben = candidateOf(detail, 'Ben Berg').targetProfile;
  assert.equal(ben.rated, false);
  assert.equal(ben.notRated, 2);
  assert.ok(ben.items.every(item => item.statusLabel === 'Nicht bewertet'));

  // Ohne Anforderungen am Profil oder ohne Profil gibt es nichts zu vergleichen.
  const noProfile = await createPlan({ roleName: 'Frei', holderId: h.people.manager.id });
  await addCandidate(noProfile.id, 'anna');
  const free = candidateOf(await getPlan(noProfile.id), 'Anna Ahrens').targetProfile;
  assert.equal(free.rated, false);
  assert.deepEqual(free.items, []);
});

test('Ist das Talent-Modul aus, bleibt alles lesbar und zeigt "nicht bewertet"', async () => {
  const current = addProfile('Sachbearbeitung');
  const java = addCompetency('Java', current, 3);
  h.db.prepare('UPDATE users SET position_profile_id=? WHERE id=5').run(current);
  assess(5, java, 'manager', 4);
  const plan = await createPlan({ positionProfileId: current, roleName: undefined, holderId: h.people.manager.id });
  await addCandidate(plan.id, 'anna');

  enabledModules.delete('talent');
  const anna = candidateOf(await getPlan(plan.id), 'Anna Ahrens');
  assert.equal(anna.currentPosition.rated, false);
  assert.deepEqual(anna.currentPosition.items, []);
  assert.equal(anna.targetProfile.rated, false);
  assert.deepEqual(anna.targetProfile.items, []);
});

test('Bereichsleitung sieht Kompetenzdaten nur von Personen aus der eigenen Führungslinie', async () => {
  const current = addProfile('Sachbearbeitung');
  const java = addCompetency('Java', current, 3);
  h.db.prepare('UPDATE users SET position_profile_id=? WHERE id=2').run(current);
  h.db.prepare('UPDATE users SET position_profile_id=? WHERE id=5').run(current);
  assess(2, java, 'manager', 4);
  assess(5, java, 'manager', 4);
  const plan = await createPlan({ holderId: h.people.manager.id });
  await addCandidate(plan.id, 'bp');
  await addCandidate(plan.id, 'anna');

  const detail = await getPlan(plan.id, 'director');
  assert.equal(candidateOf(detail, 'Boris Partner').currentPosition, null);
  assert.equal(candidateOf(detail, 'Boris Partner').targetProfile, null);
  assert.equal(candidateOf(detail, 'Anna Ahrens').currentPosition.total, 1);
});

// ------------------------------------------------------------------------------------------
// 9-Box
// ------------------------------------------------------------------------------------------

function addPeriod(name, assessmentDate) {
  return h.db.prepare(`
    INSERT INTO talent_review_periods(name,start_date,end_date,assessment_date,status,created_by)
    VALUES(?,?,?,?,'completed',1)
  `).run(name, `${assessmentDate.slice(0, 4)}-01-01`, `${assessmentDate.slice(0, 4)}-12-31`, assessmentDate).lastInsertRowid;
}

function addReview(periodId, employeeId, { status = 'finalized', performance = 3, potential = 2 } = {}) {
  h.db.prepare(`
    INSERT INTO talent_reviews(period_id,employee_id,manager_id,calibrated_performance,calibrated_potential,status,finalized_at,created_by)
    VALUES(?,?,4,?,?,?,?,1)
  `).run(periodId, employeeId, performance, potential, status, status === 'finalized' ? '2029-12-01T00:00:00Z' : null);
}

test('9-Box: letzte freigegebene Einordnung nur für HR und nur wenn das Modul an ist', async () => {
  const older = addPeriod('Review 2028', '2028-11-30');
  const newer = addPeriod('Review 2029', '2029-11-30');
  const running = addPeriod('Review 2030', '2030-11-30');
  addReview(older, 5, { performance: 1, potential: 1 });
  addReview(newer, 5, { performance: 3, potential: 3 });
  // Noch nicht freigegeben: darf nicht erscheinen.
  addReview(running, 5, { status: 'calibrated', performance: 2, potential: 2 });

  const plan = await createPlan({ holderId: h.people.manager.id });
  await addCandidate(plan.id, 'anna');
  await addCandidate(plan.id, 'ben');

  for (const person of ['hr', 'bp', SYSTEM_ID]) {
    const detail = await getPlan(plan.id, person);
    assert.equal(detail.nineBoxAvailable, true, String(person));
    const anna = candidateOf(detail, 'Anna Ahrens');
    assert.equal(anna.nineBox.period, 'Review 2029');
    assert.equal(anna.nineBox.performance, 3);
    assert.equal(anna.nineBox.potential, 3);
    assert.equal(anna.nineBox.label, 'Bereit für nächste Herausforderung');
    assert.equal(candidateOf(detail, 'Ben Berg').nineBox, null);
  }

  // Die Bereichsleitung sieht davon nichts, auch nicht den Schlüssel.
  const forDirector = await getPlan(plan.id, 'director');
  assert.equal(forDirector.nineBoxAvailable, false);
  assert.equal('nineBox' in candidateOf(forDirector, 'Anna Ahrens'), false);
  assert.equal(JSON.stringify(forDirector).includes('Review 2029'), false);

  // Modul aus: keine Anzeige.
  enabledModules.delete('talent_review');
  const off = await getPlan(plan.id);
  assert.equal(off.nineBoxAvailable, false);
  assert.equal('nineBox' in candidateOf(off, 'Anna Ahrens'), false);
  assert.equal(JSON.stringify(off).includes('Review 2029'), false);

  // Wieder an: sofort wieder da.
  enabledModules.add('talent_review');
  assert.equal(candidateOf(await getPlan(plan.id), 'Anna Ahrens').nineBox.period, 'Review 2029');
});

test('9-Box: HR sieht die eigene Einordnung hier nicht', async () => {
  const period = addPeriod('Review 2029', '2029-11-30');
  addReview(period, h.people.bp.id, { performance: 3, potential: 3 });
  const plan = await createPlan({ holderId: h.people.manager.id });
  await addCandidate(plan.id, 'bp');

  const forOthers = candidateOf(await getPlan(plan.id, 'hr'), 'Boris Partner');
  assert.equal(forOthers.nineBox.potential, 3);
  const forSelf = await h.api('bp', 'GET', `/api/succession/plans/${plan.id}`);
  assert.equal(forSelf.status, 404);
  assert.equal(JSON.stringify(forSelf.data).includes('Review 2029'), false);
});

test('9-Box: ohne passende Tabellen oder Spalten gibt es keine Anzeige und keinen Fehler', async () => {
  await h.close();
  h = await startHarness({ talentReviewTables: false });
  let plan = await createPlan();
  await addCandidate(plan.id, 'anna');
  let detail = await getPlan(plan.id);
  assert.equal(detail.nineBoxAvailable, false);
  assert.equal('nineBox' in candidateOf(detail, 'Anna Ahrens'), false);

  // Tabelle da, aber eine benötigte Spalte fehlt.
  h.db.exec('CREATE TABLE talent_reviews (id INTEGER PRIMARY KEY, period_id INTEGER, employee_id INTEGER, status TEXT, finalized_at TEXT)');
  h.db.exec('CREATE TABLE talent_review_periods (id INTEGER PRIMARY KEY, name TEXT, assessment_date TEXT)');
  plan = await createPlan({ roleName: 'Zweiter Plan' });
  await addCandidate(plan.id, 'ben');
  detail = await getPlan(plan.id);
  assert.equal(detail.nineBoxAvailable, false);
  assert.equal('nineBox' in candidateOf(detail, 'Ben Berg'), false);
});

// ------------------------------------------------------------------------------------------
// Protokoll, Hilfe, Demo-Daten
// ------------------------------------------------------------------------------------------

test('Protokoll und Aufgaben enthalten keine Einstufungen und keine Inhalte', async () => {
  const plan = await createPlan({ roleName: 'Leitung Technik', riskReason: 'Geheime Begründung', criticality: 'high', risk: 'low', plannedDeparture: '2099-06-30' });
  const anna = await addCandidate(plan.id, 'anna', { readiness: 'ready_3_plus_years', strengths: 'Geheime Stärke', gaps: 'Geheime Lücke', developmentActions: 'Geheime Maßnahme', note: 'Geheime Notiz' });
  expectStatus(await h.api('hr', 'PATCH', `/api/succession/candidates/${anna.id}`, { readiness: 'ready_now', note: 'Geheime Änderung' }), 200);
  expectStatus(await h.api('hr', 'PATCH', `/api/succession/plans/${plan.id}`, { risk: 'high', riskReason: 'Geheim geändert' }), 200);
  expectStatus(await h.api('hr', 'POST', `/api/succession/plans/${plan.id}/reviewed`), 200);
  await addCandidate(plan.id, 'ben', { readiness: 'ready_now' }, 'director');
  h.instance.maintenance();

  const audit = h.db.prepare('SELECT * FROM audit_log').all();
  const actions = audit.map(row => row.action);
  for (const action of ['succession_plan_created', 'succession_plan_updated', 'succession_plan_reviewed', 'succession_candidate_created', 'succession_candidate_updated']) {
    assert.ok(actions.includes(action), action);
  }
  // Wer, wann und für wen.
  const updated = audit.find(row => row.action === 'succession_candidate_updated');
  assert.equal(updated.actor_id, 1);
  assert.ok(updated.created_at);
  assert.deepEqual(JSON.parse(updated.new_values), { planId: plan.id, userId: h.people.anna.id });
  assert.equal(updated.old_values, null);

  // Es dürfen nur diese Felder vorkommen, und nie ein Vorher-Wert.
  const allowedKeys = new Set(['holderId', 'status', 'planId', 'userId']);
  for (const row of audit) {
    assert.equal(row.old_values, null, row.action);
    for (const key of Object.keys(JSON.parse(row.new_values || '{}'))) assert.ok(allowedKeys.has(key), `${row.action}: ${key}`);
  }

  const tasks = h.db.prepare('SELECT title FROM tasks').all();
  assert.ok(tasks.length >= 2);
  for (const text of [JSON.stringify(audit), JSON.stringify(tasks)]) {
    for (const secret of ['Geheim', 'ready_', 'readiness', 'criticality', '"risk"', 'high', '2099-06-30', 'Anna', 'Ahrens', 'Ben Berg', 'Sofort']) {
      assert.equal(text.includes(secret), false, `${secret} in ${text}`);
    }
  }
});

test('Dayo-Hilfe erklärt Abläufe, nennt keine Daten und ist nur für berechtigte Rollen', () => {
  const articles = h.instance.helpArticles;
  assert.ok(articles.length >= 2);
  for (const article of articles) {
    const text = `${article.title} ${article.answer} ${article.steps.join(' ')}`;
    assert.equal(/\d/.test(text), false, article.id);
    assert.ok(article.id.startsWith('succession-'));
    assert.equal(article.roles.includes('employee'), false, article.id);
    assert.equal(article.roles.includes('manager'), false, article.id);
    assert.ok(article.views.length);
    assert.ok(article.keywords.length);
  }
});

test('Demo-Daten: mehrfach aufrufbar, keine Konten, nur vorhandene Personen', async () => {
  const count = table => h.db.prepare(`SELECT COUNT(*) count FROM ${table}`).get().count;
  const users = count('users');
  h.instance.seedDemo();
  const first = { plans: count('succession_plans'), candidates: count('succession_candidates'), history: count('succession_history') };
  assert.ok(first.plans >= 2);
  assert.ok(first.candidates >= 3);
  assert.equal(first.history, first.candidates);

  h.instance.seedDemo();
  assert.deepEqual({ plans: count('succession_plans'), candidates: count('succession_candidates'), history: count('succession_history') }, first);
  assert.equal(count('users'), users);

  // Inhaberinnen stehen nicht als Kandidaten im eigenen Plan, und die Oberfläche kann alles lesen.
  const conflicts = h.db.prepare('SELECT COUNT(*) count FROM succession_candidates c JOIN succession_plans p ON p.id=c.plan_id WHERE c.user_id=p.holder_id').get().count;
  assert.equal(conflicts, 0);
  const plans = expectStatus(await h.api('hr', 'GET', '/api/succession/plans'), 200).plans;
  assert.equal(plans.length, first.plans);
  for (const plan of plans) await getPlan(plan.id);
  // Die Bereichsleitung sieht nicht den Plan für die eigene Stelle.
  const forDirector = expectStatus(await h.api('director', 'GET', '/api/succession/plans'), 200).plans;
  assert.ok(forDirector.length < plans.length);
  assert.ok(forDirector.every(plan => plan.holder.id !== h.people.director.id));
  assert.ok(expectStatus(await h.api('hr', 'GET', '/api/succession/metrics'), 200).riskMatrix);
});

test('Demo-Daten: ohne genug Personen passiert nichts', () => {
  h.db.prepare('UPDATE users SET active=0 WHERE id>2').run();
  h.instance.seedDemo();
  assert.equal(h.db.prepare('SELECT COUNT(*) count FROM succession_plans').get().count, 0);
});

test('Das Grundgerüst lässt sich mehrfach anlegen, ohne Daten zu verlieren', async () => {
  await createPlan();
  h.instance.initialize();
  assert.equal(h.db.prepare('SELECT COUNT(*) count FROM succession_plans').get().count, 1);
});

// ------------------------------------------------------------------------------------------
// Aufgaben folgen dem Plan
// ------------------------------------------------------------------------------------------

test('Aufgaben nennen den Plan und folgen seinem Namen', async () => {
  const plan = await createPlan({ roleName: 'Leitung Technik', holderId: h.people.manager.id });
  h.instance.maintenance();
  await addCandidate(plan.id, 'anna', {}, 'director');
  await addCandidate(plan.id, 'clara', {}, 'director');
  const proposals = () => h.db.prepare("SELECT * FROM tasks WHERE type='succession_candidate_proposal' AND done=0").all();
  // Mehrere Vorschläge ergeben eine Aufgabe, ohne Frist und ohne Namen der vorgeschlagenen Personen.
  assert.equal(proposals().length, 1);
  assert.equal(proposals()[0].title, 'Nachfolgeplan „Leitung Technik“: neuen Vorschlag prüfen');
  assert.equal(proposals()[0].due_date, null);

  expectStatus(await h.api('hr', 'PATCH', `/api/succession/plans/${plan.id}`, { roleName: 'Leitung Werk' }), 200);
  assert.equal(proposals()[0].title, 'Nachfolgeplan „Leitung Werk“: neuen Vorschlag prüfen');
  assert.equal(openReviewTasks()[0].title, 'Nachfolgeplan „Leitung Werk“: jährliche Überprüfung');

  // Ältere Aufgaben trugen den Tag des Anlegens als Frist und einen Titel mit Nummer. Die Wartung korrigiert beides.
  h.db.prepare("UPDATE tasks SET due_date='2030-02-03', title='Nachfolgeplan Nr. 1: jährliche Überprüfung' WHERE type='succession_review'").run();
  h.db.prepare("UPDATE tasks SET due_date='2030-02-03' WHERE type='succession_candidate_proposal'").run();
  h.instance.maintenance();
  assert.equal(openReviewTasks()[0].due_date, '2030-12-31');
  assert.equal(openReviewTasks()[0].title, 'Nachfolgeplan „Leitung Werk“: jährliche Überprüfung');
  assert.equal(proposals()[0].due_date, null);
});

test('Steht eine HR-Person selbst im Plan, wandert ihre Aufgabe weiter', async () => {
  const plan = await createPlan({ holderId: h.people.manager.id });
  h.instance.maintenance();
  assert.equal(openReviewTasks()[0].user_id, h.people.hr.id);

  // Die HR-Administration wird über die Systemadministration Kandidatin: Sie darf den Plan nicht mehr öffnen.
  await addCandidate(plan.id, 'hr', {}, SYSTEM_ID);
  assert.equal(openReviewTasks()[0].user_id, h.people.bp.id);

  // Fällt auch diese Person aus, wandert die Aufgabe zur nächsten, und ohne jemanden ist sie hinfällig.
  addPerson(8, null, 'hr_admin');
  h.db.prepare('UPDATE users SET active=0 WHERE id=2').run();
  h.instance.maintenance();
  assert.equal(openReviewTasks()[0].user_id, 8);
  h.db.prepare('UPDATE users SET active=0 WHERE id=8').run();
  h.instance.maintenance();
  assert.deepEqual(openReviewTasks(), []);
});

test('Wird ein Plan neu besetzt, gibt die betroffene HR-Person ihre Aufgabe ab', async () => {
  const plan = await createPlan({ holderId: h.people.manager.id }, 'bp');
  h.instance.maintenance();
  assert.equal(openReviewTasks()[0].user_id, h.people.bp.id);
  expectStatus(await h.api(SYSTEM_ID, 'PATCH', `/api/succession/plans/${plan.id}`, { holderId: h.people.bp.id }), 200);
  assert.equal(openReviewTasks()[0].user_id, h.people.hr.id);
});

test('Ein zurückgeholter Plan bekommt die offene Überprüfung des Jahres zurück', async () => {
  const plan = await createPlan();
  h.instance.maintenance();
  expectStatus(await h.api('hr', 'PATCH', `/api/succession/plans/${plan.id}`, { status: 'archived' }), 200);
  assert.deepEqual(openReviewTasks(), []);
  expectStatus(await h.api('hr', 'PATCH', `/api/succession/plans/${plan.id}`, { status: 'active' }), 200);
  assert.equal(openReviewTasks().length, 1);
  assert.equal(openReviewTasks()[0].due_date, '2030-12-31');

  // Wer in diesem Jahr schon überprüft hat, wird nicht noch einmal gefragt.
  expectStatus(await h.api('hr', 'POST', `/api/succession/plans/${plan.id}/reviewed`), 200);
  expectStatus(await h.api('hr', 'PATCH', `/api/succession/plans/${plan.id}`, { status: 'archived' }), 200);
  expectStatus(await h.api('hr', 'PATCH', `/api/succession/plans/${plan.id}`, { status: 'active' }), 200);
  assert.deepEqual(openReviewTasks(), []);
});

// ------------------------------------------------------------------------------------------
// Sprache
// ------------------------------------------------------------------------------------------

test('Texte kommen ohne Fachjargon aus', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const page = fs.readFileSync(path.join(__dirname, '../public/succession.js'), 'utf8');
  for (const word of ['Bankstärke', 'Kritikalität', 'Risiko-Matrix', 'Nominierung', 'Positionsprofil', 'Zielprofil']) {
    assert.equal(page.includes(word), false, word);
  }
  for (const article of h.instance.helpArticles) {
    const text = `${article.title} ${article.answer} ${article.steps.join(' ')}`;
    for (const word of ['Bankstärke', 'Kritikalität', 'Risiko-Matrix']) assert.equal(text.includes(word), false, `${article.id}: ${word}`);
  }
});

test('Ein geplanter Abgang in der Vergangenheit wird abgelehnt, ein vorhandenes Datum bleibt erlaubt', async () => {
  const valid = { roleName: 'Rolle', holderId: h.people.manager.id, criticality: 'high', risk: 'low', riskReason: 'Weil' };
  const past = await h.api('hr', 'POST', '/api/succession/plans', { ...valid, plannedDeparture: '2020-01-01' });
  assert.equal(past.status, 400);
  assert.match(past.data.error, /Vergangenheit/);
  const plan = await createPlan({ plannedDeparture: '2099-06-30' });
  h.db.prepare('UPDATE succession_plans SET planned_departure=? WHERE id=?').run('2020-01-01', plan.id);
  assert.equal((await h.api('hr', 'PATCH', `/api/succession/plans/${plan.id}`, { riskReason: 'Geändert, Datum bleibt' })).status, 200);
});
