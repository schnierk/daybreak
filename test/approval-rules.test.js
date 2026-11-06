const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const { APPROVAL_RULES } = require('../lib/approval-rules');
const { createModuleHarness } = require('../lib/testing/module-harness');
const { createAbsenceModule } = require('../routes/absence');
const { createCompensationModule } = require('../routes/compensation');
const { createPersonnelModule } = require('../routes/personnel');
const { createRecruitingModule } = require('../routes/recruiting');
const { createTimeModule } = require('../routes/time');

const hr = { id: 1 };

test('Jede Regel hat eine gültige Voreinstellung und mindestens zwei Möglichkeiten', () => {
  for (const rule of APPROVAL_RULES) {
    assert.ok(rule.options.length >= 2, rule.key);
    assert.ok(rule.options.some(option => option.value === rule.defaultValue), rule.key);
  }
  assert.equal(new Set(APPROVAL_RULES.map(rule => rule.key)).size, APPROVAL_RULES.length);
});

test('Regeln lassen sich nur mit gültigen Werten setzen, Unbekanntes bleibt beim Standard', async () => {
  const h = await createModuleHarness(createAbsenceModule);
  try {
    assert.equal(h.deps.approvalRule('absence.approval'), 'manager');
    assert.equal(h.deps.setApprovalRule('absence.approval', 'hr', hr), true);
    assert.equal(h.deps.approvalRule('absence.approval'), 'hr');
    assert.equal(h.deps.setApprovalRule('absence.approval', 'quatsch', hr), false);
    assert.equal(h.deps.setApprovalRule('gibt.es.nicht', 'hr', hr), false);
    assert.equal(h.deps.approvalRule('absence.approval'), 'hr');
    assert.throws(() => h.deps.approvalRule('gibt.es.nicht'));
    const audit = h.db.prepare("SELECT old_values,new_values FROM audit_log WHERE action='approval_rule_changed'").all();
    assert.equal(audit.length, 1);
    assert.match(audit[0].new_values, /absence\.approval/);
  } finally {
    await h.close();
  }
});

test('Abwesenheit: Regel bestimmt, wer entscheidet und ob überhaupt', async () => {
  const h = await createModuleHarness(createAbsenceModule);
  try {
    const vacation = h.db.prepare("SELECT id FROM absence_types WHERE code='vacation'").get().id;
    const request = (person, date) => h.api(person, 'POST', '/api/absence/requests', { typeId: vacation, startDate: date, endDate: date });
    const tasksFor = id => h.db.prepare("SELECT user_id FROM tasks WHERE type='absence_approval' AND entity_id=?").all(id).map(row => row.user_id);

    // Standard: direkte Führungskraft
    const standard = await request('anna', '2030-03-04');
    assert.equal(standard.data.status, 'pending');
    assert.deepEqual(tasksFor(standard.data.id), [h.people.manager.id]);
    assert.equal((await h.api('manager', 'POST', `/api/absence/requests/${standard.data.id}/decision`, { decision: 'approve' })).status, 200);

    // Nur HR: Die Führungskraft darf nicht mehr entscheiden und bekommt keine Aufgabe
    h.deps.setApprovalRule('absence.approval', 'hr', hr);
    const hrOnly = await request('anna', '2030-03-05');
    assert.equal(hrOnly.data.status, 'pending');
    assert.equal(tasksFor(hrOnly.data.id).includes(h.people.manager.id), false);
    assert.ok(tasksFor(hrOnly.data.id).includes(h.people.hr.id));
    assert.equal((await h.api('manager', 'POST', `/api/absence/requests/${hrOnly.data.id}/decision`, { decision: 'approve' })).status, 403);
    assert.equal((await h.api('hr', 'POST', `/api/absence/requests/${hrOnly.data.id}/decision`, { decision: 'approve' })).status, 200);

    // Ohne Genehmigung: gilt sofort, keine Aufgabe, das Konto wird trotzdem belastet
    h.deps.setApprovalRule('absence.approval', 'none', hr);
    const direct = await request('anna', '2030-03-06');
    assert.equal(direct.data.status, 'approved');
    assert.deepEqual(tasksFor(direct.data.id), []);
    const over = await h.api('anna', 'POST', '/api/absence/requests', { typeId: vacation, startDate: '2030-04-01', endDate: '2030-09-30' });
    assert.equal(over.status, 400, 'Der Resturlaub gilt auch ohne Genehmigung');
  } finally {
    await h.close();
  }
});

test('Zeiterfassung: Regel bestimmt, wer freigibt und ob überhaupt', async () => {
  const h = await createModuleHarness(createTimeModule);
  try {
    const addAndSubmit = async (person, date) => {
      const entry = await h.api(person, 'POST', '/api/time/entries', { date, startTime: '09:00', endTime: '12:00' });
      assert.equal(entry.status < 300, true, JSON.stringify(entry.data));
      return h.api(person, 'POST', '/api/time/weeks/submit', { week: date });
    };
    const standard = await addAndSubmit('anna', '2026-03-02');
    assert.equal(standard.data.status, 'submitted');
    assert.equal((await h.api('manager', 'POST', `/api/time/weeks/${standard.data.id}/decision`, { decision: 'approve' })).status, 200);

    h.deps.setApprovalRule('time.approval', 'hr', hr);
    const hrOnly = await addAndSubmit('anna', '2026-03-09');
    assert.equal(hrOnly.data.status, 'submitted');
    assert.equal((await h.api('manager', 'POST', `/api/time/weeks/${hrOnly.data.id}/decision`, { decision: 'approve' })).status, 403);
    assert.equal(h.db.prepare("SELECT COUNT(*) count FROM tasks WHERE type='time_week_approval' AND entity_id=? AND user_id=?").get(hrOnly.data.id, h.people.manager.id).count, 0);
    assert.equal((await h.api('hr', 'POST', `/api/time/weeks/${hrOnly.data.id}/decision`, { decision: 'approve' })).status, 200);

    h.deps.setApprovalRule('time.approval', 'none', hr);
    const direct = await addAndSubmit('anna', '2026-03-16');
    assert.equal(direct.data.status, 'approved');
    const stored = h.db.prepare('SELECT status,weekly_minutes,decided_at FROM time_weeks WHERE id=?').get(direct.data.id);
    assert.equal(stored.status, 'approved');
    assert.ok(stored.weekly_minutes > 0);
    assert.ok(stored.decided_at);
    assert.equal(h.db.prepare("SELECT COUNT(*) count FROM tasks WHERE type='time_week_approval' AND entity_id=?").get(direct.data.id).count, 0);
  } finally {
    await h.close();
  }
});

test('Recruiting: Stellen und Angebote folgen der eingestellten Regel', async () => {
  const h = await createModuleHarness(createRecruitingModule);
  try {
    const requisition = async title => (await h.api('manager', 'POST', '/api/recruiting/requisitions', { title })).data.id;
    const standard = await requisition('Mit Freigabe');
    assert.equal((await h.api('manager', 'POST', `/api/recruiting/requisitions/${standard}/submit`, {})).data.status, 'pending_approval');
    assert.equal((await h.api('hr', 'POST', `/api/recruiting/requisitions/${standard}/approve`, {})).status, 200);

    h.deps.setApprovalRule('recruiting.requisition', 'none', hr);
    const direct = await requisition('Ohne Freigabe');
    const submitted = await h.api('manager', 'POST', `/api/recruiting/requisitions/${direct}/submit`, {});
    assert.equal(submitted.data.status, 'open');
    const stored = h.db.prepare('SELECT status,opened_at FROM recruiting_requisitions WHERE id=?').get(direct);
    assert.equal(stored.status, 'open');
    assert.ok(stored.opened_at);
    assert.equal(h.db.prepare("SELECT COUNT(*) count FROM tasks WHERE type='recruiting_approval' AND entity_id=?").get(direct).count, 0);

    const application = async (req, email) => (await h.api('hr', 'POST', `/api/recruiting/requisitions/${req}/applications`, { candidate: { name: 'Test Person', email } })).data.id;
    const offerFor = async applicationId => {
      const created = await h.api('hr', 'POST', `/api/recruiting/applications/${applicationId}/offers`, { startDate: '2030-01-01', positionTitle: 'Test', compensation: 'nach Absprache' });
      assert.equal(created.status < 300, true, JSON.stringify(created.data));
      return created.data.id;
    };

    // Vier Augen: Wer das Angebot erstellt hat, darf es nicht freigeben
    const first = await offerFor(await application(standard, 'eins@firma.example'));
    await h.api('hr', 'POST', `/api/recruiting/offers/${first}/submit`, {});
    assert.equal((await h.api('hr', 'POST', `/api/recruiting/offers/${first}/approve`, {})).status, 403);

    // HR, auch das eigene Angebot
    h.deps.setApprovalRule('recruiting.offer', 'hr', hr);
    assert.equal((await h.api('hr', 'POST', `/api/recruiting/offers/${first}/approve`, {})).status, 200);

    // Ohne Freigabe
    h.deps.setApprovalRule('recruiting.offer', 'none', hr);
    const third = await offerFor(await application(direct, 'drei@firma.example'));
    const result = await h.api('hr', 'POST', `/api/recruiting/offers/${third}/submit`, {});
    assert.equal(result.data.status, 'approved');
    assert.equal(h.db.prepare('SELECT status FROM recruiting_offers WHERE id=?').get(third).status, 'approved');
  } finally {
    await h.close();
  }
});

test('Personalakte: HR ändert eigene Daten nur, wenn die Regel es erlaubt', async () => {
  const h = await createModuleHarness(createPersonnelModule);
  try {
    assert.equal((await h.api('hr', 'PATCH', '/api/personnel/1/master', { personnelNumber: 'HR-1' })).status, 403);
    h.deps.setApprovalRule('personnel.hr_self_edit', 'allowed', hr);
    assert.equal((await h.api('hr', 'PATCH', '/api/personnel/1/master', { personnelNumber: 'HR-1' })).status, 200);
    // Fremde Akten bleiben für Beschäftigte gesperrt, egal wie die Regel steht.
    assert.equal((await h.api('anna', 'PATCH', '/api/personnel/5/master', { personnelNumber: 'A-1' })).status, 403);
  } finally {
    await h.close();
  }
});

test('Vergütung: Eigene Vorschläge genehmigen ist einstellbar und standardmäßig erlaubt', async () => {
  const h = await createModuleHarness(createCompensationModule);
  try {
    h.db.prepare("UPDATE users SET manager_id=1 WHERE id=7").run(); // clara arbeitet direkt für hr
    const grade = (await h.api('hr', 'POST', '/api/compensation/grades', { name: 'B1', min: '30.000,00', mid: '50.000,00', max: '80.000,00', validFrom: '2020-01-01' })).data.grade;
    const record = await h.api('hr', 'POST', '/api/compensation/people/7/records', { annualSalary: '50.000,00', effectiveDate: '2020-01-01', gradeId: grade.id, reason: 'hire' });
    assert.equal(record.status < 300, true, JSON.stringify(record.data));
    const cycle = (await h.api('hr', 'POST', '/api/compensation/cycles', { name: 'Runde', budgetMode: 'percent', budgetPercent: '3', effectiveDate: '2030-01-01' })).data.cycle;
    assert.equal((await h.api('hr', 'POST', `/api/compensation/cycles/${cycle.id}/open`, {})).status, 200);
    const proposal = await h.api('hr', 'PUT', `/api/compensation/team/${cycle.id}/proposals/7`, { mode: 'percent', value: '2' });
    assert.equal(proposal.status < 300, true, JSON.stringify(proposal.data));
    assert.equal((await h.api('hr', 'POST', `/api/compensation/cycles/${cycle.id}/review`, {})).status, 200);

    h.deps.setApprovalRule('compensation.self_approval', 'denied', hr);
    const blocked = await h.api('hr', 'POST', `/api/compensation/cycles/${cycle.id}/decisions/7`, { action: 'approve' });
    assert.equal(blocked.status, 403);
    const bulk = await h.api('hr', 'POST', `/api/compensation/cycles/${cycle.id}/approve-open`, {});
    assert.equal(bulk.data.approved, 0);
    assert.equal(bulk.data.skippedOwn, 1);

    h.deps.setApprovalRule('compensation.self_approval', 'allowed', hr);
    assert.equal((await h.api('hr', 'POST', `/api/compensation/cycles/${cycle.id}/decisions/7`, { action: 'approve' })).status, 200);
  } finally {
    await h.close();
  }
});
