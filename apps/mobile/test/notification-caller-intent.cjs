/** Runs the actual Today TSX and notification module together. React/host UI,
 * HTTP, cache and native notification APIs are controlled. Not handset E2E. */
const assert = require('node:assert/strict');
const { createHarness } = require('./profile-screen-harness.cjs');
const { loadModule, deferred, until, dose, flush } = require('./notification-schedule-races.cjs');

function cache(name) {
  const d = dose(name);
  return { profileId: 'A', cachedAt: new Date().toISOString(), timezone: 'Asia/Riyadh',
    doses: [{ ...d, medicationName: name, foodInstruction: 'no_preference' }] };
}
function answer(h, batch, name = 'SYNTHETIC-TODAY') {
  const d = { ...dose(name), scheduledLocalDate: new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Riyadh', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date()), medication: { name, foodInstruction: 'no_preference' } };
  for (const req of batch) {
    req.completed = true;
    req.resolve({ profileId: 'A', localDate: d.scheduledLocalDate, timezone: 'Asia/Riyadh',
      serverTime: new Date().toISOString(), today: [d], prefetch: [], next: d, prefetchDays: 7 });
  }
}
function scenarios(notificationFile, todayFile, hookFile) {
  const cases = [];
  const addNative = (name, run) => cases.push({ name, run: async () => run(loadModule(notificationFile)) });
  const addScreen = (name, run, isSelf = true) => cases.push({ name, run: async () => {
    const n = loadModule(notificationFile);
    const h = createHarness(todayFile, hookFile, { isSelf }, { '@/notifications': n.api });
    // The initial HTTP request starts with default private preferences. Complete
    // it, then start the controlled request with explicit disclosure enabled.
    answer(h, h.batch(), 'INITIAL'); await h.flush();
    h.app.preferences = { ...h.app.preferences, showMedicationInNotifications: true, voiceRemindersEnabled: true };
    h.render();
    h.find('RefreshControl').onRefresh();
    try { await run(h, n); } finally { h.unmount(); }
  } });

  for (const order of ['old-first', 'new-first']) {
    addNative(`two cached rebuilds honor newest privacy intent (${order})`, async ({ api, state }) => {
      const a = deferred(), b = deferred(); let reads = 0;
      state.readCache = () => (++reads === 1 ? a : b).promise;
      const old = api.rebuildRemindersFromCache('A', 'en', { showMedication: true, voiceEnabled: true });
      await until(() => reads === 1);
      const current = api.rebuildRemindersFromCache('A', 'en', { showMedication: false });
      await until(() => reads === 2);
      if (order === 'old-first') { a.resolve(cache('OLD-NAMED')); await old; b.resolve(cache('NEW-PRIVATE')); await current; }
      else { b.resolve(cache('NEW-PRIVATE')); await current; a.resolve(cache('OLD-NAMED')); await old; }
      assert.equal(state.active.length, 1);
      assert.equal(state.active[0].content.data.doseId, 'NEW-PRIVATE');
      assert.equal(state.active[0].content.title, 'PRIVATE');
    });
  }
  addNative('cancellation does not wait for a stalled storage read', async ({ api, state }) => {
    const gate = deferred(); let started = false;
    state.readCache = () => { started = true; return gate.promise; };
    const old = api.rebuildRemindersFromCache('A', 'en', { showMedication: true });
    await until(() => started);
    let done = false;
    const cancel = api.cancelAllLocalNotifications().then(() => { done = true; });
    await until(() => done);
    gate.resolve(cache('OLD')); await Promise.all([old, cancel]);
    assert.equal(state.active.length, 0);
  });
  addNative('current cache remains schedulable after a storage rejection', async ({ api, state }) => {
    state.readCache = async () => { throw new Error('controlled read error'); };
    await assert.rejects(api.rebuildRemindersFromCache('A', 'en', {}), /controlled read error/);
    await api.cancelAllLocalNotifications();
    state.readCache = async () => cache('CURRENT');
    const result = await api.rebuildRemindersFromCache('A', 'en', {});
    assert.equal(result.scheduled, 1); assert.equal(state.active[0].content.title, 'PRIVATE');
  });
  addScreen('current self Today load still schedules with explicit opt-in', async (h, { state }) => {
    answer(h, h.batch()); await h.flush();
    assert.equal(state.active.length, 1); assert.equal(state.active[0].content.title, 'NAMED');
    assert.equal(state.active[0].content.body, 'SYNTHETIC-TODAY');
  });
  for (const waitAt of ['HTTP', 'cache-write']) {
    for (const boundary of ['privacy', 'cancel']) {
      addScreen(`Today waiting on ${waitAt} cannot cross newer ${boundary} intent`, async (h, { api, state }) => {
        const pending = h.batch();
        const gate = deferred();
        if (waitAt === 'cache-write') {
          h.cacheWriter = () => gate.promise;
          answer(h, pending, 'OLD-TODAY'); await h.flush();
        }
        if (boundary === 'privacy') {
          h.app.preferences = { ...h.app.preferences, showMedicationInNotifications: false, voiceRemindersEnabled: false };
          h.render();
          state.readCache = async () => cache('NEW-PRIVATE');
          await api.rebuildRemindersFromCache('A', 'en', { showMedication: false });
        } else {
          await api.cancelAllLocalNotifications();
        }
        if (waitAt === 'cache-write') gate.resolve();
        else answer(h, pending, 'OLD-TODAY');
        await h.flush(); await flush();
        if (boundary === 'privacy') {
          assert.equal(state.active.length, 1);
          assert.equal(state.active[0].content.title, 'PRIVATE');
          assert.equal(state.active[0].content.data.doseId, 'NEW-PRIVATE');
        } else assert.equal(state.active.length, 0);
        // Discard only obsolete reminder work, not legitimate clinical loading.
        assert.match(h.text(), /OLD-TODAY/);
        assert.equal(h.find('Loading'), null);
      });
    }
  }
  addScreen('a legitimate refresh started after cancellation can schedule again', async (h, { api, state }) => {
    const obsolete = h.batch();
    await api.cancelAllLocalNotifications();
    h.find('RefreshControl').onRefresh();
    const current = h.batch().filter(r => !obsolete.includes(r));
    answer(h, current, 'CURRENT-TODAY'); await h.flush();
    answer(h, obsolete, 'OBSOLETE'); await h.flush();
    assert.equal(state.active.length, 1); assert.equal(state.active[0].content.data.doseId, 'CURRENT-TODAY');
  });
  addScreen('caregiver Today viewing still never schedules the other patient locally', async (h, { state }) => {
    answer(h, h.batch()); await h.flush();
    assert.equal(state.active.length, 0); assert.equal(state.scheduledCalls.length, 0);
  }, false);
  return cases;
}
module.exports = { scenarios };
if (require.main === module) {
  (async () => {
    let failed = 0;
    const cases = scenarios(process.argv[2], process.argv[3], process.argv[4]);
    for (const scenario of cases) {
      try { await scenario.run(); console.log(`PASS ${scenario.name}`); }
      catch (error) { failed++; console.log(`FAIL ${scenario.name}: ${error.message}`); }
    }
    console.log(JSON.stringify({ total: cases.length, failed }));
    process.exitCode = failed ? 1 : 0;
  })().catch(error => { console.error(error); process.exitCode = 2; });
}
