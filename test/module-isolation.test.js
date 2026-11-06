const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createModuleHarness } = require('../lib/testing/module-harness');
const { createTalentReviewModule } = require('../routes/talentReview');

const period = { start_date: '2026-01-01', end_date: '2026-12-31', assessment_date: '2026-11-30' };

async function reviewSupportFor(isModuleEnabled) {
  const harness = await createModuleHarness(deps => createTalentReviewModule(deps), { isModuleEnabled });
  try {
    harness.db.prepare("INSERT INTO checkins(employee_id,manager_id,period,summary,performance,on_track) VALUES(5,4,'2026-06','Gespräch',1,'off_track')").run();
    return harness.instance.reviewSupport(5, period);
  } finally {
    await harness.close();
  }
}

test('Talent Review zeigt Check-ins nur, wenn das Modul eingeschaltet ist', async () => {
  const on = await reviewSupportFor(() => true);
  assert.equal(on.checkins.latestPerformance, 1);
  const off = await reviewSupportFor(key => key !== 'checkins');
  assert.equal(off.checkins.latestPerformance, null);
});
