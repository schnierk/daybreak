const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { createModuleHarness } = require('../lib/testing/module-harness');
const { createTalentReviewModule } = require('../routes/talentReview');

// Die Beispielorganisation: hr(1), bp(2), director(3) führt manager(4) und clara(7), manager führt anna(5) und ben(6).
const ID = { hr: 1, bp: 2, director: 3, manager: 4, anna: 5, ben: 6, clara: 7 };
const SECRET = 'GEHEIMER-ENTWURFSTEXT';

const startHarness = (options = {}) => createModuleHarness(deps => createTalentReviewModule({ ...deps, ...(options.deps || {}) }));

async function withHarness(work, options) {
  const h = await startHarness(options);
  try {
    await work(h);
  } finally {
    await h.close();
  }
}

async function createPeriod(h, name = 'Talent Review Test') {
  const created = await h.api('hr', 'POST', '/api/talent-review/periods', { name, description: 'Testperiode', startDate: '2026-01-01', endDate: '2026-12-31', assessmentDate: '2026-11-30' });
  assert.equal(created.status, 201);
  return created.data.id;
}

async function setPeriodStatus(h, periodId, status, person = 'hr') {
  const result = await h.api(person, 'PATCH', `/api/talent-review/periods/${periodId}/status`, { status });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  return result.data;
}

async function openPeriod(h, name) {
  const periodId = await createPeriod(h, name);
  await setPeriodStatus(h, periodId, 'open');
  return periodId;
}

const reviewRow = (h, periodId, employeeId) => h.db.prepare('SELECT * FROM talent_reviews WHERE period_id=? AND employee_id=?').get(periodId, employeeId);
const openTasks = (h, type, entityId) => h.db.prepare('SELECT * FROM tasks WHERE type=? AND entity_id=? AND done=0').all(type, entityId);

function managerPayload(h, overrides = {}) {
  const criteria = h.db.prepare('SELECT id FROM talent_review_potential_criteria ORDER BY display_order').all();
  return {
    performance: 3,
    potential: 2,
    performanceReason: 'Die Ergebnisse waren im gesamten Zeitraum deutlich über den vereinbarten Erwartungen.',
    potentialReason: 'Die Person übernimmt neue Aufgaben schnell und entwickelt andere im Team weiter.',
    observations: 'Ergebnisse, Zusammenarbeit und Lernfortschritt wurden in mehreren Situationen beobachtet.',
    developmentFields: 'Strategische Kommunikation weiter ausbauen.',
    nextSteps: 'Ein bereichsübergreifendes Vorhaben verantworten.',
    criteria: criteria.map((criterion, index) => ({ criterionId: criterion.id, rating: index % 5 + 1, comment: 'Konkrete beobachtbare Beispiele sind vorhanden.' })),
    ...overrides
  };
}

function selfPayload(overrides = {}) {
  return {
    performance: 3,
    potential: 2,
    performanceReason: 'Ich habe die vereinbarten Ergebnisse zuverlässig erreicht und konkrete Wirkung im Team erzielt.',
    potentialReason: 'Ich möchte neue Verantwortung übernehmen und sehe dafür eine realistische Entwicklungsperspektive.',
    observations: 'Ich habe ein komplexes Vorhaben strukturiert vorangebracht und andere aktiv eingebunden.',
    developmentFields: 'Meine strategische Kommunikation möchte ich weiter stärken.',
    nextSteps: 'Ich möchte ein bereichsübergreifendes Projekt mitgestalten.',
    ...overrides
  };
}

async function saveAndSubmit(h, person, reviewId, overrides) {
  const saved = await h.api(person, 'PATCH', `/api/talent-review/reviews/${reviewId}/manager`, managerPayload(h, overrides));
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  const submitted = await h.api(person, 'POST', `/api/talent-review/reviews/${reviewId}/submit`);
  assert.equal(submitted.status, 200, JSON.stringify(submitted.data));
}

async function createSession(h, periodId, { title = 'Testsitzung', moderatorId = ID.hr, organizationManagerId } = {}) {
  const session = await h.api('hr', 'POST', '/api/talent-review/sessions', { periodId, title, description: 'Runde', sessionDate: '2026-10-15', moderatorId, organizationManagerId });
  assert.equal(session.status, 201, JSON.stringify(session.data));
  return session.data.id;
}

const addParticipant = async (h, sessionId, userId) => assert.equal((await h.api('hr', 'POST', `/api/talent-review/sessions/${sessionId}/participants`, { userId })).status, 200);
const addCase = async (h, sessionId, reviewId, extra = {}) => assert.equal((await h.api('hr', 'POST', `/api/talent-review/sessions/${sessionId}/cases`, { reviewId, displayOrder: 1, ...extra })).status, 201);
const setSessionStatus = async (h, sessionId, status) => assert.equal((await h.api('hr', 'PATCH', `/api/talent-review/sessions/${sessionId}`, { status })).status, 200);

const calibrationBody = (sessionId, version, overrides = {}) => ({
  sessionId,
  performance: 1,
  potential: 1,
  reason: 'Die Kalibrierungsrunde hat mehrere konkrete Vergleichsfälle nachvollziehbar diskutiert.',
  version,
  ...overrides
});

/** Bringt die Einschätzung einer Person bis in eine laufende Sitzung. */
async function reachCalibration(h, periodId, employeeId, managerKey, participants = []) {
  const reviewId = reviewRow(h, periodId, employeeId).id;
  await saveAndSubmit(h, managerKey, reviewId);
  const sessionId = await createSession(h, periodId, { title: `Sitzung ${employeeId}` });
  for (const person of participants) await addParticipant(h, sessionId, person);
  await addCase(h, sessionId, reviewId);
  await setPeriodStatus(h, periodId, 'calibration');
  await setSessionStatus(h, sessionId, 'active');
  return { reviewId, sessionId };
}

// ---------------------------------------------------------------------------
// Grundablauf
// ---------------------------------------------------------------------------

test('Perioden sind HR-exklusiv, validiert und erzeugen beim Öffnen Einschätzungen und Aufgaben', () => withHarness(async h => {
  assert.equal((await h.api(null, 'GET', '/api/talent-review/meta')).status, 401);
  assert.equal((await h.api('manager', 'POST', '/api/talent-review/periods', {})).status, 403);
  assert.equal((await h.api('hr', 'POST', '/api/talent-review/periods', { name: 'Ungültig', startDate: '2026-12-31', endDate: '2026-01-01', assessmentDate: '2026-06-01' })).status, 400);
  const periodId = await createPeriod(h);
  assert.equal((await h.api('hr', 'PATCH', `/api/talent-review/periods/${periodId}/status`, { status: 'calibration' })).status, 409);
  await setPeriodStatus(h, periodId, 'open');
  const reviews = await h.api('manager', 'GET', `/api/talent-review/reviews?periodId=${periodId}`);
  assert.equal(reviews.status, 200);
  assert.deepEqual(reviews.data.items.map(item => item.employee_id).sort(), [ID.anna, ID.ben]);
  assert.equal(h.db.prepare("SELECT COUNT(*) count FROM tasks WHERE user_id=? AND type='talent_review_start'").get(ID.manager).count, 2);
  assert.equal(h.db.prepare("SELECT COUNT(*) count FROM tasks WHERE user_id=? AND type='talent_review_self_assessment'").get(ID.anna).count, 1);
}));

test('Die Selbsteinschätzung schreibt und gibt nur die Person selbst ab', () => withHarness(async h => {
  const periodId = await openPeriod(h);
  const reviewId = reviewRow(h, periodId, ID.anna).id;
  const own = (await h.api('anna', 'GET', '/api/talent-review/self-reviews')).data.items.find(item => item.id === reviewId);
  assert.equal(own.self.status, 'not_started');
  assert.equal(own.canEdit, true);
  assert.equal((await h.api('manager', 'PATCH', `/api/talent-review/reviews/${reviewId}/self`, selfPayload())).status, 403);
  assert.equal((await h.api('clara', 'PATCH', `/api/talent-review/reviews/${reviewId}/self`, selfPayload())).status, 403);
  assert.equal((await h.api('anna', 'PATCH', `/api/talent-review/reviews/${reviewId}/self`, selfPayload())).status, 200);
  assert.equal(reviewRow(h, periodId, ID.anna).self_status, 'employee_draft');
  const draftView = await h.api('manager', 'GET', `/api/talent-review/reviews/${reviewId}`);
  assert.equal(draftView.status, 200);
  assert.equal(draftView.data.selfAssessment.status, 'employee_draft');
  assert.equal(draftView.data.selfAssessment.performance, undefined);
  assert.equal((await h.api('anna', 'POST', `/api/talent-review/reviews/${reviewId}/self/submit`)).status, 200);
  assert.equal(reviewRow(h, periodId, ID.anna).self_status, 'employee_submitted');
  assert.equal(openTasks(h, 'talent_review_self_assessment', reviewId).length, 0);
  const submittedView = await h.api('manager', 'GET', `/api/talent-review/reviews/${reviewId}`);
  assert.equal(submittedView.data.selfAssessment.performance, 3);
  assert.match(submittedView.data.selfAssessment.observations, /Vorhaben/);
  assert.equal((await h.api('anna', 'PATCH', `/api/talent-review/reviews/${reviewId}/self`, selfPayload())).status, 409);
}));

test('Nur die zuständige Führungskraft speichert und reicht ein, HR kann zurückgeben', () => withHarness(async h => {
  const periodId = await openPeriod(h);
  const reviewId = reviewRow(h, periodId, ID.anna).id;
  assert.equal((await h.api('clara', 'PATCH', `/api/talent-review/reviews/${reviewId}/manager`, managerPayload(h))).status, 403);
  assert.equal((await h.api('director', 'PATCH', `/api/talent-review/reviews/${reviewId}/manager`, managerPayload(h))).status, 403);
  assert.equal((await h.api('manager', 'PATCH', `/api/talent-review/reviews/${reviewId}/manager`, managerPayload(h))).status, 200);
  assert.equal(reviewRow(h, periodId, ID.anna).status, 'manager_draft');
  assert.equal(h.db.prepare('SELECT COUNT(*) count FROM talent_review_potential_ratings WHERE review_id=?').get(reviewId).count, 8);
  assert.equal((await h.api('manager', 'POST', `/api/talent-review/reviews/${reviewId}/submit`)).status, 200);
  assert.equal(openTasks(h, 'talent_review_submitted', reviewId).length, 2, 'Beide HR-Personen bekommen die Aufgabe');
  assert.equal((await h.api('manager', 'PATCH', `/api/talent-review/reviews/${reviewId}/manager`, managerPayload(h))).status, 409);
  assert.equal((await h.api('manager', 'POST', `/api/talent-review/reviews/${reviewId}/return`, { reason: 'Darf ich nicht.' })).status, 403);
  assert.equal((await h.api('hr', 'POST', `/api/talent-review/reviews/${reviewId}/return`, { reason: 'kurz' })).status, 409);
  assert.equal((await h.api('hr', 'POST', `/api/talent-review/reviews/${reviewId}/return`, { reason: 'Bitte die Auswirkungen auf die Zusammenarbeit ergänzen.' })).status, 200);
  assert.equal(openTasks(h, 'talent_review_submitted', reviewId).length, 0, 'Zurückgegeben wartet nichts mehr bei HR');
  const returned = openTasks(h, 'talent_review_returned', reviewId);
  assert.equal(returned.length, 1);
  assert.equal(returned[0].user_id, ID.manager);
  assert.equal((await h.api('manager', 'PATCH', `/api/talent-review/reviews/${reviewId}/manager`, managerPayload(h, { potential: 3 }))).status, 200);
  assert.equal((await h.api('manager', 'POST', `/api/talent-review/reviews/${reviewId}/submit`)).status, 200);
  assert.equal(openTasks(h, 'talent_review_returned', reviewId).length, 0);
}));

test('Kalibrierung verlangt Sitzung, Teilnahme, Begründung und aktuelle Version und rechnet die 9-Box selbst', () => withHarness(async h => {
  const periodId = await openPeriod(h);
  const reviewId = reviewRow(h, periodId, ID.anna).id;
  await saveAndSubmit(h, 'manager', reviewId);
  const sessionId = await createSession(h, periodId, { organizationManagerId: ID.manager });
  await addParticipant(h, sessionId, ID.manager);
  assert.equal(openTasks(h, 'talent_review_calibration', sessionId).filter(task => task.user_id === ID.manager).length, 1);
  const foreign = reviewRow(h, periodId, ID.clara).id;
  await saveAndSubmit(h, 'director', foreign);
  assert.equal((await h.api('hr', 'POST', `/api/talent-review/sessions/${sessionId}/cases`, { reviewId: foreign, displayOrder: 0 })).status, 400, 'Clara gehört nicht zur Organisation der Sitzung');
  await addCase(h, sessionId, reviewId);
  await setPeriodStatus(h, periodId, 'calibration');
  await setSessionStatus(h, sessionId, 'active');
  const { version } = reviewRow(h, periodId, ID.anna);
  const url = `/api/talent-review/reviews/${reviewId}/calibrate`;
  assert.equal((await h.api('clara', 'POST', url, calibrationBody(sessionId, version))).status, 403);
  assert.equal((await h.api('manager', 'POST', url, calibrationBody(sessionId, version, { reason: 'kurz' }))).status, 400);
  const stale = await h.api('manager', 'POST', url, calibrationBody(sessionId, version - 1));
  assert.equal(stale.status, 409);
  const calibrated = await h.api('manager', 'POST', url, calibrationBody(sessionId, version, { box: '3-3' }));
  assert.equal(calibrated.status, 200);
  assert.equal(calibrated.data.boxKey, '1-1');
  const row = reviewRow(h, periodId, ID.anna);
  assert.deepEqual([row.original_performance, row.original_potential, row.calibrated_performance, row.calibrated_potential, row.status], [3, 2, 1, 1, 'calibrated']);
}));

test('Abschluss, Matrix, Talentpool und Maßnahmen bleiben berechtigungsgeprüft', () => withHarness(async h => {
  const periodId = await openPeriod(h);
  const { reviewId, sessionId } = await reachCalibration(h, periodId, ID.anna, 'manager');
  const { version } = reviewRow(h, periodId, ID.anna);
  assert.equal((await h.api('hr', 'POST', `/api/talent-review/reviews/${reviewId}/calibrate`, calibrationBody(sessionId, version))).status, 200);
  assert.equal((await h.api('manager', 'POST', `/api/talent-review/reviews/${reviewId}/finalize`)).status, 403);
  assert.equal((await h.api('hr', 'POST', `/api/talent-review/reviews/${reviewId}/finalize`)).status, 200);
  assert.equal(openTasks(h, 'talent_review_submitted', reviewId).length, 0);
  const matrix = await h.api('hr', 'GET', `/api/talent-review/matrix?periodId=${periodId}`);
  assert.equal(matrix.status, 200);
  assert.equal(matrix.data.boxes['1-1'].reviews.some(item => item.id === reviewId), true);
  assert.equal((await h.api('anna', 'GET', `/api/talent-review/reviews/${reviewId}`)).status, 403, 'Vor der Freigabe sieht die Person nichts');
  assert.equal((await h.api('hr', 'PATCH', `/api/talent-review/periods/${periodId}/status`, { status: 'completed' })).status, 409);
  const pool = await h.api('hr', 'POST', '/api/talent-pools', { name: 'Testpool', description: 'Nachwuchs', purpose: 'Entwicklung', responsibleId: ID.hr });
  assert.equal(pool.status, 201);
  const poolUrl = `/api/talent-pools/${pool.data.id}/members`;
  assert.equal((await h.api('manager', 'POST', poolUrl, { employeeId: ID.clara, periodId, reason: 'Nicht erlaubter Vorschlag aus fremdem Bereich.' })).status, 403);
  const proposal = await h.api('manager', 'POST', poolUrl, { employeeId: ID.anna, periodId, reason: 'Die Person zeigt nachvollziehbar Entwicklungspotenzial.' });
  assert.equal(proposal.status, 201);
  assert.equal((await h.api('manager', 'POST', poolUrl, { employeeId: ID.anna, periodId, reason: 'Doppelter Vorschlag ist nicht zulässig.' })).status, 409);
  assert.equal((await h.api('hr', 'PATCH', `/api/talent-pools/memberships/${proposal.data.id}`, { status: 'active' })).status, 200);
  assert.equal((await h.api('hr', 'PATCH', `/api/talent-pools/memberships/${proposal.data.id}`, { status: 'removed', reason: 'Der Schwerpunkt des Pools hat sich geändert.' })).status, 200);
  const decision = await h.api('hr', 'POST', '/api/development-decisions', { reviewId, decisionType: 'development_goal', description: 'Verantwortung für ein bereichsübergreifendes Vorhaben übernehmen.', responsibleId: ID.manager, startDate: '2026-10-20', targetDate: '2026-12-15', createGoal: true, goalTitle: 'Strategische Wirkung ausbauen' });
  assert.equal(decision.status, 201, JSON.stringify(decision.data));
  assert.ok(decision.data.linkedGoalId);
  assert.equal(h.db.prepare('SELECT goal_type FROM goals WHERE id=?').get(decision.data.linkedGoalId).goal_type, 'development');
  assert.equal((await h.api('anna', 'GET', '/api/development-decisions')).data.items.some(item => item.id === decision.data.id), true);
  assert.ok(h.db.prepare("SELECT COUNT(*) count FROM talent_review_history WHERE entity_type='talent_review' AND entity_id=?").get(reviewId).count >= 4);
}));

test('Die Demodaten sind wiederholbar und enthalten alle neun Felder und die Beispielfälle', () => withHarness(async h => {
  h.instance.seed();
  h.instance.seed();
  const active = h.db.prepare("SELECT id FROM talent_review_periods WHERE name='Talent Review 2026'").get();
  const historical = h.db.prepare("SELECT id FROM talent_review_periods WHERE name='Talent Review 2025'").get();
  assert.equal(h.db.prepare("SELECT COUNT(*) count FROM talent_reviews WHERE period_id=? AND status='finalized'").get(historical.id).count, 9);
  assert.equal(h.db.prepare("SELECT COUNT(DISTINCT calibrated_potential || '-' || calibrated_performance) count FROM talent_reviews WHERE period_id=?").get(historical.id).count, 9);
  const stateOf = email => h.db.prepare('SELECT r.status FROM talent_reviews r JOIN users u ON u.id=r.employee_id WHERE r.period_id=? AND u.email=?').get(active.id, email)?.status;
  assert.equal(stateOf('ayse.demir@loop.local'), 'manager_draft');
  assert.equal(stateOf('mina.wagner@loop.local'), 'manager_draft');
  assert.equal(stateOf('jonas.richter@loop.local'), 'manager_submitted');
  assert.equal(h.db.prepare('SELECT COUNT(*) count FROM talent_review_sessions WHERE period_id=?').get(active.id).count, 3);
  assert.equal(h.db.prepare("SELECT COUNT(*) count FROM talent_pools WHERE name IN ('Führungskräftenachwuchs','Expertenlaufbahn')").get().count, 2);
  assert.equal(h.db.prepare("SELECT COUNT(*) count FROM talent_pool_memberships WHERE status IN ('proposed','active')").get().count, 3);
  assert.equal(h.db.prepare('SELECT COUNT(*) count FROM development_decisions').get().count, 1);
}, { deps: { demoPasswordHash: '!TEST!' } }));

// ---------------------------------------------------------------------------
// D1/A3/H1/B1/M1: Formulare
// ---------------------------------------------------------------------------

test('D1: Kein Knopf der Oberfläche kann ein Formular absenden, und jedes Formular fängt das Absenden ab', () => {
  const source = fs.readFileSync(path.join(__dirname, '../public/talent-review.js'), 'utf8');
  const buttons = source.match(/<button\b[^>]*>/g) || [];
  assert.ok(buttons.length >= 3, 'Die Suche nach Knöpfen muss etwas finden');
  for (const button of buttons) assert.match(button, /type="button"/, `Knopf ohne type="button": ${button}`);
  assert.match(source, /addEventListener\('submit'/);
  assert.match(source, /preventDefault\(\)/);
});

test('A14/H20/B20/B26: Die Oberfläche belegt nichts vor, zeigt alle Hinweise und fragt vor endgültigen Schritten nach', () => {
  const source = fs.readFileSync(path.join(__dirname, '../public/talent-review.js'), 'utf8');
  assert.match(source, /<option value="">Bitte wählen<\/option>/);
  assert.doesNotMatch(source, /selected\|\|2|selected \|\| 2/, 'Die Selbsteinschätzung startet nicht bei einem Mittelwert');
  assert.doesNotMatch(source, /reportValidity/, 'Der Browser hält einen Entwurf nicht wegen Pflichtfeldern auf');
  for (const shown of ['moderator_note', 'development_plan', 'removed_reason', 'calibrationHint', 'return_reason']) assert.ok(source.includes(shown), `Nicht angezeigt: ${shown}`);
  assert.match(source, /value: member\.development_plan/, 'Beim Entscheiden steht der Plan im Feld, sonst löscht ihn das Speichern');
  for (const question of ['Final abschließen?', 'Ergebnisse freigeben?', 'confirmArchive']) assert.ok(source.includes(question), `Rückfrage fehlt: ${question}`);
  assert.match(source, /registerTaskAction/);
  for (const type of ['talent_review_start', 'talent_review_returned', 'talent_review_self_assessment', 'talent_review_submitted', 'talent_review_finalized', 'talent_review_calibration', 'talent_pool_proposal', 'development_decision']) {
    assert.ok(source.includes(`${type}:`), `Aufgabe ohne Knopf: ${type}`);
  }
});

// ---------------------------------------------------------------------------
// D2/A1/B6: Private Entwürfe
// ---------------------------------------------------------------------------

test('D2: Der Entwurf der Selbsteinschätzung verlässt den Server nie, auch nicht an HR, und steht nicht im Verlauf', () => withHarness(async h => {
  const periodId = await openPeriod(h);
  const reviewId = reviewRow(h, periodId, ID.anna).id;
  assert.equal((await h.api('manager', 'PATCH', `/api/talent-review/reviews/${reviewId}/manager`, managerPayload(h))).status, 200);
  const draft = selfPayload({ performanceReason: `${SECRET} Leistung im Entwurf`, potentialReason: `${SECRET} Potenzial im Entwurf`, observations: `${SECRET} Beobachtung`, developmentFields: SECRET, nextSteps: SECRET });
  assert.equal((await h.api('anna', 'PATCH', `/api/talent-review/reviews/${reviewId}/self`, draft)).status, 200);

  const places = [
    ['manager', `/api/talent-review/reviews?periodId=${periodId}`],
    ['director', `/api/talent-review/reviews?periodId=${periodId}`],
    ['hr', `/api/talent-review/reviews?periodId=${periodId}`],
    ['bp', `/api/talent-review/reviews?periodId=${periodId}`],
    ['manager', `/api/talent-review/reviews/${reviewId}`],
    ['director', `/api/talent-review/reviews/${reviewId}`],
    ['hr', `/api/talent-review/reviews/${reviewId}`],
    ['manager', `/api/talent-review/matrix?periodId=${periodId}`],
    ['director', `/api/talent-review/matrix?periodId=${periodId}`],
    ['hr', `/api/talent-review/matrix?periodId=${periodId}`],
    ['manager', '/api/talent-review/dashboard/manager'],
    ['director', '/api/talent-review/dashboard/manager'],
    ['hr', `/api/talent-review/dashboard/hr?periodId=${periodId}`]
  ];
  for (const [person, url] of places) {
    const response = await h.api(person, 'GET', url);
    assert.equal(response.status, 200, `${person} ${url}`);
    const body = JSON.stringify(response.data);
    assert.ok(!body.includes(SECRET), `${person} liest den Entwurf über ${url}`);
    assert.ok(!/"self_(performance|potential)"/.test(body), `${person} bekommt Werte der Selbsteinschätzung über ${url}`);
  }
  // Auch die Person selbst bekommt ihren Entwurf nur über ihre eigene Seite zurück.
  const own = (await h.api('anna', 'GET', '/api/talent-review/self-reviews')).data.items.find(item => item.id === reviewId);
  assert.match(own.self.observations, new RegExp(SECRET));

  const historyText = JSON.stringify(h.db.prepare('SELECT old_value,new_value,reason FROM talent_review_history').all());
  assert.ok(!historyText.includes(SECRET), 'Der Entwurfstext steht im Verlauf');
  const auditText = JSON.stringify(h.db.prepare('SELECT old_values,new_values FROM audit_log').all());
  assert.ok(!auditText.includes(SECRET), 'Der Entwurfstext steht im Protokoll');

  // Eine ältere Datenbank enthält solche Zeilen noch. Sie bleiben liegen, gehen aber nicht mehr hinaus.
  h.db.prepare("INSERT INTO talent_review_history(entity_type,entity_id,field_name,old_value,new_value,actor_id) VALUES('talent_review',?,'self_draft_saved',?,?,?)").run(reviewId, JSON.stringify({ observations: SECRET }), JSON.stringify({ observations: SECRET }), ID.anna);
  for (const person of ['manager', 'director', 'hr']) {
    const body = JSON.stringify((await h.api(person, 'GET', `/api/talent-review/reviews/${reviewId}`)).data);
    assert.ok(!body.includes(SECRET), `${person} liest den Altbestand im Verlauf`);
    assert.ok(!body.includes('self_draft_saved'));
  }
}));

// ---------------------------------------------------------------------------
// D3/A2/B7/B21: Kalibrierung
// ---------------------------------------------------------------------------

test('D3/A2: Niemand kalibriert den eigenen Fall, auch nicht nach dem Abschluss', () => withHarness(async h => {
  const periodId = await openPeriod(h);
  // Malte ist Teilnehmer der Sitzung, in der sein eigener Fall liegt.
  const { reviewId, sessionId } = await reachCalibration(h, periodId, ID.manager, 'director', [ID.manager, ID.director]);
  const url = `/api/talent-review/reviews/${reviewId}/calibrate`;
  const body = () => calibrationBody(sessionId, reviewRow(h, periodId, ID.manager).version, { performance: 3, potential: 3 });
  const own = await h.api('manager', 'POST', url, body());
  assert.equal(own.status, 403);
  assert.equal(own.data.currentVersion, undefined);
  assert.equal(reviewRow(h, periodId, ID.manager).calibrated_performance, null);

  // Die eigene Einschätzung taucht in der Sitzung für die betroffene Person gar nicht auf.
  const sessionView = await h.api('manager', 'GET', `/api/talent-review/sessions/${sessionId}`);
  assert.equal(sessionView.status, 200);
  assert.equal(sessionView.data.cases.length, 0);
  assert.equal((await h.api('manager', 'GET', `/api/talent-review/reviews/${reviewId}`)).status, 403);

  assert.equal((await h.api('director', 'POST', url, body())).status, 200);
  assert.equal((await h.api('hr', 'POST', `/api/talent-review/reviews/${reviewId}/finalize`)).status, 200);
  assert.equal((await h.api('manager', 'POST', url, body())).status, 403, 'Auch nach dem Abschluss nicht');
  assert.equal(reviewRow(h, periodId, ID.manager).status, 'finalized');
}));

test('A2: Kalibrieren geht nur im Stand „in Kalibrierung“ und nur für Fälle dieser Sitzung', () => withHarness(async h => {
  const periodId = await openPeriod(h);
  const { reviewId, sessionId } = await reachCalibration(h, periodId, ID.anna, 'manager');
  const url = `/api/talent-review/reviews/${reviewId}/calibrate`;
  const version = () => reviewRow(h, periodId, ID.anna).version;
  assert.equal((await h.api('hr', 'POST', url, calibrationBody(sessionId, version()))).status, 200);
  const again = await h.api('hr', 'POST', url, calibrationBody(sessionId, version(), { performance: 2 }));
  assert.equal(again.status, 409, 'Ein kalibrierter Fall wird nicht einfach überschrieben');
  assert.equal(reviewRow(h, periodId, ID.anna).calibrated_performance, 1);
  assert.equal((await h.api('hr', 'POST', `/api/talent-review/reviews/${reviewId}/finalize`)).status, 200);
  const afterFinal = await h.api('hr', 'POST', url, calibrationBody(sessionId, version(), { performance: 2 }));
  assert.equal(afterFinal.status, 409, 'Nach dem Abschluss ist Schluss');
  assert.equal(reviewRow(h, periodId, ID.anna).status, 'finalized');

  // Ein Fall einer anderen Sitzung lässt sich hier nicht kalibrieren.
  const other = reviewRow(h, periodId, ID.ben).id;
  h.db.prepare("UPDATE talent_reviews SET status='in_calibration' WHERE id=?").run(other);
  const wrongSession = await h.api('hr', 'POST', `/api/talent-review/reviews/${other}/calibrate`, calibrationBody(sessionId, reviewRow(h, periodId, ID.ben).version));
  assert.equal(wrongSession.status, 403);
}));

test('H6: Eine Korrektur geht über eine weitere Sitzung, nicht am Abschluss vorbei', () => withHarness(async h => {
  const periodId = await openPeriod(h);
  const { reviewId, sessionId } = await reachCalibration(h, periodId, ID.anna, 'manager');
  assert.equal((await h.api('hr', 'POST', `/api/talent-review/reviews/${reviewId}/calibrate`, calibrationBody(sessionId, reviewRow(h, periodId, ID.anna).version))).status, 200);
  const second = await createSession(h, periodId, { title: 'Zweite Runde' });
  await addCase(h, second, reviewId);
  assert.equal(reviewRow(h, periodId, ID.anna).status, 'in_calibration');
  assert.equal(reviewRow(h, periodId, ID.anna).calibrated_performance, 1, 'Das bisherige Ergebnis bleibt, bis neu entschieden ist');
  await setSessionStatus(h, second, 'active');
  assert.equal((await h.api('hr', 'POST', `/api/talent-review/reviews/${reviewId}/calibrate`, calibrationBody(second, reviewRow(h, periodId, ID.anna).version, { performance: 2 }))).status, 200);
  assert.equal(reviewRow(h, periodId, ID.anna).calibrated_performance, 2);
}));

test('B7: Moderation und Teilnahme gibt es nur für passende Rollen', () => withHarness(async h => {
  const periodId = await openPeriod(h);
  const sessionBody = moderatorId => ({ periodId, title: `Runde ${moderatorId}`, sessionDate: '2026-10-15', moderatorId });
  assert.equal((await h.api('hr', 'POST', '/api/talent-review/sessions', sessionBody(ID.anna))).status, 400);
  const sessionId = await createSession(h, periodId, { moderatorId: ID.director });
  assert.equal((await h.api('hr', 'POST', `/api/talent-review/sessions/${sessionId}/participants`, { userId: ID.anna })).status, 400);
  const staff = h.deps.createUserAccount({ name: 'Sach Bearbeiter', email: 'sb@test.local', role: 'hr_staff', actor: { id: 1 } }).id;
  assert.equal((await h.api('hr', 'POST', `/api/talent-review/sessions/${sessionId}/participants`, { userId: staff })).status, 400);
  h.db.prepare('UPDATE users SET active=0 WHERE id=?').run(ID.clara);
  h.db.prepare("UPDATE users SET role='manager' WHERE id=?").run(ID.clara);
  assert.equal((await h.api('hr', 'POST', `/api/talent-review/sessions/${sessionId}/participants`, { userId: ID.clara })).status, 400, 'Gesperrte Konten nehmen nicht teil');
  assert.equal((await h.api('hr', 'POST', '/api/talent-review/sessions', sessionBody(ID.clara))).status, 400, 'Gesperrte Konten moderieren nicht');
}));

test('D3/B21: Wer in der Sitzung ist, liest den Fall dort, aber nur für die Dauer der Sitzung', () => withHarness(async h => {
  const periodId = await openPeriod(h);
  const reviewId = reviewRow(h, periodId, ID.clara).id;
  assert.equal((await h.api('clara', 'PATCH', `/api/talent-review/reviews/${reviewId}/self`, selfPayload())).status, 200);
  assert.equal((await h.api('clara', 'POST', `/api/talent-review/reviews/${reviewId}/self/submit`)).status, 200);
  await saveAndSubmit(h, 'director', reviewId);
  // Malte steht außerhalb von Claras Führungslinie.
  const sessionId = await createSession(h, periodId);
  await addParticipant(h, sessionId, ID.manager);
  await addCase(h, sessionId, reviewId, { moderatorNote: 'Bitte auf die Projektarbeit achten.' });

  const detailUrl = `/api/talent-review/reviews/${reviewId}`;
  assert.equal((await h.api('manager', 'GET', detailUrl)).status, 403, 'Vor Beginn der Sitzung kein Zugriff');
  const planned = await h.api('manager', 'GET', `/api/talent-review/sessions/${sessionId}`);
  assert.equal(planned.data.cases[0].canOpen, false);
  assert.equal(planned.data.cases[0].moderator_note, 'Bitte auf die Projektarbeit achten.', 'B20: Der Hinweis erreicht die Teilnehmenden');

  await setPeriodStatus(h, periodId, 'calibration');
  await setSessionStatus(h, sessionId, 'active');
  const during = await h.api('manager', 'GET', detailUrl);
  assert.equal(during.status, 200, 'Während der Sitzung lesbar');
  assert.equal(during.data.scope, 'session');
  assert.equal(during.data.permissions.canCalibrate, true);
  assert.deepEqual(during.data.calibrationSessions.map(item => item.id), [sessionId]);
  assert.equal(during.data.review.original_performance, 3);
  assert.equal(during.data.selfAssessment.performance, undefined, 'Die Selbsteinschätzung bleibt in der Führungslinie');
  assert.equal(during.data.support.career, undefined, 'Karrierewünsche gehören nicht in die Runde');
  assert.deepEqual(during.data.history, []);
  const running = await h.api('manager', 'GET', `/api/talent-review/sessions/${sessionId}`);
  assert.equal(running.data.cases[0].canOpen, true);
  assert.ok((await h.api('manager', 'GET', `/api/talent-review/reviews?periodId=${periodId}`)).data.items.some(item => item.id === reviewId));
  assert.ok((await h.api('manager', 'GET', `/api/talent-review/matrix?periodId=${periodId}&sessionId=${sessionId}`)).data.total >= 1);

  const version = reviewRow(h, periodId, ID.clara).version;
  assert.equal((await h.api('manager', 'POST', `${detailUrl}/calibrate`, calibrationBody(sessionId, version))).status, 200);

  await setSessionStatus(h, sessionId, 'completed');
  assert.equal((await h.api('manager', 'GET', detailUrl)).status, 403, 'Nach der Sitzung kein Zugriff mehr');
  assert.ok(!(await h.api('manager', 'GET', `/api/talent-review/reviews?periodId=${periodId}`)).data.items.some(item => item.id === reviewId));
  const ended = await h.api('manager', 'GET', `/api/talent-review/sessions/${sessionId}`);
  assert.equal(ended.data.cases.length, 0, 'Das Ergebnis bleibt nach der Sitzung nicht offen');
}));

test('D3: Unbefugte bekommen keine Hilfe zur aktuellen Version', () => withHarness(async h => {
  const periodId = await openPeriod(h);
  const { reviewId, sessionId } = await reachCalibration(h, periodId, ID.anna, 'manager');
  for (const person of ['ben', 'clara', 'bp', 'director']) {
    const response = await h.api(person, 'POST', `/api/talent-review/reviews/${reviewId}/calibrate`, calibrationBody(sessionId, 1));
    assert.equal(response.status, 403, person);
    assert.equal(response.data.currentVersion, undefined, person);
  }
  const stale = await h.api('hr', 'POST', `/api/talent-review/reviews/${reviewId}/calibrate`, calibrationBody(sessionId, 1));
  assert.equal(stale.status, 409);
  assert.equal(stale.data.currentVersion, undefined);
}));

test('H20: Ohne laufende Sitzung sagt die Einschätzung klar, warum nicht kalibriert werden kann', () => withHarness(async h => {
  const periodId = await openPeriod(h);
  const reviewId = reviewRow(h, periodId, ID.anna).id;
  await saveAndSubmit(h, 'manager', reviewId);
  const sessionId = await createSession(h, periodId);
  await addCase(h, sessionId, reviewId);
  await setPeriodStatus(h, periodId, 'calibration');
  const view = (await h.api('hr', 'GET', `/api/talent-review/reviews/${reviewId}`)).data;
  assert.equal(view.permissions.canCalibrate, false);
  assert.deepEqual(view.calibrationSessions, []);
  assert.match(view.calibrationHint, /keine Sitzung/);
  // Eine Sitzung startet erst, wenn die Periode in der Kalibrierung ist.
  const notYet = await openPeriod(h, 'Zweite Periode');
  const early = await createSession(h, notYet, { title: 'Zu früh' });
  assert.equal((await h.api('hr', 'PATCH', `/api/talent-review/sessions/${early}`, { status: 'active' })).status, 409);
}));

// ---------------------------------------------------------------------------
// D5/A4/H5/B3/B4: Zuständigkeit folgt der Führungslinie
// ---------------------------------------------------------------------------

test('D5: Nach dem Führungswechsel schreibt die neue Führungskraft, Aufgaben und Einschätzung ziehen mit', () => withHarness(async h => {
  const periodId = await openPeriod(h);
  const reviewId = reviewRow(h, periodId, ID.anna).id;
  assert.equal((await h.api('manager', 'PATCH', `/api/talent-review/reviews/${reviewId}/manager`, managerPayload(h, { nextSteps: 'Begonnener Entwurf' }))).status, 200);
  assert.equal(openTasks(h, 'talent_review_start', reviewId)[0].user_id, ID.manager);

  h.deps.changeManager(ID.anna, ID.clara);

  assert.equal(reviewRow(h, periodId, ID.anna).manager_id, ID.clara);
  const tasks = openTasks(h, 'talent_review_start', reviewId);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].user_id, ID.clara, 'Die Aufgabe liegt jetzt bei der neuen Führungskraft');
  assert.equal(openTasks(h, 'talent_review_self_assessment', reviewId)[0].user_id, ID.anna);

  assert.equal((await h.api('manager', 'PATCH', `/api/talent-review/reviews/${reviewId}/manager`, managerPayload(h))).status, 403, 'Die alte Führungskraft schreibt nicht mehr');
  assert.equal((await h.api('manager', 'GET', `/api/talent-review/reviews/${reviewId}`)).status, 403, 'und liest auch nicht mehr');
  // Clara ist hier Mitarbeiterin mit eigener Führungsaufgabe: Es zählt die Linie, nicht die Rolle.
  const view = (await h.api('clara', 'GET', `/api/talent-review/reviews/${reviewId}`)).data;
  assert.equal(view.permissions.canEdit, true);
  assert.equal(view.review.next_steps, 'Begonnener Entwurf', 'Der begonnene Entwurf geht nicht verloren');
  await saveAndSubmit(h, 'clara', reviewId);
  assert.equal(openTasks(h, 'talent_review_start', reviewId).length, 0);
  assert.equal(h.db.prepare("SELECT field_name FROM talent_review_history WHERE entity_id=? AND field_name='manager_changed'").all(reviewId).length, 1);
}));

test('D5: Abgeschlossene Einschätzungen behalten die damalige Führungskraft', () => withHarness(async h => {
  const periodId = await openPeriod(h);
  h.db.prepare("UPDATE talent_reviews SET status='finalized' WHERE period_id=? AND employee_id=?").run(periodId, ID.anna);
  h.deps.changeManager(ID.anna, ID.director);
  assert.equal(reviewRow(h, periodId, ID.anna).manager_id, ID.manager);
}));

test('D5: Ohne Führungskraft enden die Schreibaufgaben, mit einer neuen beginnen sie wieder', () => withHarness(async h => {
  const periodId = await openPeriod(h);
  const reviewId = reviewRow(h, periodId, ID.anna).id;
  h.deps.changeManager(ID.anna, null);
  assert.equal(openTasks(h, 'talent_review_start', reviewId).length, 0);
  assert.equal((await h.api('manager', 'PATCH', `/api/talent-review/reviews/${reviewId}/manager`, managerPayload(h))).status, 403);
  h.deps.changeManager(ID.anna, ID.manager);
  assert.equal(openTasks(h, 'talent_review_start', reviewId)[0].user_id, ID.manager);
}));

test('B4/H5: HR als direkte Führungskraft schreibt die Einschätzung und die Periode lässt sich abschließen', () => withHarness(async h => {
  h.deps.changeManager(ID.director, ID.hr);
  const periodId = await openPeriod(h);
  const reviewId = reviewRow(h, periodId, ID.director).id;
  assert.equal(openTasks(h, 'talent_review_start', reviewId)[0].user_id, ID.hr);
  const view = (await h.api('hr', 'GET', `/api/talent-review/reviews/${reviewId}`)).data;
  assert.equal(view.permissions.canEdit, true);
  await saveAndSubmit(h, 'hr', reviewId);
  const others = { [ID.manager]: 'director', [ID.anna]: 'manager', [ID.ben]: 'manager', [ID.clara]: 'director' };
  for (const [employeeId, manager] of Object.entries(others)) await saveAndSubmit(h, manager, reviewRow(h, periodId, Number(employeeId)).id);
  const sessionId = await createSession(h, periodId);
  const all = h.db.prepare('SELECT id,employee_id FROM talent_reviews WHERE period_id=?').all(periodId);
  for (const review of all) await addCase(h, sessionId, review.id);
  await setPeriodStatus(h, periodId, 'calibration');
  await setSessionStatus(h, sessionId, 'active');
  for (const review of all) {
    const { version } = reviewRow(h, periodId, review.employee_id);
    const calibrated = await h.api('hr', 'POST', `/api/talent-review/reviews/${review.id}/calibrate`, calibrationBody(sessionId, version, { performance: 3, potential: 2 }));
    assert.equal(calibrated.status, 200, JSON.stringify(calibrated.data));
    assert.equal((await h.api('hr', 'POST', `/api/talent-review/reviews/${review.id}/finalize`)).status, 200);
  }
  await setPeriodStatus(h, periodId, 'completed');
}));

test('D5: Beim Start zieht eine ältere Datenbank nach, und ohne Anmeldung am Wechsel holt das Modul es nach', async () => {
  await withHarness(async h => {
    const periodId = await openPeriod(h);
    const reviewId = reviewRow(h, periodId, ID.anna).id;
    h.db.prepare('UPDATE users SET manager_id=? WHERE id=?').run(ID.director, ID.anna);
    h.instance.initialize();
    assert.equal(reviewRow(h, periodId, ID.anna).manager_id, ID.director);
    assert.equal(openTasks(h, 'talent_review_start', reviewId)[0].user_id, ID.director);
  });
  await withHarness(async h => {
    const periodId = await openPeriod(h);
    const reviewId = reviewRow(h, periodId, ID.anna).id;
    h.deps.changeManager(ID.anna, ID.director);
    assert.equal((await h.api('director', 'PATCH', `/api/talent-review/reviews/${reviewId}/manager`, managerPayload(h))).status, 200);
    assert.equal(openTasks(h, 'talent_review_start', reviewId)[0].user_id, ID.director);
  }, { deps: { onManagerChanged: undefined } });
});

// ---------------------------------------------------------------------------
// H6/B5: Wege zwischen den Ständen der Periode
// ---------------------------------------------------------------------------

test('H6: Offene Einschätzungen werden vorher genannt, und aus der Kalibrierung führt ein Weg zurück', () => withHarness(async h => {
  const periodId = await openPeriod(h);
  const anna = reviewRow(h, periodId, ID.anna).id;
  const ben = reviewRow(h, periodId, ID.ben).id;
  await saveAndSubmit(h, 'manager', anna);
  assert.equal((await h.api('ben', 'PATCH', `/api/talent-review/reviews/${ben}/self`, selfPayload())).status, 200);

  assert.equal((await h.api('manager', 'GET', `/api/talent-review/periods/${periodId}/open-items`)).status, 403);
  const open = (await h.api('hr', 'GET', `/api/talent-review/periods/${periodId}/open-items`)).data;
  assert.deepEqual(open.notSubmitted.map(item => item.employee_id).sort(), [ID.manager, ID.ben, ID.clara].sort());
  assert.equal(open.selfNotSubmitted, 4);
  assert.deepEqual(open.notInSession.map(item => item.id), [anna]);
  assert.ok(!JSON.stringify(open).includes('Wirkung im Team'), 'Auch hier kein Entwurfstext');

  await setPeriodStatus(h, periodId, 'calibration');
  assert.equal(openTasks(h, 'talent_review_start', ben).length, 0, 'In der Kalibrierung kann niemand mehr schreiben, also keine Aufgabe');
  assert.equal(openTasks(h, 'talent_review_self_assessment', ben).length, 0);
  assert.equal((await h.api('manager', 'PATCH', `/api/talent-review/reviews/${ben}/manager`, managerPayload(h))).status, 409);

  await setPeriodStatus(h, periodId, 'open');
  assert.equal(openTasks(h, 'talent_review_start', ben)[0].user_id, ID.manager, 'Zurück in der offenen Periode gibt es die Aufgabe wieder');
  assert.equal(openTasks(h, 'talent_review_self_assessment', ben)[0].user_id, ID.ben);
  assert.equal(openTasks(h, 'talent_review_start', anna).length, 0, 'Eingereichtes braucht keine neue Aufgabe');
  assert.equal((await h.api('manager', 'PATCH', `/api/talent-review/reviews/${ben}/manager`, managerPayload(h))).status, 200);
  assert.equal(reviewRow(h, periodId, ID.ben).self_status, 'employee_draft', 'Der private Entwurf bleibt erhalten');
}));

test('B5: Nur sinnvolle Übergänge sind erlaubt, Archiviert ist endgültig', () => withHarness(async h => {
  const periodId = await createPeriod(h);
  const refused = async status => assert.equal((await h.api('hr', 'PATCH', `/api/talent-review/periods/${periodId}/status`, { status })).status, 409, status);
  await refused('calibration');
  await refused('completed');
  await setPeriodStatus(h, periodId, 'open');
  await refused('completed');
  await refused('draft');
  await setPeriodStatus(h, periodId, 'calibration');
  await refused('draft');
  const blocked = await h.api('hr', 'PATCH', `/api/talent-review/periods/${periodId}/status`, { status: 'completed' });
  assert.equal(blocked.status, 409);
  assert.match(blocked.data.error, /Malte Manager/, 'Die Meldung nennt, wer noch offen ist');
  assert.equal(blocked.data.open.length, 4);
  await setPeriodStatus(h, periodId, 'archived');
  for (const status of ['draft', 'open', 'calibration', 'completed', 'archived']) await refused(status);
  const listed = (await h.api('hr', 'GET', '/api/talent-review/periods')).data.items.find(item => item.id === periodId);
  assert.deepEqual(listed.nextStatuses, []);
}));

test('H6: Wer ausgeschieden ist oder keine Führungskraft mehr hat, blockiert den Abschluss nicht', () => withHarness(async h => {
  const periodId = await openPeriod(h);
  const finalized = [ID.manager, ID.anna];
  for (const employeeId of finalized) h.db.prepare("UPDATE talent_reviews SET status='finalized' WHERE period_id=? AND employee_id=?").run(periodId, employeeId);
  h.db.prepare('UPDATE users SET active=0 WHERE id=?').run(ID.ben);
  h.deps.changeManager(ID.clara, null);
  await setPeriodStatus(h, periodId, 'calibration');
  await setPeriodStatus(h, periodId, 'completed');
}));

// ---------------------------------------------------------------------------
// M13: Unvollständige Entwürfe
// ---------------------------------------------------------------------------

test('M13: Entwürfe lassen sich unvollständig speichern, geprüft wird beim Einreichen', () => withHarness(async h => {
  const periodId = await openPeriod(h);
  const reviewId = reviewRow(h, periodId, ID.anna).id;
  const criteria = h.db.prepare('SELECT id FROM talent_review_potential_criteria ORDER BY display_order').all();

  // Führungskraft: nur eine Note, ein kurzer Satz, Notizen ohne Note.
  const partial = await h.api('manager', 'PATCH', `/api/talent-review/reviews/${reviewId}/manager`, {
    performance: 2,
    potential: '',
    performanceReason: 'zu kurz',
    criteria: [
      { criterionId: criteria[0].id, rating: 4, comment: 'Mit Note' },
      { criterionId: criteria[1].id, rating: '', comment: 'Notiz ohne Note' }
    ]
  });
  assert.equal(partial.status, 200, JSON.stringify(partial.data));
  const row = reviewRow(h, periodId, ID.anna);
  assert.equal(row.status, 'manager_draft');
  assert.equal(row.original_performance, 2);
  assert.equal(row.original_potential, null);
  assert.equal(row.performance_reason, 'zu kurz');
  const editing = (await h.api('manager', 'GET', `/api/talent-review/reviews/${reviewId}`)).data;
  assert.equal(editing.ratings.length, 1);
  assert.equal(editing.unratedComments[criteria[1].id], 'Notiz ohne Note', 'Eine Notiz ohne Note geht nicht verloren');
  assert.deepEqual(editing.limits, { reason: 20, observations: 10 });
  assert.ok(!('criteria_draft' in editing.review));

  const refused = await h.api('manager', 'POST', `/api/talent-review/reviews/${reviewId}/submit`);
  assert.equal(refused.status, 409);
  assert.ok(refused.data.missing.includes('Potenzial auswählen'));
  assert.ok(refused.data.missing.some(item => /Begründung zur Leistung: noch 13 Zeichen/.test(item)), JSON.stringify(refused.data.missing));
  assert.ok(refused.data.missing.some(item => /7 von 8/.test(item)), JSON.stringify(refused.data.missing));
  assert.match(refused.data.error, /fehlt noch/);

  // Eine zurückgenommene Note verschwindet, die Notiz bleibt.
  await h.api('manager', 'PATCH', `/api/talent-review/reviews/${reviewId}/manager`, { criteria: [{ criterionId: criteria[0].id, rating: '', comment: 'Note zurückgenommen' }] });
  const cleared = (await h.api('manager', 'GET', `/api/talent-review/reviews/${reviewId}`)).data;
  assert.equal(cleared.ratings.length, 0);
  assert.equal(cleared.unratedComments[criteria[0].id], 'Note zurückgenommen');

  assert.equal((await h.api('manager', 'PATCH', `/api/talent-review/reviews/${reviewId}/manager`, { performance: 7 })).status, 400, 'Werte außerhalb der Skala bleiben ungültig');
  assert.equal((await h.api('manager', 'PATCH', `/api/talent-review/reviews/${reviewId}/manager`, { criteria: [{ criterionId: criteria[0].id, rating: 9 }] })).status, 400);
  await saveAndSubmit(h, 'manager', reviewId);

  // Selbsteinschätzung: leerer Entwurf, dann kurzer Text.
  const self = `/api/talent-review/reviews/${reviewId}/self`;
  assert.equal((await h.api('anna', 'PATCH', self, { observations: 'kurz' })).status, 200);
  assert.equal(reviewRow(h, periodId, ID.anna).self_status, 'employee_draft');
  const notYet = await h.api('anna', 'POST', `${self}/submit`);
  assert.equal(notYet.status, 409);
  assert.ok(notYet.data.missing.includes('Leistung auswählen'));
  assert.ok(notYet.data.missing.some(item => /Erfolge und Wirkung: noch 6 Zeichen/.test(item)), JSON.stringify(notYet.data.missing));
  const limits = (await h.api('anna', 'GET', '/api/talent-review/self-reviews')).data;
  assert.deepEqual(limits.limits, { reason: 20, observations: 10 });
  assert.equal((await h.api('anna', 'PATCH', self, { performance: 'abc' })).status, 400);
  assert.equal((await h.api('anna', 'PATCH', self, selfPayload())).status, 200);
  assert.equal((await h.api('anna', 'POST', `${self}/submit`)).status, 200);
}));

// ---------------------------------------------------------------------------
// D10/A15: Die Ebene darüber
// ---------------------------------------------------------------------------

test('D10: Die nächsthöhere Ebene sieht Entwürfe der Führungskraft erst ab dem Einreichen', () => withHarness(async h => {
  const periodId = await openPeriod(h);
  const reviewId = reviewRow(h, periodId, ID.anna).id;
  await h.api('manager', 'PATCH', `/api/talent-review/reviews/${reviewId}/manager`, managerPayload(h, { performanceReason: `${SECRET} der Führungskraft im Entwurf` }));
  assert.equal((await h.api('anna', 'PATCH', `/api/talent-review/reviews/${reviewId}/self`, selfPayload())).status, 200);
  assert.equal((await h.api('anna', 'POST', `/api/talent-review/reviews/${reviewId}/self/submit`)).status, 200);

  const list = (await h.api('director', 'GET', `/api/talent-review/reviews?periodId=${periodId}`)).data.items.find(item => item.id === reviewId);
  assert.equal(list.status, 'manager_draft', 'Den Stand darf sie sehen');
  assert.equal(list.boxKey, undefined);
  assert.equal(list.performance, undefined);
  const detail = await h.api('director', 'GET', `/api/talent-review/reviews/${reviewId}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.data.scope, 'status');
  assert.ok(!JSON.stringify(detail.data).includes(SECRET));
  assert.equal(detail.data.review.original_performance, undefined);
  assert.deepEqual(detail.data.ratings, []);
  assert.equal(detail.data.selfAssessment.performance, undefined, 'Auch die Selbsteinschätzung erst ab dem Einreichen');
  assert.equal((await h.api('director', 'GET', `/api/talent-review/matrix?periodId=${periodId}`)).data.total, 0);
  assert.ok(!detail.data.history.some(item => item.field_name === 'manager_draft_saved'));

  // Die zuständige Führungskraft und HR lesen den Entwurf weiter.
  assert.ok(JSON.stringify((await h.api('manager', 'GET', `/api/talent-review/reviews/${reviewId}`)).data).includes(SECRET));
  assert.ok(JSON.stringify((await h.api('hr', 'GET', `/api/talent-review/reviews/${reviewId}`)).data).includes(SECRET));

  assert.equal((await h.api('manager', 'POST', `/api/talent-review/reviews/${reviewId}/submit`)).status, 200);
  const submitted = (await h.api('director', 'GET', `/api/talent-review/reviews/${reviewId}`)).data;
  assert.equal(submitted.scope, 'full');
  assert.match(submitted.review.performance_reason, new RegExp(SECRET));
  assert.equal(submitted.selfAssessment.performance, 3);
  assert.equal((await h.api('director', 'GET', `/api/talent-review/matrix?periodId=${periodId}`)).data.total, 1);

  // Zurückgegeben ist wieder ein Entwurf.
  assert.equal((await h.api('hr', 'POST', `/api/talent-review/reviews/${reviewId}/return`, { reason: 'Bitte die Begründung noch einmal schärfen.' })).status, 200);
  assert.equal((await h.api('director', 'GET', `/api/talent-review/reviews/${reviewId}`)).data.scope, 'status');
}));

// ---------------------------------------------------------------------------
// B19, B20, A18, H17, M20
// ---------------------------------------------------------------------------

test('B19: Der Filter „Organisation“ wirkt und „Führungskraft“ meint die heutige', () => withHarness(async h => {
  const periodId = await openPeriod(h);
  for (const [employeeId, manager] of [[ID.anna, 'manager'], [ID.ben, 'manager'], [ID.clara, 'director'], [ID.manager, 'director']]) {
    await h.api(manager, 'PATCH', `/api/talent-review/reviews/${reviewRow(h, periodId, employeeId).id}/manager`, managerPayload(h));
  }
  const names = async query => {
    const { data } = await h.api('hr', 'GET', `/api/talent-review/matrix?periodId=${periodId}&${query}`);
    return Object.values(data.boxes).flatMap(box => box.reviews.map(item => item.employee_id)).sort();
  };
  assert.deepEqual(await names(`organizationManagerId=${ID.manager}`), [ID.anna, ID.ben]);
  assert.deepEqual(await names(`organizationManagerId=${ID.director}`), [ID.manager, ID.anna, ID.ben, ID.clara].sort());
  assert.deepEqual(await names(`managerId=${ID.manager}`), [ID.anna, ID.ben]);
  h.deps.changeManager(ID.anna, ID.director);
  assert.deepEqual(await names(`managerId=${ID.manager}`), [ID.ben]);
  assert.deepEqual(await names(`managerId=${ID.director}`), [ID.manager, ID.anna, ID.clara].sort());
  // Eine Führungskraft kommt nicht über den Filter an fremde Bereiche.
  const foreign = await h.api('manager', 'GET', `/api/talent-review/matrix?periodId=${periodId}&organizationManagerId=${ID.director}`);
  assert.equal(foreign.data.total, 0);
}));

test('B20: Entwicklungsplan und Entfernungsgrund bleiben erhalten und sind sichtbar', () => withHarness(async h => {
  const periodId = await openPeriod(h);
  const pool = (await h.api('hr', 'POST', '/api/talent-pools', { name: 'Testpool', responsibleId: ID.hr })).data.id;
  const proposal = await h.api('manager', 'POST', `/api/talent-pools/${pool}/members`, { employeeId: ID.anna, periodId, reason: 'Die Person zeigt nachvollziehbar Entwicklungspotenzial.', developmentPlan: 'Mentoring im nächsten Halbjahr' });
  assert.equal(proposal.status, 201);
  const url = `/api/talent-pools/memberships/${proposal.data.id}`;
  assert.equal((await h.api('hr', 'PATCH', url, { status: 'active' })).status, 200);
  const member = async person => (await h.api(person, 'GET', `/api/talent-pools/${pool}/members`)).data.items[0];
  assert.equal((await member('hr')).development_plan, 'Mentoring im nächsten Halbjahr', 'Der Statuswechsel löscht den Plan nicht');
  assert.equal((await member('manager')).development_plan, 'Mentoring im nächsten Halbjahr');
  assert.equal((await h.api('hr', 'PATCH', url, { status: 'removed', reason: 'kurz' })).status, 400);
  assert.equal((await h.api('hr', 'PATCH', url, { status: 'removed', reason: 'Der Schwerpunkt des Pools hat sich geändert.' })).status, 200);
  assert.equal((await member('hr')).removed_reason, 'Der Schwerpunkt des Pools hat sich geändert.');
  assert.equal((await member('hr')).development_plan, 'Mentoring im nächsten Halbjahr');
}));

test('A18: Führungskräfte sehen die Talentpools und können vorschlagen, nur nicht sich selbst', () => withHarness(async h => {
  const pool = (await h.api('hr', 'POST', '/api/talent-pools', { name: 'Offener Pool', responsibleId: ID.hr })).data.id;
  const inactive = (await h.api('hr', 'POST', '/api/talent-pools', { name: 'Alter Pool', responsibleId: ID.hr })).data.id;
  await h.api('hr', 'PATCH', `/api/talent-pools/${inactive}`, { active: false });

  const pools = await h.api('manager', 'GET', '/api/talent-pools');
  assert.deepEqual(pools.data.items.map(item => item.id), [pool], 'Auch ohne Mitglied aus dem eigenen Team');
  assert.equal(pools.data.items[0].member_count, 0);
  const members = await h.api('manager', 'GET', `/api/talent-pools/${pool}/members`);
  assert.equal(members.status, 200);
  assert.equal(members.data.canPropose, true);
  assert.equal(members.data.canDecide, false);

  const reason = 'Diese Begründung ist lang genug für den Vorschlag.';
  assert.equal((await h.api('manager', 'POST', `/api/talent-pools/${pool}/members`, { employeeId: ID.manager, reason })).status, 403, 'Sich selbst vorschlagen geht nicht');
  assert.equal((await h.api('hr', 'POST', `/api/talent-pools/${pool}/members`, { employeeId: ID.hr, reason })).status, 403, 'Auch HR nicht');
  assert.equal((await h.api('anna', 'POST', `/api/talent-pools/${pool}/members`, { employeeId: ID.anna, reason })).status, 403);
  assert.equal((await h.api('director', 'POST', `/api/talent-pools/${pool}/members`, { employeeId: ID.anna, reason })).status, 403, 'Nur die direkte Führungskraft schlägt vor');

  // Beschäftigte ohne Führungsaufgabe sehen weder Pools noch Mitglieder.
  assert.deepEqual((await h.api('anna', 'GET', '/api/talent-pools')).data.items, []);
  assert.equal((await h.api('anna', 'GET', `/api/talent-pools/${pool}/members`)).status, 403);

  // Über die eigene Mitgliedschaft erfährt niemand etwas.
  assert.equal((await h.api('director', 'POST', `/api/talent-pools/${pool}/members`, { employeeId: ID.manager, reason })).status, 201);
  const ownView = (await h.api('manager', 'GET', `/api/talent-pools/${pool}/members`)).data.items;
  assert.ok(!ownView.some(item => item.employee_id === ID.manager));
}));

test('H17: In den Beispieldaten passt die Freigabe von 2025 zu dem, was Beschäftigte sehen', () => withHarness(async h => {
  h.instance.seed();
  const historical = () => h.db.prepare("SELECT * FROM talent_review_periods WHERE name='Talent Review 2025'").get();
  assert.equal(historical().employee_results_visible, 1);
  assert.ok((await h.api('anna', 'GET', '/api/talent-review/me')).data.reviews.length >= 1);
  // Nimmt HR die Freigabe zurück, bleibt das auch nach einem Neustart so.
  assert.equal((await h.api('hr', 'PATCH', `/api/talent-review/periods/${historical().id}/release`, { employeeVisible: false })).status, 200);
  h.instance.seed();
  assert.equal(historical().employee_results_visible, 0);
  assert.equal((await h.api('anna', 'GET', '/api/talent-review/me')).data.reviews.length, 0);
}));

test('M20: Beschäftigte bekommen ihr Ergebnis, aber nichts aus der Kalibrierung', () => withHarness(async h => {
  const earlier = await openPeriod(h, 'Periode unsichtbar');
  h.db.prepare("UPDATE talent_reviews SET status='finalized',original_performance=1,original_potential=1,employee_visible=0 WHERE period_id=?").run(earlier);
  await setPeriodStatus(h, earlier, 'calibration');
  await setPeriodStatus(h, earlier, 'completed');
  const periodId = await openPeriod(h);
  const reviewId = reviewRow(h, periodId, ID.anna).id;
  assert.equal((await h.api('anna', 'PATCH', `/api/talent-review/reviews/${reviewId}/self`, selfPayload())).status, 200);
  assert.equal((await h.api('anna', 'POST', `/api/talent-review/reviews/${reviewId}/self/submit`)).status, 200);
  await saveAndSubmit(h, 'manager', reviewId, { performance: 3, potential: 3 });
  const sessionId = await createSession(h, periodId);
  await addCase(h, sessionId, reviewId, { moderatorNote: 'Nur für die Runde' });
  await setPeriodStatus(h, periodId, 'calibration');
  await setSessionStatus(h, sessionId, 'active');
  const calibrationReason = 'VERTRAULICH: Im Vergleich mit Ben hat die Runde die Note gesenkt.';
  assert.equal((await h.api('hr', 'POST', `/api/talent-review/reviews/${reviewId}/calibrate`, calibrationBody(sessionId, reviewRow(h, periodId, ID.anna).version, { performance: 2, potential: 2, reason: calibrationReason }))).status, 200);
  assert.equal((await h.api('hr', 'POST', `/api/talent-review/reviews/${reviewId}/finalize`)).status, 200);
  h.db.prepare("UPDATE talent_reviews SET status='finalized' WHERE period_id=? AND id!=?").run(periodId, reviewId);
  await setPeriodStatus(h, periodId, 'completed');
  assert.equal((await h.api('anna', 'GET', `/api/talent-review/reviews/${reviewId}`)).status, 403);
  assert.equal((await h.api('hr', 'PATCH', `/api/talent-review/periods/${periodId}/release`, { employeeVisible: true })).status, 200);

  const result = await h.api('anna', 'GET', `/api/talent-review/reviews/${reviewId}`);
  assert.equal(result.status, 200);
  assert.equal(result.data.scope, 'employee');
  const body = JSON.stringify(result.data);
  assert.ok(!body.includes('VERTRAULICH'), 'Die Begründung der Kalibrierung bleibt in der Runde');
  for (const hidden of ['calibration_reason', 'calibrated_by', 'calibrated_performance', 'original_performance', 'return_reason', 'version', 'moderator_note']) {
    assert.ok(!body.includes(`"${hidden}"`), hidden);
  }
  assert.equal(result.data.review.performance, 2);
  assert.equal(result.data.review.potential, 2);
  assert.ok(result.data.review.boxLabel);
  assert.deepEqual(result.data.history, []);
  assert.equal(result.data.selfAssessment.performance, 3, 'Die eigene Abgabe sieht die Person');
  assert.deepEqual(result.data.previous, [], 'Unveröffentlichte Vorjahre bleiben verborgen');
  assert.deepEqual(result.data.permissions, { canEdit: false, canReturn: false, canFinalize: false, canCalibrate: false, canCreateDecision: false });
  const own = (await h.api('anna', 'GET', `/api/talent-review/reviews?periodId=${periodId}`)).data.items;
  assert.deepEqual(own.map(item => item.id), [reviewId]);
  assert.ok(!JSON.stringify(own).includes('VERTRAULICH'));
}));

// ---------------------------------------------------------------------------
// D7/A12/H12/B18: Aufgaben
// ---------------------------------------------------------------------------

test('D7: Aufgaben nennen Person und Periode und tragen die echte Frist', () => withHarness(async h => {
  const periodId = await openPeriod(h, 'Talent Review 2026');
  const anna = reviewRow(h, periodId, ID.anna).id;
  const start = openTasks(h, 'talent_review_start', anna)[0];
  assert.match(start.title, /Anna Ahrens/);
  assert.match(start.title, /Talent Review 2026/);
  assert.equal(start.due_date, '2026-11-30');
  const self = openTasks(h, 'talent_review_self_assessment', anna)[0];
  assert.match(self.title, /Talent Review 2026/);
  assert.equal(self.due_date, '2026-11-30');
  await saveAndSubmit(h, 'manager', anna);
  const hrTask = openTasks(h, 'talent_review_submitted', anna).find(task => task.user_id === ID.hr);
  assert.match(hrTask.title, /Anna Ahrens/);
  assert.equal(hrTask.due_date, '2026-12-31');
  const sessionId = await createSession(h, periodId, { moderatorId: ID.director });
  const moderator = openTasks(h, 'talent_review_calibration', sessionId)[0];
  assert.match(moderator.title, /Testsitzung/);
  assert.equal(moderator.due_date, '2026-10-15');
  const pool = (await h.api('hr', 'POST', '/api/talent-pools', { name: 'Testpool', responsibleId: ID.hr })).data.id;
  const proposal = (await h.api('manager', 'POST', `/api/talent-pools/${pool}/members`, { employeeId: ID.ben, periodId, reason: 'Die Person zeigt nachvollziehbar Entwicklungspotenzial.' })).data.id;
  const poolTask = openTasks(h, 'talent_pool_proposal', proposal)[0];
  assert.match(poolTask.title, /Ben Berg/);
  assert.match(poolTask.title, /Testpool/);
  assert.equal(poolTask.user_id, ID.hr);
  const decision = (await h.api('hr', 'POST', '/api/development-decisions', { reviewId: anna, decisionType: 'mentoring', description: 'Mentoring für die nächste Aufgabe aufsetzen.', responsibleId: ID.manager, targetDate: '2026-12-15' })).data.id;
  const decisionTask = openTasks(h, 'development_decision', decision)[0];
  assert.match(decisionTask.title, /Anna Ahrens/);
  assert.equal(decisionTask.due_date, '2026-12-15');
  // Eine Aufgabe, die nicht hinführt, nützt nichts: Die verantwortliche Person muss die Maßnahme öffnen können.
  assert.ok((await h.api('manager', 'GET', '/api/development-decisions')).data.items.some(item => item.id === decision && item.canEdit));
  assert.equal((await h.api('hr', 'GET', `/api/talent-pools/memberships/${proposal}`)).data.poolId, pool);
  assert.equal((await h.api('manager', 'GET', `/api/talent-pools/memberships/${proposal}`)).status, 403);
}));

test('B18: Aufgaben schließen sich, wenn der Vorgang erledigt oder hinfällig ist', () => withHarness(async h => {
  const periodId = await openPeriod(h);
  const anna = reviewRow(h, periodId, ID.anna).id;
  await saveAndSubmit(h, 'manager', anna);
  assert.equal(openTasks(h, 'talent_review_start', anna).length, 0, 'Die erledigte Einreichung schließt „beginnen“');

  // Talentpool: Die Entscheidung schließt den Vorschlag.
  const pool = (await h.api('hr', 'POST', '/api/talent-pools', { name: 'Testpool', responsibleId: ID.hr })).data.id;
  const proposal = (await h.api('manager', 'POST', `/api/talent-pools/${pool}/members`, { employeeId: ID.ben, periodId, reason: 'Die Person zeigt nachvollziehbar Entwicklungspotenzial.' })).data.id;
  assert.equal(openTasks(h, 'talent_pool_proposal', proposal).length, 1);
  assert.equal((await h.api('hr', 'PATCH', `/api/talent-pools/memberships/${proposal}`, { status: 'active' })).status, 200);
  assert.equal(openTasks(h, 'talent_pool_proposal', proposal).length, 0);

  // Maßnahme: Der Abschluss schließt die Aufgabe, ein Wiederaufnehmen öffnet sie.
  const decision = (await h.api('hr', 'POST', '/api/development-decisions', { reviewId: anna, decisionType: 'mentoring', description: 'Mentoring für die nächste Aufgabe aufsetzen.', responsibleId: ID.manager, targetDate: '2026-12-15' })).data.id;
  assert.equal(openTasks(h, 'development_decision', decision).length, 1);
  assert.equal((await h.api('manager', 'PATCH', `/api/development-decisions/${decision}`, { status: 'completed' })).status, 200);
  assert.equal(openTasks(h, 'development_decision', decision).length, 0);
  assert.equal((await h.api('manager', 'PATCH', `/api/development-decisions/${decision}`, { status: 'in_progress' })).status, 200);
  assert.equal(openTasks(h, 'development_decision', decision).length, 1);

  // Sitzung: Absagen schließt die Einladungen.
  const cancelled = await createSession(h, periodId, { title: 'Abgesagt' });
  await addParticipant(h, cancelled, ID.director);
  assert.equal(openTasks(h, 'talent_review_calibration', cancelled).length, 2);
  await setSessionStatus(h, cancelled, 'cancelled');
  assert.equal(openTasks(h, 'talent_review_calibration', cancelled).length, 0);

  // Archivieren beendet alles, was an der Periode hängt.
  const ben = reviewRow(h, periodId, ID.ben).id;
  const session = await createSession(h, periodId, { title: 'Offen geblieben' });
  await setPeriodStatus(h, periodId, 'archived');
  assert.equal(openTasks(h, 'talent_review_start', ben).length, 0);
  assert.equal(openTasks(h, 'talent_review_self_assessment', ben).length, 0);
  assert.equal(openTasks(h, 'talent_review_submitted', anna).length, 0);
  assert.equal(openTasks(h, 'talent_review_calibration', session).length, 0);
  assert.equal(openTasks(h, 'development_decision', decision).length, 0);
  assert.equal(h.db.prepare("SELECT status FROM talent_review_sessions WHERE id=?").get(session).status, 'cancelled', 'Eine nie begonnene Sitzung gilt als abgesagt');
}));

test('B18: Das Ergebnis wird erst zur Aufgabe, wenn die Person es sehen kann, und schließt sich beim Ansehen', () => withHarness(async h => {
  const periodId = await openPeriod(h);
  const { reviewId, sessionId } = await reachCalibration(h, periodId, ID.anna, 'manager');
  assert.equal((await h.api('hr', 'POST', `/api/talent-review/reviews/${reviewId}/calibrate`, calibrationBody(sessionId, reviewRow(h, periodId, ID.anna).version))).status, 200);
  assert.equal((await h.api('hr', 'POST', `/api/talent-review/reviews/${reviewId}/finalize`)).status, 200);
  assert.equal(openTasks(h, 'talent_review_finalized', reviewId).length, 0, 'Noch nicht freigegeben: Der Knopf führte ins Leere');
  h.db.prepare("UPDATE talent_reviews SET status='finalized' WHERE period_id=? AND id!=?").run(periodId, reviewId);
  await setPeriodStatus(h, periodId, 'completed');
  assert.equal(h.db.prepare('SELECT status FROM talent_review_sessions WHERE id=?').get(sessionId).status, 'completed', 'Mit der Periode endet auch die Sitzung');

  assert.equal((await h.api('hr', 'PATCH', `/api/talent-review/periods/${periodId}/release`, { employeeVisible: true })).status, 200);
  const notice = openTasks(h, 'talent_review_finalized', reviewId);
  assert.equal(notice.length, 1);
  assert.equal(notice[0].user_id, ID.anna);
  assert.equal((await h.api('manager', 'GET', `/api/talent-review/reviews/${reviewId}`)).status, 200);
  assert.equal(openTasks(h, 'talent_review_finalized', reviewId).length, 1, 'Das Lesen durch andere schließt nichts');
  assert.equal((await h.api('anna', 'GET', `/api/talent-review/reviews/${reviewId}`)).status, 200);
  assert.equal(openTasks(h, 'talent_review_finalized', reviewId).length, 0);

  // Wird die Freigabe zurückgenommen, gibt es nichts mehr anzusehen.
  await h.api('hr', 'PATCH', `/api/talent-review/periods/${periodId}/release`, { employeeVisible: false });
  await h.api('hr', 'PATCH', `/api/talent-review/periods/${periodId}/release`, { employeeVisible: true });
  assert.equal(openTasks(h, 'talent_review_finalized', reviewId).length, 1);
  await h.api('hr', 'PATCH', `/api/talent-review/periods/${periodId}/release`, { employeeVisible: false });
  assert.equal(openTasks(h, 'talent_review_finalized', reviewId).length, 0);
}));

test('D7: Beispieldaten und ältere Datenbanken bekommen stimmige Aufgaben', () => withHarness(async h => {
  h.instance.seed();
  const jonas = h.db.prepare("SELECT r.id FROM talent_reviews r JOIN users u ON u.id=r.employee_id JOIN talent_review_periods p ON p.id=r.period_id WHERE u.email='jonas.richter@loop.local' AND p.name='Talent Review 2026'").get().id;
  assert.equal(openTasks(h, 'talent_review_start', jonas).length, 0, 'Jonas ist eingereicht, die Aufgabe „beginnen“ bleibt nicht offen');
  assert.equal(openTasks(h, 'talent_review_submitted', jonas).length, 2, 'HR hat dafür etwas zu tun');
  const generic = h.db.prepare("SELECT COUNT(*) count FROM tasks WHERE done=0 AND title='Talent Review für Teammitglied beginnen'").get().count;
  assert.equal(generic, 0);
  assert.equal(h.db.prepare("SELECT COUNT(*) count FROM tasks WHERE done=0 AND type='talent_pool_proposal'").get().count, 1);

  // So sah eine Aufgabe früher aus: ohne Namen, mit dem Anlegetag als Frist, teils längst erledigt.
  const ayse = h.db.prepare("SELECT r.id FROM talent_reviews r JOIN users u ON u.id=r.employee_id JOIN talent_review_periods p ON p.id=r.period_id WHERE u.email='ayse.demir@loop.local' AND p.name='Talent Review 2026'").get().id;
  h.db.prepare("UPDATE tasks SET title='Talent Review für Teammitglied beginnen',due_date='2020-01-01' WHERE type='talent_review_start' AND entity_id=?").run(ayse);
  h.db.prepare("INSERT INTO tasks(user_id,title,type,entity_id,due_date) VALUES(?,'Talent Review für Teammitglied beginnen','talent_review_start',?,'2020-01-01')").run(ID.director, jonas);
  h.instance.initialize();
  const refreshed = openTasks(h, 'talent_review_start', ayse)[0];
  assert.match(refreshed.title, /Ayşe Demir/);
  assert.equal(refreshed.due_date, '2026-11-30');
  assert.equal(openTasks(h, 'talent_review_start', jonas).length, 0);
}, { deps: { demoPasswordHash: '!TEST!' } }));

// ---------------------------------------------------------------------------
// D12/A13/H14/M11: Zielzahl
// ---------------------------------------------------------------------------

test('D12: Die Zielerreichung kommt aus goalProgress: nur freigegebene Ziele, gewichtet', () => withHarness(async h => {
  const addGoal = (progress, weight, approval) => h.db.prepare("INSERT INTO goals(user_id,title,weight,progress,approval_status) VALUES(?,?,?,?,?)").run(ID.anna, `Ziel ${progress}`, weight, progress, approval);
  const period = { start_date: '2026-01-01', end_date: '2026-12-31', assessment_date: '2026-11-30' };
  assert.equal(h.instance.reviewSupport(ID.anna, period).goals.weightedProgress, null, 'Ohne Ziele kein Wert');
  addGoal(0, 100, 'pending_manager_approval');
  assert.equal(h.instance.reviewSupport(ID.anna, period).goals.weightedProgress, null, 'Ein wartendes Ziel zählt nicht');
  addGoal(100, 10, 'approved');
  addGoal(0, 30, 'approved');
  assert.equal(h.instance.reviewSupport(ID.anna, period).goals.weightedProgress, h.deps.goalProgress(h.db.prepare('SELECT progress,weight,approval_status FROM goals WHERE user_id=?').all(ID.anna)));
  assert.equal(h.instance.reviewSupport(ID.anna, period).goals.weightedProgress, 25);
  assert.equal(h.instance.reviewSupport(ID.anna, period).goals.count, 2);
}));

// ---------------------------------------------------------------------------
// B32: Neue Personen und die Rolle hr_staff
// ---------------------------------------------------------------------------

test('B32: HR nimmt neue Personen nachträglich in die offene Periode auf', () => withHarness(async h => {
  const periodId = await openPeriod(h);
  const newcomer = h.deps.createUserAccount({ name: 'Neu Eingestellt', email: 'neu@test.local', role: 'employee', managerId: ID.manager, actor: { id: 1 } }).id;
  const noManager = h.deps.createUserAccount({ name: 'Ohne Führung', email: 'ohne@test.local', role: 'employee', actor: { id: 1 } }).id;
  const url = `/api/talent-review/periods/${periodId}/people`;

  assert.equal((await h.api('manager', 'GET', url)).status, 403);
  const before = (await h.api('hr', 'GET', url)).data;
  assert.deepEqual(before.missing.map(item => item.id), [newcomer]);
  assert.equal(before.missing[0].manager_name, 'Malte Manager');
  assert.ok(before.withoutManager.some(item => item.id === noManager));
  assert.equal((await h.api('hr', 'GET', '/api/talent-review/periods')).data.items.find(item => item.id === periodId).missingPeopleCount, 1);
  assert.equal((await h.api('hr', 'GET', `/api/talent-review/dashboard/hr?periodId=${periodId}`)).data.missingPeople, 1);

  assert.equal((await h.api('manager', 'POST', url, { employeeIds: [newcomer] })).status, 403);
  assert.equal((await h.api('hr', 'POST', url, { employeeIds: [noManager] })).status, 400, 'Ohne Führungskraft kann niemand einschätzen');
  assert.equal((await h.api('hr', 'POST', url, { employeeIds: [ID.bp] })).status, 400, 'HR-Rollen bleiben außen vor');
  const added = await h.api('hr', 'POST', url, { employeeIds: [newcomer] });
  assert.equal(added.status, 200);
  assert.equal(added.data.added, 1);
  const reviewId = reviewRow(h, periodId, newcomer).id;
  assert.equal(openTasks(h, 'talent_review_start', reviewId)[0].user_id, ID.manager);
  assert.match(openTasks(h, 'talent_review_start', reviewId)[0].title, /Neu Eingestellt/);
  assert.equal(openTasks(h, 'talent_review_self_assessment', reviewId)[0].user_id, newcomer);
  assert.deepEqual((await h.api('hr', 'GET', url)).data.missing, []);

  await setPeriodStatus(h, periodId, 'calibration');
  const later = h.deps.createUserAccount({ name: 'Zu Spät', email: 'spaet@test.local', role: 'employee', managerId: ID.manager, actor: { id: 1 } }).id;
  assert.equal((await h.api('hr', 'POST', url, { employeeIds: [later] })).status, 409, 'In der Kalibrierung kann niemand mehr schreiben');
}));

test('hr_staff ist im Talent Review eine normale Person und sieht keine HR-Ansichten', () => withHarness(async h => {
  const staff = h.deps.createUserAccount({ name: 'Sach Bearbeiter', email: 'sb@test.local', role: 'hr_staff', managerId: ID.hr, actor: { id: 1 } }).id;
  h.db.prepare('UPDATE users SET must_change_password=0 WHERE id=?').run(staff);
  const periodId = await openPeriod(h);
  const reviewId = reviewRow(h, periodId, staff)?.id;
  assert.ok(reviewId, 'Die Sachbearbeitung wird eingeschätzt wie alle anderen');
  assert.equal(openTasks(h, 'talent_review_start', reviewId)[0].user_id, ID.hr);
  assert.equal(openTasks(h, 'talent_review_self_assessment', reviewId)[0].user_id, staff);
  assert.equal((await h.api(staff, 'PATCH', `/api/talent-review/reviews/${reviewId}/self`, selfPayload())).status, 200);

  const meta = (await h.api(staff, 'GET', '/api/talent-review/meta')).data;
  assert.equal(meta.canManagePeriods, false);
  assert.equal(meta.canReview, false);
  assert.equal((await h.api(staff, 'POST', '/api/talent-review/periods', { name: 'Nein', startDate: '2026-01-01', endDate: '2026-12-31', assessmentDate: '2026-11-30' })).status, 403);
  assert.equal((await h.api(staff, 'PATCH', `/api/talent-review/periods/${periodId}/status`, { status: 'archived' })).status, 403);
  assert.equal((await h.api(staff, 'GET', `/api/talent-review/periods/${periodId}/open-items`)).status, 403);
  assert.equal((await h.api(staff, 'GET', `/api/talent-review/periods/${periodId}/people`)).status, 403);
  assert.equal((await h.api(staff, 'GET', '/api/talent-review/dashboard/hr')).status, 403);
  assert.equal((await h.api(staff, 'GET', '/api/talent-review/dashboard/manager')).status, 403);
  assert.equal((await h.api(staff, 'GET', `/api/talent-review/matrix?periodId=${periodId}`)).status, 403);
  assert.deepEqual((await h.api(staff, 'GET', `/api/talent-review/reviews?periodId=${periodId}`)).data.items, []);
  assert.deepEqual((await h.api(staff, 'GET', '/api/talent-review/sessions')).data.items, []);
  assert.deepEqual((await h.api(staff, 'GET', '/api/talent-pools')).data.items, []);
  const anna = reviewRow(h, periodId, ID.anna).id;
  assert.equal((await h.api(staff, 'GET', `/api/talent-review/reviews/${anna}`)).status, 403);
  assert.equal((await h.api(staff, 'POST', `/api/talent-review/reviews/${anna}/finalize`)).status, 403);
  assert.equal((await h.api(staff, 'POST', `/api/talent-review/reviews/${anna}/return`, { reason: 'Darf die Sachbearbeitung nicht.' })).status, 403);
}));

test('HR handelt nicht in eigener Sache und hrbp nicht bei der HR-Leitung', () => withHarness(async h => {
  // David ist hier HRBP und bekommt von früher eine Einschätzung, zum Beispiel nach einem Rollenwechsel.
  h.db.prepare('UPDATE users SET manager_id=? WHERE id=?').run(ID.hr, ID.bp);
  const periodId = await openPeriod(h);
  h.db.prepare("INSERT INTO talent_reviews(period_id,employee_id,manager_id,status,created_by,original_performance,original_potential) VALUES(?,?,?,'calibrated',?,2,2)").run(periodId, ID.bp, ID.hr, ID.hr);
  h.db.prepare('UPDATE talent_reviews SET calibrated_performance=3,calibrated_potential=3 WHERE period_id=? AND employee_id=?').run(periodId, ID.bp);
  const own = reviewRow(h, periodId, ID.bp).id;
  assert.equal((await h.api('bp', 'GET', `/api/talent-review/reviews/${own}`)).status, 403, 'Das eigene Ergebnis erst nach der Freigabe');
  assert.ok(!(await h.api('bp', 'GET', `/api/talent-review/reviews?periodId=${periodId}`)).data.items.some(item => item.id === own));
  await setPeriodStatus(h, periodId, 'calibration');
  assert.equal((await h.api('bp', 'POST', `/api/talent-review/reviews/${own}/finalize`)).status, 403);
  assert.equal((await h.api('hr', 'POST', `/api/talent-review/reviews/${own}/finalize`)).status, 200);

  // Eine Einschätzung der HR-Leitung bleibt für den HRBP verschlossen.
  h.db.prepare('UPDATE users SET manager_id=? WHERE id=?').run(ID.director, ID.hr);
  h.db.prepare("INSERT INTO talent_reviews(period_id,employee_id,manager_id,status,created_by) VALUES(?,?,?,'manager_submitted',?)").run(periodId, ID.hr, ID.director, ID.director);
  const lead = reviewRow(h, periodId, ID.hr).id;
  assert.equal((await h.api('bp', 'GET', `/api/talent-review/reviews/${lead}`)).status, 403);
  assert.equal((await h.api('bp', 'POST', `/api/talent-review/reviews/${lead}/finalize`)).status, 403);
}));

// ---------------------------------------------------------------------------
// D18/B33/H21: Verständlicher Verlauf
// ---------------------------------------------------------------------------

test('D18/B33: Der Verlauf nennt deutsche Bezeichnungen und gibt keine Rohwerte heraus', () => withHarness(async h => {
  const periodId = await openPeriod(h);
  const reviewId = reviewRow(h, periodId, ID.anna).id;
  await saveAndSubmit(h, 'manager', reviewId);
  assert.equal((await h.api('hr', 'POST', `/api/talent-review/reviews/${reviewId}/return`, { reason: 'Bitte die Begründung noch einmal schärfen.' })).status, 200);
  const { history } = (await h.api('manager', 'GET', `/api/talent-review/reviews/${reviewId}`)).data;
  const labels = history.map(item => item.label);
  for (const expected of ['Zur Überarbeitung zurückgegeben', 'Eingereicht', 'Entwurf gespeichert', 'In die Periode aufgenommen']) assert.ok(labels.includes(expected), expected);
  for (const label of labels) assert.doesNotMatch(label, /_|created|calibrated/);
  for (const item of history) {
    assert.equal(item.old_value, undefined);
    assert.equal(item.new_value, undefined);
  }
  assert.equal(history.find(item => item.label === 'Zur Überarbeitung zurückgegeben').reason, 'Bitte die Begründung noch einmal schärfen.');
}));

test('Sprache: Die Oberfläche nutzt einheitliche, verständliche Begriffe', () => {
  const source = fs.readFileSync(path.join(__dirname, '../public/talent-review.js'), 'utf8');
  const server = fs.readFileSync(path.join(__dirname, '../routes/talentReview.js'), 'utf8');
  for (const word of ['URSprüngliche', 'Zyklus', 'Cockpit', 'serverseitig', 'Audit', 'Demo-Aufbewahrungsregeln', 'Positions-Fit', 'Stretch Assignment', 'Job Rotation']) {
    assert.ok(!source.includes(word), `Oberfläche enthält „${word}“`);
  }
  assert.doesNotMatch(source, /(^|[^a-zA-Z])Performance/, 'Leistung statt Performance');
  assert.doesNotMatch(source, /\bReviews\b/, 'Einschätzungen statt Reviews');
  for (const word of ['Zyklus', 'Performancebegründung']) assert.ok(!server.includes(word), `Server enthält „${word}“`);
  assert.doesNotMatch(source, /L\$\{|P\$\{/, 'Keine Kürzel wie L1 oder P3 in der 9-Box');
});

test('Sitzung umbenennen: Ein vergebener Titel ergibt eine klare Meldung', () => withHarness(async h => {
  const periodId = await openPeriod(h);
  await createSession(h, periodId, { title: 'Erste Sitzung' });
  const second = await createSession(h, periodId, { title: 'Zweite Sitzung' });
  const renamed = await h.api('hr', 'PATCH', `/api/talent-review/sessions/${second}`, { title: 'Erste Sitzung' });
  assert.equal(renamed.status, 409);
  assert.match(renamed.data.error, /Titel/);
  assert.equal((await h.api('hr', 'PATCH', `/api/talent-review/sessions/${second}`, { title: 'Dritte Sitzung' })).status, 200);
}));

// ---------------------------------------------------------------------------
// Runde 3
// ---------------------------------------------------------------------------

const managerChanges = (data) => data.history.filter(item => item.field_name === 'manager_changed');

test('Führungswechsel: Der Verlauf nennt, wer gewechselt hat, und ohne handelnde Person das System', () => withHarness(async h => {
  const periodId = await openPeriod(h);
  const reviewId = reviewRow(h, periodId, ID.anna).id;
  const detail = async () => (await h.api('hr', 'GET', `/api/talent-review/reviews/${reviewId}`)).data;
  const auditActors = () => h.db.prepare("SELECT actor_id FROM audit_log WHERE action='talent_review_manager_changed' AND entity_id=? ORDER BY id").all(reviewId).map(row => row.actor_id);

  h.deps.changeManager(ID.anna, ID.clara, ID.hr);
  let changes = managerChanges(await detail());
  assert.equal(changes.length, 1);
  assert.equal(changes[0].actor_name, 'Hanna HR', 'Nicht die neue Führungskraft, sondern wer gewechselt hat');
  assert.match(changes[0].label, /Clara Cordes/, 'Zu wem es ging, steht in der Bezeichnung');
  assert.deepEqual(auditActors(), [ID.hr]);

  // Wechsel ohne handelnde Person, etwa aus einem Hintergrundlauf.
  h.deps.changeManager(ID.anna, ID.director);
  changes = managerChanges(await detail());
  assert.equal(changes.length, 2, 'Der Eintrag geht nicht verloren');
  assert.equal(changes[0].actor_name, 'System');
  assert.deepEqual(auditActors(), [ID.hr, null]);

  // Abgleich beim Start: Auch hier hat niemand gehandelt.
  h.db.prepare('UPDATE users SET manager_id=? WHERE id=?').run(ID.manager, ID.anna);
  h.instance.initialize();
  changes = managerChanges(await detail());
  assert.equal(changes.length, 3);
  assert.equal(changes[0].actor_name, 'System');
  assert.match(changes[0].label, /Malte Manager/);
  assert.equal(reviewRow(h, periodId, ID.anna).manager_id, ID.manager);
}));

test('Eine beendete Periode zeigt ihre eigenen Ziele und Check-ins, nicht den Stand von heute', () => withHarness(async h => {
  const addGoal = (progress, dueDate) => h.db.prepare("INSERT INTO goals(user_id,title,weight,progress,due_date,approval_status) VALUES(?,?,?,?,?,'approved')").run(ID.anna, `Ziel ${progress}`, 50, progress, dueDate);
  addGoal(100, '2025-06-30');
  addGoal(20, '2026-06-30');
  addGoal(60, null);
  const addCheckin = (month, performance) => h.db.prepare("INSERT INTO checkins(employee_id,manager_id,period,summary,performance,on_track) VALUES(?,?,?,'Gespräch',?,'on_track')").run(ID.anna, ID.manager, month, performance);
  addCheckin('2025-03', 2);
  addCheckin('2026-03', 5);

  const dates = { start_date: '2025-01-01', end_date: '2025-12-31', assessment_date: '2025-11-30' };
  const finished = h.instance.reviewSupport(ID.anna, { ...dates, status: 'completed' });
  assert.equal(finished.periodFinished, true);
  assert.equal(finished.goals.weightedProgress, 100, 'Nur das Ziel aus 2025');
  assert.equal(finished.goals.count, 1);
  assert.equal(finished.checkins.latestPerformance, 2, 'Nicht der Check-in von heute');
  assert.equal(h.instance.reviewSupport(ID.ben, { ...dates, status: 'archived' }).goals.weightedProgress, null, 'Ohne Ziele kein Wert');

  // In der laufenden Periode bleibt es bei der einen Zahl, die überall steht.
  const running = h.instance.reviewSupport(ID.anna, { ...dates, status: 'open' });
  assert.equal(running.periodFinished, false);
  assert.equal(running.goals.weightedProgress, h.deps.goalProgress(h.db.prepare('SELECT progress,weight,approval_status FROM goals WHERE user_id=?').all(ID.anna)));
  assert.equal(running.checkins.latestPerformance, 5);

  // Über die Schnittstelle, für alle, die den Fall lesen dürfen, und auf der Seite der Person.
  const created = await h.api('hr', 'POST', '/api/talent-review/periods', { name: 'Periode 2025', startDate: '2025-01-01', endDate: '2025-12-31', assessmentDate: '2025-11-30' });
  await setPeriodStatus(h, created.data.id, 'open');
  const reviewId = reviewRow(h, created.data.id, ID.anna).id;
  h.db.prepare("UPDATE talent_reviews SET status='finalized',employee_visible=1 WHERE period_id=?").run(created.data.id);
  await setPeriodStatus(h, created.data.id, 'calibration');
  await setPeriodStatus(h, created.data.id, 'completed');
  for (const person of ['hr', 'manager', 'director', 'anna']) {
    const { support } = (await h.api(person, 'GET', `/api/talent-review/reviews/${reviewId}`)).data;
    assert.equal(support.periodFinished, true, person);
    assert.equal(support.goals.weightedProgress, 100, person);
  }
  const own = (await h.api('anna', 'GET', '/api/talent-review/self-reviews')).data.items.find(item => item.id === reviewId);
  assert.equal(own.support.periodFinished, true);
  assert.equal(own.support.goals.weightedProgress, 100);
}));

test('Sammelaktion: Alle eingereichten Fälle aufnehmen, mit Meldung, was geklappt hat und was nicht', () => withHarness(async h => {
  const periodId = await openPeriod(h);
  const anna = reviewRow(h, periodId, ID.anna).id;
  const ben = reviewRow(h, periodId, ID.ben).id;
  const clara = reviewRow(h, periodId, ID.clara).id;
  await saveAndSubmit(h, 'manager', anna);
  await saveAndSubmit(h, 'manager', ben);
  await saveAndSubmit(h, 'director', clara);
  const sessionId = await createSession(h, periodId, { organizationManagerId: ID.manager });

  const candidatesUrl = `/api/talent-review/sessions/${sessionId}/case-candidates`;
  const bulkUrl = `/api/talent-review/sessions/${sessionId}/cases/bulk`;
  assert.equal((await h.api('manager', 'GET', candidatesUrl)).status, 403);
  const before = (await h.api('hr', 'GET', candidatesUrl)).data;
  assert.deepEqual(before.candidates.map(item => item.id).sort(), [anna, ben].sort());
  assert.deepEqual(before.outside.map(item => item.id), [clara], 'Clara gehört nicht zum Bereich der Sitzung');
  assert.deepEqual(before.notSubmitted.map(item => item.employee_id ?? item.id), [reviewRow(h, periodId, ID.manager).id]);

  assert.equal((await h.api('manager', 'POST', bulkUrl, { reviewIds: [anna] })).status, 403);
  assert.equal((await h.api('hr', 'POST', bulkUrl, { reviewIds: [] })).status, 400);
  const result = await h.api('hr', 'POST', bulkUrl, { reviewIds: [anna, ben, clara, 999999] });
  assert.equal(result.status, 200);
  assert.deepEqual(result.data.added.map(item => item.employee_name).sort(), ['Anna Ahrens', 'Ben Berg']);
  assert.equal(result.data.failed.length, 2);
  assert.match(result.data.failed.find(item => item.reviewId === clara).reason, /Bereich/);
  assert.equal(result.data.failed.find(item => item.reviewId === clara).employee_name, 'Clara Cordes');
  assert.match(result.data.failed.find(item => item.reviewId === 999999).reason, /gibt es nicht/);
  assert.equal(reviewRow(h, periodId, ID.anna).status, 'in_calibration');
  assert.equal(reviewRow(h, periodId, ID.clara).status, 'manager_submitted');
  const orders = h.db.prepare('SELECT display_order FROM talent_review_session_cases WHERE session_id=? ORDER BY display_order').all(sessionId).map(row => row.display_order);
  assert.deepEqual(orders, [1, 2], 'Die Fälle bekommen eine Reihenfolge');

  // Wer schon drin ist, wird nicht noch einmal angeboten, und bereits Kalibriertes öffnet die Sammlung nicht wieder.
  assert.deepEqual((await h.api('hr', 'GET', candidatesUrl)).data.candidates, []);
  const again = await h.api('hr', 'POST', bulkUrl, { reviewIds: [anna] });
  assert.equal(again.data.added.length, 0);
  assert.match(again.data.failed[0].reason, /schon zugeordnet/);
  await setPeriodStatus(h, periodId, 'calibration');
  await setSessionStatus(h, sessionId, 'active');
  assert.equal((await h.api('hr', 'POST', `/api/talent-review/reviews/${anna}/calibrate`, calibrationBody(sessionId, reviewRow(h, periodId, ID.anna).version))).status, 200);
  const other = await createSession(h, periodId, { title: 'Zweite Runde' });
  const offered = (await h.api('hr', 'GET', `/api/talent-review/sessions/${other}/case-candidates`)).data.candidates.map(item => item.id);
  assert.ok(!offered.includes(anna), 'Ein kalibrierter Fall wird nicht nebenbei wieder geöffnet');
  assert.ok(offered.includes(clara));
  await setSessionStatus(h, other, 'cancelled');
  assert.equal((await h.api('hr', 'POST', `/api/talent-review/sessions/${other}/cases/bulk`, { reviewIds: [clara] })).status, 409);
}));

test('Sammelaktion: Alle kalibrierten final abschließen, mit Meldung, was geklappt hat und was nicht', () => withHarness(async h => {
  const periodId = await openPeriod(h);
  const anna = reviewRow(h, periodId, ID.anna).id;
  const ben = reviewRow(h, periodId, ID.ben).id;
  const clara = reviewRow(h, periodId, ID.clara).id;
  await saveAndSubmit(h, 'manager', anna);
  await saveAndSubmit(h, 'manager', ben);
  await saveAndSubmit(h, 'director', clara);
  const sessionId = await createSession(h, periodId);
  for (const reviewId of [anna, ben, clara]) await addCase(h, sessionId, reviewId);
  await setPeriodStatus(h, periodId, 'calibration');
  await setSessionStatus(h, sessionId, 'active');
  for (const [employeeId, reviewId] of [[ID.anna, anna], [ID.ben, ben]]) {
    assert.equal((await h.api('hr', 'POST', `/api/talent-review/reviews/${reviewId}/calibrate`, calibrationBody(sessionId, reviewRow(h, periodId, employeeId).version))).status, 200);
  }
  const open = (await h.api('hr', 'GET', `/api/talent-review/periods/${periodId}/open-items`)).data;
  assert.deepEqual(open.readyToFinalize.map(item => item.id).sort(), [anna, ben].sort());
  assert.ok(open.readyToFinalize[0].boxLabel);
  assert.equal((await h.api('hr', 'GET', '/api/talent-review/periods')).data.items.find(item => item.id === periodId).readyToFinalizeCount, 2);

  const url = `/api/talent-review/periods/${periodId}/finalize-all`;
  assert.equal((await h.api('manager', 'POST', url, { reviewIds: [anna] })).status, 403);
  assert.equal((await h.api('hr', 'POST', url, { reviewIds: [] })).status, 400);
  const otherPeriod = await openPeriod(h, 'Andere Periode');
  const foreign = reviewRow(h, otherPeriod, ID.anna).id;
  const result = await h.api('hr', 'POST', url, { reviewIds: [anna, ben, clara, foreign, anna] });
  assert.equal(result.status, 200);
  assert.deepEqual(result.data.finalized.map(item => item.employee_name).sort(), ['Anna Ahrens', 'Ben Berg']);
  assert.equal(result.data.failed.length, 2);
  assert.match(result.data.failed.find(item => item.reviewId === clara).reason, /nur kalibrierte/);
  assert.match(result.data.failed.find(item => item.reviewId === foreign).reason, /anderen Periode/);
  assert.equal(reviewRow(h, periodId, ID.anna).status, 'finalized');
  assert.equal(reviewRow(h, periodId, ID.clara).status, 'in_calibration');
  assert.equal(openTasks(h, 'talent_review_submitted', anna).length, 0, 'Dieselben Folgen wie beim einzelnen Abschluss');
  assert.equal((await h.api('hr', 'GET', `/api/talent-review/periods/${periodId}/open-items`)).data.readyToFinalize.length, 0);

  // In eigener Sache hilft auch die Sammlung nicht.
  h.db.prepare('UPDATE users SET manager_id=? WHERE id=?').run(ID.hr, ID.bp);
  h.db.prepare("INSERT INTO talent_reviews(period_id,employee_id,manager_id,status,created_by,calibrated_performance,calibrated_potential) VALUES(?,?,?,'calibrated',?,2,2)").run(periodId, ID.bp, ID.hr, ID.hr);
  const own = reviewRow(h, periodId, ID.bp).id;
  assert.ok(!(await h.api('bp', 'GET', `/api/talent-review/periods/${periodId}/open-items`)).data.readyToFinalize.some(item => item.id === own));
  const ownTry = await h.api('bp', 'POST', url, { reviewIds: [own] });
  assert.equal(ownTry.data.finalized.length, 0);
  assert.equal(reviewRow(h, periodId, ID.bp).status, 'calibrated');
}));

test('Runde 3: Texte, Sammelknöpfe und Adressen in der Oberfläche', () => {
  const source = fs.readFileSync(path.join(__dirname, '../public/talent-review.js'), 'utf8');
  const server = fs.readFileSync(path.join(__dirname, '../routes/talentReview.js'), 'utf8');

  // Wer nach dem Abgeben mitliest, steht vor dem Abgeben da, auch in der Rückfrage.
  assert.match(source, /Führungskräfte über ihr/);
  assert.match(source, /Selbsteinschätzung abgeben\?[\s\S]{0,120}SELF_ASSESSMENT_READERS/);

  // Einzahl und Mehrzahl.
  assert.doesNotMatch(source, /Personen sehen[^\n]*und bekommt/);
  assert.match(source, /1 Person sieht danach ihr Ergebnis/);
  assert.doesNotMatch(source, /<span>(Selbsteinschätzungen abgegeben|geplante oder laufende Sitzungen|aktive Talentpools|offene Maßnahmen|offene Entwicklungsmaßnahmen)/, 'Zählerzeilen brauchen die Einzahl');

  // Beispieltexte klingen wie im Betrieb.
  assert.doesNotMatch(server, /[Ff]iktiv/);

  // Sammelaktionen haben einen Knopf und eine Rückfrage mit Zahl.
  assert.match(source, /'session-cases-all'/);
  assert.match(source, /'period-finalize-all'/);
  assert.match(source, /title: `\$\{count\} aufnehmen\?`/);
  assert.match(source, /title: `\$\{count\} final abschließen\?`/);

  // Nummer in der Adresse.
  assert.match(source, /registerAddress\(/);
  for (const view of ['reviewDetail', 'reviewSessionDetail', 'reviewPoolDetail']) assert.match(source, new RegExp(`${view}: addressOf\\(`), view);
});
