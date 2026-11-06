const assert = require('node:assert/strict');
const { before, after, test } = require('node:test');
const express = require('express');
const { openTestDatabase } = require('../lib/testing/test-database');
const { createTalentModule } = require('../routes/talent');

let db;
let server;
let baseUrl;

const cleanText = (value, max = 4000) => typeof value === 'string' ? value.replace(/[<>]/g, '').trim().slice(0, max) : '';
const boundedInt = (value, min, max, fallback) => {
  const number = Number(value);
  return Number.isInteger(number) && number >= min && number <= max ? number : fallback;
};
const validDate = value => !value || /^\d{4}-\d{2}-\d{2}$/.test(value);

function buildApp() {
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
  const canEditEmployee = (actor, employeeId) => isHr(actor) || actor.id === Number(employeeId) || db.prepare('SELECT manager_id FROM users WHERE id=?').get(employeeId)?.manager_id === actor.id;
  const auth = (req, res, next) => req.session?.user ? next() : res.status(401).json({ error: 'Nicht angemeldet' });
  const log = (actor, action, entity, entityId, beforeValues = null, afterValues = null) => db.prepare('INSERT INTO audit_log(actor_id,action,entity,entity_id,old_values,new_values) VALUES(?,?,?,?,?,?)').run(actor || null, action, entity, entityId || null, beforeValues ? JSON.stringify(beforeValues) : null, afterValues ? JSON.stringify(afterValues) : null);
  const talent = createTalentModule({ db, auth, current, isHr, canViewEmployee, canEditEmployee, cleanText, boundedInt, validDate, log });
  talent.initialize();
  app.use('/api', talent.router);
  return { app, talent };
}

async function request(userId, path, { method = 'GET', body } = {}) {
  const response = await fetch(baseUrl + path, {
    method,
    headers: { 'x-test-user': String(userId || ''), 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: response.status, data: await response.json() };
}

before(async () => {
  db = openTestDatabase();
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, role TEXT NOT NULL, title TEXT, manager_id INTEGER REFERENCES users(id));
    CREATE TABLE goals (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), title TEXT NOT NULL, description TEXT, weight INTEGER DEFAULT 100, progress INTEGER DEFAULT 0, status TEXT DEFAULT 'on_track', due_date TEXT, created_by INTEGER REFERENCES users(id), approval_status TEXT DEFAULT 'approved');
    CREATE TABLE audit_log (id INTEGER PRIMARY KEY, actor_id INTEGER, action TEXT NOT NULL, entity TEXT, entity_id INTEGER, old_values TEXT, new_values TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
  `);
  const user = db.prepare('INSERT INTO users(id,name,email,password_hash,role,title,manager_id) VALUES(?,?,?,?,?,?,?)');
  user.run(1, 'HR Admin', 'hr@example.test', 'x', 'hr_admin', 'HR', null);
  user.run(2, 'Direkte Führungskraft', 'manager@example.test', 'x', 'manager', 'Leitung', 1);
  user.run(3, 'Beschäftigte Person', 'employee@example.test', 'x', 'employee', 'Designer', 2);
  user.run(5, 'Fremde Führungskraft', 'other-manager@example.test', 'x', 'manager', 'Leitung', null);
  user.run(4, 'Fremde Person', 'other@example.test', 'x', 'employee', 'Analystin', 5);
  const { app, talent } = buildApp();
  globalThis.talentModule = talent;
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server?.close();
  db?.close();
});

test('Talentprofile benötigen Authentifizierung und schützen fremde Profile', async () => {
  assert.equal((await request(null, '/api/talent/profile')).status, 401);
  assert.equal((await request(3, '/api/talent/profile')).status, 200);
  assert.equal((await request(3, '/api/talent/profile/4')).status, 403);
  assert.equal((await request(2, '/api/talent/profile/3')).status, 200);
});

test('Karriereinteressen gehören nur der jeweiligen beschäftigten Person', async () => {
  const saved = await request(3, '/api/talent/career-interests', { method: 'PATCH', body: { careerPath: 'expert', targetPosition: 'Senior Designer', expertInterest: 'on' } });
  assert.equal(saved.status, 200);
  const managerSave = await request(2, '/api/talent/career-interests', { method: 'PATCH', body: { careerPath: 'leadership', targetPosition: 'Leitung' } });
  assert.equal(managerSave.status, 200);
  const employeeCareer = db.prepare('SELECT career_path,target_position,expert_interest FROM career_interests WHERE user_id=3').get();
  assert.deepEqual(employeeCareer, { career_path: 'expert', target_position: 'Senior Designer', expert_interest: 1 });
});

test('Nur HR verwaltet den Kompetenzkatalog und Kategorien werden validiert', async () => {
  const denied = await request(3, '/api/competencies', { method: 'POST', body: { name: 'Datenanalyse', category: 'digital' } });
  assert.equal(denied.status, 403);
  const invalid = await request(1, '/api/competencies', { method: 'POST', body: { name: 'Datenanalyse', category: 'invalid' } });
  assert.equal(invalid.status, 400);
  const created = await request(1, '/api/competencies', { method: 'POST', body: { name: 'Datenanalyse', category: 'digital', description: 'Auswertungen verständlich erklären.' } });
  assert.equal(created.status, 200);
  assert.ok(created.data.id);
  globalThis.competencyId = created.data.id;
});

test('Selbst- und Führungskräfteeinschätzung bleiben getrennt und historisiert', async () => {
  const self = await request(3, '/api/talent/competencies/self-assessment', { method: 'POST', body: { competencyId: globalThis.competencyId, rating: 3, comment: 'Eigenes Niveau' } });
  assert.equal(self.status, 200);
  const manager = await request(2, '/api/talent/competencies/manager-assessment', { method: 'POST', body: { userId: 3, competencyId: globalThis.competencyId, rating: 2, comment: 'Noch mehr Praxis erforderlich.' } });
  assert.equal(manager.status, 200);
  const updatedSelf = await request(3, '/api/talent/competencies/self-assessment', { method: 'POST', body: { competencyId: globalThis.competencyId, rating: 4, comment: 'Fortschritt erzielt' } });
  assert.equal(updatedSelf.status, 200);
  const records = db.prepare('SELECT assessment_type,rating FROM competency_assessments WHERE user_id=3 ORDER BY assessment_type').all();
  assert.deepEqual(records, [{ assessment_type: 'manager', rating: 2 }, { assessment_type: 'self', rating: 4 }]);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM competency_assessment_history WHERE assessment_type='self'").get().count, 1);
});

test('Direkte Führungskräfte können mehrere Kompetenzbewertungen gesammelt speichern', async () => {
  const first = await request(1, '/api/competencies', { method: 'POST', body: { name: 'Moderation', category: 'social' } });
  const second = await request(1, '/api/competencies', { method: 'POST', body: { name: 'Priorisierung', category: 'methodological' } });
  const saved = await request(2, '/api/talent/competencies/manager-assessments', { method: 'POST', body: { userId: 3, assessments: [
    { competencyId: first.data.id, rating: 3, comment: 'Moderiert Termine strukturiert und adressatengerecht.' },
    { competencyId: second.data.id, rating: 4, comment: 'Setzt in komplexen Vorhaben klare Prioritäten.' }
  ] } });
  assert.equal(saved.status, 200);
  assert.equal(saved.data.ids.length, 2);
  assert.equal(db.prepare("SELECT comment FROM competency_assessments WHERE user_id=3 AND competency_id=? AND assessment_type='manager'").get(first.data.id).comment, 'Moderiert Termine strukturiert und adressatengerecht.');
  const updated = await request(2, '/api/talent/competencies/manager-assessments', { method: 'POST', body: { userId: 3, assessments: [
    { competencyId: first.data.id, rating: 4, comment: 'Hat die Moderation in bereichsübergreifenden Terminen weiter verbessert.' }
  ] } });
  assert.equal(updated.status, 200);
  assert.equal(db.prepare("SELECT rating FROM competency_assessments WHERE user_id=3 AND competency_id=? AND assessment_type='manager'").get(first.data.id).rating, 4);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM competency_assessment_history WHERE competency_id=? AND assessment_type='manager'").get(first.data.id).count, 1);
  const optionalReason = await request(2, '/api/talent/competencies/manager-assessments', { method: 'POST', body: { userId: 3, assessments: [
    { competencyId: second.data.id, rating: 5 }
  ] } });
  assert.equal(optionalReason.status, 200);
  assert.equal(db.prepare("SELECT comment FROM competency_assessments WHERE user_id=3 AND competency_id=? AND assessment_type='manager'").get(second.data.id).comment, '');
  const cleared = await request(2, '/api/talent/competencies/manager-assessments', { method: 'POST', body: { userId: 3, assessments: [
    { competencyId: first.data.id, rating: null }
  ] } });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.data.cleared, 1);
  assert.equal(db.prepare("SELECT active FROM competency_assessments WHERE user_id=3 AND competency_id=? AND assessment_type='manager'").get(first.data.id).active, 0);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM competency_assessment_history WHERE competency_id=? AND assessment_type='manager'").get(first.data.id).count, 2);
  const duplicate = await request(2, '/api/talent/competencies/manager-assessments', { method: 'POST', body: { userId: 3, assessments: [
    { competencyId: second.data.id, rating: 3, comment: 'Begründung eins.' },
    { competencyId: second.data.id, rating: 4, comment: 'Begründung zwei.' }
  ] } });
  assert.equal(duplicate.status, 400);
});

test('Ungültige Bewertungen, inaktive Kompetenzen und fremde Teams werden abgewiesen', async () => {
  const invalidRating = await request(3, '/api/talent/competencies/self-assessment', { method: 'POST', body: { competencyId: globalThis.competencyId, rating: 6 } });
  assert.equal(invalidRating.status, 400);
  const noReason = await request(2, '/api/talent/competencies/manager-assessment', { method: 'POST', body: { userId: 3, competencyId: globalThis.competencyId, rating: 3 } });
  assert.equal(noReason.status, 200);
  const foreign = await request(2, '/api/talent/competencies/manager-assessment', { method: 'POST', body: { userId: 4, competencyId: globalThis.competencyId, rating: 3, comment: 'Unzulässig' } });
  assert.equal(foreign.status, 403);
  const deactivated = await request(1, `/api/competencies/${globalThis.competencyId}/active`, { method: 'PATCH', body: { active: false } });
  assert.equal(deactivated.status, 200);
  const inactive = await request(3, '/api/talent/competencies/self-assessment', { method: 'POST', body: { competencyId: globalThis.competencyId, rating: 3 } });
  assert.equal(inactive.status, 400);
  assert.equal((await request(1, `/api/competencies/${globalThis.competencyId}/active`, { method: 'PATCH', body: { active: true } })).status, 200);
});

test('Positionsanforderungen und Skill-Gap nutzen die Führungskräfteeinschätzung vorrangig', async () => {
  const position = await request(1, '/api/positions', { method: 'POST', body: { title: 'Designer', description: 'Testprofil' } });
  assert.equal(position.status, 200);
  const invalidRequirement = await request(1, `/api/positions/${position.data.id}/requirements`, { method: 'POST', body: { competencyId: globalThis.competencyId, requiredLevel: 6, weight: 1 } });
  assert.equal(invalidRequirement.status, 400);
  const requirement = await request(1, `/api/positions/${position.data.id}/requirements`, { method: 'POST', body: { competencyId: globalThis.competencyId, requiredLevel: 4, weight: 2, mandatory: true } });
  assert.equal(requirement.status, 200);
  assert.equal((await request(1, '/api/positions/assign/3', { method: 'PATCH', body: { positionProfileId: position.data.id, effectiveDate: '2026-01-01' } })).status, 200);
  const gap = globalThis.talentModule.skillGap(3);
  assert.equal(gap.requirements[0].source, 'manager');
  assert.equal(gap.requirements[0].availableLevel, 3);
  assert.equal(gap.requirements[0].gap, 1);
  assert.ok(gap.fit >= 0 && gap.fit <= 100);
});

test('Positionsänderungen speichern offizielle Wirksamkeit und Verlauf', async () => {
  const position = await request(1, '/api/positions', { method: 'POST', body: { title: 'Senior Designer', description: 'Weiterentwicklung der Designrolle' } });
  assert.equal(position.status, 200);
  assert.equal((await request(1, '/api/positions/assign/3', { method: 'PATCH', body: { positionProfileId: position.data.id } })).status, 400);
  const changed = await request(1, '/api/positions/assign/3', { method: 'PATCH', body: { positionProfileId: position.data.id, effectiveDate: '2026-07-01' } });
  assert.equal(changed.status, 200);
  assert.ok(changed.data.historyId);
  const profile = await request(1, '/api/talent/profile/3');
  const latest = profile.data.profile.positionHistory[0];
  assert.equal(latest.position_title, 'Senior Designer');
  assert.equal(latest.previous_position_title, 'Designer');
  assert.equal(latest.effective_date, '2026-07-01');
  assert.equal(latest.changed_by_name, 'HR Admin');
  assert.equal(db.prepare('SELECT position_profile_id FROM users WHERE id=3').get().position_profile_id, position.data.id);
});

test('Entwicklungsziel-Kompetenzen werden persistent verknüpft', async () => {
  const goalId = db.prepare("INSERT INTO goals(user_id,title,created_by,approval_status,goal_type) VALUES(?,?,?,?,?)").run(3, 'Präsentation verbessern', 3, 'pending_manager_approval', 'development').lastInsertRowid;
  const linked = await request(3, `/api/talent/development-goals/${goalId}/competencies`, { method: 'POST', body: { competencyId: globalThis.competencyId } });
  assert.equal(linked.status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM goal_competencies WHERE goal_id=?').get(goalId).count, 1);
});

test('Parameter werden nicht als SQL interpretiert und Audit-Werte werden gespeichert', async () => {
  const injection = await request(1, '/api/talent/overview?search=%27%20OR%201%3D1--');
  assert.equal(injection.status, 200);
  assert.equal(injection.data.rows.length, 0);
  const audit = db.prepare("SELECT old_values,new_values FROM audit_log WHERE action='self_assessment_updated' ORDER BY id DESC LIMIT 1").get();
  assert.match(audit.old_values, /"rating":3/);
  assert.match(audit.new_values, /"rating":4/);
});
