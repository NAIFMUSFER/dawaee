/** Actual scheduling module; only native I/O and unrelated imports are mocked.
 * These controlled native-boundary interleavings are not physical-device E2E. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require(process.env.TYPESCRIPT_PATH || 'typescript');

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function flush() { for (let i = 0; i < 40; i++) await Promise.resolve(); }
async function until(predicate) {
  for (let i = 0; i < 100 && !predicate(); i++) await Promise.resolve();
  assert.ok(predicate(), 'controlled native boundary was not reached');
}
function dose(id, minutes = 30) {
  return { id, medicationId: `med-${id}`, status: 'upcoming', scheduledAt: new Date(Date.now() + minutes * 60000).toISOString(), scheduledLocalTime: '09:00', doseQuantity: 1, doseUnit: 'tablet', medication: { name: `SYNTHETIC-${id}`, foodInstruction: 'none' } };
}
function loadModule(file, platform = 'ios') {
  const state = {
    active: [], scheduledCalls: [], cancellations: 0, schedule: null, cancel: null, readCache: async () => null,
    notificationGranted: true, exactAlarmsAllowed: true, exactAlarmChecks: 0,
    readQueue: async () => [],
    applyQueuedToCache: (cache, queue) => {
      assert.equal(queue.length, 0, 'nonempty queue requires an explicit test overlay');
      return cache;
    },
  };
  const native = {
    SchedulableTriggerInputTypes: { DATE: 'date' },
    IosAuthorizationStatus: { PROVISIONAL: 3 },
    getPermissionsAsync: async () => ({ granted: state.notificationGranted }),
    cancelAllScheduledNotificationsAsync: async () => {
      state.cancellations++;
      if (state.cancel) await state.cancel(state.cancellations);
      state.active = [];
    },
    scheduleNotificationAsync: async (notification) => {
      state.scheduledCalls.push(notification);
      if (state.schedule) await state.schedule(notification);
      state.active.push(notification);
      return `native-${state.scheduledCalls.length}`;
    },
  };
  // Wording is outside this race test. Preserve disclosure choices as visible
  // sentinels; the existing reminder-text/privacy suites test real translations.
  const text = (p) => ({ title: p.showMedication ? 'NAMED' : 'PRIVATE', body: p.showMedication ? p.medicationName || 'NAMED-GROUP' : 'GENERIC', voice: p.showMedication ? 'NAMED-VOICE' : 'PRIVATE-VOICE' });
  const imports = {
    'react-native': { Platform: { OS: platform } },
    'expo-constants': { default: {} },
    // Mock native I/O, not inspectCapability or the scheduler under test.
    // This source of truth is deliberately independent of scheduling failures.
    '../../modules/exact-alarm-access': {
      canScheduleExactAlarms: () => { state.exactAlarmChecks++; return state.exactAlarmsAllowed; },
      withExactAlarmScheduleMutation: (operation) => operation(),
    },
    '../api/client.js': { api: {} },
    '@dawaee/shared': { t: (_locale, key) => key, reminderText: text, groupedReminderText: text },
    './actions.js': { ACTION_SKIP: 'SKIP', ACTION_SNOOZE: 'SNOOZE', ACTION_TAKEN: 'TAKEN', applyNotificationAction: async () => null },
    'expo-notifications': native,
    '../storage/offline-queue.js': {
      readCachedSchedule: (id) => state.readCache(id),
      readQueue: () => state.readQueue(),
      applyQueuedToCache: (cache, queue) => state.applyQueuedToCache(cache, queue),
    },
  };
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    fileName: file, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText;
  const exports = {};
  vm.runInNewContext(code, { exports, Date, console, require: (id) => {
    if (!(id in imports)) throw new Error(`unmocked import ${id}`);
    return imports[id];
  } }, { filename: file });
  return { api: exports, state };
}
function scenarios(file) {
  const cases = [];
  const add = (name, run, platform) => cases.push({ name, run: async () => {
    const h = loadModule(file, platform); await run(h.api, h.state);
  } });
  add('current schedule still creates one future single-dose action', async (api, state) => {
    const result = await api.rescheduleLocalNotifications([dose('A')], 'en');
    assert.equal(result.scheduled, 1); assert.equal(result.failed, 0); assert.equal(state.active.length, 1);
    assert.equal(state.active[0].content.categoryIdentifier, 'MEDICATION_REMINDER');
  });
  add('single-dose notification keeps only the action identifier it actually needs', async (api, state) => {
    await api.rescheduleLocalNotifications([dose('A')], 'en', { showMedication: false });
    assert.equal(state.active.length, 1);
    assert.equal(state.active[0].content.data.doseId, 'A');
    assert.equal(state.active[0].content.data.medicationId, undefined,
      'a stable medication id was persisted in OS notification metadata without being used by notification actions');
  });
  add('duplicates remain deduplicated and grouped reminders have no single-dose action', async (api, state) => {
    const a = dose('A'); const b = { ...dose('B'), scheduledAt: a.scheduledAt };
    await api.rescheduleLocalNotifications([a, a, b], 'en');
    assert.equal(state.active.length, 1); assert.equal(state.active[0].content.data.doseIds.length, 2);
    assert.equal(state.active[0].content.categoryIdentifier, undefined);
  });
  add('terminal and past doses remain excluded', async (api, state) => {
    await api.rescheduleLocalNotifications([{...dose('A'), status:'taken'}, dose('past', -30)], 'en');
    assert.equal(state.active.length, 0);
  });
  add('web remains an honest unsupported no-op', async (api, state) => {
    const result = await api.rescheduleLocalNotifications([dose('A')], 'en'); await api.cancelAllLocalNotifications();
    assert.equal(result.scheduled, 0); assert.equal(state.cancellations, 0);
  }, 'web');
  add('logout cancellation cannot be undone by an already-running native schedule', async (api, state) => {
    const gate = deferred(); state.schedule = () => gate.promise;
    const old = api.rescheduleLocalNotifications([dose('A'), dose('A2', 60)], 'en', { showMedication: true });
    await until(() => state.scheduledCalls.length === 1);
    const cancelled = api.cancelAllLocalNotifications(); await flush(); gate.resolve();
    await Promise.all([old, cancelled]); assert.equal(state.active.length, 0, 'old medication reminders survived cancellation');
  });
  add('new private rebuild wins over an older named rebuild', async (api, state) => {
    const gate = deferred(); state.schedule = (n) => n.content.data.doseId === 'A' ? gate.promise : undefined;
    const old = api.rescheduleLocalNotifications([dose('A'), dose('A2', 60)], 'en', { showMedication: true, voiceEnabled: true });
    await until(() => state.scheduledCalls.length === 1);
    const current = api.rescheduleLocalNotifications([dose('B')], 'en', { showMedication: false });
    await flush(); gate.resolve(); await Promise.all([old, current]);
    assert.equal(state.active.length, 1); assert.equal(state.active[0].content.title, 'PRIVATE');
    assert.equal(state.active[0].content.data.doseId, 'B'); assert.equal(state.active[0].content.subtitle, undefined);
  });
  add('a late cancel phase of the old rebuild cannot recreate reminders after logout', async (api, state) => {
    const gate = deferred(); state.cancel = (count) => count === 1 ? gate.promise : undefined;
    const old = api.rescheduleLocalNotifications([dose('A')], 'en'); await until(() => state.cancellations === 1);
    const cancelled = api.cancelAllLocalNotifications(); await flush(); gate.resolve();
    await Promise.all([old, cancelled]); assert.equal(state.active.length, 0);
  });
  add('two immediate rebuilds cannot leave a mixed A/B schedule', async (api, state) => {
    await Promise.all([api.rescheduleLocalNotifications([dose('A')], 'en'), api.rescheduleLocalNotifications([dose('B')], 'en')]);
    assert.equal(state.active.length, 1); assert.equal(state.active[0].content.data.doseId, 'B');
  });
  add('cancel then a legitimate later schedule keeps the later schedule', async (api, state) => {
    await api.rescheduleLocalNotifications([dose('A')], 'en');
    await Promise.all([api.cancelAllLocalNotifications(), api.rescheduleLocalNotifications([dose('B')], 'en')]);
    assert.equal(state.active.length, 1); assert.equal(state.active[0].content.data.doseId, 'B');
  });
  add('a rejected cancellation does not poison the next native operation', async (api, state) => {
    state.cancel = (count) => { if (count === 1) throw new Error('controlled native cancel failure'); };
    const first = api.cancelAllLocalNotifications().catch((error) => error.message);
    const next = api.rescheduleLocalNotifications([dose('B')], 'en');
    assert.equal(await first, 'controlled native cancel failure'); await next;
    assert.equal(state.active.length, 1); assert.equal(state.active[0].content.data.doseId, 'B');
  });
  add('native scheduling rejection still reports exact-alarm degradation', async (api, state) => {
    state.exactAlarmsAllowed = false; // The OS denies access independently of the scheduling exception.
    state.schedule = () => { throw new Error('exact alarm permission denied'); };
    const result = await api.rescheduleLocalNotifications([dose('A')], 'en');
    assert.equal(result.failed, 1); assert.equal(result.exactAlarmsUnavailable, true);
    assert.equal((await api.inspectCapability()).canScheduleExact, false);
  }, 'android');
  add('fresh Android denial is reported before any scheduling attempt', async (api, state) => {
    state.exactAlarmsAllowed = false;
    const capability = await api.inspectCapability();
    assert.equal(capability.permissionGranted, true);
    assert.equal(capability.canScheduleExact, false);
    assert.equal(state.exactAlarmChecks, 1);
    assert.equal(state.scheduledCalls.length, 0);
  }, 'android');
  add('Android recheck observes grants and revocations in the same process', async (api, state) => {
    for (const allowed of [false, true, false]) {
      state.exactAlarmsAllowed = allowed;
      assert.equal((await api.inspectCapability()).canScheduleExact, allowed);
    }
    assert.equal(state.exactAlarmChecks, 3);
    assert.equal(state.scheduledCalls.length, 0);
  }, 'android');
  add('a successful scheduling call cannot substitute for Android special access', async (api, state) => {
    state.exactAlarmsAllowed = false;
    const result = await api.rescheduleLocalNotifications([dose('A')], 'en');
    assert.equal(result.scheduled, 1);
    assert.equal(result.exactAlarmsUnavailable, true);
    assert.equal((await api.inspectCapability()).canScheduleExact, false);
    assert.equal(state.exactAlarmChecks, 2);
  }, 'android');
  add('a scheduling error cannot permanently override a later Android permission check', async (api, state) => {
    state.schedule = () => { throw new Error('exact alarm permission denied'); };
    const result = await api.rescheduleLocalNotifications([dose('A')], 'en');
    assert.equal(result.failed, 1);
    assert.equal(result.exactAlarmsUnavailable, true);
    state.exactAlarmsAllowed = true;
    assert.equal((await api.inspectCapability()).canScheduleExact, true);
    assert.equal(state.exactAlarmChecks, 2);
  }, 'android');
  add('notification denial cannot be outranked by Android exact-alarm access', async (api, state) => {
    state.notificationGranted = false;
    const capability = await api.inspectCapability();
    assert.equal(capability.permissionGranted, false);
    assert.equal(capability.canScheduleExact, false);
    assert.equal(capability.warningKey, 'notifications.disabledTitle');
    assert.equal(state.exactAlarmChecks, 0);
  }, 'android');
  add('iOS capability never calls the Android-only bridge', async (api, state) => {
    state.exactAlarmsAllowed = false;
    const capability = await api.inspectCapability();
    assert.equal(capability.permissionGranted, true);
    assert.equal(capability.canScheduleExact, true);
    assert.equal(state.exactAlarmChecks, 0);
  }, 'ios');
  return cases;
}
module.exports = { scenarios, loadModule, deferred, until, dose, flush };
if (require.main === module) {
  (async () => {
    let failed = 0;
    for (const c of scenarios(process.argv[2])) {
      try { await c.run(); console.log(`PASS ${c.name}`); }
      catch (error) { failed++; console.log(`FAIL ${c.name}\n  ${error.message}`); }
    }
    console.log(JSON.stringify({ total: scenarios(process.argv[2]).length, failed }));
    process.exitCode = failed ? 1 : 0;
  })();
}
