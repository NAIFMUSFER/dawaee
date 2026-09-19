/** Executes the complete checked-in AppProvider with controlled host hooks and
 * asynchronous API/queue boundaries. State refs change only on render. This is
 * NOT a React renderer, native-device test, real API/RLS test or bootstrap test.
 * All users, permissions and responses are synthetic; no server is contacted.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require(process.env.TYPESCRIPT_PATH || 'typescript');
// Evaluate pure production policy/event modules; only native and storage I/O are stubs.
function pureProviderModules() {
 const modules = {};
 for (const [id, path] of Object.entries({
  '../api/access-changes.js': '../src/api/access-changes.ts',
  '../api/clinical-changes.js': '../src/api/clinical-changes.ts',
  '../security/profile-permissions.js': '../src/security/profile-permissions.ts',
 })) {
  const output = ts.transpileModule(fs.readFileSync(require('node:path').resolve(__dirname, path), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  modules[id] = {}; vm.runInNewContext(output, { exports: modules[id] });
 }
 return modules;
}

const self = (account = 'A') => ({ id: `SELF-${account}`, displayName: `Self ${account}`, isSelf: true, role: 'owner', timezone: 'Asia/Riyadh', permissions: null });
const patient = (permissions = ['view_medications', 'view_schedule', 'confirm_dose']) => ({ id: 'PATIENT', displayName: 'SYNTHETIC-PATIENT', isSelf: false, role: 'caregiver', timezone: 'Asia/Riyadh', permissions });
const me = (account = 'A', preferences = {}) => ({ user: { id: `ACCOUNT-${account}`, displayName: `User ${account}`, phoneE164: null }, preferences: { locale: 'en', showMedicationInNotifications: false, ...preferences } });
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function flush() { for (let i = 0; i < 60; i++) await Promise.resolve(); }
async function until(predicate) {
  for (let i = 0; i < 160 && !predicate(); i++) await Promise.resolve();
  assert.ok(predicate(), 'expected controlled request boundary was not reached');
}
const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
function makeProvider(file) {
  const h = { requests: [], owners: [], directions: [], flushCalls: [], invalidated: [], rebuilds: [], sizeCalls: 0, deviceCalls: 0,
    flushQueue: async () => ({ offline: true }), queueSize: async () => 0, device: async () => 'SYNTHETIC-DEVICE' };
  const slots = [], effects = [], cleanups = [], foreground = new Set(), queueChanges = new Set(); let cursor = 0; let currentUser = 'ACCOUNT-A';
  const hooks = {
    createContext: () => ({ Provider: 'Provider' }), useContext: () => null,
    useState: initial => {
      const i = cursor++;
      if (!(i in slots)) slots[i] = { ...initial, ready: true, signedIn: true, user: me().user, profiles: [self(), patient()], activeProfile: patient(), pendingSyncCount: 2 };
      return [slots[i], next => { slots[i] = typeof next === 'function' ? next(slots[i]) : next; }];
    },
    useRef: initial => { const i = cursor++; if (!(i in slots)) slots[i] = { current: initial }; return slots[i]; },
    useMemo: (fn, deps) => { const i = cursor++; if (!slots[i] || !same(slots[i].deps, deps)) slots[i] = { deps, value: fn() }; return slots[i].value; },
    useCallback: (fn, deps) => hooks.useMemo(() => fn, deps),
    // Most request scenarios do not mount. Event-boundary scenarios explicitly
    // mount all production effects and complete the controlled bootstrap reads.
    useEffect: (effect, deps) => { const i = cursor++; if (!slots[i] || !same(slots[i].deps, deps)) { slots[i] = { deps }; effects.push(effect); } },
  };
  const request = (method, route, payload) => {
    const gate = deferred();
    const entry = { method, route, payload, account: currentUser, done: false, ...gate };
    h.requests.push(entry);
    if (method === 'DELETE' || method === 'POST') { entry.done = true; entry.resolve({}); }
    return entry.promise;
  };
  const imports = {
    ...pureProviderModules(),
    'react-native': { AppState: { currentState: 'active', addEventListener: (_name, listener) => { foreground.add(listener); return { remove() { foreground.delete(listener); } }; } } },
    react: hooks,
    'react/jsx-runtime': { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) },
    'expo-localization': { getLocales: () => [{ languageCode: 'en' }] },
    '../api/client.js': { api: {
      get: r => request('GET', r), patch: (r,p) => request('PATCH', r,p), delete: r => request('DELETE', r), post: (r,p) => request('POST', r,p),
    }, NetworkError: class NetworkError extends Error {}, isSignedIn: () => currentUser !== null,
    getDeviceId: () => { h.deviceCalls++; return h.device(); }, loadStoredSession: async () => true, setUnauthenticatedHandler: () => {},
    clearSession: async () => { currentUser = null; }, storeSession: async tokens => { currentUser = tokens.accessToken; } },
    '../hooks/useSelfReminderRefresh.js': { useSelfReminderRefresh: () => undefined },
    '../api/restored-session-owner.js': { getRestoredSessionUserId: async () => currentUser },
    '../storage/offline-queue.js': {
      subscribeQueueChanges: listener => { queueChanges.add(listener); return () => queueChanges.delete(listener); },
      invalidateCachedProfile: async id => { h.invalidated.push(id); }, restoreCachedProfiles: () => undefined,
      setCacheOwner: id => h.owners.push(id), purgeLocalCaches: async () => {},
      flushQueue: id => { h.flushCalls.push({ id, account: currentUser }); return h.flushQueue(); },
      queueSize: () => { h.sizeCalls++; return h.queueSize(); },
      readOfflineBootstrap: async () => null,
      writeOfflineBootstrap: async () => true,
    },
    '../storage/notification-privacy-intent.js': {
      acknowledgePrivacyHide: async () => undefined,
      cancelPrivacyHidePending: async () => undefined,
      markPrivacyHidePending: async () => 'synthetic-privacy-intent',
      privacyHidePendingCount: async () => 0,
      purgePrivacyHideIntents: async () => undefined,
      readPrivacyHideIntent: async () => ({ kind: 'none' }),
    },
    '../storage/cache-key.js': { destroyCacheKey: async () => {} },
    '../notifications/index.js': { cancelAllLocalNotifications: async () => {}, rebuildRemindersFromCache: async id => { h.rebuilds.push(id); } },
    '../i18n/index.js': { applyNativeDirection: locale => { h.directions.push(locale); return { restartRequired: locale === 'ar' }; } },
  };
  const source = fs.readFileSync(file, 'utf8');
  const result = ts.transpileModule(source, { fileName: file,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  });
  const exports = {};
  vm.runInNewContext(result.outputText, { exports, Date, console, setInterval: () => 1, clearInterval: () => undefined, require: id => {
    if (!(id in imports)) throw new Error(`unmocked provider dependency: ${id}`); return imports[id];
  } }, { filename: file });
  let value;
  h.render = () => { cursor = 0; value = exports.AppProvider({ children: null }).props.value; return value; };
  h.actions = () => value;
  h.state = () => slots[0];
  h.pending = route => h.requests.filter(r => r.method === 'GET' && r.route === route && !r.done);
  h.reply = (entry, body) => { assert.ok(entry, 'expected request'); entry.done = true; entry.resolve(body); };
  h.mount = () => { for (const effect of effects.splice(0)) { const cleanup = effect(); if (cleanup) cleanups.push(cleanup); } };
  h.stop = () => { for (const cleanup of cleanups.splice(0)) cleanup(); };
  h.deny = id => imports['../api/access-changes.js'].notifyAccessDenied(id);
  h.queueChanged = () => { for (const listener of queueChanges) listener(); };
  h.foreground = () => { for (const listener of foreground) listener('active'); };
  h.render();
  return h;
}
async function next(h, route) { await until(() => h.pending(route).length > 0); return h.pending(route).at(-1); }
async function prepareProfiles(h, account = 'A', preferences = {}) {
  const existing = new Set(h.requests);
  h.reply(await next(h, '/v1/me'), me(account, preferences));
  await until(() => h.pending('/v1/profiles').some(r => !existing.has(r)));
  return h.pending('/v1/profiles').find(r => !existing.has(r));
}
async function loginB(h) {
  await h.actions().signOut(); h.render();
  const existing = new Set(h.requests);
  const login = h.actions().signInWithTokens({ accessToken: 'ACCOUNT-B', refreshToken: 'SYNTHETIC-R-B' });
  await until(() => h.pending('/v1/me').some(r => !existing.has(r)));
  h.reply(await prepareProfiles(h, 'B'), { profiles: [self('B')] });
  await login; h.render();
  assert.equal(h.state().user.id, 'ACCOUNT-B');
  assert.equal(h.state().signedIn, true);
}
function scenarios(file) {
  const cases = [];
  const add = (name, run) => cases.push({ name, run: () => run(makeProvider(file)) });
  add('a denied patient scope disappears immediately and repeated refusals cannot recurse into reads', async h => {
    h.mount();
    h.reply(await prepareProfiles(h), { profiles: [self(), patient()] }); await flush(); h.render();
    h.deny('PATIENT');
    assert.equal(h.state().activeProfile.id, 'SELF-A');
    assert.equal(h.state().profiles.some(p => p.id === 'PATIENT'), false);
    assert.deepEqual(h.invalidated, ['PATIENT']);
    await until(() => h.pending('/v1/me').length === 1);
    h.deny('PATIENT'); h.deny('PATIENT'); await flush();
    assert.equal(h.pending('/v1/me').length, 1, 'verification refusal recursively started profile reads');
    h.reply(await prepareProfiles(h), { profiles: [self()] }); await flush();
    assert.equal(h.state().profiles.some(p => p.id === 'PATIENT'), false);
    h.stop();
  });
  add('durable queue changes update pending state and foreground retries while Today is unmounted', async h => {
    h.mount();
    h.reply(await prepareProfiles(h), { profiles: [self(), patient()] }); await flush(); h.render();
    h.queueSize = async () => 1;
    h.queueChanged(); await flush(); h.render();
    assert.equal(h.state().pendingSyncCount, 1);
    assert.deepEqual(h.rebuilds, ['SELF-A']);
    h.flushQueue = async () => ({ attempted: 1, applied: 1, failed: 0, offline: false });
    h.queueSize = async () => 0;
    h.foreground();
    h.reply(await prepareProfiles(h), { profiles: [self(), patient()] }); await flush();
    assert.equal(h.flushCalls.length, 1);
    assert.equal(h.state().pendingSyncCount, 0);
    h.stop();
  });
  add('positive: uncontended refresh preserves selected patient and applies current fields', async h => {
    const work = h.actions().refreshProfiles();
    h.reply(await prepareProfiles(h, 'A', { locale: 'ar' }), { profiles: [self(), { ...patient(), displayName: 'CURRENT' }] });
    await work;
    assert.equal(h.state().activeProfile.id, 'PATIENT'); assert.equal(h.state().activeProfile.displayName, 'CURRENT');
    assert.equal(h.state().preferences.locale, 'ar'); assert.deepEqual(h.owners, ['ACCOUNT-A']);
  });
  add('late old profile list cannot restore a caregiver relationship removed by a newer refresh', async h => {
    const old = h.actions().refreshProfiles(); const oldProfiles = await prepareProfiles(h);
    const current = h.actions().refreshProfiles();
    h.reply(await prepareProfiles(h), { profiles: [self()] }); await current; h.render();
    assert.equal(h.state().profiles.some(p => p.id === 'PATIENT'), false);
    h.reply(oldProfiles, { profiles: [self(), patient()] }); await old;
    assert.equal(h.state().profiles.some(p => p.id === 'PATIENT'), false, 'obsolete relationship was restored');
    assert.deepEqual(h.owners, ['ACCOUNT-A'], 'stale response rebound cache ownership');
  });
  add('late old profile list cannot restore a revoked confirmation permission', async h => {
    const old = h.actions().refreshProfiles(); const oldProfiles = await prepareProfiles(h);
    const current = h.actions().refreshProfiles();
    h.reply(await prepareProfiles(h), { profiles: [self(), patient(['view_medications'])] }); await current; h.render();
    h.reply(oldProfiles, { profiles: [self(), patient()] }); await old;
    assert.equal(h.state().activeProfile.permissions.includes('confirm_dose'), false, 'obsolete confirmation grant was restored');
  });
  add('an older GET snapshot cannot undo newer server privacy and locale preferences', async h => {
    const old = h.actions().refreshProfiles(); const oldProfiles = await prepareProfiles(h, 'A', { locale: 'ar', showMedicationInNotifications: true });
    const current = h.actions().refreshProfiles();
    h.reply(await prepareProfiles(h), { profiles: [self()] }); await current; h.render();
    h.reply(oldProfiles, { profiles: [self()] }); await old;
    assert.equal(h.state().preferences.showMedicationInNotifications, false, 'obsolete disclosure setting was restored');
    assert.equal(h.state().preferences.locale, 'en'); assert.equal(h.directions.at(-1), 'en');
  });
  add('a superseded first-stage GET cannot dispatch its second-stage profiles request', async h => {
    const old = h.actions().refreshProfiles(); const oldMe = await next(h, '/v1/me');
    const current = h.actions().refreshProfiles();
    h.reply(await prepareProfiles(h), { profiles: [self()] }); await current;
    const count = h.requests.length;
    h.reply(oldMe, me('A', { locale: 'ar' })); await flush();
    // Settle the baseline's unwanted follow-up before asserting; the test must
    // fail for the dispatch itself, never because an unresolved promise timed out.
    for (const req of h.pending('/v1/profiles')) h.reply(req, { profiles: [self()] });
    await old; assert.equal(h.requests.length, count, 'obsolete read dispatched another API request');
  });
  add('a previous-account GET cannot start a follow-up under the new account', async h => {
    const old = h.actions().refreshProfiles(); const oldMe = await next(h, '/v1/me');
    await loginB(h); const count = h.requests.length;
    h.reply(oldMe, me()); await flush();
    for (const req of h.pending('/v1/profiles')) h.reply(req, { profiles: [self('B')] });
    await old;
    assert.equal(h.requests.length, count, 'A continuation dispatched /profiles authenticated as B');
    assert.equal(h.state().user.id, 'ACCOUNT-B');
  });
  add('positive: logout still fences an already-dispatched profile response', async h => {
    const old = h.actions().refreshProfiles(); const oldProfiles = await prepareProfiles(h);
    await h.actions().signOut(); h.render(); const owners = h.owners.length;
    h.reply(oldProfiles, { profiles: [self(), patient()] }); await old;
    assert.equal(h.state().signedIn, false); assert.equal(h.state().user, null); assert.equal(h.owners.length, owners);
  });
  add('a late queue flush cannot mark the new account offline', async h => {
    const gate = deferred(); h.flushQueue = () => gate.promise;
    const old = h.actions().syncNow(); await until(() => h.flushCalls.length === 1);
    await loginB(h); const sizeCalls = h.sizeCalls;
    gate.resolve({ offline: true }); await old;
    assert.equal(h.state().offline, false, 'previous-account flush contaminated B offline state');
    assert.equal(h.sizeCalls, sizeCalls, 'obsolete sync read the new account queue');
  });
  add('a late queue-count read cannot replace the new account pending count', async h => {
    const gate = deferred(); h.queueSize = () => gate.promise;
    const old = h.actions().syncNow(); await until(() => h.sizeCalls === 1);
    await loginB(h); const expected = h.state().pendingSyncCount;
    gate.resolve(91); await old;
    assert.equal(h.state().pendingSyncCount, expected, 'previous-account count appeared on B');
    assert.equal(h.state().offline, false);
  });
  add('a stale device lookup cannot flush the next account queue', async h => {
    const gate = deferred(); h.device = () => gate.promise;
    const old = h.actions().syncNow(); await until(() => h.deviceCalls === 1);
    h.device = async () => 'SYNTHETIC-DEVICE';
    await loginB(h); gate.resolve('SYNTHETIC-DEVICE'); await old;
    assert.equal(h.flushCalls.length, 0, 'A sync began flushing B queue');
  });
  add('overlapping same-account sync callers share one flush and its authoritative result', async h => {
    const first = deferred(); let calls = 0;
    h.flushQueue = () => { calls++; return first.promise; };
    h.queueSize = async () => 3;
    const old = h.actions().syncNow(); await until(() => calls === 1);
    const current = h.actions().syncNow(); await flush();
    assert.equal(calls, 1, 'overlapping callers dispatched duplicate sync requests');
    assert.equal(current, old, 'same-account callers must await the same completion');
    first.resolve({ offline: false });
    h.reply(await prepareProfiles(h), { profiles: [self()] }); await Promise.all([current, old]); h.render();
    assert.equal(h.state().offline, false);
    assert.equal(h.state().pendingSyncCount, 3);
  });
  add('positive: current offline sync publishes the actual remaining queue count', async h => {
    h.queueSize = async () => 7;
    await h.actions().syncNow();
    assert.equal(h.state().offline, true); assert.equal(h.state().pendingSyncCount, 7);
    assert.equal(h.requests.length, 0); assert.equal(h.flushCalls.length, 1);
  });
  add('positive: successful current sync still refreshes current account data', async h => {
    h.flushQueue = async () => ({ offline: false }); h.queueSize = async () => 0;
    const work = h.actions().syncNow();
    h.reply(await prepareProfiles(h), { profiles: [self()] }); await work;
    assert.equal(h.state().offline, false); assert.equal(h.state().pendingSyncCount, 0);
    assert.equal(h.state().activeProfile.id, 'SELF-A');
  });
  add('a refused sync remains visible until dismissed and cannot leak into the next account', async h => {
    h.flushQueue = async () => ({ attempted: 1, applied: 0, failed: 1, offline: false });
    const work = h.actions().syncNow();
    h.reply(await prepareProfiles(h), { profiles: [self()] }); await work;
    assert.equal(h.state().syncFailureCount, 1);
    h.actions().dismissSyncFailure();
    assert.equal(h.state().syncFailureCount, 0);
    const retry = h.actions().syncNow();
    h.reply(await prepareProfiles(h), { profiles: [self()] }); await retry;
    assert.equal(h.state().syncFailureCount, 1);
    await h.actions().signOut();
    assert.equal(h.state().syncFailureCount, 0);
  });
  add('a signed-out stale sync callback performs no queue operations', async h => {
    await h.actions().signOut(); h.render(); const count = h.deviceCalls;
    await h.actions().syncNow();
    assert.equal(h.flushCalls.length, 0); assert.equal(h.sizeCalls, 0); assert.equal(h.deviceCalls, count);
    assert.equal(h.state().signedIn, false);
  });
  return cases;
}
module.exports = { scenarios };
if (require.main === module) (async () => {
  let failed = 0;
  for (const scenario of scenarios(process.argv[2])) {
    try {
      let settled = false, failure;
      scenario.run().then(() => { settled = true; }, error => { failure = error; settled = true; });
      for (let i = 0; i < 2400 && !settled; i++) await Promise.resolve();
      assert.ok(settled, 'scenario did not settle; do not count an unresolved promise as success');
      if (failure) throw failure;
      console.log(`PASS ${scenario.name}`);
    }
    catch (error) { failed++; console.log(`FAIL ${scenario.name}\n  ${error.message.slice(0, 300)}`); }
  }
  console.log(JSON.stringify({ total: scenarios(process.argv[2]).length, failed }));
  process.exitCode = failed ? 1 : 0;
})();
