const assert = require('node:assert/strict');
const path = require('node:path');
const { createHarness, deferred, ApiError } = require('./profile-screen-harness.cjs');

function scenarios(screenDirectory, hookFile) {
  const cases = [];
  const add = (screen, name, run, profile) => cases.push({ name: `${screen}: ${name}`, run: async () => {
    const h = createHarness(path.join(screenDirectory, `${screen}.tsx`), hookFile, profile);
    try { await run(h); } finally { h.unmount(); }
  } });
  for (const screen of ['today', 'medications', 'history']) {
    add(screen, 'positive control: current profile success still renders its data', async (h) => {
      h.answer(h.batch(), 'A'); await h.flush(); assert.match(h.text(), /SYNTHETIC-A-ONLY/); assert.equal(h.app.offline, false);
    });
    add(screen, 'positive control: current network failure is still reported offline', async (h) => {
      h.fail(h.batch()); await h.flush(); assert.equal(h.app.offline, true); assert.equal(h.find('Loading'), null);
    });
    add(screen, 'unchanged identity and reordered permissions retain the current view', async (h) => {
      h.answer(h.batch(), 'A'); await h.flush(); const count = h.requests.length;
      h.app.activeProfile = { ...h.app.activeProfile, permissions: [...h.app.activeProfile.permissions].reverse() };
      h.render(false); assert.match(h.text(), /SYNTHETIC-A-ONLY/);
      // Passive refreshes on object identity are allowed; the key must not remount.
      assert.equal(h.requests.length, count);
    });
    add(screen, 'late A success cannot replace rendered B clinical data', async (h) => {
      const a = h.batch(); h.switchProfile('B'); const b = h.batch().filter((r) => !a.includes(r));
      h.answer(b, 'B'); await h.flush(); assert.match(h.text(), /SYNTHETIC-B-ONLY/);
      h.answer(a, 'A'); await h.flush();
      assert.doesNotMatch(h.text(), /SYNTHETIC-A-ONLY/); assert.match(h.text(), /SYNTHETIC-B-ONLY/);
    });
    add(screen, 'first B render has no A data before passive effects', async (h) => {
      h.answer(h.batch(), 'A'); await h.flush(); assert.match(h.text(), /SYNTHETIC-A-ONLY/);
      h.switchProfile('B', false); assert.doesNotMatch(h.text(), /SYNTHETIC-A-ONLY/);
    });
    add(screen, 'late A network failure cannot mark B offline', async (h) => {
      const a = h.batch(); h.switchProfile('B'); h.answer(h.batch().filter((r) => !a.includes(r)), 'B'); await h.flush();
      h.fail(a); await h.flush(); assert.equal(h.app.offline, false); assert.match(h.text(), /SYNTHETIC-B-ONLY/);
    });
    add(screen, 'A finally cannot end B loading while B is pending', async (h) => {
      const a = h.batch(); h.switchProfile('B'); h.answer(a, 'A'); await h.flush();
      assert.ok(h.find('Loading'), 'B loading indicator was cleared by A'); assert.doesNotMatch(h.text(), /SYNTHETIC-A-ONLY/);
    });
    add(screen, 'newest same-profile refresh wins out-of-order responses', async (h) => {
      h.answer(h.batch(), 'INITIAL'); await h.flush();
      h.find('RefreshControl').onRefresh(); const older = h.batch();
      h.find('RefreshControl').onRefresh(); const newer = h.batch().filter((r) => !older.includes(r));
      assert.ok(older.length && newer.length);
      h.answer(newer, 'NEWER'); await h.flush(); assert.match(h.text(), /SYNTHETIC-NEWER-ONLY/);
      h.answer(older, 'OLDER'); await h.flush();
      assert.doesNotMatch(h.text(), /SYNTHETIC-OLDER-ONLY/); assert.match(h.text(), /SYNTHETIC-NEWER-ONLY/);
    });
    add(screen, 'unmounted request cannot change global offline or cache state', async (h) => {
      const a = h.batch(); h.unmount(); h.answer(a, 'A'); await h.flush();
      assert.equal(h.offlineWrites.length, 0); assert.equal(h.cacheWrites.length, 0);
    });
    add(screen, 'A to B to A does not revive the first A request', async (h) => {
      const a = h.batch(); h.switchProfile('B'); const b = h.batch().filter((r) => !a.includes(r)); h.switchProfile('A');
      const current = h.batch().filter((r) => !a.includes(r) && !b.includes(r));
      h.answer(current, 'CURRENT-A'); await h.flush(); h.answer(a, 'OBSOLETE-A'); h.answer(b, 'B'); await h.flush();
      assert.match(h.text(), /SYNTHETIC-CURRENT-A-ONLY/); assert.doesNotMatch(h.text(), /SYNTHETIC-(OBSOLETE-A|B)-ONLY/);
    });
    add(screen, 'losing the selected profile clears data without an endless spinner', async (h) => {
      h.answer(h.batch(), 'A'); await h.flush(); h.switchProfile(null); await h.flush();
      assert.doesNotMatch(h.text(), /SYNTHETIC-A-ONLY/); assert.equal(h.find('Loading'), null);
    });
    add(screen, 'permission changes clear the old clinical view on the first render', async (h) => {
      h.answer(h.batch(), 'A'); await h.flush();
      h.app.activeProfile = { ...h.app.activeProfile, permissions: [] }; h.render(false);
      assert.doesNotMatch(h.text(), /SYNTHETIC-A-ONLY/);
    });
  }
  add('today', 'late encrypted-cache fallback cannot overwrite B', async (h) => {
    const gate = deferred(); h.cacheReader = () => gate.promise;
    h.fail(h.batch()); await h.flush(); assert.deepEqual(h.cachedReads, ['A']);
    h.switchProfile('B'); h.answer(h.batch(), 'B'); await h.flush();
    gate.resolve({ profileId: 'A', timezone: 'Asia/Riyadh', cachedAt: new Date().toISOString(), doses: [{ id: 'cached-a', medicationName: 'SYNTHETIC-CACHED-A-ONLY', scheduledAt: new Date().toISOString(), scheduledLocalDate: new Intl.DateTimeFormat('en-CA', {timeZone:'Asia/Riyadh',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date()), scheduledLocalTime: '08:00', doseQuantity: 1, doseUnit: 'tablet', status: 'due' }] });
    await h.flush(); assert.doesNotMatch(h.text(), /SYNTHETIC-CACHED-A-ONLY/); assert.match(h.text(), /SYNTHETIC-B-ONLY/);
  });
  add('today', 'switch during cache write cannot start stale self reminders', async (h) => {
    const gate = deferred();
    h.cacheWriter = (value) => value.profileId === 'A' ? gate.promise : Promise.resolve();
    h.answer(h.batch(), 'A'); await h.flush(); assert.equal(h.cacheWrites.length, 1);
    h.app.activeProfile = { ...h.app.activeProfile, isSelf: false }; h.switchProfile('B'); h.answer(h.batch(), 'B'); await h.flush();
    gate.resolve(); await h.flush(); assert.equal(h.notifications.length, 0);
  }, { isSelf: true });
  add('today', 'late dose success preserves B and does not re-fetch A', async (h) => {
    h.answer(h.batch(), 'A'); await h.flush(); h.find('DoseCard', (p) => p.prominent).onTaken();
    const action = h.batch(); assert.equal(action[0].method, 'POST');
    h.switchProfile('B'); h.answer(h.batch().filter((r) => !action.includes(r)), 'B'); await h.flush();
    const count = h.requests.length; h.answer(action, 'A'); await h.flush();
    assert.equal(h.requests.length, count, 'old action re-fetched A after profile switch'); assert.match(h.text(), /SYNTHETIC-B-ONLY/);
  });
  add('today', 'same-account profile switch preserves offline action without mutating B flags', async (h) => {
    h.answer(h.batch(), 'A'); await h.flush(); h.find('DoseCard', (p) => p.prominent).onTaken(); const action = h.batch();
    h.switchProfile('B'); h.answer(h.batch().filter((r) => !action.includes(r)), 'B'); await h.flush();
    h.fail(action); await h.flush(); assert.equal(h.queued.length, 1); assert.equal(h.queued[0].doseOccurrenceId, 'dose-A');
    assert.equal(h.app.offline, false); assert.match(h.text(), /SYNTHETIC-B-ONLY/);
  });
  add('history', 'profile change resets a patient-specific medication filter', async (h) => {
    h.answer(h.batch(), 'A'); await h.flush(); h.find('Chip', (p) => p.label === 'SYNTHETIC-A-ONLY').onPress(); await h.flush();
    const a = h.batch(); h.switchProfile('B'); const b = h.batch().filter((r) => !a.includes(r));
    assert.ok(b.some((r) => r.route === '/v1/doses')); assert.equal(b.find((r) => r.route === '/v1/doses').payload.medicationId, undefined);
  });
  add('history', 'late A API rejection cannot put an error banner on B', async (h) => {
    const a = h.batch(); h.switchProfile('B'); h.answer(h.batch().filter((r) => !a.includes(r)), 'B'); await h.flush();
    h.fail(a, new ApiError('controlled_A_rejection')); await h.flush(); assert.doesNotMatch(h.text(), /controlled_A_rejection/);
  });
  return cases;
}
module.exports = { scenarios };
if (require.main === module) {
  (async () => {
    let failed = 0;
    for (const c of scenarios(process.argv[2], process.argv[3])) {
      try { await c.run(); console.log(`PASS ${c.name}`); }
      catch (error) { failed++; console.log(`FAIL ${c.name}\n  ${error.message.slice(0, 220)}`); }
    }
    console.log(JSON.stringify({ total: scenarios(process.argv[2], process.argv[3]).length, failed }));
    process.exitCode = failed ? 1 : 0;
  })();
}
