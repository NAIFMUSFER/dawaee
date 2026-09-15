/** Real action handler, listener and Shell; only native/storage/network/React
 * boundaries are controlled. Synthetic data only; not handset delivery proof. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require(process.env.TYPESCRIPT_PATH || 'typescript');
const source = (...parts) => path.join(__dirname, ...parts);
const listenerFile = source('../src/notifications/index.ts');
const actionFile = source('../src/notifications/actions.ts');
const layoutFile = source('../app/_layout.tsx');
const quiet = { log() {}, warn() {}, error() {} };
async function flush() { for (let i = 0; i < 80; i++) await Promise.resolve(); }
function evaluate(file, imports, console = quiet) {
  const exports = {};
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { fileName: file,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, esModuleInterop: true },
  }).outputText;
  vm.runInNewContext(code, { exports, Date, Intl, console, require(id) {
    if (!(id in imports)) throw new Error(`unmocked dependency: ${id}`);
    return imports[id];
  } }, { filename: file });
  return exports;
}
function response(action = 'TAKEN') {
  return { actionIdentifier: action, notification: { request: { content: {
    data: { kind: 'dose_reminder', doseId: 'SYNTHETIC-DOSE' },
  } } } };
}
function listenerHarness(last = response()) {
  const h = { last, posts: [], queued: [], outcomes: [], failures: [], logs: [], cleared: 0, removed: 0, offline: false, storageFailure: false };
  class NetworkError extends Error {}
  const client = { NetworkError, api: { post: async (...args) => {
    h.posts.push(args);
    if (h.offline) throw new NetworkError('SYNTHETIC-NETWORK-DETAIL');
  } }, getDeviceId: async () => {
    if (h.deviceFailure) throw new Error('SYNTHETIC-DEVICE-DETAIL');
    return 'SYNTHETIC-DEVICE';
  } };
  const storage = { newClientEventId: () => 'SYNTHETIC-EVENT', enqueue: async item => {
    if (h.storageFailure) throw new Error('SYNTHETIC-PRIVATE-STORAGE-DETAIL');
    h.queued.push(item);
  } };
  const actions = evaluate(actionFile, { '../api/client.js': client, '../storage/offline-queue.js': storage });
  const native = {
    getLastNotificationResponseAsync: async () => {
      if (h.readFailure) throw new Error('SYNTHETIC-NATIVE-READ-DETAIL');
      return h.last;
    },
    clearLastNotificationResponseAsync: async () => {
      if (h.clearFailure) throw new Error('SYNTHETIC-NATIVE-CLEAR-DETAIL');
      h.cleared++; h.last = null;
    },
    addNotificationResponseReceivedListener: callback => {
      h.emit = callback;
      return { remove() { h.removed++; } };
    },
  };
  h.api = evaluate(listenerFile, {
    'react-native': { Platform: { OS: 'ios' } },
    'expo-constants': { default: {} }, '../api/client.js': client,
    '@dawaee/shared': {}, '../../modules/exact-alarm-access': {},
    './actions.js': actions, 'expo-notifications': native,
  }, Object.fromEntries(['log', 'warn', 'error'].map(k => [k, (...args) => h.logs.push(args)])));
  h.start = (onHandled = outcome => h.outcomes.push(outcome), onFailure = (...args) => h.failures.push(args)) =>
    h.api.startNotificationActionListener(onHandled, onFailure);
  return h;
}
function shellHarness(locale) {
  const h = { listeners: [], alerts: [], effects: [], cleanups: [], calls: [], refs: [], cursor: 0 };
  h.state = { ready: true, signedIn: true, user: { id: 'ACCOUNT-A' }, deviceId: null,
    activeProfile: { id: 'SELF-A' }, profiles: [{ id: 'SELF-A', isSelf: true, role: 'owner' }],
    preferences: { locale, showMedicationInNotifications: false, voiceRemindersEnabled: false },
    syncNow: async () => { h.calls.push('sync'); },
  };
  const React = { createElement: (type, props, ...children) => ({ type, props: { ...props, children: children.length === 1 ? children[0] : children } }),
    useEffect: effect => h.effects.push(effect), useRef: initial => {
      const i = h.cursor++; if (!(i in h.refs)) h.refs[i] = { current: initial }; return h.refs[i];
    },
  };
  const noop = () => undefined;
  const asyncNoop = async () => undefined;
  const imports = {
    react: { __esModule: true, default: React, ...React },
    'expo-router': { Stack: 'Stack', useRouter: () => ({ replace: noop }) },
    'expo-status-bar': { StatusBar: 'StatusBar' },
    'react-native-safe-area-context': { SafeAreaProvider: 'SafeAreaProvider' },
    'react-native': { Platform: { OS: 'ios' }, View: 'View', Alert: { alert: (...args) => h.alerts.push(args) } },
    '@/state/app-store': { AppProvider: 'AppProvider', useApp: () => h.state },
    '@/i18n': { I18nProvider: 'I18nProvider' }, '@/components/ui': { Loading: 'Loading', PreviewBanner: 'PreviewBanner' },
    '@dawaee/shared': { PALETTE: { background: '#fff' } },
    '@/notifications': { configureCategories: asyncNoop, configureChannels: asyncNoop, syncPushRegistration: asyncNoop,
      rebuildRemindersFromCache: async (...args) => { h.calls.push(['rebuild', ...args]); },
      startNotificationActionListener: async (handled, failed) => { h.listeners.push({ handled, failed }); return noop; },
    },
    '@/api/client': { DEMO_MODE: false }, '@/security/AppLockGate': { AppLockGate: 'AppLockGate' },
    '@/navigation/private-navigation': { clearClinicalRouteIntents: noop }, '@/storage/medication-draft': { clearMedicationDrafts: noop },
    '@/notifications/caregiver-navigation': { startCaregiverNotificationListener: () => noop },
    '@/notifications/grouped-navigation': { startGroupedNotificationListener: () => noop },
    '@/notifications/caregiver-intent': { bindCaregiverNotificationAccount: noop, setCaregiverNotificationIntent: noop },
    'expo-notifications': {},
  };
  const mod = evaluate(layoutFile, imports);
  const shell = mod.default().props.children.props.children.type;
  h.render = () => { h.cursor = 0; shell(); };
  h.mount = async () => { h.render(); for (const effect of h.effects.splice(0)) h.cleanups.push(effect()); await flush(); };
  h.unmount = () => { for (const cleanup of h.cleanups) cleanup?.(); };
  return h;
}
function scenarios() {
  const cases = [];
  const add = (name, run) => cases.push({ name, run });
  for (const action of ['TAKEN', 'SNOOZE', 'SKIP']) {
    add(`cold ${action}: failed encrypted persistence preserves response and installs cleanup`, async () => {
      const h = listenerHarness(response(action)); h.offline = true; h.storageFailure = true;
      const stop = await h.start();
      assert.equal(typeof h.emit, 'function'); assert.equal(typeof stop, 'function');
      assert.equal(h.posts.length, 1); assert.equal(h.queued.length, 0); assert.equal(h.outcomes.length, 0);
      assert.deepEqual(h.failures, [[]]); assert.equal(h.cleared, 0); assert.ok(h.last);
      assert.deepEqual(h.logs, []); stop(); assert.equal(h.removed, 1);
    });
  }
  add('live storage rejection is contained and the next valid action still works', async () => {
    const h = listenerHarness(null); const stop = await h.start();
    h.offline = true; h.storageFailure = true; h.last = response('SNOOZE');
    h.emit(h.last); await flush();
    assert.deepEqual(h.failures, [[]]); assert.equal(h.outcomes.length, 0); assert.equal(h.cleared, 0);
    h.offline = false; h.storageFailure = false; h.emit(response('TAKEN')); await flush();
    assert.equal(h.outcomes.length, 1); assert.equal(h.outcomes[0].synced, true); assert.equal(h.cleared, 1);
    assert.deepEqual(h.logs, []); stop(); assert.equal(h.removed, 1);
  });
  add('a failure callback cannot abort listener setup or consume an unsaved response', async () => {
    const h = listenerHarness(); h.offline = true; h.storageFailure = true;
    const stop = await h.start(undefined, () => { throw new Error('SYNTHETIC-UI-FAILURE'); });
    assert.equal(typeof h.emit, 'function'); assert.equal(h.cleared, 0); stop();
  });
  add('device-storage rejection before HTTP has the same honest failure path', async () => {
    const h = listenerHarness(); h.deviceFailure = true;
    const stop = await h.start();
    assert.equal(h.posts.length, 0); assert.equal(h.queued.length, 0);
    assert.equal(h.outcomes.length, 0); assert.deepEqual(h.failures, [[]]); assert.equal(h.cleared, 0); stop();
  });
  for (const offline of [false, true]) {
    add(`positive control: ${offline ? 'durably queued' : 'server accepted'} action is handled and consumed`, async () => {
      const h = listenerHarness(); h.offline = offline;
      const stop = await h.start();
      assert.equal(h.outcomes.length, 1); assert.equal(h.outcomes[0].synced, !offline);
      assert.equal(h.queued.length, offline ? 1 : 0); assert.equal(h.cleared, 1);
      assert.deepEqual(h.failures, []); stop();
    });
  }
  add('unrecognized actions remain ignored without clearing another listener response', async () => {
    const h = listenerHarness(response('DEFAULT')); const stop = await h.start();
    assert.equal(h.posts.length, 0); assert.equal(h.outcomes.length, 0); assert.equal(h.cleared, 0);
    assert.deepEqual(h.failures, []); stop();
  });
  add('native cold-response read failure does not disable future live actions', async () => {
    const h = listenerHarness(null); h.readFailure = true;
    const stop = await h.start(); assert.equal(typeof h.emit, 'function');
    h.emit(response()); await flush(); assert.equal(h.outcomes.length, 1); stop();
  });
  add('a native clear error is not misreported as a persistence error', async () => {
    const h = listenerHarness(); h.clearFailure = true;
    const stop = await h.start();
    assert.equal(h.outcomes.length, 1); assert.deepEqual(h.failures, []);
    assert.equal(typeof h.emit, 'function'); stop();
  });
  add('post-save callback failure cannot abort cleanup registration', async () => {
    const h = listenerHarness();
    const stop = await h.start(() => { throw new Error('SYNTHETIC-REFRESH-FAILURE'); });
    assert.equal(h.posts.length, 1); assert.equal(h.cleared, 1);
    assert.deepEqual(h.failures, []); stop();
  });
  for (const locale of ['ar', 'en']) {
    add(`Shell exposes generic ${locale} feedback without reporting a saved dose`, async () => {
      const h = shellHarness(locale); await h.mount();
      assert.equal(h.listeners.length, 1); assert.equal(typeof h.listeners[0].failed, 'function');
      h.listeners[0].failed();
      assert.equal(h.alerts.length, 1);
      assert.match(h.alerts[0].join(' '), locale === 'ar' ? /تعذر تأكيد|راجع حالة الجرعة/ : /could not be confirmed|review the dose/i);
      assert.doesNotMatch(h.alerts[0].join(' '), /ACCOUNT-A|SELF-A|SYNTHETIC/);
      assert.equal(h.calls.length, 0); h.unmount();
    });
  }
  add('stale failure feedback is fenced before account-change passive cleanup', async () => {
    const h = shellHarness('ar'); await h.mount(); const old = h.listeners[0];
    assert.equal(typeof old.failed, 'function');
    h.state.user = { id: 'ACCOUNT-B' }; h.render(); old.failed();
    assert.equal(h.alerts.length, 0); h.unmount(); old.failed(); assert.equal(h.alerts.length, 0);
  });
  add('queued snooze still rebuilds the owned self schedule before sync', async () => {
    const h = shellHarness('ar'); await h.mount();
    h.listeners[0].handled({ action: 'snoozed', synced: false, doseId: 'SYNTHETIC-DOSE' }); await flush();
    assert.equal(h.calls.length, 2); assert.equal(h.calls[0][0], 'rebuild'); assert.equal(h.calls[0][1], 'SELF-A');
    assert.equal(h.calls[1], 'sync'); h.unmount();
  });
  return cases;
}
module.exports = { scenarios };
if (require.main === module) {
  if (process.argv.length !== 2) { console.error('This runner accepts no file arguments.'); process.exitCode = 64; }
  else {
    const unhandled = [];
    process.on('unhandledRejection', error => unhandled.push(String(error)));
    (async () => {
      let failed = 0;
      const cases = scenarios();
      for (const scenario of cases) {
        try { await scenario.run(); console.log(`PASS ${scenario.name}`); }
        catch (error) { failed++; console.log(`FAIL ${scenario.name}: ${error.message}`); }
      }
      await new Promise(resolve => setImmediate(resolve));
      console.log(JSON.stringify({ total: cases.length, failed, unhandled: unhandled.length }));
      process.exitCode = failed || unhandled.length ? 1 : 0;
    })();
  }
}
