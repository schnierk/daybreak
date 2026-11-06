'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { after, before, test } = require('node:test');
const bcrypt = require('bcryptjs');
const express = require('express');
const { createModuleHarness } = require('../lib/testing/module-harness');
const { createOnboardingModule } = require('../routes/onboarding');
const { createPersonnelModule } = require('../routes/personnel');
const { createRecruitingModule } = require('../routes/recruiting');

const RECOMMENDATION = 'continue';
const SECRET_PAY = 'Geheime Vergütung 54321';

let h;
let emailCounter = 0;

async function ok(promise, expectedStatus = 200) {
  const response = await promise;
  assert.equal(response.status, expectedStatus, JSON.stringify(response.data));
  return response.data;
}

const uniqueEmail = (prefix = 'person') => `${prefix}.${++emailCounter}@example.com`;

function sharedHelpers(harness) {
  async function createOpenRequisition({ owner = 'manager', title = 'Testfall', openings = 1, internalPosting = false, positionProfileId } = {}) {
    const { id } = await ok(harness.api(owner, 'POST', '/api/recruiting/requisitions', { title, openings, internalPosting, positionProfileId }));
    await ok(harness.api(owner, 'POST', `/api/recruiting/requisitions/${id}/submit`, {}));
    await ok(harness.api('hr', 'POST', `/api/recruiting/requisitions/${id}/approve`, {}));
    return id;
  }

  async function addApplication(requisitionId, candidate = {}, actor = 'hr') {
    const email = candidate.email || uniqueEmail();
    const { id } = await ok(harness.api(actor, 'POST', `/api/recruiting/requisitions/${requisitionId}/applications`, {
      candidate: { name: 'Bea Bewerbung', email, ...candidate }
    }));
    return { applicationId: id, email };
  }

  async function createAcceptedOffer(applicationId, { startDate = '2098-02-01', creator = 'manager', approver = 'hr', compensation = SECRET_PAY } = {}) {
    const { id } = await ok(harness.api(creator, 'POST', `/api/recruiting/applications/${applicationId}/offers`, { startDate, compensation }));
    await ok(harness.api(creator, 'POST', `/api/recruiting/offers/${id}/submit`, {}));
    await ok(harness.api(approver, 'POST', `/api/recruiting/offers/${id}/approve`, {}));
    await ok(harness.api(creator, 'POST', `/api/recruiting/offers/${id}/response`, { accepted: true }));
    return id;
  }

  return { createOpenRequisition, addApplication, createAcceptedOffer };
}

let createOpenRequisition;
let addApplication;
let createAcceptedOffer;

const columnsOf = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all().map(column => column.name);
const tablesStartingWith = (db, prefix) => db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE ?").all(`${prefix}%`);
const openTasks = (type, entityId) => h.db.prepare('SELECT * FROM tasks WHERE type=? AND entity_id=? AND done=0').all(type, entityId);
// Bewertet wird erst ab dem Termin. Deshalb liegt das übliche Testgespräch in der Vergangenheit.
const interviewPlan = participantIds => ({ scheduledAt: '2026-01-15T10:30', location: 'Raum 1', participantIds });
const futureInterviewPlan = participantIds => ({ scheduledAt: '2099-01-15T10:30', location: 'Raum 1', participantIds });
const feedbackBody = (extra = {}) => ({ rating: 4, strengths: 'Klare Sprache', concerns: 'Noch wenig Erfahrung', recommendation: RECOMMENDATION, ...extra });

before(async () => {
  h = await createModuleHarness(createRecruitingModule);
  ({ createOpenRequisition, addApplication, createAcceptedOffer } = sharedHelpers(h));
});

after(() => h.close());

test('Ohne Anmeldung gibt es nirgends Zugriff, auch keine öffentliche Stellenseite', async () => {
  for (const [method, url] of [
    ['GET', '/api/recruiting/job-board'],
    ['GET', '/api/recruiting/requisitions'],
    ['POST', '/api/recruiting/requisitions'],
    ['GET', '/api/recruiting/candidates'],
    ['GET', '/api/recruiting/applications/1'],
    ['POST', '/api/recruiting/applications/1/hire'],
    ['GET', '/api/recruiting/metrics'],
    ['GET', '/api/recruiting/settings'],
    ['GET', '/api/recruiting/stages'],
    ['GET', '/api/recruiting/interviews/mine']
  ]) {
    const response = await h.api(null, method, url, method === 'POST' ? {} : undefined);
    assert.equal(response.status, 401, `${method} ${url}`);
  }
});

test('Voreinstellungen: fünf Stufen und sechs Monate Frist, genau einmal angelegt', async () => {
  h.instance.initialize();
  h.instance.initialize();
  const { stages } = await ok(h.api('manager', 'GET', '/api/recruiting/stages'));
  assert.deepEqual(stages.map(stage => stage.name), ['Eingang', 'Vorauswahl', 'Gespräch', 'Angebot', 'Eingestellt']);
  assert.equal(stages.at(-1).kind, 'hired');
  const { settings } = await ok(h.api('hr', 'GET', '/api/recruiting/settings'));
  assert.equal(settings.retentionMonths, 6);
  assert.equal(h.db.prepare('SELECT COUNT(*) AS count FROM recruiting_settings').get().count, 1);
});

test('Es gibt keine Felder für Foto, Geburtsdatum oder Merkmale nach AGG', async () => {
  const columns = columnsOf(h.db, 'recruiting_candidates');
  for (const forbidden of ['photo', 'foto', 'birth_date', 'birthdate', 'gender', 'religion', 'nationality', 'age', 'disability']) {
    assert.ok(!columns.includes(forbidden), forbidden);
  }
  const { id } = await ok(h.api('hr', 'POST', '/api/recruiting/candidates', {
    name: 'Feld Test',
    email: uniqueEmail(),
    birthDate: '1980-01-01',
    photo: 'data:image/png;base64,AAAA',
    gender: 'x'
  }));
  const { candidate } = await ok(h.api('hr', 'GET', `/api/recruiting/candidates/${id}`));
  const text = JSON.stringify(candidate);
  assert.ok(!text.includes('1980-01-01') && !text.includes('base64'), 'unbekannte Felder werden nicht gespeichert');
});

test('Stellen anfordern: Führungskräfte für ihren Bereich, Mitarbeitende nicht', async () => {
  const create = (who, body) => h.api(who, 'POST', '/api/recruiting/requisitions', { title: 'Stelle', ...body });
  assert.equal((await create('anna', {})).status, 403, 'Mitarbeiterin');
  assert.equal((await create('manager', { hiringManagerId: h.people.director.id })).status, 403, 'nach oben');
  assert.equal((await create('manager', { hiringManagerId: h.people.clara.id })).status, 403, 'fremder Bereich');

  const own = await ok(create('manager', {}));
  assert.equal((await ok(h.api('manager', 'GET', `/api/recruiting/requisitions/${own.id}`))).requisition.hiringManagerId, h.people.manager.id);
  const delegated = await ok(create('director', { hiringManagerId: h.people.manager.id }));
  assert.equal((await ok(h.api('manager', 'GET', `/api/recruiting/requisitions/${delegated.id}`))).requisition.status, 'draft');
  assert.equal((await create('director', { hiringManagerId: h.people.anna.id })).status, 400, 'nur Führungskräfte stellen ein');
  const forManager = await ok(create('hr', { hiringManagerId: h.people.manager.id }));
  assert.ok(forManager.id);
  assert.equal((await create('hr', { hiringManagerId: 999999 })).status, 400);
});

test('Wer für einen anderen Bereich anlegt, übergibt die Stelle per Aufgabe', async () => {
  const { id, handedOver } = await ok(h.api('director', 'POST', '/api/recruiting/requisitions', { title: 'Übergabe', hiringManagerId: h.people.manager.id }));
  assert.equal(handedOver, true);
  assert.deepEqual(openTasks('recruiting_requisition_assigned', id).map(task => task.user_id), [h.people.manager.id]);
  assert.equal((await h.api('director', 'GET', `/api/recruiting/requisitions/${id}`)).status, 403, 'die anlegende Person sieht sie nicht mehr');
  await ok(h.api('manager', 'POST', `/api/recruiting/requisitions/${id}/submit`, {}));
  assert.equal(openTasks('recruiting_requisition_assigned', id).length, 0);
  const own = await ok(h.api('manager', 'POST', '/api/recruiting/requisitions', { title: 'Eigene Stelle' }));
  assert.equal(own.handedOver, false);
  assert.equal(openTasks('recruiting_requisition_assigned', own.id).length, 0, 'keine Aufgabe an sich selbst');
  const byHr = await ok(h.api('hr', 'POST', '/api/recruiting/requisitions', { title: 'Von HR', hiringManagerId: h.people.manager.id }));
  assert.equal(openTasks('recruiting_requisition_assigned', byHr.id).length, 0, 'HR führt den Ablauf selbst weiter');
});

test('Die Systemadministration wird wie HR behandelt, kann sich aber nicht bewerben', async () => {
  const SYSTEM_ID = 99;
  const sysHarness = await createModuleHarness(createRecruitingModule, {
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
    const helpers = sharedHelpers(sysHarness);
    const noManager = await sysHarness.api(SYSTEM_ID, 'POST', '/api/recruiting/requisitions', { title: 'Ohne Führungskraft' });
    assert.equal(noManager.status, 400, 'das technische Konto ist keine einstellende Führungskraft');
    const { id: requisitionId } = await ok(sysHarness.api(SYSTEM_ID, 'POST', '/api/recruiting/requisitions', { title: 'Vom System', hiringManagerId: sysHarness.people.manager.id, internalPosting: true }));
    await ok(sysHarness.api(SYSTEM_ID, 'POST', `/api/recruiting/requisitions/${requisitionId}/submit`, {}));
    await ok(sysHarness.api(SYSTEM_ID, 'POST', `/api/recruiting/requisitions/${requisitionId}/approve`, {}));
    const { applicationId } = await helpers.addApplication(requisitionId, {}, SYSTEM_ID);
    await helpers.createAcceptedOffer(applicationId, { approver: SYSTEM_ID });
    const hired = await ok(sysHarness.api(SYSTEM_ID, 'POST', `/api/recruiting/applications/${applicationId}/hire`, {}));
    assert.ok(hired.temporaryPassword);
    await ok(sysHarness.api(SYSTEM_ID, 'GET', '/api/recruiting/metrics'));
    const board = await ok(sysHarness.api(SYSTEM_ID, 'GET', '/api/recruiting/job-board'));
    assert.deepEqual(board.myApplications, []);
    const other = await helpers.createOpenRequisition({ title: 'Noch offen', internalPosting: true });
    assert.equal((await ok(sysHarness.api(SYSTEM_ID, 'GET', '/api/recruiting/job-board'))).jobs.find(job => job.id === other).canApply, false);
    assert.equal((await sysHarness.api(SYSTEM_ID, 'POST', `/api/recruiting/job-board/${other}/apply`, {})).status, 403);
    assert.ok(!sysHarness.db.prepare('SELECT id FROM tasks WHERE user_id=?').get(SYSTEM_ID), 'das technische Konto bekommt keine Aufgaben');
  } finally {
    await sysHarness.close();
  }
});

test('Ungültige Stellen werden abgelehnt', async () => {
  const create = body => h.api('manager', 'POST', '/api/recruiting/requisitions', { title: 'Stelle', ...body });
  assert.equal((await create({ title: '' })).status, 400);
  assert.equal((await create({ title: '   ' })).status, 400);
  assert.equal((await create({ title: 123 })).status, 400);
  assert.equal((await create({ openings: 0 })).status, 400);
  assert.equal((await create({ openings: 'viele' })).status, 400);
  assert.equal((await create({ openings: 100000 })).status, 400);
  assert.equal((await create({ targetDate: '31.12.2026' })).status, 400);
  assert.equal((await create({ targetDate: '2026-02-31' })).status, 400, 'den 31. Februar gibt es nicht');
  assert.equal((await create({ targetDate: ['2026-12-01'] })).status, 400);
  assert.equal((await create({ internalPosting: 'ja' })).status, 400);
  assert.equal((await create({ positionProfileId: 999999 })).status, 400);
  assert.equal((await h.api('manager', 'POST', '/api/recruiting/requisitions')).status, 400, 'ganz ohne Inhalt');
  const script = await ok(create({ title: 'Stelle <script>alert(1)</script>' }));
  const { requisition } = await ok(h.api('manager', 'GET', `/api/recruiting/requisitions/${script.id}`));
  assert.ok(!requisition.title.includes('<'), 'spitze Klammern werden entfernt');
});

test('Freigabe: Führungskraft reicht ein, HR gibt frei, Aufgaben folgen dem Stand', async () => {
  const { id } = await ok(h.api('manager', 'POST', '/api/recruiting/requisitions', { title: 'Freigabefall' }));
  const url = `/api/recruiting/requisitions/${id}`;
  assert.equal((await h.api('hr', 'POST', `${url}/approve`, {})).status, 409, 'Entwurf lässt sich nicht freigeben');
  assert.equal((await h.api('anna', 'POST', `${url}/submit`, {})).status, 403);
  await ok(h.api('manager', 'POST', `${url}/submit`, {}));

  const tasks = openTasks('recruiting_approval', id);
  assert.deepEqual(tasks.map(task => task.user_id).sort(), [h.people.hr.id, h.people.bp.id].sort());
  assert.equal((await h.api('manager', 'POST', `${url}/approve`, {})).status, 403, 'nicht die Führungskraft selbst');
  assert.equal((await h.api('director', 'POST', `${url}/approve`, {})).status, 403);

  assert.equal((await h.api('hr', 'POST', `${url}/return`, {})).status, 400, 'Rückgabe braucht einen Grund');
  await ok(h.api('hr', 'POST', `${url}/return`, { comment: 'Bitte Beschreibung ergänzen' }));
  assert.equal(openTasks('recruiting_approval', id).length, 0);
  assert.deepEqual(openTasks('recruiting_requisition_returned', id).map(task => task.user_id), [h.people.manager.id]);
  const returned = (await ok(h.api('manager', 'GET', url))).requisition;
  assert.equal(returned.status, 'draft');
  assert.equal(returned.returnComment, 'Bitte Beschreibung ergänzen');

  await ok(h.api('manager', 'PATCH', url, { description: 'Ergänzt' }));
  await ok(h.api('manager', 'POST', `${url}/submit`, {}));
  assert.equal(openTasks('recruiting_requisition_returned', id).length, 0);
  assert.equal((await ok(h.api('manager', 'GET', url))).requisition.returnComment, null);
  await ok(h.api('bp', 'POST', `${url}/approve`, {}));
  assert.equal(openTasks('recruiting_approval', id).length, 0, 'alle Freigabe-Aufgaben sind erledigt');
  const opened = (await ok(h.api('manager', 'GET', url))).requisition;
  assert.equal(opened.status, 'open');
  assert.ok(opened.openedAt);
});

test('Statuswege: nur erlaubte Schritte, Änderungsrechte hängen vom Status ab', async () => {
  const id = await createOpenRequisition({ title: 'Status' });
  const url = `/api/recruiting/requisitions/${id}`;
  assert.equal((await h.api('manager', 'POST', `${url}/resume`, {})).status, 409, 'offen lässt sich nicht fortsetzen');
  assert.equal((await h.api('manager', 'POST', `${url}/submit`, {})).status, 409);
  assert.equal((await h.api('manager', 'PATCH', url, { title: 'Neu' })).status, 403, 'Führungskraft ändert nur Entwürfe');
  await ok(h.api('hr', 'PATCH', url, { title: 'Neu von HR' }));
  await ok(h.api('manager', 'POST', `${url}/pause`, {}));
  assert.equal((await h.api('hr', 'POST', `${url}/applications`, { candidate: { name: 'X', email: uniqueEmail() } })).status, 409, 'pausiert nimmt nichts an');
  await ok(h.api('manager', 'POST', `${url}/resume`, {}));
  assert.equal((await h.api('manager', 'POST', `${url}/fill`, {})).status, 403, 'von Hand besetzen darf nur HR');
  await ok(h.api('manager', 'POST', `${url}/cancel`, {}));
  assert.equal((await h.api('hr', 'POST', `${url}/pause`, {})).status, 409, 'abgebrochen bleibt abgebrochen');
  assert.equal((await h.api('hr', 'PATCH', url, { title: 'Zu spät' })).status, 409);
  assert.equal((await h.api('manager', 'POST', `${url}/nichtsda`, {})).status, 404);
});

test('Rollengrenzen bei Stellen: Führungskraft sieht fremde Stellen nicht', async () => {
  const id = await createOpenRequisition({ owner: 'manager', title: 'Fremd' });
  const url = `/api/recruiting/requisitions/${id}`;
  for (const who of ['director', 'anna', 'clara']) {
    assert.equal((await h.api(who, 'GET', url)).status, 403, `${who} darf die Stelle nicht sehen`);
    assert.equal((await h.api(who, 'GET', `${url}/board`)).status, 403, `${who} darf die Spalten nicht sehen`);
    assert.equal((await h.api(who, 'PATCH', url, { title: 'Übernahme' })).status, 403, who);
    assert.equal((await h.api(who, 'POST', `${url}/cancel`, {})).status, 403, who);
    assert.equal((await h.api(who, 'POST', `${url}/applications`, { candidate: { name: 'X', email: uniqueEmail() } })).status, 403, who);
  }
  await ok(h.api('bp', 'GET', url));
  await ok(h.api('hr', 'GET', `${url}/board`));

  const directorOwn = await createOpenRequisition({ owner: 'director', title: 'Eigene der Bereichsleitung' });
  const managerList = await ok(h.api('manager', 'GET', '/api/recruiting/requisitions'));
  assert.ok(managerList.requisitions.some(item => item.id === id));
  assert.ok(!managerList.requisitions.some(item => item.id === directorOwn), 'Liste enthält nur eigene Stellen');
  const directorList = await ok(h.api('director', 'GET', '/api/recruiting/requisitions'));
  assert.ok(!directorList.requisitions.some(item => item.id === id), 'auch die Führungslinie darüber sieht nichts');
  const hrList = await ok(h.api('hr', 'GET', '/api/recruiting/requisitions'));
  assert.ok(hrList.requisitions.some(item => item.id === id) && hrList.requisitions.some(item => item.id === directorOwn));

  assert.equal((await h.api('anna', 'GET', '/api/recruiting/requisitions')).status, 403, 'Mitarbeitende haben keine Stellenliste');
  assert.equal((await h.api('anna', 'GET', '/api/recruiting/meta')).status, 403);
  assert.equal((await h.api('anna', 'GET', '/api/recruiting/stages')).status, 403);
  assert.equal((await h.api('hr', 'GET', '/api/recruiting/requisitions?status=boese')).status, 400);
  assert.equal((await h.api('hr', 'GET', '/api/recruiting/requisitions/999999')).status, 404);
  assert.equal((await h.api('hr', 'GET', '/api/recruiting/requisitions/abc')).status, 404);
});

test('Bewerbende: Dubletten über die E-Mail, unabhängig von der Schreibweise', async () => {
  const email = uniqueEmail('dublette');
  const first = await ok(h.api('hr', 'POST', '/api/recruiting/candidates', { name: 'Erste Person', email }));
  const second = await h.api('hr', 'POST', '/api/recruiting/candidates', { name: 'Zweite Person', email: email.toUpperCase() });
  assert.equal(second.status, 409);
  assert.equal(second.data.code, 'duplicate_candidate');
  assert.equal(second.data.duplicate.id, first.id);

  const id = await createOpenRequisition({ title: 'Dublette' });
  const viaApplication = await h.api('hr', 'POST', `/api/recruiting/requisitions/${id}/applications`, { candidate: { name: 'Dritte Person', email } });
  assert.equal(viaApplication.status, 409);
  const existing = await ok(h.api('hr', 'POST', `/api/recruiting/requisitions/${id}/applications`, { candidateId: first.id }));
  assert.ok(existing.id, 'HR ordnet die vorhandene Person zu');

  const other = await ok(h.api('hr', 'POST', '/api/recruiting/candidates', { name: 'Andere Person', email: uniqueEmail() }));
  assert.equal((await h.api('hr', 'PATCH', `/api/recruiting/candidates/${other.id}`, { email })).status, 409, 'auch beim Ändern');
});

test('Eingaben bei Bewerbenden werden geprüft', async () => {
  const create = body => h.api('hr', 'POST', '/api/recruiting/candidates', { name: 'Check', email: uniqueEmail(), ...body });
  assert.equal((await create({ name: '' })).status, 400);
  assert.equal((await create({ email: 'keine-mail' })).status, 400);
  assert.equal((await create({ email: undefined })).status, 400);
  assert.equal((await create({ phone: 'ruf mich an' })).status, 400);
  assert.equal((await create({ source: 'Erfunden' })).status, 400);
  assert.equal((await create({ resumeUrl: 'javascript:alert(1)' })).status, 400, 'nur http und https');
  assert.equal((await create({ resumeUrl: 'data:text/html,hallo' })).status, 400);
  assert.equal((await create({ talentPoolConsent: 'ja' })).status, 400);
  assert.equal((await create({ talentPoolConsent: true, talentPoolConsentDate: '2999-01-01' })).status, 400, 'kein Datum in der Zukunft');
  const good = await ok(create({ phone: '+49 (30) 123-45', source: 'Empfehlung', resumeUrl: 'https://example.com/cv', talentPoolConsent: true }));
  const { candidate } = await ok(h.api('hr', 'GET', `/api/recruiting/candidates/${good.id}`));
  assert.equal(candidate.talentPoolConsent, true);
  assert.equal(candidate.talentPoolConsentDate, new Date().toISOString().slice(0, 10), 'ohne Angabe gilt heute');
  await ok(h.api('hr', 'PATCH', `/api/recruiting/candidates/${good.id}`, { talentPoolConsent: false }));
  const withdrawn = (await ok(h.api('hr', 'GET', `/api/recruiting/candidates/${good.id}`))).candidate;
  assert.equal(withdrawn.talentPoolConsent, false);
  assert.equal(withdrawn.talentPoolConsentDate, null);
  assert.equal((await h.api('hr', 'GET', '/api/recruiting/candidates/999999')).status, 404);
});

test('Rollengrenzen bei Bewerbenden: Liste nur HR, Führungskraft nur eigene Bewerbungen', async () => {
  const ownRequisition = await createOpenRequisition({ title: 'Eigene' });
  const foreignRequisition = await createOpenRequisition({ owner: 'director', title: 'Fremde' });
  const { applicationId: ownApplication } = await addApplication(ownRequisition, { name: 'Eigene Person' });
  const { applicationId: foreignApplication } = await addApplication(foreignRequisition, { name: 'Fremde Person', notes: 'Interne Notiz' });
  const candidateIdOf = applicationId => h.db.prepare('SELECT candidate_id FROM recruiting_applications WHERE id=?').get(applicationId).candidate_id;

  for (const who of ['manager', 'director', 'anna']) {
    assert.equal((await h.api(who, 'GET', '/api/recruiting/candidates')).status, 403, who);
    assert.equal((await h.api(who, 'POST', '/api/recruiting/candidates', { name: 'X', email: uniqueEmail() })).status, 403, who);
  }
  await ok(h.api('manager', 'GET', `/api/recruiting/candidates/${candidateIdOf(ownApplication)}`));
  assert.equal((await h.api('manager', 'GET', `/api/recruiting/candidates/${candidateIdOf(foreignApplication)}`)).status, 403, 'fremde Person');
  assert.equal((await h.api('anna', 'GET', `/api/recruiting/candidates/${candidateIdOf(ownApplication)}`)).status, 403);
  assert.equal((await h.api('manager', 'GET', `/api/recruiting/applications/${foreignApplication}`)).status, 403, 'fremde Bewerbung');
  assert.equal((await h.api('anna', 'GET', `/api/recruiting/applications/${ownApplication}`)).status, 403, 'Mitarbeitende sehen keine Bewerbungen');

  const candidateUrl = `/api/recruiting/candidates/${candidateIdOf(ownApplication)}`;
  await ok(h.api('manager', 'PATCH', candidateUrl, { notes: 'Notiz der Führungskraft', phone: '+49 30 1' }));
  assert.equal((await h.api('manager', 'PATCH', candidateUrl, { email: uniqueEmail() })).status, 403, 'E-Mail ändert HR');
  assert.equal((await h.api('manager', 'PATCH', candidateUrl, { name: 'Anders' })).status, 403);
  assert.equal((await h.api('manager', 'PATCH', candidateUrl, { talentPoolConsent: true })).status, 403, 'Einwilligung pflegt HR');
  assert.equal((await h.api('manager', 'POST', `${candidateUrl}/anonymize`, {})).status, 403);
  assert.equal((await h.api('manager', 'PATCH', `/api/recruiting/candidates/${candidateIdOf(foreignApplication)}`, { notes: 'x' })).status, 403);

  const candidateList = await ok(h.api('hr', 'GET', '/api/recruiting/candidates?q=Fremde'));
  assert.ok(candidateList.candidates.every(item => item.name.includes('Fremde')));
  assert.ok(candidateList.candidates.length >= 1);
});

test('Führungskräfte erfahren beim Erfassen nicht, ob jemand anderswo bekannt ist', async () => {
  const ownRequisition = await createOpenRequisition({ title: 'Ohne Orakel' });
  const foreignRequisition = await createOpenRequisition({ owner: 'director', title: 'Anderswo' });
  const email = uniqueEmail('orakel');
  await addApplication(foreignRequisition, { name: 'Bekannt bei HR', email, notes: 'Vertraulich' });

  const response = await h.api('manager', 'POST', `/api/recruiting/requisitions/${ownRequisition}/applications`, {
    candidate: { name: 'Neu erfasst', email }
  });
  assert.equal(response.status, 200, 'dieselbe Antwort wie bei einer unbekannten E-Mail');
  assert.ok(!JSON.stringify(response.data).includes('Bekannt'));
  const detail = await ok(h.api('manager', 'GET', `/api/recruiting/applications/${response.data.id}`));
  assert.equal(detail.candidate.name, 'Neu erfasst');
  assert.equal(detail.candidate.notes, null, 'fremde Notizen bleiben verborgen');
  assert.ok(!('duplicates' in detail.candidate), 'Dubletten-Hinweis nur für HR');
  const hrDetail = await ok(h.api('hr', 'GET', `/api/recruiting/applications/${response.data.id}`));
  assert.equal(hrDetail.candidate.duplicates.length, 1, 'HR sieht die mögliche Dublette');

  const again = await h.api('manager', 'POST', `/api/recruiting/requisitions/${ownRequisition}/applications`, { candidate: { name: 'Noch mal', email } });
  assert.equal(again.status, 409, 'auf derselben Stelle gibt es die Doppelbewerbung-Sperre');
  const byId = await h.api('manager', 'POST', `/api/recruiting/requisitions/${ownRequisition}/applications`, { candidateId: 1 });
  assert.equal(byId.status, 403, 'vorhandene Personen kann nur HR zuordnen');

  const employeeEmail = await ok(h.api('manager', 'POST', `/api/recruiting/requisitions/${ownRequisition}/applications`, {
    candidate: { name: 'Klingt wie Clara', email: 'clara@test.local' }
  }));
  const employeeDetail = await ok(h.api('manager', 'GET', `/api/recruiting/applications/${employeeEmail.id}`));
  assert.equal(employeeDetail.candidate.internal, false, 'auch ein Konto wird nicht verraten');
  const employeeHr = await ok(h.api('hr', 'GET', `/api/recruiting/applications/${employeeEmail.id}`));
  assert.equal(employeeHr.candidate.matchingEmployee.id, h.people.clara.id, 'HR sieht den Treffer');
});

test('Je Stelle und Person gibt es genau eine Bewerbung', async () => {
  const id = await createOpenRequisition({ title: 'Doppelt' });
  const candidate = await ok(h.api('hr', 'POST', '/api/recruiting/candidates', { name: 'Doppel Person', email: uniqueEmail() }));
  await ok(h.api('hr', 'POST', `/api/recruiting/requisitions/${id}/applications`, { candidateId: candidate.id }));
  const second = await h.api('hr', 'POST', `/api/recruiting/requisitions/${id}/applications`, { candidateId: candidate.id });
  assert.equal(second.status, 409);
  assert.equal(h.db.prepare('SELECT COUNT(*) AS count FROM recruiting_applications WHERE requisition_id=? AND candidate_id=?').get(id, candidate.id).count, 1);
  assert.throws(
    () => h.db.prepare("INSERT INTO recruiting_applications(requisition_id,candidate_id,stage_id,created_at,updated_at) VALUES(?,?,1,'x','x')").run(id, candidate.id),
    /UNIQUE/,
    'auch die Datenbank verhindert es'
  );
  const otherRequisition = await createOpenRequisition({ title: 'Doppelt zwei' });
  await ok(h.api('hr', 'POST', `/api/recruiting/requisitions/${otherRequisition}/applications`, { candidateId: candidate.id }));
  assert.equal((await h.api('hr', 'POST', `/api/recruiting/requisitions/${id}/applications`, { candidateId: 999999 })).status, 404);
  assert.equal((await h.api('hr', 'POST', `/api/recruiting/requisitions/${id}/applications`, {})).status, 400, 'ohne Angaben');
});

test('Stufenverlauf: Jeder Wechsel steht im Verlauf, Spaltenansicht folgt', async () => {
  const id = await createOpenRequisition({ title: 'Verlauf' });
  const { applicationId } = await addApplication(id, { name: 'Stufen Person' });
  const { stages } = await ok(h.api('hr', 'GET', '/api/recruiting/stages'));
  const stage = name => stages.find(item => item.name === name).id;
  const move = (who, stageId) => h.api(who, 'POST', `/api/recruiting/applications/${applicationId}/move`, { stageId });

  await ok(move('manager', stage('Vorauswahl')));
  await ok(move('hr', stage('Gespräch')));
  await ok(move('manager', stage('Vorauswahl')));
  assert.equal((await move('manager', stage('Vorauswahl'))).status, 400, 'schon dort');
  assert.equal((await move('manager', stage('Eingestellt'))).status, 400, 'nur über Einstellen');
  assert.equal((await move('manager', 999999)).status, 400);
  assert.equal((await move('manager', 'abc')).status, 400);
  assert.equal((await move('director', stage('Gespräch'))).status, 403);
  assert.equal((await move('anna', stage('Gespräch'))).status, 403);
  await ok(move('manager', stage('Gespräch')));

  const detail = await ok(h.api('manager', 'GET', `/api/recruiting/applications/${applicationId}`));
  assert.deepEqual(detail.history.map(entry => [entry.fromStageName, entry.toStageName]), [
    [null, 'Eingang'],
    ['Eingang', 'Vorauswahl'],
    ['Vorauswahl', 'Gespräch'],
    ['Gespräch', 'Vorauswahl'],
    ['Vorauswahl', 'Gespräch']
  ]);
  assert.ok(detail.history.every(entry => entry.changedByName), 'mit Namen der handelnden Person');

  const board = await ok(h.api('manager', 'GET', `/api/recruiting/requisitions/${id}/board`));
  assert.equal(board.applications.find(card => card.id === applicationId).stageId, stage('Gespräch'));
  assert.equal(board.stages.length, 5);
  assert.equal(board.canMoveApplications, true);
});

test('Absage: Grund aus fester Liste, Text neutral und nur zum Kopieren', async () => {
  const id = await createOpenRequisition({ title: 'Absage Stelle' });
  const { applicationId } = await addApplication(id, { name: 'Abgesagte Person' });
  const url = `/api/recruiting/applications/${applicationId}`;
  assert.equal((await h.api('manager', 'GET', `${url}/rejection-text`)).status, 409, 'erst nach der Absage');
  assert.equal((await h.api('manager', 'POST', `${url}/reject`, {})).status, 400);
  assert.equal((await h.api('manager', 'POST', `${url}/reject`, { reason: 'unsympathisch' })).status, 400);
  assert.equal((await h.api('manager', 'POST', `${url}/reject`, { reason: '__proto__' })).status, 400);
  assert.equal((await h.api('director', 'POST', `${url}/reject`, { reason: 'other' })).status, 403);
  assert.equal((await h.api('anna', 'POST', `${url}/reject`, { reason: 'other' })).status, 403);

  const internalNote = 'Interner Vermerk: passt nicht ins Team';
  const rejected = await ok(h.api('manager', 'POST', `${url}/reject`, { reason: 'experience', note: internalNote }));
  const { text, subject } = rejected.rejectionText;
  assert.ok(text.includes('Guten Tag Abgesagte Person'));
  assert.ok(subject.includes('Absage Stelle'));
  assert.ok(text.includes('Testfirma'));
  assert.ok(!text.includes('Erfahrung') && !text.includes(internalNote), 'interner Grund bleibt intern');
  const copied = await ok(h.api('hr', 'GET', `${url}/rejection-text`));
  assert.ok(copied.rejectionText.text.includes('Abgesagte Person'));
  assert.equal((await h.api('anna', 'GET', `${url}/rejection-text`)).status, 403);

  const detail = await ok(h.api('manager', 'GET', url));
  assert.equal(detail.application.status, 'rejected');
  assert.equal(detail.application.rejectionReason, 'experience');
  assert.equal(detail.application.rejectionNote, internalNote);
  assert.equal(detail.history.at(-1).toStatus, 'rejected');
  assert.equal((await h.api('manager', 'POST', `${url}/reject`, { reason: 'other' })).status, 409);
  const { stages } = await ok(h.api('hr', 'GET', '/api/recruiting/stages'));
  assert.equal((await h.api('manager', 'POST', `${url}/move`, { stageId: stages[2].id })).status, 409, 'abgesagt bleibt abgesagt');
  const board = await ok(h.api('manager', 'GET', `/api/recruiting/requisitions/${id}/board`));
  assert.ok(board.rejected.some(card => card.id === applicationId), 'erscheint gesondert');
  assert.ok(!board.applications.some(card => card.id === applicationId));
});

test('Unabhängige Bewertung: fremde Bewertungen erst nach der eigenen', async () => {
  const id = await createOpenRequisition({ title: 'Blind' });
  const { applicationId } = await addApplication(id, { name: 'Blind Person' });
  const { id: interviewId } = await ok(h.api('manager', 'POST', `/api/recruiting/applications/${applicationId}/interviews`, interviewPlan([h.people.anna.id, h.people.ben.id])));
  const url = `/api/recruiting/interviews/${interviewId}`;

  const tasks = openTasks('recruiting_feedback', interviewId);
  assert.deepEqual(tasks.map(task => task.user_id).sort(), [h.people.anna.id, h.people.ben.id].sort(), 'je Person eine Aufgabe');
  assert.ok(tasks.every(task => task.title.includes('Blind Person')), 'der Titel nennt die Person');
  assert.ok(tasks[0].title.includes('15.01.2026'));
  assert.ok(tasks.every(task => task.due_date === '2026-01-15'), 'die Frist ist der Gesprächstag');

  await ok(h.api('ben', 'POST', `${url}/feedback`, feedbackBody({ strengths: 'Bens Einschätzung' })));
  assert.deepEqual(openTasks('recruiting_feedback', interviewId).map(task => task.user_id), [h.people.anna.id], 'Bens Aufgabe ist erledigt');

  const blindView = await ok(h.api('anna', 'GET', url));
  assert.equal(blindView.interview.feedbackVisible, false);
  assert.deepEqual(blindView.interview.feedback, []);
  assert.ok(!JSON.stringify(blindView).includes('Bens Einschätzung'));
  assert.ok(blindView.interview.participants.every(person => !('submitted' in person)), 'auch nicht, wer schon bewertet hat');
  assert.equal(blindView.interview.canSubmitFeedback, true);
  const blindApplication = await ok(h.api('anna', 'GET', `/api/recruiting/applications/${applicationId}`));
  assert.ok(!JSON.stringify(blindApplication).includes('Bens Einschätzung'), 'auch nicht über die Bewerbung');

  const managerView = await ok(h.api('manager', 'GET', url));
  assert.equal(managerView.interview.feedback.length, 1, 'die einstellende Führungskraft bewertet hier nicht selbst');
  const hrView = await ok(h.api('bp', 'GET', url));
  assert.equal(hrView.interview.feedback.length, 1, 'HR bewertet hier nicht selbst');

  assert.equal((await h.api('anna', 'POST', `${url}/feedback`, feedbackBody({ rating: 9 }))).status, 400);
  assert.equal((await h.api('anna', 'POST', `${url}/feedback`, feedbackBody({ rating: 0 }))).status, 400);
  assert.equal((await h.api('anna', 'POST', `${url}/feedback`, feedbackBody({ rating: 'gut' }))).status, 400);
  assert.equal((await h.api('anna', 'POST', `${url}/feedback`, feedbackBody({ recommendation: 'vielleicht' }))).status, 400);
  await ok(h.api('anna', 'POST', `${url}/feedback`, feedbackBody({ rating: 2, strengths: 'Annas Einschätzung' })));
  const openView = await ok(h.api('anna', 'GET', url));
  assert.equal(openView.interview.feedbackVisible, true);
  assert.equal(openView.interview.feedback.length, 2);
  assert.equal(openView.interview.ownFeedback.strengths, 'Annas Einschätzung');
  assert.equal(openView.interview.canSubmitFeedback, false);
  assert.ok(openView.interview.participants.every(person => person.submitted === true));
  assert.equal((await h.api('anna', 'POST', `${url}/feedback`, feedbackBody())).status, 409, 'nachträglich nicht änderbar');
  assert.equal(openTasks('recruiting_feedback', interviewId).length, 0);

  for (const who of ['hr', 'manager', 'clara']) {
    assert.equal((await h.api(who, 'POST', `${url}/feedback`, feedbackBody())).status, 403, `${who} ist nicht zugewiesen`);
  }
  assert.equal((await h.api('clara', 'GET', url)).status, 403);
  assert.equal((await h.api('director', 'GET', url)).status, 403);
  assert.equal((await h.api('hr', 'GET', '/api/recruiting/interviews/999999')).status, 404);

  const board = await ok(h.api('manager', 'GET', `/api/recruiting/requisitions/${id}/board`));
  const card = board.applications.find(item => item.id === applicationId);
  assert.equal(card.feedbackCount, 2);
  assert.equal(card.averageRating, 3);
});

test('Bei mehreren Gesprächen gilt die Sperre je Gespräch', async () => {
  const id = await createOpenRequisition({ title: 'Zwei Gespräche' });
  const { applicationId } = await addApplication(id, {});
  const plan = participants => h.api('hr', 'POST', `/api/recruiting/applications/${applicationId}/interviews`, interviewPlan(participants));
  const first = await ok(plan([h.people.anna.id, h.people.ben.id]));
  const second = await ok(plan([h.people.anna.id, h.people.clara.id]));
  await ok(h.api('anna', 'POST', `/api/recruiting/interviews/${first.id}/feedback`, feedbackBody()));
  await ok(h.api('clara', 'POST', `/api/recruiting/interviews/${second.id}/feedback`, feedbackBody({ strengths: 'Claras Einschätzung' })));

  const annaSecond = await ok(h.api('anna', 'GET', `/api/recruiting/interviews/${second.id}`));
  assert.deepEqual(annaSecond.interview.feedback, [], 'die erste Bewertung öffnet das zweite Gespräch nicht');
  assert.equal((await h.api('ben', 'GET', `/api/recruiting/interviews/${second.id}`)).status, 403, 'nur zugewiesene Gespräche');
  const benApplication = await ok(h.api('ben', 'GET', `/api/recruiting/applications/${applicationId}`));
  assert.deepEqual(benApplication.interviews.map(interview => interview.id), [first.id], 'Bewerbung zeigt nur eigene Gespräche');
  const { interviews } = await ok(h.api('anna', 'GET', '/api/recruiting/interviews/mine'));
  const own = interviews.filter(interview => interview.applicationId === applicationId);
  assert.deepEqual(own.map(interview => interview.submitted), [true, false]);
});

test('Interview-Beteiligte sehen nur das Nötigste: kein Angebot, kein Absagegrund, keine Kontaktdaten', async () => {
  const id = await createOpenRequisition({ title: 'Nötigstes' });
  const { applicationId, email } = await addApplication(id, {
    name: 'Knapp Person',
    phone: '+49 30 999',
    notes: 'HR-Notiz vertraulich',
    resumeText: 'Lebenslauf zum Vorbereiten'
  });
  const { applicationId: otherApplication } = await addApplication(id, { name: 'Andere Person' });
  await ok(h.api('manager', 'POST', `/api/recruiting/applications/${applicationId}/interviews`, interviewPlan([h.people.anna.id])));
  const { id: offerId } = await ok(h.api('manager', 'POST', `/api/recruiting/applications/${applicationId}/offers`, { startDate: '2098-03-01', compensation: SECRET_PAY }));

  const { status, data } = await h.api('anna', 'GET', `/api/recruiting/applications/${applicationId}`);
  assert.equal(status, 200);
  assert.equal(data.access, 'interviewer');
  assert.equal(data.candidate.name, 'Knapp Person');
  assert.equal(data.candidate.resumeText, 'Lebenslauf zum Vorbereiten');
  const text = JSON.stringify(data);
  for (const hidden of [email, '+49 30 999', 'HR-Notiz vertraulich', SECRET_PAY, 'rejection', 'offers', 'history', 'notes']) {
    assert.ok(!text.includes(hidden), `${hidden} darf nicht erscheinen`);
  }
  assert.equal((await h.api('anna', 'GET', `/api/recruiting/applications/${otherApplication}`)).status, 403, 'nur zugewiesene Bewerbungen');
  assert.equal((await h.api('anna', 'GET', `/api/recruiting/requisitions/${id}`)).status, 403);
  assert.equal((await h.api('anna', 'GET', `/api/recruiting/requisitions/${id}/board`)).status, 403);
  assert.equal((await h.api('anna', 'POST', `/api/recruiting/offers/${offerId}/submit`, {})).status, 403);
  assert.equal((await h.api('anna', 'PATCH', `/api/recruiting/offers/${offerId}`, { compensation: 'x' })).status, 403);
  assert.equal((await h.api('anna', 'POST', `/api/recruiting/applications/${applicationId}/offers`, { startDate: '2098-03-01' })).status, 403);
  assert.equal((await h.api('anna', 'POST', `/api/recruiting/applications/${applicationId}/reject`, { reason: 'other' })).status, 403);
  assert.equal((await h.api('anna', 'GET', `/api/recruiting/applications/${applicationId}/rejection-text`)).status, 403);
  assert.equal((await h.api('anna', 'POST', `/api/recruiting/applications/${applicationId}/interviews`, interviewPlan([h.people.ben.id]))).status, 403);
  assert.equal((await h.api('anna', 'POST', `/api/recruiting/applications/${applicationId}/hire`, {})).status, 403);

  await ok(h.api('manager', 'POST', `/api/recruiting/applications/${applicationId}/reject`, { reason: 'better_fit', note: 'Absagegrund vertraulich' }));
  const afterRejection = await h.api('anna', 'GET', `/api/recruiting/applications/${applicationId}`);
  assert.equal(afterRejection.status, 403, 'nach der Absage endet der Zugriff');
  assert.ok(!JSON.stringify(afterRejection.data).includes('Absagegrund vertraulich'));
  const mine = await ok(h.api('anna', 'GET', '/api/recruiting/interviews/mine'));
  assert.ok(!mine.interviews.some(interview => interview.applicationId === applicationId));
});

test('Gespräche verwalten: Prüfungen, Terminänderung, Absage', async () => {
  const id = await createOpenRequisition({ title: 'Termine' });
  const { applicationId } = await addApplication(id, {});
  const plan = body => h.api('manager', 'POST', `/api/recruiting/applications/${applicationId}/interviews`, body);
  assert.equal((await plan(interviewPlan([]))).status, 400, 'ohne Personen');
  assert.equal((await plan(interviewPlan('alle'))).status, 400);
  assert.equal((await plan(interviewPlan([999999]))).status, 400);
  assert.equal((await plan(interviewPlan(['x']))).status, 400);
  assert.equal((await plan({ ...interviewPlan([h.people.anna.id]), scheduledAt: 'bald' })).status, 400);
  assert.equal((await plan({ ...interviewPlan([h.people.anna.id]), scheduledAt: '2098-02-31T10:00' })).status, 400);
  assert.equal((await plan({ ...interviewPlan([h.people.anna.id]), scheduledAt: '2098-02-20T25:00' })).status, 400);
  assert.equal((await h.api('director', 'POST', `/api/recruiting/applications/${applicationId}/interviews`, interviewPlan([h.people.anna.id]))).status, 403);

  const { id: interviewId } = await ok(plan(interviewPlan([h.people.anna.id, h.people.anna.id, h.people.ben.id])));
  const url = `/api/recruiting/interviews/${interviewId}`;
  assert.equal(openTasks('recruiting_feedback', interviewId).length, 2, 'doppelte Personen zählen einmal');
  await ok(h.api('anna', 'POST', `${url}/feedback`, feedbackBody()));

  assert.equal((await h.api('manager', 'PATCH', url, { participantIds: [h.people.ben.id] })).status, 409, 'wer bewertet hat, bleibt');
  assert.equal((await h.api('anna', 'PATCH', url, { scheduledAt: '2098-03-01T09:00' })).status, 403);
  await ok(h.api('manager', 'PATCH', url, { scheduledAt: '2098-03-01T09:00', participantIds: [h.people.anna.id, h.people.clara.id] }));
  const tasks = openTasks('recruiting_feedback', interviewId);
  assert.deepEqual(tasks.map(task => task.user_id), [h.people.clara.id], 'Ben raus, Clara neu, Anna hat schon bewertet');
  assert.ok(tasks[0].title.includes('01.03.2098'), 'Aufgabe nennt den neuen Termin');
  assert.equal((await h.api('ben', 'GET', url)).status, 403, 'Ben hat keinen Zugriff mehr');

  assert.equal((await h.api('clara', 'POST', `${url}/cancel`, {})).status, 403);
  await ok(h.api('manager', 'POST', `${url}/cancel`, {}));
  assert.equal(openTasks('recruiting_feedback', interviewId).length, 0);
  assert.equal((await h.api('clara', 'GET', url)).status, 403, 'abgesagt: kein Zugriff mehr');
  assert.equal((await h.api('clara', 'POST', `${url}/feedback`, feedbackBody())).status, 403);
  assert.equal((await h.api('manager', 'POST', `${url}/cancel`, {})).status, 409);
  assert.equal((await h.api('manager', 'PATCH', url, { location: 'x' })).status, 409);
  assert.equal((await h.api('hr', 'POST', `${url}/feedback`, feedbackBody())).status, 403);
});

test('Vier-Augen-Freigabe: nie durch die Person, die das Angebot erstellt oder zuletzt geändert hat', async () => {
  const id = await createOpenRequisition({ title: 'Vier Augen' });
  const { applicationId } = await addApplication(id, {});

  const byHr = await ok(h.api('hr', 'POST', `/api/recruiting/applications/${applicationId}/offers`, { startDate: '2098-04-01', compensation: SECRET_PAY }));
  const url = `/api/recruiting/offers/${byHr.id}`;
  assert.equal((await h.api('hr', 'POST', `${url}/approve`, {})).status, 403, 'noch im Entwurf und von der Erstellerin');
  await ok(h.api('hr', 'POST', `${url}/submit`, {}));
  assert.deepEqual(openTasks('recruiting_offer_approval', applicationId).map(task => task.user_id), [h.people.bp.id], 'Aufgabe nur an die andere HR-Person');
  const blocked = await h.api('hr', 'POST', `${url}/approve`, {});
  assert.equal(blocked.status, 403, 'HR darf eigenes Angebot nicht freigeben');
  assert.equal((await h.api('manager', 'POST', `${url}/approve`, {})).status, 403, 'Führungskraft gibt nie frei');
  assert.equal((await h.api('anna', 'POST', `${url}/approve`, {})).status, 403);
  const hrView = await ok(h.api('hr', 'GET', `/api/recruiting/applications/${applicationId}`));
  assert.equal(hrView.offers[0].canApprove, false);
  assert.equal(hrView.offers[0].approvalBlockedForYou, true);
  const bpView = await ok(h.api('bp', 'GET', `/api/recruiting/applications/${applicationId}`));
  assert.equal(bpView.offers[0].canApprove, true);

  assert.equal((await h.api('bp', 'POST', `${url}/return`, {})).status, 400, 'Rückgabe braucht einen Grund');
  await ok(h.api('bp', 'POST', `${url}/return`, { comment: 'Bitte Datum prüfen' }));
  assert.equal(openTasks('recruiting_offer_approval', applicationId).length, 0);
  assert.deepEqual(openTasks('recruiting_offer_returned', applicationId).map(task => task.user_id), [h.people.hr.id]);
  await ok(h.api('bp', 'PATCH', url, { startDate: '2098-05-01' }));
  const nobody = await h.api('bp', 'POST', `${url}/submit`, {});
  assert.equal(nobody.status, 409, 'ohne freigebende Person bleibt es ein Entwurf');
  assert.match(nobody.data.error, /andere HR-Person/);
  assert.equal(h.db.prepare('SELECT status FROM recruiting_offers WHERE id=?').get(byHr.id).status, 'draft');

  h.db.prepare("INSERT INTO users(id,name,email,password_hash,role) VALUES(62,'Dritte HR','hr3@test.local','!TEST!','hr_admin')").run();
  await ok(h.api('bp', 'POST', `${url}/submit`, {}));
  assert.deepEqual(openTasks('recruiting_offer_approval', applicationId).map(task => task.user_id), [62]);
  assert.equal((await h.api('bp', 'POST', `${url}/approve`, {})).status, 403, 'wer zuletzt geändert hat, gibt nicht frei');
  assert.equal((await h.api('hr', 'POST', `${url}/approve`, {})).status, 403, 'wer erstellt hat, auch dann nicht');

  await ok(h.api(62, 'POST', `${url}/approve`, {}));
  assert.equal((await h.api(62, 'POST', `${url}/approve`, {})).status, 409, 'nur einmal');
  h.db.prepare('UPDATE users SET active=0 WHERE id=62').run();
  const approved = await ok(h.api('manager', 'GET', `/api/recruiting/applications/${applicationId}`));
  assert.equal(approved.offers[0].status, 'approved');
  assert.equal(approved.offers[0].approvedByName, 'Dritte HR');
  assert.equal((await h.api('hr', 'PATCH', url, { compensation: 'x' })).status, 409, 'nach der Freigabe nicht mehr änderbar');
});

test('Angebotsablauf: Statusfolge, Eingaben, nur ein offenes Angebot, keine Vergütung im Protokoll', async () => {
  const id = await createOpenRequisition({ title: 'Angebotsablauf' });
  const { applicationId } = await addApplication(id, {});
  const create = body => h.api('manager', 'POST', `/api/recruiting/applications/${applicationId}/offers`, body);
  assert.equal((await create({})).status, 400);
  assert.equal((await create({ startDate: '2098-02-31' })).status, 400);
  const inThePast = await create({ startDate: '2020-01-01' });
  assert.equal(inThePast.status, 400);
  assert.match(inThePast.data.error, /Vergangenheit/);
  assert.equal((await h.api('director', 'POST', `/api/recruiting/applications/${applicationId}/offers`, { startDate: '2098-04-01' })).status, 403);

  const { id: offerId } = await ok(create({ startDate: '2098-04-01', compensation: SECRET_PAY }));
  const url = `/api/recruiting/offers/${offerId}`;
  assert.equal((await create({ startDate: '2098-04-02' })).status, 409, 'nur ein offenes Angebot');
  assert.equal((await h.api('manager', 'POST', `${url}/response`, { accepted: true })).status, 409, 'Antwort erst nach Freigabe');
  await ok(h.api('manager', 'PATCH', url, { compensation: `${SECRET_PAY} plus Bonus` }));
  await ok(h.api('manager', 'POST', `${url}/submit`, {}));
  assert.equal((await h.api('manager', 'POST', `${url}/submit`, {})).status, 409);
  assert.equal((await h.api('manager', 'PATCH', url, { compensation: 'x' })).status, 409, 'zur Freigabe nicht änderbar');
  assert.equal((await h.api('hr', 'POST', `${url}/response`, { accepted: true })).status, 409);
  await ok(h.api('hr', 'POST', `${url}/approve`, {}));
  assert.equal((await h.api('manager', 'POST', `${url}/response`, { accepted: 'ja' })).status, 400);
  await ok(h.api('manager', 'POST', `${url}/response`, { accepted: false }));

  const detail = await ok(h.api('manager', 'GET', `/api/recruiting/applications/${applicationId}`));
  assert.equal(detail.offers[0].status, 'declined');
  assert.equal(detail.permissions.canCreateOffer, true, 'nach einer Ablehnung ist ein neues Angebot möglich');
  assert.equal(detail.permissions.canHire, false);
  await ok(create({ startDate: '2098-06-01' }));
  assert.equal((await h.api('hr', 'POST', '/api/recruiting/offers/999999/approve', {})).status, 404);

  const logged = h.db.prepare("SELECT old_values,new_values FROM audit_log WHERE entity='recruiting_offers'").all();
  assert.ok(logged.length > 0);
  assert.ok(!JSON.stringify(logged).includes(SECRET_PAY), 'Vergütung gehört nicht ins Protokoll');
});

test('Einstellung: nur HR, nur mit angenommenem Angebot, Passwort genau einmal', async () => {
  const positionId = h.db.prepare("INSERT INTO position_profiles(title,title_normalized) VALUES('Testposition','testposition')").run().lastInsertRowid;
  const id = await createOpenRequisition({ title: 'Einstellung', positionProfileId: positionId });
  const { applicationId, email } = await addApplication(id, { name: 'Neue Kollegin' });
  const url = `/api/recruiting/applications/${applicationId}/hire`;
  const usersBefore = h.db.prepare('SELECT COUNT(*) AS count FROM users').get().count;

  assert.equal((await h.api('hr', 'POST', url, {})).status, 409, 'ohne Angebot');
  const { id: offerId } = await ok(h.api('manager', 'POST', `/api/recruiting/applications/${applicationId}/offers`, { startDate: '2098-02-01', compensation: SECRET_PAY }));
  assert.equal((await h.api('hr', 'POST', url, {})).status, 409, 'Entwurf reicht nicht');
  await ok(h.api('manager', 'POST', `/api/recruiting/offers/${offerId}/submit`, {}));
  await ok(h.api('hr', 'POST', `/api/recruiting/offers/${offerId}/approve`, {}));
  assert.equal((await h.api('hr', 'POST', url, {})).status, 409, 'freigegeben reicht nicht');
  await ok(h.api('manager', 'POST', `/api/recruiting/offers/${offerId}/response`, { accepted: true }));

  for (const who of ['manager', 'director', 'anna']) {
    assert.equal((await h.api(who, 'POST', url, {})).status, 403, `${who} darf nicht einstellen`);
  }
  assert.equal(h.db.prepare('SELECT COUNT(*) AS count FROM users').get().count, usersBefore, 'bisher kein Konto');

  const hired = await ok(h.api('hr', 'POST', url, {}));
  assert.equal(hired.internal, false);
  assert.equal(typeof hired.temporaryPassword, 'string');
  assert.ok(hired.temporaryPassword.length >= 12);
  assert.equal(hired.requisitionFilled, true, 'eine Stelle, eine Einstellung: besetzt');

  const account = h.db.prepare('SELECT * FROM users WHERE id=?').get(hired.userId);
  assert.equal(account.name, 'Neue Kollegin');
  assert.equal(account.email, email);
  assert.equal(account.role, 'employee');
  assert.equal(account.manager_id, h.people.manager.id, 'Führungskraft ist die einstellende Person');
  assert.equal(account.position_profile_id, positionId);
  assert.equal(account.must_change_password, 1);
  assert.ok(bcrypt.compareSync(hired.temporaryPassword, account.password_hash), 'das Passwort passt zum Konto');

  const second = await h.api('hr', 'POST', url, {});
  assert.equal(second.status, 409, 'nur einmal');
  assert.ok(!('temporaryPassword' in second.data), 'kein zweites Passwort');
  assert.equal(h.db.prepare('SELECT COUNT(*) AS count FROM users').get().count, usersBefore + 1, 'genau ein Konto');

  const detail = await ok(h.api('hr', 'GET', `/api/recruiting/applications/${applicationId}`));
  assert.ok(!JSON.stringify(detail).includes(hired.temporaryPassword), 'danach nirgends mehr abrufbar');
  const logged = JSON.stringify(h.db.prepare('SELECT * FROM audit_log').all());
  assert.ok(!logged.includes(hired.temporaryPassword), 'nicht im Protokoll');
  const taskText = JSON.stringify(h.db.prepare('SELECT * FROM tasks').all());
  assert.ok(!taskText.includes(hired.temporaryPassword), 'nicht in Aufgaben');

  assert.equal(detail.application.status, 'hired');
  assert.equal(detail.history.at(-1).toStatus, 'hired');
  assert.equal(detail.history.at(-1).toStageName, 'Eingestellt');
  const { requisition } = await ok(h.api('hr', 'GET', `/api/recruiting/requisitions/${id}`));
  assert.equal(requisition.status, 'filled');
  assert.ok(requisition.filledAt);
  assert.equal(requisition.hiredCount, 1);
  assert.equal((await h.api('hr', 'POST', `/api/recruiting/applications/${applicationId}/reject`, { reason: 'other' })).status, 409);
  assert.equal((await h.api('hr', 'POST', '/api/recruiting/applications/999999/hire', {})).status, 404);
});

test('Die Stelle bleibt offen, bis alle Plätze vergeben sind, und nimmt dann niemanden mehr an', async () => {
  const id = await createOpenRequisition({ title: 'Zwei Plätze', openings: 2 });
  const applications = [await addApplication(id, {}), await addApplication(id, {}), await addApplication(id, {})];
  for (const { applicationId } of applications) await createAcceptedOffer(applicationId);

  const first = await ok(h.api('hr', 'POST', `/api/recruiting/applications/${applications[0].applicationId}/hire`, {}));
  assert.equal(first.requisitionFilled, false);
  assert.equal(first.remainingActiveApplications, 2);
  assert.equal((await ok(h.api('hr', 'GET', `/api/recruiting/requisitions/${id}`))).requisition.status, 'open');
  assert.equal((await h.api('hr', 'PATCH', `/api/recruiting/requisitions/${id}`, { openings: 0 })).status, 400);

  const second = await ok(h.api('hr', 'POST', `/api/recruiting/applications/${applications[1].applicationId}/hire`, {}));
  assert.equal(second.requisitionFilled, true);
  const third = await h.api('hr', 'POST', `/api/recruiting/applications/${applications[2].applicationId}/hire`, {});
  assert.equal(third.status, 409, 'alle Plätze sind vergeben');
  assert.equal((await h.api('hr', 'POST', `/api/recruiting/requisitions/${id}/applications`, { candidate: { name: 'Zu spät', email: uniqueEmail() } })).status, 409);
  await ok(h.api('hr', 'POST', `/api/recruiting/applications/${applications[2].applicationId}/reject`, { reason: 'position_closed' }));
});

test('Scheitert die Kontoanlage, bleibt alles unverändert', async () => {
  const id = await createOpenRequisition({ title: 'Rollback' });
  const { applicationId } = await addApplication(id, { email: 'system@test.local' });
  await createAcceptedOffer(applicationId);
  h.db.prepare("INSERT INTO users(id,name,email,password_hash,role,is_system_account) VALUES(60,'Technik','system@test.local','!',?,1)").run('hr_admin');
  const failed = await h.api('hr', 'POST', `/api/recruiting/applications/${applicationId}/hire`, {});
  assert.equal(failed.status, 409, JSON.stringify(failed.data));
  assert.ok(failed.data.error.includes('vergeben'));
  const detail = await ok(h.api('hr', 'GET', `/api/recruiting/applications/${applicationId}`));
  assert.equal(detail.application.status, 'active', 'keine halbe Einstellung');
  assert.equal((await ok(h.api('hr', 'GET', `/api/recruiting/requisitions/${id}`))).requisition.status, 'open');
  h.db.prepare('DELETE FROM users WHERE id=60').run();
});

test('Gesperrte Konten und gesperrte Führungskräfte stoppen die Einstellung verständlich', async () => {
  h.db.prepare("INSERT INTO users(id,name,email,password_hash,role,active) VALUES(61,'Ehemalig','ehemalig@test.local','!','employee',0)").run();
  const id = await createOpenRequisition({ title: 'Gesperrt' });
  const { applicationId } = await addApplication(id, { email: 'ehemalig@test.local' });
  await createAcceptedOffer(applicationId);
  const failed = await h.api('hr', 'POST', `/api/recruiting/applications/${applicationId}/hire`, {});
  assert.equal(failed.status, 409);
  assert.ok(failed.data.error.includes('gesperrtes Konto'));
  h.db.prepare('UPDATE recruiting_applications SET status=?,rejected_at=? WHERE id=?').run('rejected', '2026-01-01T00:00:00.000Z', applicationId);

  const nextId = await createOpenRequisition({ title: 'Führung fehlt' });
  const { applicationId: nextApplication } = await addApplication(nextId, {});
  await createAcceptedOffer(nextApplication);
  h.db.prepare('UPDATE users SET active=0 WHERE id=?').run(h.people.manager.id);
  const noManager = await h.api('hr', 'POST', `/api/recruiting/applications/${nextApplication}/hire`, {});
  h.db.prepare('UPDATE users SET active=1 WHERE id=?').run(h.people.manager.id);
  assert.equal(noManager.status, 409);
  assert.ok(noManager.data.error.includes('nicht mehr aktiv'));
  await ok(h.api('hr', 'POST', `/api/recruiting/applications/${nextApplication}/reject`, { reason: 'other' }));
});

test('Interne Stellenbörse: alle sehen offene interne Stellen, aber keine Bewerbungsdaten', async () => {
  const visible = await createOpenRequisition({ title: 'Intern sichtbar', internalPosting: true });
  const hidden = await createOpenRequisition({ title: 'Nur extern', internalPosting: false });
  const paused = await createOpenRequisition({ title: 'Intern pausiert', internalPosting: true });
  await ok(h.api('manager', 'POST', `/api/recruiting/requisitions/${paused}/pause`, {}));
  const draft = await ok(h.api('manager', 'POST', '/api/recruiting/requisitions', { title: 'Intern Entwurf', internalPosting: true }));
  await addApplication(visible, { name: 'Geheim Bewerbung', notes: 'Geheime Notiz' });

  for (const who of ['anna', 'clara', 'manager', 'hr']) {
    const { jobs } = await ok(h.api(who, 'GET', '/api/recruiting/job-board'));
    const ids = jobs.map(job => job.id);
    assert.ok(ids.includes(visible), who);
    assert.ok(!ids.includes(hidden) && !ids.includes(paused) && !ids.includes(draft.id), who);
  }
  const annaBoard = await ok(h.api('anna', 'GET', '/api/recruiting/job-board'));
  const job = annaBoard.jobs.find(item => item.id === visible);
  assert.deepEqual(
    Object.keys(job).sort(),
    ['alreadyApplied', 'applicationWithdrawn', 'applyBlockedReason', 'canApply', 'contactName', 'description', 'id', 'openings', 'positionTitle', 'targetDate', 'title'].sort(),
    'keine Felder mit Bewerbungsdaten'
  );
  assert.ok(!JSON.stringify(annaBoard).includes('Geheim'));

  assert.equal((await h.api('anna', 'POST', `/api/recruiting/job-board/${hidden}/apply`, {})).status, 404);
  assert.equal((await h.api('anna', 'POST', `/api/recruiting/job-board/${paused}/apply`, {})).status, 404);
  assert.equal((await h.api('anna', 'POST', `/api/recruiting/job-board/${draft.id}/apply`, {})).status, 404);
  assert.equal((await h.api('anna', 'POST', '/api/recruiting/job-board/999999/apply', {})).status, 404);
  assert.equal((await h.api('manager', 'POST', `/api/recruiting/job-board/${visible}/apply`, {})).status, 400, 'nicht auf die eigene Stelle');
  assert.equal(annaBoard.jobs.find(item => item.id === visible).canApply, true);
  assert.equal((await ok(h.api('manager', 'GET', '/api/recruiting/job-board'))).jobs.find(item => item.id === visible).canApply, false);
});

test('Interne Bewerbung: Führungskraft erfährt nichts, Bewerbende sehen nur das Eigene', async () => {
  const requisitionId = await createOpenRequisition({ owner: 'director', title: 'Interner Wechsel', internalPosting: true });
  const tasksBefore = h.db.prepare('SELECT COUNT(*) AS count FROM tasks WHERE user_id=?').get(h.people.manager.id).count;
  const badLink = await h.api('anna', 'POST', `/api/recruiting/job-board/${requisitionId}/apply`, { resumeUrl: 'javascript:alert(1)' });
  assert.equal(badLink.status, 400, 'nur http und https');
  const { id: applicationId } = await ok(h.api('anna', 'POST', `/api/recruiting/job-board/${requisitionId}/apply`, {
    message: 'Ich möchte wechseln',
    resumeText: 'Mein Werdegang'
  }));

  const again = await h.api('anna', 'POST', `/api/recruiting/job-board/${requisitionId}/apply`, {});
  assert.equal(again.status, 409, 'Doppelbewerbung');

  const candidate = h.db.prepare('SELECT c.* FROM recruiting_candidates c JOIN recruiting_applications a ON a.candidate_id=c.id WHERE a.id=?').get(applicationId);
  assert.equal(candidate.user_id, h.people.anna.id);
  assert.equal(candidate.source, 'Intern');
  assert.equal(candidate.email, 'anna@test.local');

  assert.equal(h.db.prepare('SELECT COUNT(*) AS count FROM tasks WHERE user_id=?').get(h.people.manager.id).count, tasksBefore, 'keine Aufgabe für die eigene Führungskraft');
  assert.equal((await h.api('manager', 'GET', `/api/recruiting/applications/${applicationId}`)).status, 403, 'auch kein Einblick');
  assert.equal((await h.api('manager', 'GET', `/api/recruiting/candidates/${candidate.id}`)).status, 403);
  assert.equal((await h.api('manager', 'GET', `/api/recruiting/requisitions/${requisitionId}/board`)).status, 403);
  assert.equal((await h.api('ben', 'GET', `/api/recruiting/applications/${applicationId}`)).status, 403);

  const hrTasks = openTasks('recruiting_internal_application', applicationId);
  assert.deepEqual(hrTasks.map(task => task.user_id).sort(), [h.people.hr.id, h.people.bp.id].sort());
  assert.ok(hrTasks.every(task => task.title.includes('Anna Ahrens')), 'der Titel nennt die Person, die Aufgabe sieht nur HR');
  const seenByOwner = await ok(h.api('director', 'GET', `/api/recruiting/applications/${applicationId}`));
  assert.equal(seenByOwner.candidate.internal, true);
  assert.equal(seenByOwner.application.message, 'Ich möchte wechseln');

  const own = await ok(h.api('anna', 'GET', `/api/recruiting/applications/${applicationId}`));
  assert.equal(own.access, 'self');
  assert.deepEqual(Object.keys(own).sort(), ['access', 'application', 'requisition']);
  const board = await ok(h.api('anna', 'GET', '/api/recruiting/job-board'));
  const mine = board.myApplications.find(item => item.id === applicationId);
  assert.equal(mine.status, 'active');
  assert.equal(mine.stageName, 'Eingang');
  assert.equal(mine.canWithdraw, true);
  assert.equal(board.jobs.find(job => job.id === requisitionId).alreadyApplied, true);

  await ok(h.api('director', 'POST', `/api/recruiting/applications/${applicationId}/reject`, { reason: 'experience', note: 'Vertraulicher Grund' }));
  assert.equal(openTasks('recruiting_internal_application', applicationId).length, 0);
  const afterRejection = await ok(h.api('anna', 'GET', `/api/recruiting/applications/${applicationId}`));
  assert.equal(afterRejection.application.status, 'rejected');
  assert.ok(!JSON.stringify(afterRejection).includes('Vertraulicher Grund') && !JSON.stringify(afterRejection).includes('experience'), 'Absagegrund bleibt intern');
  const boardAfter = await ok(h.api('anna', 'GET', '/api/recruiting/job-board'));
  assert.ok(!JSON.stringify(boardAfter.myApplications).includes('experience'));
  assert.equal(boardAfter.myApplications.find(item => item.id === applicationId).canWithdraw, false);
});

test('Wer an Gesprächen zu einer Stelle beteiligt ist, kann sich nicht selbst darauf bewerben', async () => {
  const requisitionId = await createOpenRequisition({ owner: 'director', title: 'Beteiligt', internalPosting: true });
  const { applicationId } = await addApplication(requisitionId, {}, 'director');
  await ok(h.api('director', 'POST', `/api/recruiting/applications/${applicationId}/interviews`, interviewPlan([h.people.ben.id])));
  assert.equal((await h.api('ben', 'POST', `/api/recruiting/job-board/${requisitionId}/apply`, {})).status, 409);
  const benBoard = await ok(h.api('ben', 'GET', '/api/recruiting/job-board'));
  assert.equal(benBoard.jobs.find(job => job.id === requisitionId).canApply, false, 'der Knopf fehlt gleich');
  const claraBoard = await ok(h.api('clara', 'GET', '/api/recruiting/job-board'));
  assert.equal(claraBoard.jobs.find(job => job.id === requisitionId).canApply, true);
  await ok(h.api('clara', 'POST', `/api/recruiting/job-board/${requisitionId}/apply`, {}));
});

test('HR erfasst eine E-Mail mit Konto: Die Person gilt als intern, Selbsterfassung ist gesperrt', async () => {
  const requisitionId = await createOpenRequisition({ owner: 'director', title: 'Erfasst durch HR' });
  const add = (who, email) => h.api(who, 'POST', `/api/recruiting/requisitions/${requisitionId}/applications`, { candidate: { name: 'Konto Person', email } });
  const { id: applicationId } = await ok(add('hr', 'ben@test.local'));
  const detail = await ok(h.api('hr', 'GET', `/api/recruiting/applications/${applicationId}`));
  assert.equal(detail.candidate.internal, true);
  assert.equal((await add('hr', 'ben@test.local')).status, 409, 'Dublette');
  assert.equal((await add('hr', 'hr@test.local')).status, 403, 'nicht sich selbst');
  assert.equal((await add('hr', 'director@test.local')).status, 400, 'nicht die einstellende Führungskraft');
  assert.equal(h.db.prepare("SELECT COUNT(*) AS count FROM recruiting_candidates WHERE email='hr@test.local'").get().count, 0, 'die abgelehnte Erfassung hinterlässt nichts');
});

test('Interne Bewerbung lässt sich zurückziehen, aber nur die eigene', async () => {
  const requisitionId = await createOpenRequisition({ owner: 'director', title: 'Rückzug', internalPosting: true });
  const { id: applicationId } = await ok(h.api('ben', 'POST', `/api/recruiting/job-board/${requisitionId}/apply`, {}));
  const url = `/api/recruiting/job-board/applications/${applicationId}/withdraw`;
  for (const who of ['anna', 'manager', 'hr', 'director']) {
    assert.equal((await h.api(who, 'POST', url, {})).status, 403, who);
  }
  await ok(h.api('ben', 'POST', url, {}));
  assert.equal((await h.api('ben', 'POST', url, {})).status, 409);
  const detail = await ok(h.api('director', 'GET', `/api/recruiting/applications/${applicationId}`));
  assert.equal(detail.application.rejectionReason, 'candidate_withdrew');
  assert.equal((await h.api('ben', 'POST', `/api/recruiting/job-board/${requisitionId}/apply`, {})).status, 409, 'je Stelle genau eine Bewerbung');
});

test('Niemand sieht eigene Bewertungen: HR mit eigener Bewerbung ist dort nur Bewerbende', async () => {
  const requisitionId = await createOpenRequisition({ owner: 'manager', title: 'HR bewirbt sich', internalPosting: true });
  const { id: ownApplication } = await ok(h.api('bp', 'POST', `/api/recruiting/job-board/${requisitionId}/apply`, {}));
  const { applicationId: rivalApplication } = await addApplication(requisitionId, { name: 'Mitbewerberin' });
  const { id: interviewId } = await ok(h.api('hr', 'POST', `/api/recruiting/applications/${ownApplication}/interviews`, interviewPlan([h.people.anna.id])));
  await ok(h.api('anna', 'POST', `/api/recruiting/interviews/${interviewId}/feedback`, feedbackBody({ strengths: 'Bewertung über Boris' })));

  const own = await ok(h.api('bp', 'GET', `/api/recruiting/applications/${ownApplication}`));
  assert.equal(own.access, 'self', 'nicht als HR');
  assert.ok(!JSON.stringify(own).includes('Bewertung über Boris'));
  assert.ok(!('interviews' in own));
  assert.equal((await h.api('bp', 'GET', `/api/recruiting/interviews/${interviewId}`)).status, 403);
  assert.equal((await h.api('bp', 'GET', `/api/recruiting/requisitions/${requisitionId}/board`)).status, 403, 'keine Spaltenansicht');
  assert.equal((await h.api('bp', 'GET', `/api/recruiting/requisitions/${requisitionId}`)).status, 403);
  assert.equal((await h.api('bp', 'GET', `/api/recruiting/applications/${rivalApplication}`)).status, 403, 'keine Mitbewerbenden');
  assert.equal((await h.api('bp', 'POST', `/api/recruiting/applications/${ownApplication}/move`, { stageId: 2 })).status, 403);
  assert.equal((await h.api('bp', 'POST', `/api/recruiting/applications/${ownApplication}/hire`, {})).status, 403);
  assert.equal((await h.api('bp', 'POST', `/api/recruiting/applications/${ownApplication}/reject`, { reason: 'other' })).status, 403);
  assert.equal((await h.api('bp', 'POST', `/api/recruiting/applications/${ownApplication}/offers`, { startDate: '2098-04-01' })).status, 403);

  const candidateId = h.db.prepare('SELECT candidate_id FROM recruiting_applications WHERE id=?').get(ownApplication).candidate_id;
  assert.equal((await h.api('bp', 'GET', `/api/recruiting/candidates/${candidateId}`)).status, 403, 'eigener Eintrag');
  assert.equal((await h.api('bp', 'PATCH', `/api/recruiting/candidates/${candidateId}`, { notes: 'x' })).status, 403);
  assert.equal((await h.api('bp', 'POST', `/api/recruiting/candidates/${candidateId}/anonymize`, {})).status, 403);
  const hrList = await ok(h.api('bp', 'GET', '/api/recruiting/candidates'));
  assert.ok(!hrList.candidates.some(item => item.id === candidateId), 'eigener Eintrag fehlt in der Liste');
  assert.equal((await ok(h.api('bp', 'GET', '/api/recruiting/requisitions'))).requisitions.find(item => item.id === requisitionId).ownCandidacy, true);

  const { id: offerId } = await ok(h.api('hr', 'POST', `/api/recruiting/applications/${ownApplication}/offers`, { startDate: '2098-04-01' }));
  const submitted = await h.api('hr', 'POST', `/api/recruiting/offers/${offerId}/submit`, {});
  assert.equal(submitted.status, 409, 'keine Freigabe durch die bewerbende Person selbst, deshalb bleibt es ein Entwurf');
  assert.equal(openTasks('recruiting_offer_approval', ownApplication).length, 0);
  assert.equal((await h.api('bp', 'POST', `/api/recruiting/offers/${offerId}/approve`, {})).status, 403, 'nie das eigene Angebot');

  const other = await ok(h.api('hr', 'GET', `/api/recruiting/applications/${ownApplication}`));
  assert.equal(other.interviews[0].feedback.length, 1, 'andere HR-Personen sehen die Bewertung');
  const participant = await h.api('hr', 'POST', `/api/recruiting/applications/${rivalApplication}/interviews`, interviewPlan([h.people.bp.id]));
  assert.equal(participant.status, 400, 'Bewerbende nehmen nicht an Gesprächen zur selben Stelle teil');
  const self = await h.api('hr', 'POST', `/api/recruiting/applications/${ownApplication}/interviews`, interviewPlan([h.people.bp.id]));
  assert.equal(self.status, 400, 'und erst recht nicht am eigenen');
  const taken = await h.api('hr', 'PATCH', `/api/recruiting/requisitions/${requisitionId}`, { hiringManagerId: h.people.bp.id });
  assert.equal(taken.status, 409, 'Bewerbende können die Stelle nicht verantworten');
  await ok(h.api('hr', 'POST', `/api/recruiting/applications/${ownApplication}/reject`, { reason: 'other' }));
});

test('Auch eine später zu HR beförderte Person sieht die eigene alte Bewerbung nicht', async () => {
  const id = await createOpenRequisition({ title: 'Früher extern' });
  const { applicationId } = await addApplication(id, { name: 'Spätere Kollegin' });
  const { id: interviewId } = await ok(h.api('manager', 'POST', `/api/recruiting/applications/${applicationId}/interviews`, interviewPlan([h.people.ben.id])));
  await ok(h.api('ben', 'POST', `/api/recruiting/interviews/${interviewId}/feedback`, feedbackBody({ concerns: 'Alte Bedenken' })));
  await createAcceptedOffer(applicationId);
  const hired = await ok(h.api('hr', 'POST', `/api/recruiting/applications/${applicationId}/hire`, {}));
  h.db.prepare("UPDATE users SET role='hrbp' WHERE id=?").run(hired.userId);

  const own = await ok(h.api(hired.userId, 'GET', `/api/recruiting/applications/${applicationId}`));
  assert.equal(own.access, 'self');
  assert.ok(!JSON.stringify(own).includes('Alte Bedenken'));
  assert.equal((await h.api(hired.userId, 'GET', `/api/recruiting/interviews/${interviewId}`)).status, 403);
  assert.equal((await h.api(hired.userId, 'GET', `/api/recruiting/requisitions/${id}/board`)).status, 403);
  h.db.prepare("UPDATE users SET role='employee' WHERE id=?").run(hired.userId);
});

test('Interne Einstellung: kein neues Konto, Wechsel wird nur angeboten und protokolliert', async () => {
  const positionId = h.db.prepare("INSERT INTO position_profiles(title,title_normalized) VALUES('Neue Rolle','neue rolle')").run().lastInsertRowid;
  const requisitionId = await createOpenRequisition({ owner: 'director', title: 'Interner Wechsel 2', internalPosting: true, positionProfileId: positionId });
  const { id: applicationId } = await ok(h.api('clara', 'POST', `/api/recruiting/job-board/${requisitionId}/apply`, {}));
  await createAcceptedOffer(applicationId, { creator: 'director', startDate: '2098-07-01' });
  const usersBefore = h.db.prepare('SELECT COUNT(*) AS count FROM users').get().count;
  const claraBefore = h.db.prepare('SELECT manager_id,position_profile_id,title,role,password_hash FROM users WHERE id=?').get(h.people.clara.id);

  const hired = await ok(h.api('hr', 'POST', `/api/recruiting/applications/${applicationId}/hire`, {}));
  assert.equal(hired.internal, true);
  assert.equal(hired.temporaryPassword, null, 'kein Passwort');
  assert.equal(hired.userId, h.people.clara.id);
  assert.equal(hired.journeyId, null, 'kein Einstieg ohne ausdrücklichen Wunsch');
  assert.deepEqual(hired.positionChange, {
    positionProfileId: positionId,
    positionTitle: 'Neue Rolle',
    managerId: h.people.director.id,
    managerName: 'Dora Direktor',
    startDate: '2098-07-01'
  });
  assert.equal(h.db.prepare('SELECT COUNT(*) AS count FROM users').get().count, usersBefore, 'kein neues Konto');
  assert.deepEqual(h.db.prepare('SELECT manager_id,position_profile_id,title,role,password_hash FROM users WHERE id=?').get(h.people.clara.id), claraBefore, 'am Konto ändert sich nichts');
  const logged = h.db.prepare("SELECT * FROM audit_log WHERE action='recruiting_internal_move_offered' AND entity_id=? ORDER BY id DESC").get(h.people.clara.id);
  assert.ok(logged, 'der Wechsel ist protokolliert');
  assert.ok(logged.new_values.includes('2098-07-01'));
  assert.equal((await ok(h.api('hr', 'GET', `/api/recruiting/requisitions/${requisitionId}`))).requisition.status, 'filled');
  assert.equal((await h.api('hr', 'POST', `/api/recruiting/applications/${applicationId}/hire`, {})).status, 409);
});

test('Eine bekannte E-Mail führt zum internen Weg statt zu einem zweiten Konto', async () => {
  const id = await createOpenRequisition({ title: 'Konto vorhanden' });
  const { id: applicationId } = await ok(h.api('manager', 'POST', `/api/recruiting/requisitions/${id}/applications`, {
    candidate: { name: 'Eigentlich Ben', email: 'ben@test.local' }
  }));
  await createAcceptedOffer(applicationId);
  const hired = await ok(h.api('hr', 'POST', `/api/recruiting/applications/${applicationId}/hire`, {}));
  assert.equal(hired.internal, true);
  assert.equal(hired.userId, h.people.ben.id);
  assert.equal(hired.temporaryPassword, null);
});

test('Onboarding startet bei eingeschaltetem Modul mit dem Eintrittsdatum', async () => {
  const id = await createOpenRequisition({ title: 'Mit Einstieg' });
  const { applicationId } = await addApplication(id, { name: 'Einstieg Person' });
  await createAcceptedOffer(applicationId, { startDate: '2098-03-01' });
  const hired = await ok(h.api('hr', 'POST', `/api/recruiting/applications/${applicationId}/hire`, {}));
  assert.ok(hired.journeyId, 'der Ablauf läuft');
  const journey = h.db.prepare('SELECT * FROM onboarding_journeys WHERE id=?').get(hired.journeyId);
  assert.equal(journey.user_id, hired.userId);
  assert.equal(journey.key_date, '2098-03-01');
  assert.equal(journey.kind, 'onboarding');
  const managerTask = h.db.prepare("SELECT * FROM onboarding_journey_tasks WHERE journey_id=? AND assignee_type='manager' LIMIT 1").get(hired.journeyId);
  assert.equal(managerTask.assignee_id, h.people.manager.id, 'Führungskraft-Aufgaben gehen an die einstellende Person');
  const ownTasks = h.db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE user_id=? AND type='onboarding_task' AND done=0").get(hired.userId).count;
  assert.ok(ownTasks > 0, 'die neue Person hat Aufgaben');
});

test('Interne Einstellung startet den Einstieg nur auf ausdrücklichen Wunsch', async () => {
  const id = await createOpenRequisition({ owner: 'director', title: 'Intern mit Einstieg', internalPosting: true });
  const { id: applicationId } = await ok(h.api('clara', 'POST', `/api/recruiting/job-board/${id}/apply`, {}));
  await createAcceptedOffer(applicationId, { creator: 'director' });
  const hired = await ok(h.api('hr', 'POST', `/api/recruiting/applications/${applicationId}/hire`, { startOnboarding: true }));
  assert.ok(hired.journeyId);
  h.db.prepare("UPDATE onboarding_journeys SET status='cancelled' WHERE id=?").run(hired.journeyId);
});

test('Eine ungültige Einstiegsvorlage stoppt die Einstellung vor der Kontoanlage', async () => {
  const id = await createOpenRequisition({ title: 'Vorlage falsch' });
  const { applicationId } = await addApplication(id, {});
  await createAcceptedOffer(applicationId);
  const usersBefore = h.db.prepare('SELECT COUNT(*) AS count FROM users').get().count;
  const failed = await h.api('hr', 'POST', `/api/recruiting/applications/${applicationId}/hire`, { templateId: 999999 });
  assert.equal(failed.status, 400);
  const offboarding = h.db.prepare("SELECT id FROM onboarding_templates WHERE kind='offboarding' LIMIT 1").get();
  assert.equal((await h.api('hr', 'POST', `/api/recruiting/applications/${applicationId}/hire`, { templateId: offboarding.id })).status, 400, 'falsche Art');
  assert.equal(h.db.prepare('SELECT COUNT(*) AS count FROM users').get().count, usersBefore);
  const onboarding = h.db.prepare("SELECT id FROM onboarding_templates WHERE kind='onboarding' LIMIT 1").get();
  const hired = await ok(h.api('hr', 'POST', `/api/recruiting/applications/${applicationId}/hire`, { templateId: onboarding.id }));
  assert.equal(h.db.prepare('SELECT template_id FROM onboarding_journeys WHERE id=?').get(hired.journeyId).template_id, onboarding.id);
});

test('Fehlt eine Einstiegsvorlage, gelingt die Einstellung trotzdem und das Passwort bleibt erhalten', async () => {
  const id = await createOpenRequisition({ title: 'Ohne Vorlage' });
  const { applicationId } = await addApplication(id, {});
  await createAcceptedOffer(applicationId);
  h.db.prepare("UPDATE onboarding_templates SET active=0 WHERE kind='onboarding'").run();
  const hired = await ok(h.api('hr', 'POST', `/api/recruiting/applications/${applicationId}/hire`, {}));
  h.db.prepare("UPDATE onboarding_templates SET active=1 WHERE kind='onboarding'").run();
  assert.ok(hired.temporaryPassword);
  assert.equal(hired.journeyId, null);
  assert.ok(hired.onboardingNote.includes('Vorlage'));
});

test('Onboarding startet nicht, wenn das Modul abgeschaltet ist', async () => {
  const off = await createModuleHarness(createRecruitingModule, { isModuleEnabled: key => key !== 'onboarding' });
  try {
    const helpers = sharedHelpers(off);
    const id = await helpers.createOpenRequisition({ title: 'Ohne Modul' });
    const { applicationId } = await helpers.addApplication(id, {});
    await helpers.createAcceptedOffer(applicationId);
    const hired = await ok(off.api('hr', 'POST', `/api/recruiting/applications/${applicationId}/hire`, { templateId: 12345 }));
    assert.ok(hired.temporaryPassword, 'die Einstellung selbst funktioniert');
    assert.equal(hired.journeyId, null);
    assert.equal(hired.onboardingNote, null);
    assert.equal(tablesStartingWith(off.db, 'onboarding_').length, 0, 'das Modul wurde gar nicht angefasst');
    assert.equal(off.db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE type LIKE 'onboarding_%'").get().count, 0);
    const meta = await ok(off.api('hr', 'GET', '/api/recruiting/meta'));
    assert.equal(meta.onboardingEnabled, false);
  } finally {
    await off.close();
  }
});

test('Ist das Talentmodul aus, gibt es keine Positionsauswahl', async () => {
  const off = await createModuleHarness(createRecruitingModule, { isModuleEnabled: key => key !== 'talent' });
  try {
    const positionId = off.db.prepare("INSERT INTO position_profiles(title,title_normalized) VALUES('Position','position')").run().lastInsertRowid;
    const meta = await ok(off.api('hr', 'GET', '/api/recruiting/meta'));
    assert.deepEqual(meta.positions, []);
    assert.equal(meta.talentEnabled, false);
    const rejected = await off.api('hr', 'POST', '/api/recruiting/requisitions', { title: 'Mit Position', positionProfileId: positionId });
    assert.equal(rejected.status, 400);
    await ok(off.api('hr', 'POST', '/api/recruiting/requisitions', { title: 'Ohne Position' }));
  } finally {
    await off.close();
  }
});

test('Datenschutz: Anonymisierung nach Ablauf, Ausnahme Talentpool, wiederholbar', async () => {
  const fresh = await createModuleHarness(createRecruitingModule);
  try {
    const helpers = sharedHelpers(fresh);
    const requisitionId = await helpers.createOpenRequisition({ title: 'Frist' });
    const old = '2020-01-01T00:00:00.000Z';
    const setRejectedAt = (applicationId, value) => fresh.db.prepare('UPDATE recruiting_applications SET rejected_at=? WHERE id=?').run(value, applicationId);
    const candidateOf = applicationId => fresh.db.prepare('SELECT c.* FROM recruiting_candidates c JOIN recruiting_applications a ON a.candidate_id=c.id WHERE a.id=?').get(applicationId);

    const expired = await helpers.addApplication(requisitionId, { name: 'Abgelaufene Person', phone: '+49 30 111', notes: 'Notiz alt', resumeText: 'Lebenslauf alt', resumeUrl: 'https://example.com/alt' });
    const recent = await helpers.addApplication(requisitionId, { name: 'Frische Person' });
    const pool = await helpers.addApplication(requisitionId, { name: 'Pool Person', talentPoolConsent: true });
    const active = await helpers.addApplication(requisitionId, { name: 'Aktive Person' });

    const { id: interviewId } = await ok(fresh.api('manager', 'POST', `/api/recruiting/applications/${expired.applicationId}/interviews`, interviewPlan([fresh.people.anna.id])));
    await ok(fresh.api('anna', 'POST', `/api/recruiting/interviews/${interviewId}/feedback`, feedbackBody({ strengths: 'Freitext Stärke', concerns: 'Freitext Bedenken', rating: 5 })));
    await ok(fresh.api('manager', 'POST', `/api/recruiting/applications/${expired.applicationId}/offers`, { startDate: '2098-01-01', compensation: SECRET_PAY }));
    for (const entry of [expired, recent, pool]) {
      await ok(fresh.api('hr', 'POST', `/api/recruiting/applications/${entry.applicationId}/reject`, { reason: 'experience', note: 'Notiz zur Absage' }));
    }
    setRejectedAt(expired.applicationId, old);
    setRejectedAt(pool.applicationId, old);

    assert.equal(fresh.instance.maintenance(), 1);
    const anonymized = candidateOf(expired.applicationId);
    assert.equal(anonymized.name, 'Anonymisierte Person');
    for (const field of ['email', 'phone', 'notes', 'resume_text', 'resume_url', 'user_id']) {
      assert.equal(anonymized[field], null, field);
    }
    assert.ok(anonymized.anonymized_at);
    const feedback = fresh.db.prepare('SELECT * FROM recruiting_feedback WHERE interview_id=?').get(interviewId);
    assert.equal(feedback.strengths, null, 'auch Freitexte verschwinden');
    assert.equal(feedback.concerns, null);
    assert.equal(feedback.rating, 5, 'Zahlen bleiben für Auswertungen');
    const application = fresh.db.prepare('SELECT * FROM recruiting_applications WHERE id=?').get(expired.applicationId);
    assert.equal(application.rejection_note, null);
    assert.equal(application.rejection_reason, 'experience', 'die interne Kategorie bleibt');
    assert.equal(fresh.db.prepare('SELECT compensation FROM recruiting_offers WHERE application_id=?').get(expired.applicationId).compensation, null);

    const traces = JSON.stringify([
      fresh.db.prepare('SELECT title FROM tasks').all(),
      fresh.db.prepare('SELECT old_values,new_values FROM audit_log').all()
    ]);
    assert.ok(!traces.includes('Abgelaufene Person') && !traces.includes(expired.email), 'keine Spuren in Aufgaben und Protokoll');

    assert.equal(candidateOf(recent.applicationId).name, 'Frische Person', 'Frist läuft noch');
    assert.equal(candidateOf(pool.applicationId).name, 'Pool Person', 'gültige Einwilligung');
    assert.equal(candidateOf(active.applicationId).name, 'Aktive Person', 'noch aktiv');

    const stamp = anonymized.anonymized_at;
    const logCount = () => fresh.db.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE action='recruiting_candidate_anonymized'").get().count;
    const countBefore = logCount();
    assert.equal(fresh.instance.maintenance(), 0, 'ein zweiter Lauf ändert nichts');
    assert.equal(candidateOf(expired.applicationId).anonymized_at, stamp);
    assert.equal(logCount(), countBefore);

    const poolCandidate = candidateOf(pool.applicationId);
    fresh.db.prepare('UPDATE recruiting_candidates SET talent_pool_consent_date=NULL WHERE id=?').run(poolCandidate.id);
    assert.equal(fresh.instance.maintenance(), 1, 'ohne Datum ist die Einwilligung nicht gültig');
    assert.equal(candidateOf(pool.applicationId).name, 'Anonymisierte Person');

    await ok(fresh.api('hr', 'PATCH', '/api/recruiting/settings', { retentionMonths: 3 }));
    setRejectedAt(recent.applicationId, new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString());
    assert.equal(fresh.instance.maintenance(), 1, 'die eingestellte Frist gilt');

    const detail = await ok(fresh.api('manager', 'GET', `/api/recruiting/applications/${expired.applicationId}`));
    assert.equal(detail.candidate.name, 'Anonymisierte Person');
    assert.equal(detail.candidate.anonymized, true);
    assert.equal(detail.permissions.canCopyRejectionText, false);
    assert.equal((await fresh.api('manager', 'GET', `/api/recruiting/applications/${expired.applicationId}/rejection-text`)).status, 409);
    assert.equal((await fresh.api('hr', 'PATCH', `/api/recruiting/candidates/${anonymized.id}`, { notes: 'x' })).status, 409);
    const list = await ok(fresh.api('hr', 'GET', '/api/recruiting/candidates'));
    assert.ok(!list.candidates.some(item => item.id === anonymized.id), 'in der Standardliste nicht mehr enthalten');
    const reattach = await fresh.api('hr', 'POST', `/api/recruiting/requisitions/${requisitionId}/applications`, { candidateId: anonymized.id });
    assert.equal(reattach.status, 409);
  } finally {
    await fresh.close();
  }
});

test('Einwilligung zurückgezogen: Beim nächsten Lauf wird anonymisiert', async () => {
  const fresh = await createModuleHarness(createRecruitingModule);
  try {
    const helpers = sharedHelpers(fresh);
    const requisitionId = await helpers.createOpenRequisition({ title: 'Einwilligung' });
    const { applicationId } = await helpers.addApplication(requisitionId, { name: 'Widerruf Person', talentPoolConsent: true, talentPoolConsentDate: '2020-01-01' });
    await ok(fresh.api('hr', 'POST', `/api/recruiting/applications/${applicationId}/reject`, { reason: 'other' }));
    fresh.db.prepare('UPDATE recruiting_applications SET rejected_at=? WHERE id=?').run('2020-02-01T00:00:00.000Z', applicationId);
    assert.equal(fresh.instance.maintenance(), 0);
    const candidateId = fresh.db.prepare('SELECT candidate_id FROM recruiting_applications WHERE id=?').get(applicationId).candidate_id;
    await ok(fresh.api('hr', 'PATCH', `/api/recruiting/candidates/${candidateId}`, { talentPoolConsent: false }));
    assert.equal(fresh.instance.maintenance(), 1);
  } finally {
    await fresh.close();
  }
});

test('Eingestellte werden nie automatisch anonymisiert, auch mit einer alten Absage nicht', async () => {
  const fresh = await createModuleHarness(createRecruitingModule);
  try {
    const helpers = sharedHelpers(fresh);
    const firstRequisition = await helpers.createOpenRequisition({ title: 'Früher abgesagt' });
    const secondRequisition = await helpers.createOpenRequisition({ title: 'Später eingestellt' });
    const { id: candidateId } = await ok(fresh.api('hr', 'POST', '/api/recruiting/candidates', { name: 'Zweiter Anlauf', email: uniqueEmail() }));
    const firstApplication = await ok(fresh.api('hr', 'POST', `/api/recruiting/requisitions/${firstRequisition}/applications`, { candidateId }));
    const secondApplication = await ok(fresh.api('hr', 'POST', `/api/recruiting/requisitions/${secondRequisition}/applications`, { candidateId }));
    await ok(fresh.api('hr', 'POST', `/api/recruiting/applications/${firstApplication.id}/reject`, { reason: 'other' }));
    fresh.db.prepare('UPDATE recruiting_applications SET rejected_at=? WHERE id=?').run('2020-02-01T00:00:00.000Z', firstApplication.id);
    assert.equal(fresh.instance.maintenance(), 0, 'es läuft noch eine zweite Bewerbung');
    await helpers.createAcceptedOffer(secondApplication.id);
    await ok(fresh.api('hr', 'POST', `/api/recruiting/applications/${secondApplication.id}/hire`, {}));
    assert.equal(fresh.instance.maintenance(), 0);
    assert.equal(fresh.db.prepare('SELECT name FROM recruiting_candidates WHERE id=?').get(candidateId).name, 'Zweiter Anlauf');
  } finally {
    await fresh.close();
  }
});

test('HR kann sofort anonymisieren, aber nicht mitten im laufenden Verfahren', async () => {
  const id = await createOpenRequisition({ title: 'Sofort' });
  const { applicationId } = await addApplication(id, { name: 'Sofort Person' });
  const candidateId = h.db.prepare('SELECT candidate_id FROM recruiting_applications WHERE id=?').get(applicationId).candidate_id;
  const url = `/api/recruiting/candidates/${candidateId}/anonymize`;
  for (const who of ['manager', 'anna', 'director']) {
    assert.equal((await h.api(who, 'POST', url, {})).status, 403, who);
  }
  assert.equal((await h.api('hr', 'POST', url, {})).status, 409, 'läuft noch');
  await ok(h.api('manager', 'POST', `/api/recruiting/applications/${applicationId}/reject`, { reason: 'other' }));
  assert.deepEqual(await ok(h.api('hr', 'POST', url, {})), { ok: true, alreadyAnonymized: false });
  assert.deepEqual(await ok(h.api('hr', 'POST', url, {})), { ok: true, alreadyAnonymized: true }, 'ein zweites Mal ändert nichts');
  assert.equal(h.db.prepare('SELECT name FROM recruiting_candidates WHERE id=?').get(candidateId).name, 'Anonymisierte Person');
  assert.equal((await h.api('hr', 'POST', '/api/recruiting/candidates/999999/anonymize', {})).status, 404);
});

test('Einstellungen: nur HR, Frist mit sinnvollen Grenzen', async () => {
  for (const who of ['manager', 'anna']) {
    assert.equal((await h.api(who, 'GET', '/api/recruiting/settings')).status, 403, who);
    assert.equal((await h.api(who, 'PATCH', '/api/recruiting/settings', { retentionMonths: 12 })).status, 403, who);
  }
  for (const value of [0, -1, 1, 2, 121, 1000, 'bald', null]) {
    assert.equal((await h.api('hr', 'PATCH', '/api/recruiting/settings', { retentionMonths: value })).status, 400, String(value));
  }
  const updated = await ok(h.api('hr', 'PATCH', '/api/recruiting/settings', { retentionMonths: 12 }));
  assert.equal(updated.retentionMonths, 12);
  await ok(h.api('hr', 'PATCH', '/api/recruiting/settings', { retentionMonths: 6, confirmAnonymization: true }));
});

test('Stufen konfigurieren: nur HR, Reihenfolge, Grenzen', async () => {
  const fresh = await createModuleHarness(createRecruitingModule);
  try {
    const names = async () => (await ok(fresh.api('hr', 'GET', '/api/recruiting/stages'))).stages.map(stage => stage.name);
    assert.equal((await fresh.api('manager', 'POST', '/api/recruiting/stages', { name: 'Neu' })).status, 403);
    assert.equal((await fresh.api('hr', 'POST', '/api/recruiting/stages', { name: '' })).status, 400);
    assert.equal((await fresh.api('hr', 'POST', '/api/recruiting/stages', { name: 'eingang' })).status, 409, 'kein doppelter Name');
    const { id: testStage } = await ok(fresh.api('hr', 'POST', '/api/recruiting/stages', { name: 'Probetag' }));
    assert.deepEqual(await names(), ['Eingang', 'Vorauswahl', 'Gespräch', 'Angebot', 'Probetag', 'Eingestellt'], 'neue Stufen kommen vor „Eingestellt“');

    await ok(fresh.api('hr', 'POST', `/api/recruiting/stages/${testStage}/move`, { direction: 'up' }));
    assert.deepEqual(await names(), ['Eingang', 'Vorauswahl', 'Gespräch', 'Probetag', 'Angebot', 'Eingestellt']);
    assert.equal((await fresh.api('manager', 'POST', `/api/recruiting/stages/${testStage}/move`, { direction: 'up' })).status, 403);
    assert.equal((await fresh.api('hr', 'POST', `/api/recruiting/stages/${testStage}/move`, { direction: 'seitlich' })).status, 400);

    const { stages } = await ok(fresh.api('hr', 'GET', '/api/recruiting/stages'));
    const byName = name => stages.find(stage => stage.name === name).id;
    assert.equal((await fresh.api('hr', 'POST', `/api/recruiting/stages/${byName('Eingestellt')}/move`, { direction: 'up' })).status, 409, 'bleibt am Ende');
    assert.equal((await fresh.api('hr', 'POST', `/api/recruiting/stages/${byName('Eingang')}/move`, { direction: 'up' })).status, 409, 'weiter nach oben geht nicht');
    assert.equal((await fresh.api('hr', 'PATCH', `/api/recruiting/stages/${byName('Eingestellt')}`, { active: false })).status, 409, 'wird gebraucht');
    await ok(fresh.api('hr', 'PATCH', `/api/recruiting/stages/${testStage}`, { name: 'Schnuppertag' }));
    assert.equal((await fresh.api('hr', 'PATCH', `/api/recruiting/stages/${testStage}`, { name: 'Angebot' })).status, 409);
    assert.equal((await fresh.api('hr', 'PATCH', `/api/recruiting/stages/${testStage}`, { active: 'nein' })).status, 400);
    assert.equal((await fresh.api('manager', 'PATCH', `/api/recruiting/stages/${testStage}`, { name: 'x' })).status, 403);
    assert.equal((await fresh.api('hr', 'PATCH', '/api/recruiting/stages/999999', { name: 'x' })).status, 404);

    const helpers = sharedHelpers(fresh);
    const requisitionId = await helpers.createOpenRequisition({ title: 'Stufe belegt' });
    const { applicationId } = await helpers.addApplication(requisitionId, {});
    await ok(fresh.api('hr', 'POST', `/api/recruiting/applications/${applicationId}/move`, { stageId: testStage }));
    assert.equal((await fresh.api('hr', 'PATCH', `/api/recruiting/stages/${testStage}`, { active: false })).status, 409, 'noch belegt');
    await ok(fresh.api('hr', 'POST', `/api/recruiting/applications/${applicationId}/move`, { stageId: byName('Angebot') }));
    await ok(fresh.api('hr', 'PATCH', `/api/recruiting/stages/${testStage}`, { active: false }));
    assert.ok(!(await names()).includes('Schnuppertag'));
    assert.equal((await fresh.api('hr', 'POST', `/api/recruiting/applications/${applicationId}/move`, { stageId: testStage })).status, 400, 'abgeschaltete Stufe');
    const withInactive = await ok(fresh.api('hr', 'GET', '/api/recruiting/stages?includeInactive=true'));
    assert.ok(withInactive.stages.some(stage => stage.name === 'Schnuppertag' && !stage.active));
    const detail = await ok(fresh.api('hr', 'GET', `/api/recruiting/applications/${applicationId}`));
    assert.ok(detail.history.some(entry => entry.toStageName === 'Schnuppertag'), 'der Verlauf behält den Namen');

    for (const name of ['Eingang', 'Vorauswahl', 'Gespräch']) {
      await ok(fresh.api('hr', 'PATCH', `/api/recruiting/stages/${byName(name)}`, { active: false }));
    }
    assert.equal((await fresh.api('hr', 'PATCH', `/api/recruiting/stages/${byName('Angebot')}`, { active: false })).status, 409, 'eine Stufe muss bleiben');
  } finally {
    await fresh.close();
  }
});

test('Kennzahlen: nur HR, offene Stellen, Bewerbungen je Stufe, Zeit bis Besetzung', async () => {
  const fresh = await createModuleHarness(createRecruitingModule);
  try {
    const helpers = sharedHelpers(fresh);
    for (const who of ['manager', 'director', 'anna']) {
      assert.equal((await fresh.api(who, 'GET', '/api/recruiting/metrics')).status, 403, who);
    }
    const empty = await ok(fresh.api('hr', 'GET', '/api/recruiting/metrics'));
    assert.equal(empty.openRequisitions, 0);
    assert.equal(empty.timeToFill.averageDays, null);

    const open = await helpers.createOpenRequisition({ title: 'Offen' });
    const toFill = await helpers.createOpenRequisition({ title: 'Wird besetzt' });
    await ok(fresh.api('manager', 'POST', '/api/recruiting/requisitions', { title: 'Noch Entwurf' }));
    const { applicationId: stays } = await helpers.addApplication(open, {});
    const { applicationId: rejected } = await helpers.addApplication(open, {});
    await ok(fresh.api('hr', 'POST', `/api/recruiting/applications/${rejected}/reject`, { reason: 'other' }));
    const { stages } = await ok(fresh.api('hr', 'GET', '/api/recruiting/stages'));
    await ok(fresh.api('hr', 'POST', `/api/recruiting/applications/${stays}/move`, { stageId: stages[1].id }));
    const { applicationId: hiredApplication } = await helpers.addApplication(toFill, {});
    await helpers.createAcceptedOffer(hiredApplication);
    await ok(fresh.api('hr', 'POST', `/api/recruiting/applications/${hiredApplication}/hire`, {}));
    fresh.db.prepare('UPDATE recruiting_requisitions SET opened_at=?,filled_at=? WHERE id=?').run('2026-01-01T00:00:00.000Z', '2026-01-11T12:00:00.000Z', toFill);

    const metrics = await ok(fresh.api('hr', 'GET', '/api/recruiting/metrics'));
    assert.equal(metrics.openRequisitions, 1);
    const count = name => metrics.applicationsByStage.find(item => item.name === name).count;
    assert.equal(count('Eingang'), 0, 'Abgesagte zählen nicht');
    assert.equal(count('Vorauswahl'), 1);
    assert.equal(count('Eingestellt'), 1);
    assert.deepEqual(metrics.timeToFill, { filledCount: 1, averageDays: 10.5 });
  } finally {
    await fresh.close();
  }
});

test('Stammdaten für die Formulare passen zur Rolle', async () => {
  const hrMeta = await ok(h.api('hr', 'GET', '/api/recruiting/meta'));
  const hrManagers = hrMeta.hiringManagers.map(person => person.id);
  assert.ok(hrManagers.includes(h.people.manager.id) && hrManagers.includes(h.people.director.id) && hrManagers.includes(h.people.hr.id));
  assert.ok(!hrManagers.includes(h.people.anna.id), 'keine Mitarbeitenden');
  assert.ok(hrMeta.rejectionReasons.length >= 3);
  assert.ok(hrMeta.sources.includes('Empfehlung'));
  assert.equal(hrMeta.onboardingEnabled, true);

  const managerMeta = await ok(h.api('manager', 'GET', '/api/recruiting/meta'));
  assert.deepEqual(managerMeta.hiringManagers.map(person => person.id), [h.people.manager.id], 'nur der eigene Bereich');
  const directorMeta = await ok(h.api('director', 'GET', '/api/recruiting/meta'));
  assert.deepEqual(directorMeta.hiringManagers.map(person => person.id).sort(), [h.people.director.id, h.people.manager.id].sort());
  assert.ok(!('people' in hrMeta) && !('people' in managerMeta) && !('people' in directorMeta), 'keine Liste aller Personen');
});

test('D20: Namen und Titel aller bekommt nur, wer zu dieser Bewerbung ein Gespräch planen darf', async () => {
  const id = await createOpenRequisition({ title: 'Personenauswahl' });
  const { applicationId } = await addApplication(id, {});
  const url = `/api/recruiting/applications/${applicationId}/participant-options`;
  const { people } = await ok(h.api('manager', 'GET', url));
  assert.ok(people.some(person => person.id === h.people.clara.id), 'Gesprächsteilnehmende auch aus anderen Bereichen');
  assert.ok(!JSON.stringify(people).includes('test.local'), 'keine E-Mail-Adressen');
  await ok(h.api('bp', 'GET', url));
  for (const who of ['director', 'anna', 'clara']) {
    assert.equal((await h.api(who, 'GET', url)).status, 403, who);
  }
  assert.equal((await h.api('hr', 'GET', '/api/recruiting/applications/999999/participant-options')).status, 404);
});

test('Eine frühere Führungskraft behält den Zugriff auf ihre Stelle, aber nur darauf', async () => {
  const fresh = await createModuleHarness(createRecruitingModule);
  try {
    const helpers = sharedHelpers(fresh);
    const id = await helpers.createOpenRequisition({ title: 'Rollenwechsel' });
    fresh.db.prepare("UPDATE users SET role='employee' WHERE id=?").run(fresh.people.manager.id);
    await ok(fresh.api('manager', 'GET', `/api/recruiting/requisitions/${id}/board`));
    const list = await ok(fresh.api('manager', 'GET', '/api/recruiting/requisitions'));
    assert.equal(list.requisitions.length, 1);
    assert.equal(list.canCreate, false);
    assert.equal((await fresh.api('manager', 'POST', '/api/recruiting/requisitions', { title: 'Neu' })).status, 403);
  } finally {
    await fresh.close();
  }
});

/** Eine HR-Sachbearbeitung, wie sie über die Oberfläche entsteht. */
function createStaff(harness) {
  const { id } = harness.deps.createUserAccount({ name: 'Sach Bearbeiter', email: uniqueEmail('sachbearbeitung'), role: 'hr_staff', actor: { id: 1 } });
  harness.db.prepare('UPDATE users SET must_change_password=0 WHERE id=?').run(id);
  return id;
}

test('D8: Auch HR und die einstellende Führungskraft sehen fremde Bewertungen erst nach der eigenen', async () => {
  const fresh = await createModuleHarness(createRecruitingModule);
  try {
    const helpers = sharedHelpers(fresh);
    const requisitionId = await helpers.createOpenRequisition({ title: 'Unabhängig' });
    const { applicationId } = await helpers.addApplication(requisitionId, { name: 'Unabhängig Person' });
    const participants = [fresh.people.anna.id, fresh.people.manager.id, fresh.people.bp.id];
    const { id: interviewId } = await ok(fresh.api('hr', 'POST', `/api/recruiting/applications/${applicationId}/interviews`, interviewPlan(participants)));
    const url = `/api/recruiting/interviews/${interviewId}`;
    const applicationUrl = `/api/recruiting/applications/${applicationId}`;
    const boardUrl = `/api/recruiting/requisitions/${requisitionId}/board`;
    await ok(fresh.api('anna', 'POST', `${url}/feedback`, feedbackBody({ rating: 2, strengths: 'Annas Einschätzung' })));

    for (const who of ['manager', 'bp']) {
      const blind = await ok(fresh.api(who, 'GET', url));
      assert.equal(blind.interview.feedbackVisible, false, who);
      assert.deepEqual(blind.interview.feedback, [], who);
      assert.ok(blind.interview.participants.every(person => !('submitted' in person)), `${who}: auch nicht, wer schon bewertet hat`);
      assert.equal(blind.interview.canSubmitFeedback, true, who);
      const application = await ok(fresh.api(who, 'GET', applicationUrl));
      assert.ok(!JSON.stringify(application).includes('Annas Einschätzung'), `${who}: auch nicht über die Bewerbung`);
      const card = (await ok(fresh.api(who, 'GET', boardUrl))).applications.find(item => item.id === applicationId);
      assert.equal(card.ratingsHidden, true, who);
      assert.equal(card.feedbackCount, 0, `${who}: die Spaltenansicht verrät nichts`);
      assert.equal(card.averageRating, null, who);
    }

    const uninvolved = await ok(fresh.api('hr', 'GET', url));
    assert.equal(uninvolved.interview.feedback.length, 1, 'wer nicht bewerten soll, sieht alles');
    assert.equal((await ok(fresh.api('hr', 'GET', boardUrl))).applications.find(item => item.id === applicationId).averageRating, 2);

    await ok(fresh.api('manager', 'POST', `${url}/feedback`, feedbackBody({ rating: 4, strengths: 'Maltes Einschätzung' })));
    const afterOwn = await ok(fresh.api('manager', 'GET', url));
    assert.equal(afterOwn.interview.feedback.length, 2, 'nach der eigenen Bewertung ist alles offen');
    assert.equal((await ok(fresh.api('manager', 'GET', boardUrl))).applications.find(item => item.id === applicationId).averageRating, 3);
    assert.deepEqual((await ok(fresh.api('bp', 'GET', url))).interview.feedback, [], 'für die andere gilt die Sperre weiter');

    // Ein zweites Gespräch: Die einstellende Führungskraft soll dort noch bewerten und sieht nichts Fremdes aus dem ersten.
    const { id: second } = await ok(fresh.api('hr', 'POST', `/api/recruiting/applications/${applicationId}/interviews`, interviewPlan([fresh.people.manager.id, fresh.people.ben.id])));
    await ok(fresh.api('ben', 'POST', `/api/recruiting/interviews/${second}/feedback`, feedbackBody({ strengths: 'Bens Einschätzung' })));
    const withOpenRating = await ok(fresh.api('manager', 'GET', applicationUrl));
    const interviewById = id => withOpenRating.interviews.find(item => item.id === id);
    assert.equal(interviewById(interviewId).feedback.length, 2, 'wo sie schon bewertet hat, bleibt es offen');
    assert.deepEqual(interviewById(second).feedback, [], 'im neuen Gespräch nicht');
    const { id: third } = await ok(fresh.api('hr', 'POST', `/api/recruiting/applications/${applicationId}/interviews`, interviewPlan([fresh.people.clara.id])));
    await ok(fresh.api('clara', 'POST', `/api/recruiting/interviews/${third}/feedback`, feedbackBody({ strengths: 'Claras Einschätzung' })));
    const others = await ok(fresh.api('manager', 'GET', `/api/recruiting/interviews/${third}`));
    assert.deepEqual(others.interview.feedback, [], 'auch nicht aus Gesprächen, an denen sie gar nicht beteiligt ist');

    // Ohne offene Bewertung gibt es keine Sackgasse.
    await ok(fresh.api('hr', 'POST', `/api/recruiting/interviews/${second}/cancel`, {}));
    assert.equal((await ok(fresh.api('manager', 'GET', `/api/recruiting/interviews/${third}`))).interview.feedback.length, 1, 'nach der Absage des Gesprächs wieder sichtbar');
    await ok(fresh.api('hr', 'POST', `${applicationUrl}/reject`, { reason: 'other' }));
    assert.equal((await ok(fresh.api('bp', 'GET', url))).interview.feedback.length, 2, 'nach dem Abschluss der Bewerbung kann niemand mehr bewerten, also ist alles sichtbar');
  } finally {
    await fresh.close();
  }
});

test('B16: Wer sich als HR selbst bewirbt, sieht und ändert Mitbewerbende nirgends', async () => {
  const fresh = await createModuleHarness(createRecruitingModule);
  try {
    const helpers = sharedHelpers(fresh);
    const conflicted = await helpers.createOpenRequisition({ owner: 'director', title: 'Konfliktstelle', internalPosting: true });
    const otherRequisition = await helpers.createOpenRequisition({ owner: 'director', title: 'Andere Stelle' });
    const rivalEmail = uniqueEmail('rita');
    const { id: rival } = await ok(fresh.api('hr', 'POST', '/api/recruiting/candidates', { name: 'Rita Rival', email: rivalEmail, notes: 'Geheime Notiz', resumeText: 'Lebenslauf Rita' }));
    const { id: rivalApplication } = await ok(fresh.api('hr', 'POST', `/api/recruiting/requisitions/${conflicted}/applications`, { candidateId: rival }));
    const { id: rivalElsewhere } = await ok(fresh.api('hr', 'POST', `/api/recruiting/requisitions/${otherRequisition}/applications`, { candidateId: rival }));
    const { applicationId: unrelated } = await helpers.addApplication(otherRequisition, { name: 'Ulla Unbeteiligt' });
    const unrelatedCandidate = fresh.db.prepare('SELECT candidate_id FROM recruiting_applications WHERE id=?').get(unrelated).candidate_id;

    const { id: claraApplication } = await ok(fresh.api('clara', 'POST', `/api/recruiting/job-board/${conflicted}/apply`, {}));
    const { id: offerId } = await ok(fresh.api('director', 'POST', `/api/recruiting/applications/${rivalApplication}/offers`, { startDate: '2099-02-01' }));
    await ok(fresh.api('director', 'POST', `/api/recruiting/offers/${offerId}/submit`, {}));
    const openFor = (type, entityId, userId) => fresh.db.prepare('SELECT id FROM tasks WHERE type=? AND entity_id=? AND user_id=? AND done=0').all(type, entityId, userId);
    assert.equal(openFor('recruiting_offer_approval', rivalApplication, fresh.people.bp.id).length, 1, 'vor der Bewerbung hat Boris Aufgaben dazu');
    assert.equal(openFor('recruiting_internal_application', claraApplication, fresh.people.bp.id).length, 1);

    await ok(fresh.api('bp', 'POST', `/api/recruiting/job-board/${conflicted}/apply`, {}));
    assert.equal(openFor('recruiting_offer_approval', rivalApplication, fresh.people.bp.id).length, 0, 'seine Aufgaben dazu wären jetzt Sackgassen');
    assert.equal(openFor('recruiting_internal_application', claraApplication, fresh.people.bp.id).length, 0);
    assert.equal(openFor('recruiting_offer_approval', rivalApplication, fresh.people.hr.id).length, 1, 'die der anderen HR-Person bleiben');

    const rivalUrl = `/api/recruiting/candidates/${rival}`;
    assert.equal((await fresh.api('bp', 'GET', rivalUrl)).status, 403, 'lesen');
    assert.equal((await fresh.api('bp', 'PATCH', rivalUrl, { notes: 'Von Boris geändert' })).status, 403, 'ändern');
    assert.equal(fresh.db.prepare('SELECT notes FROM recruiting_candidates WHERE id=?').get(rival).notes, 'Geheime Notiz');
    await ok(fresh.api('hr', 'POST', `/api/recruiting/applications/${rivalApplication}/reject`, { reason: 'other' }));
    await ok(fresh.api('hr', 'POST', `/api/recruiting/applications/${rivalElsewhere}/reject`, { reason: 'other' }));
    const anonymize = await fresh.api('bp', 'POST', `${rivalUrl}/anonymize`, {});
    assert.equal(anonymize.status, 403, 'endgültig löschen schon gar nicht');
    assert.match(anonymize.data.error, /andere HR-Person/);
    assert.equal(fresh.db.prepare('SELECT anonymized_at FROM recruiting_candidates WHERE id=?').get(rival).anonymized_at, null);

    const list = await ok(fresh.api('bp', 'GET', '/api/recruiting/candidates'));
    assert.ok(!list.candidates.some(item => item.id === rival), 'nicht in der Liste');
    assert.ok(!(await ok(fresh.api('bp', 'GET', '/api/recruiting/candidates?q=Rita'))).candidates.length, 'auch nicht über die Suche');
    assert.ok(list.candidates.some(item => item.id === unrelatedCandidate), 'alle anderen bleiben sichtbar');
    await ok(fresh.api('bp', 'GET', `/api/recruiting/candidates/${unrelatedCandidate}`));

    assert.equal((await fresh.api('bp', 'GET', `/api/recruiting/applications/${rivalElsewhere}`)).status, 403, 'auch nicht über eine andere Stelle');
    await ok(fresh.api('bp', 'GET', `/api/recruiting/applications/${unrelated}`));
    const board = await ok(fresh.api('bp', 'GET', `/api/recruiting/requisitions/${otherRequisition}/board`));
    assert.ok(![...board.applications, ...board.rejected].some(card => card.candidateId === rival), 'nicht in der Spaltenansicht');
    assert.ok(board.applications.some(card => card.id === unrelated));
    assert.equal(board.hiddenApplications, 1, 'die Lücke wird offen genannt');
    assert.equal((await ok(fresh.api('hr', 'GET', `/api/recruiting/requisitions/${otherRequisition}/board`))).hiddenApplications, 0);

    const thirdRequisition = await helpers.createOpenRequisition({ owner: 'director', title: 'Dritte Stelle' });
    assert.equal((await fresh.api('bp', 'POST', `/api/recruiting/requisitions/${thirdRequisition}/applications`, { candidateId: rival })).status, 403, 'nicht zuordnen');
    const duplicate = await fresh.api('bp', 'POST', '/api/recruiting/candidates', { name: 'Test', email: rivalEmail });
    assert.equal(duplicate.status, 409);
    assert.ok(!JSON.stringify(duplicate.data).includes('Rita'), 'die Dubletten-Meldung verrät den Namen nicht');
    assert.ok(!('duplicate' in duplicate.data));

    const listed = (await ok(fresh.api('bp', 'GET', '/api/recruiting/requisitions'))).requisitions.find(item => item.id === conflicted);
    assert.equal(listed.ownCandidacy, true);
    assert.equal(listed.activeApplications, null, 'auch die Zahl der Mitbewerbenden bleibt verborgen');
    assert.equal(listed.hiredCount, null);
    assert.equal((await ok(fresh.api('hr', 'GET', '/api/recruiting/requisitions'))).requisitions.find(item => item.id === conflicted).activeApplications, 2);

    await ok(fresh.api('hr', 'GET', rivalUrl));
    await ok(fresh.api('hr', 'PATCH', rivalUrl, { notes: 'Von Hanna geändert' }));
    const { id: benApplication } = await ok(fresh.api('ben', 'POST', `/api/recruiting/job-board/${conflicted}/apply`, {}));
    assert.deepEqual(openTasks2(fresh, 'recruiting_internal_application', benApplication), [fresh.people.hr.id], 'neue Bewerbungen landen nicht bei Boris');

    // Ist die Stelle vorbei, endet auch der Wettbewerb. Die Stelle selbst bleibt für ihn gesperrt.
    await ok(fresh.api('hr', 'POST', `/api/recruiting/requisitions/${conflicted}/cancel`, {}));
    await ok(fresh.api('bp', 'GET', rivalUrl));
    assert.ok((await ok(fresh.api('bp', 'GET', '/api/recruiting/candidates'))).candidates.some(item => item.id === rival));
    await ok(fresh.api('bp', 'GET', `/api/recruiting/applications/${rivalElsewhere}`));
    assert.equal((await fresh.api('bp', 'GET', `/api/recruiting/applications/${rivalApplication}`)).status, 403, 'die eigene Stelle bleibt tabu');
    assert.equal((await fresh.api('bp', 'GET', `/api/recruiting/requisitions/${conflicted}/board`)).status, 403);
  } finally {
    await fresh.close();
  }
});

const openTasks2 = (harness, type, entityId) => harness.db.prepare('SELECT user_id FROM tasks WHERE type=? AND entity_id=? AND done=0 ORDER BY user_id').all(type, entityId).map(row => row.user_id);

test('B17: Stufen und Frist ändert nur die HR-Administration, mit Untergrenze und Rückfrage', async () => {
  const fresh = await createModuleHarness(createRecruitingModule);
  try {
    const helpers = sharedHelpers(fresh);
    const before = (await ok(fresh.api('hr', 'GET', '/api/recruiting/stages'))).stages;
    const stageId = before[1].id;

    assert.equal((await fresh.api('bp', 'PATCH', '/api/recruiting/settings', { retentionMonths: 3 })).status, 403, 'Frist');
    assert.equal((await fresh.api('bp', 'POST', '/api/recruiting/stages', { name: 'Probe' })).status, 403, 'neue Stufe');
    assert.equal((await fresh.api('bp', 'PATCH', `/api/recruiting/stages/${stageId}`, { name: 'Umbenannt' })).status, 403, 'umbenennen');
    assert.equal((await fresh.api('bp', 'PATCH', `/api/recruiting/stages/${stageId}`, { active: false })).status, 403, 'abschalten');
    assert.equal((await fresh.api('bp', 'POST', `/api/recruiting/stages/${stageId}/move`, { direction: 'down' })).status, 403, 'verschieben');
    assert.deepEqual((await ok(fresh.api('hr', 'GET', '/api/recruiting/stages'))).stages, before, 'nichts hat sich geändert');
    assert.equal((await ok(fresh.api('hr', 'GET', '/api/recruiting/settings'))).settings.retentionMonths, 6);

    const hrbpView = await ok(fresh.api('bp', 'GET', '/api/recruiting/settings'));
    assert.equal(hrbpView.canManage, false, 'lesen darf der HR Business Partner weiterhin');
    const adminView = await ok(fresh.api('hr', 'GET', '/api/recruiting/settings'));
    assert.equal(adminView.canManage, true);
    assert.equal(adminView.settings.minRetentionMonths, 3);

    assert.equal((await fresh.api('hr', 'PATCH', '/api/recruiting/settings', { retentionMonths: 2 })).status, 400, 'Untergrenze');

    const requisitionId = await helpers.createOpenRequisition({ title: 'Frist kürzen' });
    const first = await helpers.addApplication(requisitionId, { name: 'Alte Absage' });
    const second = await helpers.addApplication(requisitionId, { name: 'Zweite Absage' });
    for (const { applicationId } of [first, second]) {
      await ok(fresh.api('hr', 'POST', `/api/recruiting/applications/${applicationId}/reject`, { reason: 'other' }));
      fresh.db.prepare('UPDATE recruiting_applications SET rejected_at=? WHERE id=?').run(new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString(), applicationId);
    }
    assert.equal((await ok(fresh.api('hr', 'GET', '/api/recruiting/settings'))).settings.retentionMonths, 6);
    const warned = await fresh.api('hr', 'PATCH', '/api/recruiting/settings', { retentionMonths: 3 });
    assert.equal(warned.status, 409, 'eine kürzere Frist, die sofort wirkt, braucht eine Bestätigung');
    assert.equal(warned.data.code, 'retention_confirmation_needed');
    assert.equal(warned.data.affected, 2);
    assert.match(warned.data.error, /2 Personen werden/);
    assert.equal((await ok(fresh.api('hr', 'GET', '/api/recruiting/settings'))).settings.retentionMonths, 6, 'ohne Bestätigung bleibt alles');
    assert.equal(fresh.instance.maintenance(), 0);
    await ok(fresh.api('hr', 'PATCH', '/api/recruiting/settings', { retentionMonths: 3, confirmAnonymization: true }));
    assert.equal(fresh.instance.maintenance(), 2);
    await ok(fresh.api('hr', 'PATCH', '/api/recruiting/settings', { retentionMonths: 12 }));
  } finally {
    await fresh.close();
  }
});

test('B17: Eine alte, zu kurze Frist gilt mit der Untergrenze', async () => {
  const fresh = await createModuleHarness(createRecruitingModule);
  try {
    const helpers = sharedHelpers(fresh);
    fresh.db.prepare('UPDATE recruiting_settings SET retention_months=1 WHERE id=1').run();
    const requisitionId = await helpers.createOpenRequisition({ title: 'Alte Frist' });
    const { applicationId } = await helpers.addApplication(requisitionId, { name: 'Schutz Person' });
    await ok(fresh.api('hr', 'POST', `/api/recruiting/applications/${applicationId}/reject`, { reason: 'other' }));
    fresh.db.prepare('UPDATE recruiting_applications SET rejected_at=? WHERE id=?').run(new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString(), applicationId);
    assert.equal((await ok(fresh.api('hr', 'GET', '/api/recruiting/settings'))).settings.retentionMonths, 3);
    assert.equal(fresh.instance.maintenance(), 0, 'nach 40 Tagen wird noch nichts endgültig gelöscht');
    fresh.db.prepare('UPDATE recruiting_applications SET rejected_at=? WHERE id=?').run(new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString(), applicationId);
    assert.equal(fresh.instance.maintenance(), 1);
  } finally {
    await fresh.close();
  }
});

test('H13: Bei der Einstellung wählt HR die Rolle, HR-Rollen vergibt nur die HR-Administration', async () => {
  const fresh = await createModuleHarness(createRecruitingModule);
  try {
    const helpers = sharedHelpers(fresh);
    const requisitionId = await helpers.createOpenRequisition({ title: 'Mit Rolle', openings: 5 });
    const prepare = async () => {
      const { applicationId, email } = await helpers.addApplication(requisitionId, {});
      await helpers.createAcceptedOffer(applicationId, { startDate: '2099-03-01' });
      return { url: `/api/recruiting/applications/${applicationId}/hire`, email };
    };
    const roleOf = id => fresh.db.prepare('SELECT role FROM users WHERE id=?').get(id).role;

    const standard = await prepare();
    const hiredStandard = await ok(fresh.api('hr', 'POST', standard.url, {}));
    assert.equal(roleOf(hiredStandard.userId), 'employee', 'ohne Wahl wie bisher');
    assert.equal(hiredStandard.role, 'employee');

    const lead = await prepare();
    assert.equal(roleOf((await ok(fresh.api('bp', 'POST', lead.url, { role: 'manager' }))).userId), 'manager', 'auch der HR Business Partner');

    const denied = await prepare();
    const usersBefore = fresh.db.prepare('SELECT COUNT(*) AS count FROM users').get().count;
    assert.equal((await fresh.api('bp', 'POST', denied.url, { role: 'hr_admin' })).status, 403, 'HR-Rollen nur durch die HR-Administration');
    assert.equal((await fresh.api('bp', 'POST', denied.url, { role: 'hr_staff' })).status, 403);
    assert.equal((await fresh.api('hr', 'POST', denied.url, { role: 'chef' })).status, 400);
    assert.equal((await fresh.api('hr', 'POST', denied.url, { role: '__proto__' })).status, 400);
    assert.equal((await fresh.api('hr', 'POST', denied.url, { role: 'super_admin' })).status, 400, 'die Systemadministration gibt es hier nicht');
    assert.equal(fresh.db.prepare('SELECT COUNT(*) AS count FROM users').get().count, usersBefore, 'die abgelehnte Einstellung legt kein Konto an');
    assert.equal(roleOf((await ok(fresh.api('hr', 'POST', denied.url, { role: 'hr_staff' }))).userId), 'hr_staff');

    const hrMeta = await ok(fresh.api('hr', 'GET', '/api/recruiting/meta'));
    assert.deepEqual(hrMeta.hireRoles.map(role => role.key), ['employee', 'manager', 'director', 'hr_staff', 'hrbp', 'hr_admin']);
    const bpMeta = await ok(fresh.api('bp', 'GET', '/api/recruiting/meta'));
    assert.deepEqual(bpMeta.hireRoles.map(role => role.key), ['employee', 'manager', 'director']);
    assert.deepEqual((await ok(fresh.api('manager', 'GET', '/api/recruiting/meta'))).hireRoles, [], 'einstellen darf die Führungskraft ohnehin nicht');

    const internalRequisition = await helpers.createOpenRequisition({ owner: 'director', title: 'Intern', internalPosting: true });
    const { id: internal } = await ok(fresh.api('clara', 'POST', `/api/recruiting/job-board/${internalRequisition}/apply`, {}));
    await helpers.createAcceptedOffer(internal, { creator: 'director' });
    const moved = await ok(fresh.api('hr', 'POST', `/api/recruiting/applications/${internal}/hire`, { role: 'hr_admin' }));
    assert.equal(moved.internal, true);
    assert.equal(roleOf(fresh.people.clara.id), 'employee', 'ein vorhandenes Konto behält seine Rolle');
  } finally {
    await fresh.close();
  }
});

test('H13: Die Antwort auf die Einstellung nennt das Eintrittsdatum für die Personalakte', async () => {
  const id = await createOpenRequisition({ title: 'Eintritt' });
  const { applicationId } = await addApplication(id, {});
  await createAcceptedOffer(applicationId, { startDate: '2099-04-01' });
  const hired = await ok(h.api('hr', 'POST', `/api/recruiting/applications/${applicationId}/hire`, {}));
  assert.equal(hired.entryDate, '2099-04-01');
  assert.equal(hired.personnelEnabled, true);
  const off = await createModuleHarness(createRecruitingModule, { isModuleEnabled: key => key !== 'personnel' });
  try {
    const helpers = sharedHelpers(off);
    const requisitionId = await helpers.createOpenRequisition({ title: 'Ohne Akte' });
    const { applicationId: other } = await helpers.addApplication(requisitionId, {});
    await helpers.createAcceptedOffer(other);
    assert.equal((await ok(off.api('hr', 'POST', `/api/recruiting/applications/${other}/hire`, {}))).personnelEnabled, false);
  } finally {
    await off.close();
  }
});

test('B9: Die Meldung zum gesperrten Konto nennt den Weg über den Reiter „Konten“', async () => {
  h.db.prepare("INSERT INTO users(name,email,password_hash,role,active) VALUES('Gesperrt Zwei','gesperrt2@test.local','!','employee',0)").run();
  const id = await createOpenRequisition({ title: 'Gesperrt Zwei' });
  const { applicationId } = await addApplication(id, { email: 'gesperrt2@test.local' });
  await createAcceptedOffer(applicationId);
  const failed = await h.api('hr', 'POST', `/api/recruiting/applications/${applicationId}/hire`, {});
  assert.equal(failed.status, 409);
  assert.ok(failed.data.error.includes('„Konten“') && failed.data.error.includes('„Mitarbeitende“'), failed.data.error);
  await ok(h.api('hr', 'POST', `/api/recruiting/applications/${applicationId}/reject`, { reason: 'other' }));
});

test('M17: Bewerten geht erst ab dem Gesprächstermin', async () => {
  const id = await createOpenRequisition({ title: 'Zu früh' });
  const { applicationId } = await addApplication(id, {});
  const { id: interviewId } = await ok(h.api('manager', 'POST', `/api/recruiting/applications/${applicationId}/interviews`, futureInterviewPlan([h.people.anna.id])));
  const url = `/api/recruiting/interviews/${interviewId}`;
  const tooEarly = await h.api('anna', 'POST', `${url}/feedback`, feedbackBody());
  assert.equal(tooEarly.status, 409);
  assert.ok(tooEarly.data.error.includes('15.01.2099'), 'die Meldung nennt den Termin');
  assert.equal(h.db.prepare('SELECT COUNT(*) AS count FROM recruiting_feedback WHERE interview_id=?').get(interviewId).count, 0);
  const { interview } = await ok(h.api('anna', 'GET', url));
  assert.equal(interview.canSubmitFeedback, false);
  assert.equal(interview.feedbackOpensAt, '2099-01-15T10:30');
  const mine = (await ok(h.api('anna', 'GET', '/api/recruiting/interviews/mine'))).interviews.find(item => item.id === interviewId);
  assert.equal(mine.canSubmitFeedback, false);
  assert.equal(openTasks('recruiting_feedback', interviewId)[0].due_date, '2099-01-15', 'die Aufgabe steht trotzdem schon da, mit dem Termin als Frist');

  await ok(h.api('manager', 'PATCH', url, { scheduledAt: '2026-01-16T09:00' }));
  const reopened = await ok(h.api('anna', 'GET', url));
  assert.equal(reopened.interview.canSubmitFeedback, true);
  assert.equal(reopened.interview.feedbackOpensAt, null);
  await ok(h.api('anna', 'POST', `${url}/feedback`, feedbackBody()));
});

test('M20: Eine zurückgezogene Bewerbung heißt auch so, und ein fehlender Knopf nennt den Grund', async () => {
  const id = await createOpenRequisition({ owner: 'director', title: 'Zurückziehen', internalPosting: true });
  const { id: applicationId } = await ok(h.api('ben', 'POST', `/api/recruiting/job-board/${id}/apply`, {}));
  await ok(h.api('ben', 'POST', `/api/recruiting/job-board/applications/${applicationId}/withdraw`, {}));
  const board = await ok(h.api('ben', 'GET', '/api/recruiting/job-board'));
  assert.equal(board.myApplications.find(item => item.id === applicationId).withdrawn, true);
  assert.equal((await ok(h.api('ben', 'GET', `/api/recruiting/applications/${applicationId}`))).application.withdrawn, true);
  const managed = await ok(h.api('director', 'GET', `/api/recruiting/applications/${applicationId}`));
  assert.equal(managed.permissions.canCopyRejectionText, false, 'wer selbst zurückzieht, bekommt keinen Absagetext');

  const rejectedRequisition = await createOpenRequisition({ owner: 'director', title: 'Abgesagt bleibt abgesagt', internalPosting: true });
  const { id: rejected } = await ok(h.api('ben', 'POST', `/api/recruiting/job-board/${rejectedRequisition}/apply`, {}));
  const rejection = await ok(h.api('director', 'POST', `/api/recruiting/applications/${rejected}/reject`, { reason: 'experience' }));
  assert.ok(rejection.rejectionText.text.includes('Guten Tag'));
  assert.equal((await ok(h.api('ben', 'GET', '/api/recruiting/job-board'))).myApplications.find(item => item.id === rejected).withdrawn, false);

  const { applicationId: external } = await addApplication(rejectedRequisition, { name: 'Sagt selbst ab' }, 'director');
  const told = await ok(h.api('director', 'POST', `/api/recruiting/applications/${external}/reject`, { reason: 'candidate_withdrew' }));
  assert.equal(told.rejectionText, null, 'wer sich selbst zurückzieht, bekommt keinen Absagetext');

  const blocked = await createOpenRequisition({ owner: 'director', title: 'Mit Gesprächsrolle', internalPosting: true });
  const { applicationId: other } = await addApplication(blocked, {}, 'director');
  await ok(h.api('director', 'POST', `/api/recruiting/applications/${other}/interviews`, interviewPlan([h.people.clara.id])));
  const reasonOf = async who => (await ok(h.api(who, 'GET', '/api/recruiting/job-board'))).jobs.find(job => job.id === blocked);
  const clara = await reasonOf('clara');
  assert.equal(clara.canApply, false);
  assert.match(clara.applyBlockedReason, /an Gesprächen zu dieser Stelle beteiligt/);
  const director = await reasonOf('director');
  assert.equal(director.canApply, false);
  assert.match(director.applyBlockedReason, /eigene Stelle/);
  const free = await reasonOf('anna');
  assert.equal(free.canApply, true);
  assert.equal(free.applyBlockedReason, null);
  await ok(h.api('anna', 'POST', `/api/recruiting/job-board/${blocked}/apply`, {}));
  const applied = await reasonOf('anna');
  assert.equal(applied.alreadyApplied, true);
  assert.equal(applied.applyBlockedReason, null, 'kein Grund nötig: Die Bewerbung läuft');
});

test('Die HR-Sachbearbeitung ist im Recruiting eine normale Person', async () => {
  const fresh = await createModuleHarness(createRecruitingModule);
  try {
    const helpers = sharedHelpers(fresh);
    const staff = createStaff(fresh);
    const requisitionId = await helpers.createOpenRequisition({ title: 'Für alle', internalPosting: true });
    const { applicationId } = await helpers.addApplication(requisitionId, { name: 'Geheim Person', notes: 'Geheime Notiz' });
    const candidateId = fresh.db.prepare('SELECT candidate_id FROM recruiting_applications WHERE id=?').get(applicationId).candidate_id;

    for (const [method, url, body] of [
      ['GET', '/api/recruiting/meta'],
      ['GET', '/api/recruiting/requisitions'],
      ['POST', '/api/recruiting/requisitions', { title: 'Von der Sachbearbeitung' }],
      ['GET', `/api/recruiting/requisitions/${requisitionId}`],
      ['GET', `/api/recruiting/requisitions/${requisitionId}/board`],
      ['GET', '/api/recruiting/candidates'],
      ['POST', '/api/recruiting/candidates', { name: 'X', email: uniqueEmail() }],
      ['GET', `/api/recruiting/candidates/${candidateId}`],
      ['GET', `/api/recruiting/applications/${applicationId}`],
      ['GET', `/api/recruiting/applications/${applicationId}/participant-options`],
      ['POST', `/api/recruiting/applications/${applicationId}/reject`, { reason: 'other' }],
      ['GET', '/api/recruiting/metrics'],
      ['GET', '/api/recruiting/settings'],
      ['PATCH', '/api/recruiting/settings', { retentionMonths: 12 }],
      ['GET', '/api/recruiting/stages'],
      ['POST', '/api/recruiting/stages', { name: 'Probe' }]
    ]) {
      assert.equal((await fresh.api(staff, method, url, body)).status, 403, `${method} ${url}`);
    }
    const board = await ok(fresh.api(staff, 'GET', '/api/recruiting/job-board'));
    assert.equal(board.jobs.find(job => job.id === requisitionId).canApply, true, 'die Stellenbörse steht ihr offen');
    await ok(fresh.api(staff, 'POST', `/api/recruiting/job-board/${requisitionId}/apply`, {}));
    assert.equal(openTasks2(fresh, 'recruiting_internal_application', 1).includes(staff), false);

    const secondRequisition = await helpers.createOpenRequisition({ title: 'Mit Gespräch', internalPosting: true });
    const { applicationId: second } = await helpers.addApplication(secondRequisition, { name: 'Gesprächs Person' });
    const { id: interviewId } = await ok(fresh.api('manager', 'POST', `/api/recruiting/applications/${second}/interviews`, interviewPlan([staff])));
    assert.equal((await ok(fresh.api(staff, 'GET', `/api/recruiting/applications/${second}`))).access, 'interviewer', 'am Gespräch nimmt sie teil wie alle anderen');
    await ok(fresh.api(staff, 'POST', `/api/recruiting/interviews/${interviewId}/feedback`, feedbackBody()));

    const pendingId = (await ok(fresh.api('manager', 'POST', '/api/recruiting/requisitions', { title: 'Zur Freigabe' }))).id;
    await ok(fresh.api('manager', 'POST', `/api/recruiting/requisitions/${pendingId}/submit`, {}));
    assert.ok(!openTasks2(fresh, 'recruiting_approval', pendingId).includes(staff), 'keine HR-Aufgaben');
  } finally {
    await fresh.close();
  }
});

test('Aufgaben: Titel nennt Person und Vorgang, echte Frist, sie schließen sich, der Name verschwindet mit der Anonymisierung', async () => {
  const fresh = await createModuleHarness(createRecruitingModule);
  try {
    const helpers = sharedHelpers(fresh);
    const tasksOf = (type, entityId) => fresh.db.prepare('SELECT * FROM tasks WHERE type=? AND entity_id=? AND done=0 ORDER BY user_id').all(type, entityId);

    const { id: requisitionId } = await ok(fresh.api('director', 'POST', '/api/recruiting/requisitions', { title: 'Aufgabenstelle', hiringManagerId: fresh.people.manager.id }));
    const assigned = tasksOf('recruiting_requisition_assigned', requisitionId);
    assert.ok(assigned[0].title.includes('Dora Direktor') && assigned[0].title.includes('Aufgabenstelle'), 'wer übergibt');
    assert.equal(assigned[0].due_date, null, 'ohne echte Frist keine Frist');

    await ok(fresh.api('hr', 'PATCH', `/api/recruiting/requisitions/${requisitionId}`, { hiringManagerId: fresh.people.director.id }));
    assert.deepEqual(tasksOf('recruiting_requisition_assigned', requisitionId).map(task => task.user_id), [fresh.people.director.id], 'die Aufgabe zieht mit der Führungskraft um');
    await ok(fresh.api('hr', 'PATCH', `/api/recruiting/requisitions/${requisitionId}`, { hiringManagerId: fresh.people.manager.id }));

    await ok(fresh.api('manager', 'POST', `/api/recruiting/requisitions/${requisitionId}/submit`, {}));
    assert.equal(tasksOf('recruiting_requisition_assigned', requisitionId).length, 0);
    const approval = tasksOf('recruiting_approval', requisitionId);
    assert.ok(approval.every(task => task.title.includes('Malte Manager') && task.title.includes('Aufgabenstelle')));
    await ok(fresh.api('hr', 'POST', `/api/recruiting/requisitions/${requisitionId}/approve`, {}));

    const { applicationId } = await helpers.addApplication(requisitionId, { name: 'Tanja Titel' });
    const { id: offerId } = await ok(fresh.api('manager', 'POST', `/api/recruiting/applications/${applicationId}/offers`, { startDate: '2099-06-01' }));
    await ok(fresh.api('manager', 'POST', `/api/recruiting/offers/${offerId}/submit`, {}));
    assert.ok(tasksOf('recruiting_offer_approval', applicationId).every(task => task.title.includes('Tanja Titel')));
    await ok(fresh.api('hr', 'POST', `/api/recruiting/offers/${offerId}/return`, { comment: 'Bitte prüfen' }));
    const returned = tasksOf('recruiting_offer_returned', applicationId);
    assert.ok(returned[0].title.includes('Tanja Titel'));
    await ok(fresh.api('manager', 'POST', `/api/recruiting/offers/${offerId}/submit`, {}));
    await ok(fresh.api('hr', 'POST', `/api/recruiting/offers/${offerId}/approve`, {}));

    const response = tasksOf('recruiting_offer_response', applicationId);
    assert.deepEqual(response.map(task => task.user_id), [fresh.people.manager.id], 'nach der Freigabe ist die erstellende Person wieder dran');
    assert.ok(response[0].title.includes('Tanja Titel'));
    await ok(fresh.api('manager', 'POST', `/api/recruiting/offers/${offerId}/response`, { accepted: true }));
    assert.equal(tasksOf('recruiting_offer_response', applicationId).length, 0);

    const hire = tasksOf('recruiting_hire_decision', applicationId);
    assert.deepEqual(hire.map(task => task.user_id), [fresh.people.hr.id, fresh.people.bp.id], 'nach der Annahme ist HR dran');
    assert.ok(hire.every(task => task.title.includes('Tanja Titel') && task.due_date === '2099-06-01'), 'die Frist ist das Eintrittsdatum');
    await ok(fresh.api('bp', 'POST', `/api/recruiting/applications/${applicationId}/hire`, {}));
    assert.equal(tasksOf('recruiting_hire_decision', applicationId).length, 0, 'erledigt schließt sie für alle');

    const fullRequisition = await helpers.createOpenRequisition({ title: 'Nur ein Platz' });
    const firstApplicant = await helpers.addApplication(fullRequisition, { name: 'Erste Zusage' });
    const secondApplicant = await helpers.addApplication(fullRequisition, { name: 'Zweite Zusage' });
    await helpers.createAcceptedOffer(firstApplicant.applicationId);
    await helpers.createAcceptedOffer(secondApplicant.applicationId);
    assert.equal(tasksOf('recruiting_hire_decision', secondApplicant.applicationId).length, 2);
    await ok(fresh.api('hr', 'POST', `/api/recruiting/applications/${firstApplicant.applicationId}/hire`, {}));
    assert.equal(tasksOf('recruiting_hire_decision', secondApplicant.applicationId).length, 0, 'die Stelle ist voll: hier lässt sich niemand mehr einstellen');

    const cancelledRequisition = await helpers.createOpenRequisition({ title: 'Wird abgebrochen' });
    const waitingApplicant = await helpers.addApplication(cancelledRequisition, { name: 'Wartet umsonst' });
    await helpers.createAcceptedOffer(waitingApplicant.applicationId);
    await ok(fresh.api('manager', 'POST', `/api/recruiting/requisitions/${cancelledRequisition}/cancel`, {}));
    assert.equal(tasksOf('recruiting_hire_decision', waitingApplicant.applicationId).length, 0, 'auch beim Abbruch der Stelle');

    // Wechselt die Führungskraft der Stelle, zieht die Arbeit mit: Die bisherige hat keinen Zugriff mehr.
    const movedRequisition = await helpers.createOpenRequisition({ title: 'Führungswechsel' });
    const movedApplicant = await helpers.addApplication(movedRequisition, { name: 'Wechsel Person' });
    const { id: movedOffer } = await ok(fresh.api('manager', 'POST', `/api/recruiting/applications/${movedApplicant.applicationId}/offers`, { startDate: '2099-06-01' }));
    await ok(fresh.api('manager', 'POST', `/api/recruiting/offers/${movedOffer}/submit`, {}));
    await ok(fresh.api('hr', 'POST', `/api/recruiting/offers/${movedOffer}/approve`, {}));
    assert.deepEqual(tasksOf('recruiting_offer_response', movedApplicant.applicationId).map(task => task.user_id), [fresh.people.manager.id]);
    await ok(fresh.api('hr', 'PATCH', `/api/recruiting/requisitions/${movedRequisition}`, { hiringManagerId: fresh.people.director.id }));
    assert.deepEqual(tasksOf('recruiting_offer_response', movedApplicant.applicationId).map(task => task.user_id), [fresh.people.director.id], 'keine Sackgasse bei der bisherigen Führungskraft');
    await ok(fresh.api('director', 'POST', `/api/recruiting/offers/${movedOffer}/response`, { accepted: false }));
    const { id: nextOffer } = await ok(fresh.api('director', 'POST', `/api/recruiting/applications/${movedApplicant.applicationId}/offers`, { startDate: '2099-06-01' }));
    fresh.db.prepare('UPDATE recruiting_offers SET created_by=? WHERE id=?').run(fresh.people.manager.id, nextOffer);
    await ok(fresh.api('director', 'POST', `/api/recruiting/offers/${nextOffer}/submit`, {}));
    await ok(fresh.api('hr', 'POST', `/api/recruiting/offers/${nextOffer}/return`, { comment: 'Bitte prüfen' }));
    assert.deepEqual(tasksOf('recruiting_offer_returned', movedApplicant.applicationId).map(task => task.user_id), [fresh.people.director.id], 'die Aufgabe geht an die zuständige Führungskraft');

    const declined = await helpers.addApplication(await helpers.createOpenRequisition({ title: 'Lehnt ab' }), { name: 'Lea Lehnt' });
    const { id: declinedOffer } = await ok(fresh.api('manager', 'POST', `/api/recruiting/applications/${declined.applicationId}/offers`, { startDate: '2099-06-01' }));
    await ok(fresh.api('manager', 'POST', `/api/recruiting/offers/${declinedOffer}/submit`, {}));
    await ok(fresh.api('hr', 'POST', `/api/recruiting/offers/${declinedOffer}/approve`, {}));
    await ok(fresh.api('manager', 'POST', `/api/recruiting/offers/${declinedOffer}/response`, { accepted: false }));
    assert.equal(tasksOf('recruiting_offer_response', declined.applicationId).length, 0);
    assert.equal(tasksOf('recruiting_hire_decision', declined.applicationId).length, 0, 'bei einem Nein gibt es nichts einzustellen');

    const rejected = await helpers.addApplication(await helpers.createOpenRequisition({ title: 'Wird anonymisiert' }), { name: 'Nora Namenlos' });
    await ok(fresh.api('manager', 'POST', `/api/recruiting/applications/${rejected.applicationId}/interviews`, interviewPlan([fresh.people.anna.id])));
    const { id: rejectedOffer } = await ok(fresh.api('manager', 'POST', `/api/recruiting/applications/${rejected.applicationId}/offers`, { startDate: '2099-06-01' }));
    await ok(fresh.api('manager', 'POST', `/api/recruiting/offers/${rejectedOffer}/submit`, {}));
    assert.ok(fresh.db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE title LIKE '%Nora Namenlos%'").get().count >= 2, 'vorher nennen die Titel den Namen');
    await ok(fresh.api('manager', 'POST', `/api/recruiting/applications/${rejected.applicationId}/reject`, { reason: 'other' }));
    assert.equal(fresh.db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE title LIKE '%Nora Namenlos%' AND done=0").get().count, 0, 'die Absage schließt alle');
    const candidateId = fresh.db.prepare('SELECT candidate_id FROM recruiting_applications WHERE id=?').get(rejected.applicationId).candidate_id;
    await ok(fresh.api('hr', 'POST', `/api/recruiting/candidates/${candidateId}/anonymize`, {}));
    assert.equal(fresh.db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE title LIKE '%Nora Namenlos%'").get().count, 0, 'die Anonymisierung überlebt kein Name');
  } finally {
    await fresh.close();
  }
});

test('Hilfeartikel haben die vorgeschriebene Form', () => {
  assert.ok(h.instance.helpArticles.length >= 3);
  for (const article of h.instance.helpArticles) {
    assert.ok(article.id && article.title && article.answer);
    assert.ok(Array.isArray(article.roles) && article.roles.length);
    assert.ok(Array.isArray(article.views) && article.views.length);
    assert.ok(Array.isArray(article.keywords) && article.keywords.length);
    assert.ok(Array.isArray(article.steps) && Array.isArray(article.actions));
    assert.ok(!/workday/i.test(JSON.stringify(article)));
  }
  const privacy = h.instance.helpArticles.find(article => article.id === 'recruiting-privacy');
  assert.ok(privacy.answer.includes('bitte im Einzelfall prüfen'));
});

test('Beispieldaten: mehrfach aufrufbar, keine Konten, nur erfundene Personen', async () => {
  const seeded = await createModuleHarness(createRecruitingModule);
  try {
    const usersBefore = seeded.db.prepare('SELECT COUNT(*) AS count FROM users').get().count;
    seeded.instance.seedDemo();
    const counts = () => ['recruiting_requisitions', 'recruiting_candidates', 'recruiting_applications', 'recruiting_interviews', 'tasks']
      .map(table => seeded.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count);
    const first = counts();
    assert.ok(first[0] >= 2 && first[1] >= 3 && first[2] >= 2);
    seeded.instance.seedDemo();
    assert.deepEqual(counts(), first);
    assert.equal(seeded.db.prepare('SELECT COUNT(*) AS count FROM users').get().count, usersBefore);
    const emails = seeded.db.prepare('SELECT email FROM recruiting_candidates').all().map(row => row.email);
    assert.ok(emails.every(email => email.endsWith('@example.com')));

    // Die erste Mitarbeiterin der Demo kann beides ausprobieren: bewerten und sich bewerben.
    const { interviews } = await ok(seeded.api('anna', 'GET', '/api/recruiting/interviews/mine'));
    assert.equal(interviews[0].canSubmitFeedback, true, 'das Beispielgespräch liegt zurück');
    const { jobs } = await ok(seeded.api('anna', 'GET', '/api/recruiting/job-board'));
    assert.ok(jobs.some(job => job.canApply), 'mindestens eine Stelle zum Bewerben');
    assert.ok(jobs.some(job => job.applyBlockedReason), 'und eine, die den Grund nennt');
  } finally {
    await seeded.close();
  }

  const empty = await createModuleHarness(createRecruitingModule);
  try {
    empty.db.prepare('UPDATE users SET active=0').run();
    empty.instance.seedDemo();
    assert.equal(empty.db.prepare('SELECT COUNT(*) AS count FROM recruiting_requisitions').get().count, 0, 'ohne Personen passiert nichts');
  } finally {
    await empty.close();
  }
});

// --- Oberfläche: der echte Browser-Code läuft gegen den echten Server, nur das DOM ist nachgebildet ---

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' };
const escapeHtml = value => String(value ?? '').replace(/[&<>'"]/g, char => HTML_ESCAPES[char]);
const unescapeHtml = value => value.replace(/&(amp|lt|gt|#39|quot);/g, entity => Object.entries(HTML_ESCAPES).find(([, code]) => code === entity)[0]);
const camelCase = name => name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());

/** Im Betrieb greift der Browser nach der Einstellung auf die Personalakte zu. */
function withPersonnelRoutes(deps) {
  const onboarding = createOnboardingModule(deps);
  const personnel = createPersonnelModule(deps);
  const recruiting = createRecruitingModule(deps);
  const router = express.Router();
  router.use(onboarding.router);
  router.use(recruiting.router);
  router.use(personnel.router);
  return {
    ...recruiting,
    router,
    initialize() {
      onboarding.initialize();
      personnel.initialize();
      recruiting.initialize();
    }
  };
}

/** Im Betrieb laufen beide Module nebeneinander; der Einstellungsdialog liest die Einstiegsvorlagen. */
function withOnboardingRoutes(deps) {
  const onboarding = createOnboardingModule(deps);
  const recruiting = createRecruitingModule(deps);
  const router = express.Router();
  router.use(onboarding.router);
  router.use(recruiting.router);
  return {
    ...recruiting,
    router,
    initialize() {
      onboarding.initialize();
      recruiting.initialize();
    }
  };
}

function parseActionButtons(html) {
  const buttons = [];
  for (const [tag] of html.matchAll(/<button\b[^>]*>/g)) {
    if (!tag.includes('data-recruiting-action')) continue;
    const dataset = {};
    for (const [, name, value] of tag.matchAll(/data-([a-z-]+)="([^"]*)"/g)) dataset[camelCase(name)] = unescapeHtml(value);
    buttons.push({ dataset, onclick: null });
  }
  return buttons;
}

function openInterface(harness, person) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'recruiting.js'), 'utf8');
  const me = harness.db.prepare('SELECT id,name,role FROM users WHERE id=?').get(harness.people[person]?.id ?? person);
  const modals = [];
  const toasts = [];
  let html = '';
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
      empty: message => `<p class="muted">${escapeHtml(message)}</p>`,
      plural: (count, one, many) => `${count} ${count === 1 ? one : many}`,
      number: (value, digits = 0) => Number(value).toLocaleString('de-DE', { minimumFractionDigits: digits, maximumFractionDigits: digits })
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
      loop.view = next;
    },
    isModuleEnabled: () => true,
    registerModule(item) {
      definition = item;
    }
  };
  class FakeFormData {
    constructor(form) {
      this.form = form;
    }

    getAll(key) {
      return this.form.values[key] || [];
    }
  }
  const elements = new Map();
  const document = {
    querySelectorAll: selector => (selector === '[data-recruiting-action]' ? buttons : []),
    querySelector(selector) {
      const id = selector.replace('#', '');
      const known = html.includes(`id="${id}"`) || modals.at(-1)?.body.includes(`id="${id}"`);
      if (!known) return null;
      if (!elements.has(id)) elements.set(id, { dataset: {}, elements: {}, value: '', textContent: '' });
      return elements.get(id);
    }
  };
  const confirmations = [];
  const answers = { confirm: true };
  const confirm = message => {
    confirmations.push(message);
    return answers.confirm;
  };
  vm.runInNewContext(source, { window: { loop }, document, URLSearchParams, FormData: FakeFormData, confirm, navigator: {}, console });
  function render(markup) {
    html = markup;
    buttons = parseActionButtons(markup);
    definition.bind();
    return markup;
  }
  return {
    definition,
    loop,
    modals,
    toasts,
    confirmations,
    answers,
    element: id => document.querySelector(`#${id}`),
    render,
    async open(view) {
      loop.view = view;
      return render(await definition.pages[view]());
    },
    async click(action, data = {}) {
      const button = buttons.find(item => item.dataset.recruitingAction === action
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
      const plainValues = Object.fromEntries(Object.entries(values).filter(([, value]) => !Array.isArray(value)));
      return modal.onSubmit(plainValues, { values });
    }
  };
}

test('Oberfläche: Der ganze Ablauf funktioniert mit den echten Formularen und Knöpfen', async () => {
  const fresh = await createModuleHarness(withOnboardingRoutes);
  try {
    const manager = openInterface(fresh, 'manager');
    const hr = openInterface(fresh, 'hr');
    const anna = openInterface(fresh, 'anna');
    const positionId = fresh.db.prepare("INSERT INTO position_profiles(title,title_normalized) VALUES('Oberflächenposition','oberflaechenposition')").run().lastInsertRowid;

    await manager.open('recruitingHome');
    await manager.click('new-requisition');
    await manager.submit({ title: 'UI-Stelle', openings: '1', targetDate: '2098-01-31', description: 'Beschreibung der Stelle', internalPosting: 'on', positionProfileId: String(positionId) });
    assert.equal(manager.loop.view, 'recruitingRequisition');
    let page = await manager.open('recruitingRequisition');
    assert.ok(page.includes('UI-Stelle') && page.includes('Entwurf') && page.includes('Oberflächenposition'));
    await manager.click('requisition-step', { step: 'submit' });

    const approval = fresh.db.prepare("SELECT * FROM tasks WHERE type='recruiting_approval' AND user_id=?").get(fresh.people.hr.id);
    assert.ok(hr.definition.taskAction(approval).includes('Prüfen'), 'Knopf in der Übersicht');
    hr.render(hr.definition.taskAction(approval));
    await hr.click('open-requisition', { id: approval.entity_id });
    assert.equal(hr.loop.view, 'recruitingRequisition');
    page = await hr.open('recruitingRequisition');
    assert.ok(page.includes('Freigeben'));
    await hr.click('requisition-step', { step: 'approve' });

    page = await manager.open('recruitingRequisition');
    assert.ok(page.includes('recruiting-board') && page.includes('Eingang'), 'Spaltenansicht');
    await manager.click('add-application');
    await manager.submit({ name: 'Ida Interface', email: 'ida@example.com', phone: '+49 30 1', source: 'Empfehlung', resumeUrl: 'https://example.com/ida', resumeText: 'Werdegang von Ida', notes: 'Kam über eine Empfehlung' });
    page = await manager.open('recruitingRequisition');
    assert.ok(page.includes('Ida Interface'));
    await manager.click('move', {});
    page = await manager.open('recruitingRequisition');
    const applicationId = fresh.db.prepare('SELECT id FROM recruiting_applications').get().id;
    assert.equal(fresh.db.prepare('SELECT s.name FROM recruiting_applications a JOIN recruiting_stages s ON s.id=a.stage_id WHERE a.id=?').get(applicationId).name, 'Vorauswahl');

    await manager.click('open-application', { id: applicationId });
    page = await manager.open('recruitingApplication');
    assert.ok(page.includes('Ida Interface') && page.includes('ida@example.com') && page.includes('Lebenslauf öffnen'));
    assert.ok(page.includes('rel="noopener noreferrer"'));
    await manager.click('plan-interview');
    await manager.submit({ scheduledAt: '2026-01-10T09:30', location: 'Raum 7', participantIds: [String(fresh.people.anna.id)] });

    const annaTask = fresh.db.prepare("SELECT * FROM tasks WHERE type='recruiting_feedback' AND user_id=?").get(fresh.people.anna.id);
    anna.render(anna.definition.taskAction(annaTask));
    await anna.click('open-interview');
    page = await anna.open('recruitingInterview');
    assert.ok(page.includes('Werdegang von Ida'));
    assert.ok(page.includes('erst, wenn du selbst bewertet hast'), 'Hinweis auf die unabhängige Bewertung');
    assert.ok(!page.includes('ida@example.com') && !page.includes('Kam über eine Empfehlung'), 'nur das Nötigste');
    await anna.click('give-feedback');
    await anna.submit({ rating: '4', strengths: 'Klar und freundlich', concerns: 'Wenig Praxis', recommendation: 'hire' });
    page = await anna.open('recruitingInterview');
    assert.ok(page.includes('Klar und freundlich') && page.includes('4 von 5'));
    page = await anna.open('recruitingInterviews');
    assert.ok(page.includes('Bewertet'));

    page = await manager.open('recruitingApplication');
    assert.ok(page.includes('Klar und freundlich') && page.includes('(bewertet)'));
    await manager.click('offer-new');
    await manager.submit({ startDate: '2098-02-01', positionTitle: 'UI-Stelle', compensation: 'Nach Vereinbarung' });
    page = await manager.open('recruitingApplication');
    assert.ok(page.includes('Nach Vereinbarung') && page.includes('Entwurf'));
    await manager.click('offer-edit');
    await manager.submit({ startDate: '2098-03-01', positionTitle: 'UI-Stelle', compensation: 'Nach Vereinbarung plus' });
    page = await manager.open('recruitingApplication');
    assert.ok(page.includes('01.03.2098'));
    await manager.click('offer-submit');
    assert.ok(manager.toasts.at(-1).text.includes('Freigabe'));

    const offerTask = fresh.db.prepare("SELECT * FROM tasks WHERE type='recruiting_offer_approval' AND user_id=?").get(fresh.people.hr.id);
    hr.render(hr.definition.taskAction(offerTask));
    await hr.click('open-application');
    page = await hr.open('recruitingApplication');
    await hr.click('offer-approve');
    page = await manager.open('recruitingApplication');
    assert.ok(page.includes('Freigegeben'));
    await manager.click('offer-response', { accepted: 'true' });
    page = await manager.open('recruitingApplication');
    assert.ok(!page.includes('Einstellen</button>'), 'die Führungskraft sieht keinen Knopf zum Einstellen');

    page = await hr.open('recruitingApplication');
    assert.ok(page.includes('Einstellen</button>'));
    await hr.click('hire');
    const result = await hr.submit({});
    assert.equal(result, true, 'der Ergebnisdialog bleibt offen');
    const passwordDialog = hr.modals.at(-1);
    assert.equal(passwordDialog.title, 'Konto angelegt');
    const password = /<code class="tempPassword">([^<]+)<\/code>/.exec(passwordDialog.body)[1];
    const account = fresh.db.prepare("SELECT * FROM users WHERE email='ida@example.com'").get();
    assert.ok(bcrypt.compareSync(password, account.password_hash), 'angezeigtes Passwort stimmt');
    assert.ok(passwordDialog.body.includes('nicht noch einmal angezeigt'));
    page = await hr.open('recruitingApplication');
    assert.ok(!page.includes(password), 'danach nicht mehr sichtbar');
    assert.ok(page.includes('Eingestellt'));
    page = await hr.open('recruitingHome');
    assert.ok(page.includes('Besetzt') && page.includes('Zeit bis Besetzung'));
  } finally {
    await fresh.close();
  }
});

test('Oberfläche: Absage zeigt den Text zum Kopieren, kein Versand', async () => {
  const fresh = await createModuleHarness(withOnboardingRoutes);
  try {
    const helpers = sharedHelpers(fresh);
    const requisitionId = await helpers.createOpenRequisition({ title: 'Absage-Oberfläche' });
    const { applicationId } = await helpers.addApplication(requisitionId, { name: 'Rita Rückmeldung' });
    const manager = openInterface(fresh, 'manager');
    manager.render(`<button data-recruiting-action="open-application" data-id="${applicationId}">x</button>`);
    await manager.click('open-application');
    await manager.open('recruitingApplication');
    await manager.click('reject');
    assert.equal(await manager.submit({ reason: 'better_fit', note: 'Nur intern sichtbar' }), true);
    const dialog = manager.modals.at(-1);
    assert.ok(dialog.body.includes('Guten Tag Rita Rückmeldung'));
    assert.ok(dialog.subtitle.includes('versendet keine E-Mails'));
    assert.ok(dialog.body.includes('Text kopieren'));
    assert.ok(!dialog.body.includes('Nur intern sichtbar') && !dialog.body.includes('passt besser'));
    assert.equal(dialog.onSubmit, undefined, 'es gibt keinen Absenden-Knopf');
    const page = await manager.open('recruitingApplication');
    assert.ok(page.includes('Nur intern sichtbar') && page.includes('Andere Person passt besser'));
    await manager.click('rejection-text');
    assert.ok(manager.modals.at(-1).body.includes('Rita Rückmeldung'));
  } finally {
    await fresh.close();
  }
});

test('Oberfläche: Navigation und Reiter passen zur Rolle und bleiben kurz', async () => {
  const fresh = await createModuleHarness(withOnboardingRoutes);
  try {
    const hr = openInterface(fresh, 'hr');
    const manager = openInterface(fresh, 'manager');
    const anna = openInterface(fresh, 'anna');
    const labels = (view, person) => Array.from(view.definition.nav(person.loop.me), item => `${item.group}:${item.label}`);
    const tabLabels = (view, route) => Array.from(view.definition.tabs(route, view.loop.me), tab => tab.label);
    assert.deepEqual(labels(anna, anna), ['myWork:Stellenbörse']);
    assert.deepEqual(labels(manager, manager), ['hr:Recruiting', 'myWork:Stellenbörse']);
    assert.deepEqual(labels(hr, hr), ['hr:Recruiting', 'myWork:Stellenbörse']);
    assert.deepEqual(tabLabels(hr, 'recruitingHome'), ['Stellen', 'Bewerbende', 'Meine Gespräche', 'Einstellungen']);
    assert.deepEqual(tabLabels(manager, 'recruitingHome'), ['Stellen', 'Meine Gespräche']);
    assert.deepEqual(tabLabels(anna, 'recruitingBoard'), ['Stellenbörse', 'Meine Gespräche']);
    assert.deepEqual(tabLabels(anna, 'dashboard'), []);
    assert.equal(anna.definition.taskAction({ type: 'goal_approval', entity_id: 1 }), '', 'fremde Aufgaben bleiben unberührt');
    for (const type of ['recruiting_approval', 'recruiting_requisition_assigned', 'recruiting_requisition_returned', 'recruiting_feedback', 'recruiting_offer_approval', 'recruiting_offer_returned', 'recruiting_offer_response', 'recruiting_hire_decision', 'recruiting_internal_application']) {
      assert.ok(anna.definition.taskAction({ type, entity_id: 7 }).includes('data-id="7"'), type);
    }

    for (const view of ['recruitingBoard', 'recruitingInterviews']) await anna.open(view);
    for (const view of ['recruitingHome', 'recruitingBoard', 'recruitingInterviews']) await manager.open(view);
    for (const view of ['recruitingHome', 'recruitingCandidates', 'recruitingSettings', 'recruitingBoard', 'recruitingInterviews']) await hr.open(view);
    for (const view of ['recruitingRequisition', 'recruitingApplication', 'recruitingInterview']) {
      assert.ok((await hr.open(view)).includes('Bitte wähle'), `${view} ohne Auswahl`);
    }
  } finally {
    await fresh.close();
  }
});

test('Oberfläche: Stellenbörse, eigene Bewerbung und Einstellungen', async () => {
  const fresh = await createModuleHarness(withOnboardingRoutes);
  try {
    const helpers = sharedHelpers(fresh);
    const requisitionId = await helpers.createOpenRequisition({ title: 'Börsenstelle', internalPosting: true });
    await helpers.addApplication(requisitionId, { name: 'Unsichtbare Bewerbung' });
    const anna = openInterface(fresh, 'anna');
    let page = await anna.open('recruitingBoard');
    assert.ok(page.includes('Börsenstelle') && !page.includes('Unsichtbare Bewerbung'));
    assert.ok(page.includes('erfährt nicht automatisch'));
    await anna.click('apply');
    await anna.submit({ message: 'Ich habe Lust darauf', resumeUrl: '', resumeText: 'Mein Weg' });
    page = await anna.open('recruitingBoard');
    assert.ok(page.includes('Meine Bewerbungen') && page.includes('Du hast dich beworben'));
    const applicationId = fresh.db.prepare("SELECT a.id FROM recruiting_applications a JOIN recruiting_candidates c ON c.id=a.candidate_id WHERE c.user_id=?").get(fresh.people.anna.id).id;
    anna.render(`<button data-recruiting-action="open-application" data-id="${applicationId}">x</button>`);
    await anna.click('open-application');
    page = await anna.open('recruitingApplication');
    assert.ok(page.includes('Deine eigene Bewerbung') && !page.includes('Absagen'));
    page = await anna.open('recruitingBoard');
    await anna.click('withdraw', { id: applicationId });
    page = await anna.open('recruitingBoard');
    assert.ok(page.includes('Zurückgezogen') && !page.includes('Abgesagt') && !page.includes('>Zurückziehen<'), 'wer selbst zurückzieht, bekommt keine Absage');
    assert.ok(page.includes('Du hast deine Bewerbung zurückgezogen') && !page.includes('Du hast dich beworben'), 'auch die Stelle selbst sagt das');

    const hr = openInterface(fresh, 'hr');
    page = await hr.open('recruitingSettings');
    assert.ok(page.includes('bitte im Einzelfall prüfen'));
    await hr.click('stage-add');
    await hr.submit({ name: 'Probetag' });
    page = await hr.open('recruitingSettings');
    assert.ok(page.includes('Probetag'));
    const stageId = fresh.db.prepare("SELECT id FROM recruiting_stages WHERE name='Probetag'").get().id;
    await hr.click('stage-move', { id: stageId, direction: 'up' });
    await hr.click('stage-rename', { id: stageId });
    await hr.submit({ name: 'Schnuppertag' });
    page = await hr.open('recruitingSettings');
    await hr.click('stage-toggle', { id: stageId });
    assert.equal(fresh.db.prepare('SELECT active FROM recruiting_stages WHERE id=?').get(stageId).active, 0);

    page = await hr.open('recruitingCandidates');
    assert.ok(page.includes('bitte im Einzelfall prüfen') && page.includes('Unsichtbare Bewerbung'));
    await hr.click('new-candidate');
    await hr.submit({ name: 'Pia Pool', email: 'pia@example.com', talentPoolConsent: 'on', talentPoolConsentDate: '2026-01-15', notes: 'Für später' });
    page = await hr.open('recruitingCandidates');
    assert.ok(page.includes('Pia Pool') && page.includes('Ja, seit 15.01.2026'));
    const piaId = fresh.db.prepare("SELECT id FROM recruiting_candidates WHERE email='pia@example.com'").get().id;
    await hr.click('edit-candidate', { id: piaId });
    await hr.submit({ name: 'Pia Pool', email: 'pia@example.com', source: 'Messe', phone: '+49 1', resumeUrl: '', resumeText: '', notes: 'Geändert', talentPoolConsentDate: '' });
    assert.equal(fresh.db.prepare('SELECT talent_pool_consent FROM recruiting_candidates WHERE id=?').get(piaId).talent_pool_consent, 0, 'ohne Häkchen ist die Einwilligung zurückgezogen');
    page = await hr.open('recruitingCandidates');
    await hr.click('anonymize', { id: piaId });
    assert.equal(fresh.db.prepare('SELECT name FROM recruiting_candidates WHERE id=?').get(piaId).name, 'Anonymisierte Person');
  } finally {
    await fresh.close();
  }
});

test('Oberfläche: Interner Wechsel wird angeboten, das Konto bleibt unverändert', async () => {
  const fresh = await createModuleHarness(withOnboardingRoutes);
  try {
    const helpers = sharedHelpers(fresh);
    const requisitionId = await helpers.createOpenRequisition({ owner: 'director', title: 'Wechselstelle', internalPosting: true });
    const { id: applicationId } = await ok(fresh.api('clara', 'POST', `/api/recruiting/job-board/${requisitionId}/apply`, {}));
    await helpers.createAcceptedOffer(applicationId, { creator: 'director' });
    const hr = openInterface(fresh, 'hr');
    hr.render(`<button data-recruiting-action="open-application" data-id="${applicationId}">x</button>`);
    await hr.click('open-application');
    await hr.open('recruitingApplication');
    await hr.click('hire');
    assert.ok(hr.modals.at(-1).body.includes('startOnboarding'), 'Einstieg ist hier freiwillig');
    assert.equal(await hr.submit({}), true);
    const dialog = hr.modals.at(-1);
    assert.equal(dialog.title, 'Interner Wechsel');
    assert.ok(dialog.body.includes('Dora Direktor') && dialog.body.includes('protokolliert'));
    assert.ok(!dialog.body.includes('tempPassword'));
  } finally {
    await fresh.close();
  }
});

test('Oberfläche: Fremde Eingaben können kein HTML und keine Attribute einschleusen', async () => {
  const fresh = await createModuleHarness(withOnboardingRoutes);
  try {
    const helpers = sharedHelpers(fresh);
    const attack = 'Mal" autofocus onfocus="alert(1)';
    const requisitionId = await helpers.createOpenRequisition({ title: attack });
    const { applicationId } = await helpers.addApplication(requisitionId, { name: attack, notes: attack, resumeText: attack });
    const { id: interviewId } = await ok(fresh.api('hr', 'POST', `/api/recruiting/applications/${applicationId}/interviews`, { ...interviewPlan([fresh.people.anna.id]), location: attack }));
    await ok(fresh.api('anna', 'POST', `/api/recruiting/interviews/${interviewId}/feedback`, feedbackBody({ strengths: attack, concerns: attack })));
    await ok(fresh.api('hr', 'POST', `/api/recruiting/applications/${applicationId}/offers`, { startDate: '2098-01-01', positionTitle: attack, compensation: attack }));
    const hr = openInterface(fresh, 'hr');
    const anna = openInterface(fresh, 'anna');
    const pages = [];
    pages.push(await hr.open('recruitingHome'));
    hr.render(`<button data-recruiting-action="open-requisition" data-id="${requisitionId}">x</button>`);
    await hr.click('open-requisition');
    pages.push(await hr.open('recruitingRequisition'));
    await hr.click('open-application', { id: applicationId });
    pages.push(await hr.open('recruitingApplication'));
    pages.push(await hr.open('recruitingCandidates'));
    anna.render(`<button data-recruiting-action="open-interview" data-id="${interviewId}">x</button>`);
    await anna.click('open-interview');
    pages.push(await anna.open('recruitingInterview'));
    for (const page of pages) {
      assert.ok(!/onfocus="alert/.test(page), 'nichts bricht aus einem Attribut aus');
      assert.ok(page.includes('Mal&quot; autofocus'), 'der Text erscheint maskiert');
    }
  } finally {
    await fresh.close();
  }
});

test('Oberfläche: Rückgaben, Änderungen und Absagen laufen über die echten Dialoge', async () => {
  const fresh = await createModuleHarness(withOnboardingRoutes);
  try {
    const helpers = sharedHelpers(fresh);
    const manager = openInterface(fresh, 'manager');
    const hr = openInterface(fresh, 'hr');

    const { id: requisitionId } = await ok(fresh.api('manager', 'POST', '/api/recruiting/requisitions', { title: 'Dialogstelle' }));
    await ok(fresh.api('manager', 'POST', `/api/recruiting/requisitions/${requisitionId}/submit`, {}));
    hr.render(`<button data-recruiting-action="open-requisition" data-id="${requisitionId}">x</button>`);
    await hr.click('open-requisition');
    await hr.open('recruitingRequisition');
    await hr.click('requisition-step', { step: 'return' });
    await hr.submit({ comment: 'Bitte Zieltermin ergänzen' });

    const director = openInterface(fresh, 'director');
    await director.open('recruitingHome');
    await director.click('new-requisition');
    assert.ok(director.modals.at(-1).body.includes('name="hiringManagerId"'), 'die Bereichsleitung kann übergeben');
    await director.submit({ title: 'Für das Team', openings: '1', targetDate: '', description: '', internalPosting: '', hiringManagerId: String(fresh.people.manager.id) });
    assert.equal(director.loop.view, 'recruitingHome', 'keine Fehlerseite nach der Übergabe');
    assert.ok(director.toasts.at(-1).text.includes('liegt jetzt bei'));

    manager.render(manager.definition.taskAction(fresh.db.prepare("SELECT * FROM tasks WHERE type='recruiting_requisition_returned'").get()));
    await manager.click('open-requisition');
    let page = await manager.open('recruitingRequisition');
    assert.ok(page.includes('Bitte Zieltermin ergänzen'));
    await manager.click('edit-requisition');
    assert.ok(!manager.modals.at(-1).body.includes('name="hiringManagerId"'), 'die Führungskraft kann die Stelle nicht weitergeben');
    await manager.submit({ title: 'Dialogstelle neu', openings: '2', targetDate: '2098-05-01', description: '', internalPosting: '' });
    await manager.open('recruitingRequisition');
    await manager.click('requisition-step', { step: 'submit' });
    await hr.open('recruitingRequisition');
    await hr.click('requisition-step', { step: 'approve' });
    assert.equal(fresh.db.prepare('SELECT openings FROM recruiting_requisitions WHERE id=?').get(requisitionId).openings, 2);

    await manager.open('recruitingRequisition');
    await manager.click('requisition-step', { step: 'pause' });
    page = await manager.open('recruitingRequisition');
    assert.ok(page.includes('Pausiert') && !page.includes('+ Bewerbung'), 'pausiert keine neuen Bewerbungen');
    await manager.click('requisition-step', { step: 'resume' });

    const { applicationId } = await helpers.addApplication(requisitionId, { name: 'Dora Dialog', phone: '+49 1' });
    manager.render(`<button data-recruiting-action="open-application" data-id="${applicationId}">x</button>`);
    await manager.click('open-application');
    await manager.open('recruitingApplication');
    await manager.click('edit-candidate');
    assert.ok(!manager.modals.at(-1).body.includes('name="email"'), 'die E-Mail ändert nur HR');
    await manager.submit({ phone: '+49 2', resumeUrl: 'https://example.com/dora', resumeText: 'Neuer Text', notes: 'Notiz der Führungskraft' });
    page = await manager.open('recruitingApplication');
    assert.ok(page.includes('+49 2') && page.includes('Notiz der Führungskraft'));

    await manager.click('plan-interview');
    await manager.submit({ scheduledAt: '2098-03-01T10:00', location: 'Raum A', participantIds: [String(fresh.people.ben.id), String(fresh.people.anna.id)] });
    await manager.open('recruitingApplication');
    await manager.click('edit-interview');
    assert.ok(manager.modals.at(-1).body.includes('value="2098-03-01T10:00"'), 'der Termin ist vorbelegt');
    await manager.submit({ scheduledAt: '2098-03-02T11:00', location: 'Raum B', participantIds: [String(fresh.people.ben.id)] });
    page = await manager.open('recruitingApplication');
    assert.ok(page.includes('02.03.2098, 11:00 Uhr') && page.includes('Raum B') && !page.includes('Anna Ahrens'));
    await manager.click('cancel-interview');
    page = await manager.open('recruitingApplication');
    assert.ok(page.includes('Abgesagt') && !page.includes('Ändern</button>'));

    await manager.click('offer-new');
    await manager.submit({ startDate: '2098-04-01', positionTitle: '', compensation: 'Freitext' });
    await manager.open('recruitingApplication');
    await manager.click('offer-submit');
    await hr.render(`<button data-recruiting-action="open-application" data-id="${applicationId}">x</button>`);
    await hr.click('open-application');
    await hr.open('recruitingApplication');
    await hr.click('offer-return');
    await hr.submit({ comment: 'Bitte Datum prüfen' });
    page = await manager.open('recruitingApplication');
    assert.ok(page.includes('Bitte Datum prüfen'));

    await manager.click('reject');
    await manager.submit({ reason: 'other', note: '' });
    page = await manager.open('recruitingApplication');
    assert.ok(page.includes('Zurückgezogen'), 'das offene Angebot endet mit der Absage');
    assert.ok(!page.includes('+ Gespräch') && !page.includes('+ Angebot'), 'abgeschlossen bietet keine neuen Schritte an');
  } finally {
    await fresh.close();
  }
});

test('H11: Die Regel für Stellen bestimmt, was angezeigt und was getan wird', async () => {
  const fresh = await createModuleHarness(withOnboardingRoutes);
  try {
    const manager = openInterface(fresh, 'manager');
    const hr = openInterface(fresh, 'hr');
    const director = openInterface(fresh, 'director');

    // Voreinstellung: HR gibt frei.
    await manager.open('recruitingHome');
    await manager.click('new-requisition');
    assert.ok(manager.modals.at(-1).subtitle.includes('zur Freigabe bei HR'));
    await manager.submit({ title: 'Mit Freigabe', openings: '1', targetDate: '', description: '', internalPosting: '' });
    let page = await manager.open('recruitingRequisition');
    assert.ok(page.includes('Zur Freigabe einreichen') && !page.includes('Stelle öffnen'));
    await manager.click('requisition-step', { step: 'submit' });
    assert.ok(manager.toasts.at(-1).text.includes('wartet jetzt auf die Freigabe'));
    const withApproval = fresh.db.prepare("SELECT id FROM recruiting_requisitions WHERE title='Mit Freigabe'").get().id;
    assert.equal(fresh.db.prepare('SELECT status FROM recruiting_requisitions WHERE id=?').get(withApproval).status, 'pending_approval');
    hr.render(`<button data-recruiting-action="open-requisition" data-id="${withApproval}">x</button>`);
    await hr.click('open-requisition');
    await hr.open('recruitingRequisition');
    await hr.click('requisition-step', { step: 'approve' });
    assert.ok(hr.toasts.at(-1).text.includes('freigegeben'), 'eine Meldung statt Stille');
    await director.open('recruitingHome');
    await director.click('new-requisition');
    await director.submit({ title: 'Übergabe mit Freigabe', openings: '1', targetDate: '', description: '', internalPosting: '', hiringManagerId: String(fresh.people.manager.id) });
    assert.ok(director.toasts.at(-1).text.includes('reicht ihn zur Freigabe ein'));

    // Ohne Freigabe: Kein Wort von Freigabe, und die Stelle ist offen.
    fresh.deps.setApprovalRule('recruiting.requisition', 'none', { id: 1 });
    await manager.open('recruitingHome');
    await manager.click('new-requisition');
    const subtitle = manager.modals.at(-1).subtitle;
    assert.ok(subtitle.includes('öffnest') && !subtitle.includes('Freigabe bei HR'), subtitle);
    await manager.submit({ title: 'Ohne Freigabe', openings: '1', targetDate: '', description: '', internalPosting: '' });
    page = await manager.open('recruitingRequisition');
    assert.ok(page.includes('Stelle öffnen') && !page.includes('Zur Freigabe einreichen'), 'der Knopf sagt, was passiert');
    await manager.click('requisition-step', { step: 'submit' });
    assert.ok(manager.toasts.at(-1).text.includes('jetzt offen'));
    const direct = fresh.db.prepare("SELECT id,status FROM recruiting_requisitions WHERE title='Ohne Freigabe'").get();
    assert.equal(direct.status, 'open');
    assert.equal(fresh.db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE type='recruiting_approval' AND entity_id=?").get(direct.id).count, 0);
    await director.open('recruitingHome');
    await director.click('new-requisition');
    await director.submit({ title: 'Übergabe ohne Freigabe', openings: '1', targetDate: '', description: '', internalPosting: '', hiringManagerId: String(fresh.people.manager.id) });
    assert.ok(director.toasts.at(-1).text.includes('öffnet die Stelle'));
    const handedOver = fresh.db.prepare("SELECT title FROM tasks WHERE type='recruiting_requisition_assigned' AND title LIKE '%Übergabe ohne Freigabe%'").get();
    assert.ok(handedOver.title.includes('prüfen und öffnen'), handedOver.title);

    // Eine Stelle, die schon auf Freigabe wartet, bleibt nach dem Regelwechsel freigebbar.
    fresh.deps.setApprovalRule('recruiting.requisition', 'hr', { id: 1 });
    const { id: waiting } = await ok(fresh.api('manager', 'POST', '/api/recruiting/requisitions', { title: 'Wartet' }));
    await ok(fresh.api('manager', 'POST', `/api/recruiting/requisitions/${waiting}/submit`, {}));
    fresh.deps.setApprovalRule('recruiting.requisition', 'none', { id: 1 });
    await ok(fresh.api('bp', 'POST', `/api/recruiting/requisitions/${waiting}/approve`, {}));
    assert.equal(fresh.db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE type='recruiting_approval' AND entity_id=? AND done=0").get(waiting).count, 0);
  } finally {
    await fresh.close();
  }
});

test('H11: Die Regel für Angebote bestimmt Texte, Knöpfe und Meldungen in jeder Stellung', async () => {
  const fresh = await createModuleHarness(withOnboardingRoutes);
  try {
    const helpers = sharedHelpers(fresh);
    const hr = openInterface(fresh, 'hr');
    const bp = openInterface(fresh, 'bp');
    const offerRow = () => fresh.db.prepare('SELECT * FROM recruiting_offers ORDER BY id DESC LIMIT 1').get();
    const openApplication = async (view, applicationId) => {
      view.render(`<button data-recruiting-action="open-application" data-id="${applicationId}">x</button>`);
      await view.click('open-application');
      return view.open('recruitingApplication');
    };
    const newApplication = async title => {
      const requisitionId = await helpers.createOpenRequisition({ title });
      return (await helpers.addApplication(requisitionId, { name: `Person ${title}` })).applicationId;
    };

    // Vier Augen: HR erstellt, eine andere HR-Person gibt frei.
    let applicationId = await newApplication('Vier Augen');
    await openApplication(hr, applicationId);
    await hr.click('offer-new');
    assert.ok(hr.modals.at(-1).subtitle.includes('Wer es erstellt oder zuletzt geändert hat, darf das nicht selbst tun'));
    await hr.submit({ startDate: '2099-01-01', positionTitle: 'Vier Augen', compensation: '' });
    let page = await hr.open('recruitingApplication');
    assert.ok(page.includes('Zur Freigabe geben') && !page.includes('fertigstellen'));
    await hr.click('offer-submit');
    assert.ok(hr.toasts.at(-1).text.includes('wartet jetzt auf die Freigabe'));
    page = await hr.open('recruitingApplication');
    assert.ok(page.includes('Eine andere HR-Person muss es freigeben'), 'die Sperre ist erklärt');
    assert.ok(!page.includes('data-recruiting-action="offer-approve"'));
    await openApplication(bp, applicationId);
    await bp.click('offer-approve');
    assert.equal(offerRow().status, 'approved');
    page = await bp.open('recruitingApplication');
    assert.ok(page.includes('Freigegeben von Boris Partner') && !page.includes('ohne Freigabe'));

    // HR, auch das eigene Angebot.
    fresh.deps.setApprovalRule('recruiting.offer', 'hr', { id: 1 });
    applicationId = await newApplication('Auch eigenes');
    await openApplication(hr, applicationId);
    await hr.click('offer-new');
    assert.ok(hr.modals.at(-1).subtitle.includes('auch die Person sein, die es erstellt hat'));
    await hr.submit({ startDate: '2099-01-01', positionTitle: 'Auch eigenes', compensation: '' });
    await hr.open('recruitingApplication');
    await hr.click('offer-submit');
    assert.ok(hr.toasts.at(-1).text.includes('wartet jetzt auf die Freigabe'));
    page = await hr.open('recruitingApplication');
    assert.ok(!page.includes('Eine andere HR-Person muss es freigeben'), 'das stimmte hier nicht');
    await hr.click('offer-approve');
    assert.equal(offerRow().status, 'approved');
    assert.equal(offerRow().approved_by, fresh.people.hr.id);
    assert.equal(offerRow().approval_skipped, 0);

    // Ohne Freigabe: Früher stand hier in Rot „Es gibt gerade keine andere HR-Person“.
    fresh.deps.setApprovalRule('recruiting.offer', 'none', { id: 1 });
    const requisitionId = await helpers.createOpenRequisition({ title: 'Ohne' });
    applicationId = (await helpers.addApplication(requisitionId, { name: 'Person Ohne' })).applicationId;
    await openApplication(hr, applicationId);
    await hr.click('offer-new');
    const subtitle = hr.modals.at(-1).subtitle;
    assert.ok(subtitle.includes('nicht nötig') && !subtitle.includes('HR-Person'), subtitle);
    await hr.submit({ startDate: '2099-01-01', positionTitle: 'Ohne', compensation: '' });
    page = await hr.open('recruitingApplication');
    assert.ok(page.includes('Angebot fertigstellen') && !page.includes('Zur Freigabe geben'));
    await hr.click('offer-submit');
    assert.equal(hr.toasts.at(-1).type, undefined, 'kein roter Fehler');
    assert.ok(hr.toasts.at(-1).text.includes('fertig') && !hr.toasts.at(-1).text.includes('HR-Person'));
    assert.equal(offerRow().status, 'approved');
    assert.equal(offerRow().approval_skipped, 1);
    page = await hr.open('recruitingApplication');
    assert.ok(page.includes('Fertig, ohne Freigabe') && page.includes('Fertiggestellt von Hanna HR') && !page.includes('Freigegeben von'));
    hr.render(`<button data-recruiting-action="open-requisition" data-id="${requisitionId}">x</button>`);
    await hr.click('open-requisition');
    const board = await hr.open('recruitingRequisition');
    assert.ok(board.includes('Angebot: Fertig, ohne Freigabe'), 'auch die Spaltenansicht bleibt ehrlich');
    assert.equal(fresh.db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE type='recruiting_offer_approval' AND entity_id=?").get(applicationId).count, 0);
    await hr.open('recruitingApplication');
    await hr.click('offer-response', { accepted: 'true' });
    assert.ok(hr.toasts.at(-1).text.includes('angenommen'));

    // Gibt es bei einer Freigaberegel niemanden, bleibt es verständlich ein Entwurf.
    fresh.deps.setApprovalRule('recruiting.offer', 'four_eyes', { id: 1 });
    fresh.db.prepare("UPDATE users SET role='employee' WHERE id=?").run(fresh.people.bp.id);
    const lonely = await newApplication('Allein');
    const { id: offerId } = await ok(fresh.api('hr', 'POST', `/api/recruiting/applications/${lonely}/offers`, { startDate: '2099-01-01' }));
    const refused = await fresh.api('hr', 'POST', `/api/recruiting/offers/${offerId}/submit`, {});
    assert.equal(refused.status, 409);
    assert.match(refused.data.error, /bleibt ein Entwurf/);
    assert.equal(offerRow().status, 'draft');
    fresh.deps.setApprovalRule('recruiting.offer', 'hr', { id: 1 });
    await ok(fresh.api('hr', 'POST', `/api/recruiting/offers/${offerId}/submit`, {}));
    await ok(fresh.api('hr', 'POST', `/api/recruiting/offers/${offerId}/approve`, {}));
  } finally {
    await fresh.close();
  }
});

test('D8: Die Oberfläche blendet fremde Bewertungen für Beteiligte aus und sagt warum', async () => {
  const fresh = await createModuleHarness(withOnboardingRoutes);
  try {
    const helpers = sharedHelpers(fresh);
    const requisitionId = await helpers.createOpenRequisition({ title: 'Blind in der Oberfläche' });
    const { applicationId } = await helpers.addApplication(requisitionId, { name: 'Blinde Bewerbung' });
    const { id: interviewId } = await ok(fresh.api('hr', 'POST', `/api/recruiting/applications/${applicationId}/interviews`, interviewPlan([fresh.people.anna.id, fresh.people.manager.id])));
    await ok(fresh.api('anna', 'POST', `/api/recruiting/interviews/${interviewId}/feedback`, feedbackBody({ strengths: 'Annas Einschätzung', rating: 2 })));
    const manager = openInterface(fresh, 'manager');
    manager.render(`<button data-recruiting-action="open-requisition" data-id="${requisitionId}">x</button>`);
    await manager.click('open-requisition');
    let page = await manager.open('recruitingRequisition');
    assert.ok(page.includes('Bewertungen siehst du nach deiner eigenen') && !page.includes('Schnitt'), 'keine Note in der Spalte');
    await manager.click('open-application', { id: applicationId });
    page = await manager.open('recruitingApplication');
    assert.ok(!page.includes('Annas Einschätzung') && !page.includes('(bewertet)'));
    assert.ok(page.includes('erst, wenn du selbst bewertet hast'));
    await manager.click('open-interview', { id: interviewId });
    page = await manager.open('recruitingInterview');
    assert.ok(page.includes('erst, wenn du selbst bewertet hast') && !page.includes('Annas Einschätzung'));
    await manager.click('give-feedback');
    assert.ok(manager.modals.at(-1).subtitle.includes('Fremde Bewertungen siehst du erst danach'), 'der Dialog sagt nun die Wahrheit');
    await manager.submit({ rating: '4', strengths: 'Meine Einschätzung', concerns: '', recommendation: 'hire' });
    page = await manager.open('recruitingInterview');
    assert.ok(page.includes('Annas Einschätzung') && page.includes('Meine Einschätzung'));
    page = await manager.open('recruitingRequisition');
    assert.ok(page.includes('Schnitt 3,0 von 5 aus 2 Bewertungen'), 'Zahlen mit Komma und richtiger Mehrzahl');
    await ok(fresh.api('ben', 'GET', '/api/recruiting/job-board'));
    assert.equal((await fresh.api('anna', 'POST', `/api/recruiting/interviews/${interviewId}/feedback`, feedbackBody())).status, 409);
  } finally {
    await fresh.close();
  }
});

test('M17: Die Oberfläche nennt den Termin, statt zu einer Bewertung einzuladen', async () => {
  const fresh = await createModuleHarness(withOnboardingRoutes);
  try {
    const helpers = sharedHelpers(fresh);
    const requisitionId = await helpers.createOpenRequisition({ title: 'Termin steht aus' });
    const { applicationId } = await helpers.addApplication(requisitionId, { name: 'Später Person' });
    const { id: interviewId } = await ok(fresh.api('manager', 'POST', `/api/recruiting/applications/${applicationId}/interviews`, futureInterviewPlan([fresh.people.anna.id])));
    const anna = openInterface(fresh, 'anna');
    let page = await anna.open('recruitingInterviews');
    assert.ok(page.includes('Termin steht noch aus') && !page.includes('>Bewerten<'));
    anna.render(`<button data-recruiting-action="open-interview" data-id="${interviewId}">x</button>`);
    await anna.click('open-interview');
    page = await anna.open('recruitingInterview');
    assert.ok(page.includes('Bewerten kannst du ab dem Termin: 15.01.2099, 10:30 Uhr') && !page.includes('Jetzt bewerten'));
  } finally {
    await fresh.close();
  }
});

test('M20: Die Stellenbörse nennt den Grund für einen fehlenden Knopf', async () => {
  const fresh = await createModuleHarness(withOnboardingRoutes);
  try {
    const helpers = sharedHelpers(fresh);
    const requisitionId = await helpers.createOpenRequisition({ title: 'Gesprächsrolle', internalPosting: true });
    const { applicationId } = await helpers.addApplication(requisitionId, {});
    await ok(fresh.api('manager', 'POST', `/api/recruiting/applications/${applicationId}/interviews`, interviewPlan([fresh.people.anna.id])));
    const anna = openInterface(fresh, 'anna');
    const page = await anna.open('recruitingBoard');
    assert.ok(!page.includes('>Bewerben<'));
    assert.ok(page.includes('an Gesprächen zu dieser Stelle beteiligt') && page.includes('sprich bitte HR an'));
  } finally {
    await fresh.close();
  }
});

test('H13: Die Einstellung übernimmt das Eintrittsdatum in die Personalakte und nennt die Rolle', async () => {
  const fresh = await createModuleHarness(withPersonnelRoutes);
  try {
    const helpers = sharedHelpers(fresh);
    const requisitionId = await helpers.createOpenRequisition({ title: 'Mit Akte', openings: 3 });
    const hireThroughDialog = async (who, name, values) => {
      const { applicationId } = await helpers.addApplication(requisitionId, { name });
      await helpers.createAcceptedOffer(applicationId, { startDate: '2099-02-01' });
      const view = openInterface(fresh, who);
      view.render(`<button data-recruiting-action="open-application" data-id="${applicationId}">x</button>`);
      await view.click('open-application');
      await view.open('recruitingApplication');
      await view.click('hire');
      const dialog = view.modals.at(-1);
      await view.submit(values);
      return { view, dialog, result: view.modals.at(-1), account: fresh.db.prepare('SELECT * FROM users WHERE name=?').get(name) };
    };

    const { dialog, result, account } = await hireThroughDialog('hr', 'Erika Eintritt', { role: 'manager' });
    assert.ok(dialog.body.includes('name="role"') && dialog.body.includes('HR-Administration'), 'die HR-Administration kann auch HR-Rollen wählen');
    assert.ok(dialog.body.includes('sofort aktiv'), 'der Dialog sagt, was gilt');
    assert.equal(account.role, 'manager');
    const record = fresh.db.prepare('SELECT entry_date FROM personnel_records WHERE user_id=?').get(account.id);
    assert.equal(record.entry_date, '2099-02-01', 'das Eintrittsdatum steht in der Akte');
    const { sheet } = await ok(fresh.api('hr', 'GET', `/api/personnel/${account.id}`));
    assert.equal(sheet.business.entryDate, '2099-02-01');
    assert.ok(result.body.includes('steht jetzt in der Personalakte'));
    assert.ok(result.body.includes('Vertrag und Vergütung'), 'und was nicht übernommen wird');
    assert.ok(result.body.includes('erst zum Eintritt am 01.02.2099'), 'das Konto ist aktiv, das Passwort kommt zum Eintritt');

    const byPartner = await hireThroughDialog('bp', 'Bert Berater', {});
    assert.ok(byPartner.dialog.body.includes('name="role"') && !byPartner.dialog.body.includes('HR-Administration'), 'der HR Business Partner vergibt keine HR-Rollen');
    assert.equal(byPartner.account.role, 'employee');
    assert.equal(fresh.db.prepare('SELECT entry_date FROM personnel_records WHERE user_id=?').get(byPartner.account.id).entry_date, '2099-02-01');

    // Ein Fehler der Akte kostet nicht das einmalige Passwort. Hier fehlt die Schnittstelle ganz.
    const broken = await createModuleHarness(withOnboardingRoutes);
    try {
      const brokenHelpers = sharedHelpers(broken);
      const brokenRequisition = await brokenHelpers.createOpenRequisition({ title: 'Akte fehlt' });
      const { applicationId } = await brokenHelpers.addApplication(brokenRequisition, { name: 'Fehler Person' });
      await brokenHelpers.createAcceptedOffer(applicationId, { startDate: '2099-02-01' });
      const hr = openInterface(broken, 'hr');
      hr.render(`<button data-recruiting-action="open-application" data-id="${applicationId}">x</button>`);
      await hr.click('open-application');
      await hr.open('recruitingApplication');
      await hr.click('hire');
      assert.equal(await hr.submit({}), true);
      const dialogBody = hr.modals.at(-1).body;
      assert.ok(dialogBody.includes('tempPassword'), 'das Passwort erscheint trotzdem');
      assert.ok(dialogBody.includes('konnte nicht in die Personalakte übernommen werden') && dialogBody.includes('01.02.2099'), 'und die Aufforderung, es selbst einzutragen');
    } finally {
      await broken.close();
    }
  } finally {
    await fresh.close();
  }
});

test('H13: Ohne Modul Personalakte und beim internen Wechsel wird die Akte nicht angefasst', async () => {
  const off = await createModuleHarness(withOnboardingRoutes, { isModuleEnabled: key => key !== 'personnel' });
  try {
    const helpers = sharedHelpers(off);
    const requisitionId = await helpers.createOpenRequisition({ title: 'Ohne Akte' });
    const { applicationId } = await helpers.addApplication(requisitionId, { name: 'Ohne Akte' });
    await helpers.createAcceptedOffer(applicationId);
    const hr = openInterface(off, 'hr');
    hr.render(`<button data-recruiting-action="open-application" data-id="${applicationId}">x</button>`);
    await hr.click('open-application');
    await hr.open('recruitingApplication');
    await hr.click('hire');
    await hr.submit({});
    assert.ok(!hr.modals.at(-1).body.includes('Personalakte'), 'kein Wort über ein Modul, das aus ist');
  } finally {
    await off.close();
  }

  const fresh = await createModuleHarness(withPersonnelRoutes);
  try {
    const helpers = sharedHelpers(fresh);
    await ok(fresh.api('hr', 'PATCH', `/api/personnel/${fresh.people.clara.id}/master`, { entryDate: '2020-05-01' }));
    const requisitionId = await helpers.createOpenRequisition({ owner: 'director', title: 'Wechsel mit Akte', internalPosting: true });
    const { id: applicationId } = await ok(fresh.api('clara', 'POST', `/api/recruiting/job-board/${requisitionId}/apply`, {}));
    await helpers.createAcceptedOffer(applicationId, { creator: 'director', startDate: '2099-02-01' });
    const hr = openInterface(fresh, 'hr');
    hr.render(`<button data-recruiting-action="open-application" data-id="${applicationId}">x</button>`);
    await hr.click('open-application');
    await hr.open('recruitingApplication');
    await hr.click('hire');
    assert.ok(!hr.modals.at(-1).body.includes('name="role"'), 'ein vorhandenes Konto behält seine Rolle');
    await hr.submit({});
    assert.equal(hr.modals.at(-1).title, 'Interner Wechsel');
    assert.ok(hr.modals.at(-1).body.includes('„Konten“'), 'der Weg stimmt');
    assert.equal(fresh.db.prepare('SELECT entry_date FROM personnel_records WHERE user_id=?').get(fresh.people.clara.id).entry_date, '2020-05-01', 'ein Wechsel ist kein neuer Eintritt');
  } finally {
    await fresh.close();
  }
});

test('B17: In der Oberfläche sieht der HR Business Partner keine Knöpfe, die Administration eine Warnung und eine Rückfrage', async () => {
  const fresh = await createModuleHarness(withOnboardingRoutes);
  try {
    const helpers = sharedHelpers(fresh);
    const bp = openInterface(fresh, 'bp');
    assert.deepEqual(Array.from(bp.definition.tabs('recruitingHome', bp.loop.me), tab => tab.label), ['Stellen', 'Bewerbende', 'Meine Gespräche'], 'kein Reiter „Einstellungen“');
    const readOnly = await bp.open('recruitingSettings');
    assert.ok(readOnly.includes('nur die HR-Administration'));
    for (const action of ['stage-add', 'stage-rename', 'stage-toggle', 'stage-move']) {
      assert.ok(!readOnly.includes(`data-recruiting-action="${action}"`), action);
    }
    assert.ok(!readOnly.includes('recruitingRetentionForm'));

    const hr = openInterface(fresh, 'hr');
    const page = await hr.open('recruitingSettings');
    assert.ok(page.includes('min="3"') && page.includes('automatisch und endgültig'), 'Untergrenze und Warnung stehen dabei');

    const requisitionId = await helpers.createOpenRequisition({ title: 'Rückfrage' });
    const { applicationId } = await helpers.addApplication(requisitionId, {});
    await ok(fresh.api('hr', 'POST', `/api/recruiting/applications/${applicationId}/reject`, { reason: 'other' }));
    fresh.db.prepare('UPDATE recruiting_applications SET rejected_at=? WHERE id=?').run(new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString(), applicationId);
    const form = hr.element('recruitingRetentionForm');
    form.elements = { retentionMonths: { value: '3' } };
    const months = () => fresh.db.prepare('SELECT retention_months FROM recruiting_settings').get().retention_months;

    hr.answers.confirm = false;
    await form.onsubmit({ preventDefault() {} });
    assert.ok(hr.confirmations.at(-1).includes('1 Person wird') && hr.confirmations.at(-1).includes('rückgängig'));
    assert.equal(months(), 6, 'nach dem Nein bleibt die Frist');
    assert.equal(hr.element('recruitingRetentionError').textContent, 'Die Frist bleibt unverändert.');

    hr.answers.confirm = true;
    await form.onsubmit({ preventDefault() {} });
    assert.equal(months(), 3);
    assert.ok(hr.toasts.at(-1).text.includes('gespeichert'));
  } finally {
    await fresh.close();
  }
});

test('Oberfläche: Mehrzahl und Zahlen stimmen auch bei einer besetzten Stelle', async () => {
  const fresh = await createModuleHarness(withOnboardingRoutes);
  try {
    const helpers = sharedHelpers(fresh);
    const requisitionId = await helpers.createOpenRequisition({ title: 'Einzelstelle' });
    const { applicationId } = await helpers.addApplication(requisitionId, {});
    await helpers.createAcceptedOffer(applicationId);
    await ok(fresh.api('hr', 'POST', `/api/recruiting/applications/${applicationId}/hire`, {}));
    fresh.db.prepare('UPDATE recruiting_requisitions SET opened_at=?,filled_at=? WHERE id=?').run('2026-01-01T00:00:00.000Z', '2026-01-11T12:00:00.000Z', requisitionId);
    const page = await openInterface(fresh, 'hr').open('recruitingHome');
    assert.ok(page.includes('Durchschnitt aus 1 besetzten Stelle') && !page.includes('1 besetzten Stellen'));
    assert.ok(page.includes('10,5 Tage'), 'Zahlen mit Komma');
  } finally {
    await fresh.close();
  }
});

test('Oberfläche: Die Sachbearbeitung sieht nur die Stellenbörse', async () => {
  const fresh = await createModuleHarness(withOnboardingRoutes);
  try {
    const staff = createStaff(fresh);
    const view = openInterface(fresh, staff);
    assert.deepEqual(Array.from(view.definition.nav(view.loop.me), item => `${item.group}:${item.label}`), ['myWork:Stellenbörse']);
    assert.deepEqual(Array.from(view.definition.tabs('recruitingBoard', view.loop.me), tab => tab.label), ['Stellenbörse', 'Meine Gespräche']);
    await view.open('recruitingBoard');
    await view.open('recruitingInterviews');
  } finally {
    await fresh.close();
  }
});

test('Oberfläche: Regeln aus dem Modul-Vertrag werden eingehalten', () => {
  for (const file of ['public/recruiting.js', 'routes/recruiting.js']) {
    const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    assert.ok(!/workday/i.test(source), `${file}: der Name erscheint nirgends`);
    assert.ok(!/E-Mail senden|mailto:|sendMail|nodemailer/i.test(source), `${file}: keine Scheinfunktion für E-Mails`);
    assert.ok(!/onclick="/.test(source), `${file}: kein onclick im HTML`);
    assert.ok(!/INSERT OR (IGNORE|REPLACE)|strftime|julianday|\bdatetime\(|GROUP_CONCAT/i.test(source), `${file}: SQL bleibt standardnah`);
  }
});
