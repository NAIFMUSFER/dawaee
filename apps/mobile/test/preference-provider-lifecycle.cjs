/** Whole AppProvider + real reminder scheduler with controlled host hooks/I/O.
 * Hooks deliberately do NOT update stateRef on setState: only render does.
 * This is a deterministic module integration harness, NOT a React renderer,
 * a real PostgreSQL API, or a physical-device test. All clinical data is synthetic.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require(process.env.TYPESCRIPT_PATH || 'typescript');
const { loadModule, deferred, until, flush } = require('./notification-schedule-races.cjs');
class NetworkError extends Error {}
const self = { id: 'SELF-A', isSelf: true, role: 'owner', displayName: 'Self', permissions: null };
const patient = { id: 'PATIENT-B', isSelf: false, role: 'caregiver', displayName: 'Patient', permissions: ['view_medications'] };
const user = (id) => ({ id, displayName: id, phoneE164: null });
const sameDeps = (a, b) => !!a && !!b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));

function makeProvider(file, notificationsFile, options = {}) {
  const native = loadModule(notificationsFile);
  const reads = [];
  native.state.readCache = async (profileId) => {
    reads.push(profileId);
    return { profileId, doses: [{ id: `DOSE-${profileId}`, medicationName: `MED-${profileId}`,
      scheduledAt: new Date(Date.now() + 3600000).toISOString(), scheduledLocalTime: '10:00',
      status: 'upcoming', doseQuantity: 1, doseUnit: 'tablet', foodInstruction: 'no_preference' }] };
  };
  const slots = []; let cursor = 0; const effects = [];
  const seed = { ready: true, signedIn: true, user: user('ACCOUNT-A'), profiles: [patient, self], activeProfile: self, ...options.state };
  const hooks = {
    createContext: () => ({ Provider: 'Provider' }),
    useContext: () => null,
    useState: (initial) => {
      const i = cursor++;
      if (!(i in slots)) slots[i] = { ...initial, ...seed, preferences: { ...initial.preferences, ...options.preferences } };
      return [slots[i], (updater) => { slots[i] = typeof updater === 'function' ? updater(slots[i]) : updater; }];
    },
    useRef: (initial) => { const i = cursor++; if (!(i in slots)) slots[i] = { current: initial }; return slots[i]; },
    useMemo: (fn, deps) => {
      const i = cursor++;
      if (!slots[i] || !sameDeps(slots[i].deps, deps)) slots[i] = { deps, value: fn() };
      return slots[i].value;
    },
    useCallback: (fn, deps) => hooks.useMemo(() => fn, deps),
    useEffect: (effect, deps) => {
      const i = cursor++;
      if (!slots[i] || !sameDeps(slots[i].deps, deps)) { slots[i] = { deps }; effects.push(effect); }
    },
  };
  let signedIn = seed.signedIn; const requests = []; const directions = []; const owners = [];
  const request = (method, route, payload) => {
    const gate = deferred();
    const entry = { method, route, payload, done: false, ...gate }; requests.push(entry);
    // Only the audited preferences/profile responses are stalled. Cleanup
    // endpoints are recorded but return successfully without touching a server.
    if (method === 'DELETE' || method === 'POST') { entry.done = true; entry.resolve({}); }
    return entry.promise;
  };
  const imports = {
    react: hooks,
    'react/jsx-runtime': { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) },
    'expo-localization': { getLocales: () => [{ languageCode: 'en' }] },
    '../api/client.js': { api: {
      get: (r) => request('GET', r), patch: (r, p) => request('PATCH', r, p),
      delete: (r) => request('DELETE', r), post: (r, p) => request('POST', r, p),
    }, NetworkError, isSignedIn: () => signedIn, getDeviceId: async () => 'SYNTHETIC-DEVICE',
    clearSession: async () => { signedIn = false; }, storeSession: async () => { signedIn = true; },
    loadStoredSession: async () => signedIn, setUnauthenticatedHandler: () => {} },
    // The provider now restores the local cache namespace before an offline
    // bootstrap. This harness is not exercising secure-storage/JWT parsing —
    // restored-session-owner.test.ts does that directly — so return the seeded
    // authenticated account and keep these lifecycle scenarios focused.
    '../api/restored-session-owner.js': { getRestoredSessionUserId: async () => seed.user?.id ?? null },
    '../storage/offline-queue.js': { setCacheOwner: (id) => owners.push(id), purgeLocalCaches: async () => {},
      queueSize: async () => 0, flushQueue: async () => ({ offline: false }) },
    '../storage/cache-key.js': { destroyCacheKey: async () => {} },
    '../i18n/index.js': { applyNativeDirection: (locale) => { directions.push(locale); return { restartRequired: locale === 'ar' }; } },
    '../notifications/index.js': native.api,
  };
  const compiled = ts.transpileModule(fs.readFileSync(file, 'utf8'), { fileName: file,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText;
  const exports = {};
  vm.runInNewContext(compiled, { exports, Date, console, require: (id) => {
    if (!(id in imports)) throw new Error(`unmocked import ${id}`); return imports[id];
  } }, { filename: file });
  let value;
  const render = () => { cursor = 0; value = exports.AppProvider({ children: null }).props.value; return value; };
  render();
  return {
    actions: () => value, render, state: () => slots[0], native: native.state, reads, requests, directions, owners,
    pending: (method, route) => requests.filter(r => !r.done && r.method === method && (!route || r.route === route)),
    resolve: (r, body) => { assert.ok(r, 'expected pending request'); r.done = true; r.resolve(body); },
    reject: (r, err) => { assert.ok(r, 'expected pending request'); r.done = true; r.reject(err); },
  };
}
async function nextRequest(h, method, route) {
  await until(() => h.pending(method, route).length > 0);
  return h.pending(method, route)[0];
}
async function finishLoad(h, me, profiles = [self], request) {
  h.resolve(request || await nextRequest(h, 'GET', '/v1/me'), me);
  h.resolve(await nextRequest(h, 'GET', '/v1/profiles'), { profiles });
}
function scenarios(file, notificationsFile) {
  const cases = [];
  const add = (name, run, options) => cases.push({ name, run: async () => run(makeProvider(file, notificationsFile, options)) });
  add('selected caregiver cache never reaches the actual native scheduler from settings', async h => {
    const save = h.actions().updatePreferences({ showMedicationInNotifications: true });
    h.resolve(await nextRequest(h, 'PATCH'), { preferences: { show_medication_in_notifications: true } });
    await save; await flush();
    assert.deepEqual(h.reads, ['SELF-A']);
    assert.equal(h.native.active.length, 1);
    assert.equal(h.native.active[0].content.data.doseId, 'DOSE-SELF-A');
  }, { state: { activeProfile: patient } });
  add('legacy isSelf on a caregiver row cannot outrank the owned self profile', async h => {
    const save = h.actions().updatePreferences({ voiceRemindersEnabled: true });
    h.resolve(await nextRequest(h, 'PATCH'), { preferences: { voice_reminders_enabled: true } });
    await save; await flush();
    assert.deepEqual(h.reads, ['SELF-A']);
  }, { state: { profiles: [{ ...patient, isSelf: true }, self], activeProfile: patient } });
  add('two privacy choices before a render leave only the latest private native reminders', async h => {
    const a = h.actions().updatePreferences({ showMedicationInNotifications: true });
    const b = h.actions().updatePreferences({ showMedicationInNotifications: false });
    await flush();
    assert.equal(h.state().preferences.showMedicationInNotifications, false);
    assert.equal(h.native.active.length, 1);
    assert.equal(h.native.active[0].content.title, 'PRIVATE');
    h.resolve(await nextRequest(h, 'PATCH'), { preferences: { show_medication_in_notifications: true } });
    await a;
    h.resolve(await nextRequest(h, 'PATCH'), { preferences: { show_medication_in_notifications: false } });
    await b;
  });
  add('a response to an unrelated patch cannot replace an optimistic locale with its old row snapshot', async h => {
    const a = h.actions().updatePreferences({ locale: 'ar' }); h.render();
    const b = h.actions().updatePreferences({ highContrast: true });
    const first = await nextRequest(h, 'PATCH');
    h.resolve(first, { preferences: { locale: 'ar', high_contrast: false } }); await a;
    // The unrelated response carries a snapshot, not a new locale intent.
    h.resolve(await nextRequest(h, 'PATCH'), { preferences: { locale: 'en', high_contrast: true } }); await b;
    assert.equal(h.state().preferences.locale, 'ar');
    assert.equal(h.state().preferences.highContrast, true);
  });
  add('server writes for two locale choices are ordered so a late old write cannot become durable', async h => {
    let storedLocale = 'en';
    const a = h.actions().updatePreferences({ locale: 'ar' }); h.render();
    const b = h.actions().updatePreferences({ locale: 'en' });
    const first = await nextRequest(h, 'PATCH');
    const second = h.pending('PATCH').find(r => r !== first);
    const complete = (r) => { storedLocale = r.payload.locale; h.resolve(r, { preferences: { locale: storedLocale } }); };
    if (second) { complete(second); await b; complete(first); await a; }
    else { complete(first); await a; complete(await nextRequest(h, 'PATCH')); await b; }
    assert.equal(storedLocale, 'en', 'the same API row would retain the old user choice');
    assert.equal(h.state().preferences.locale, 'en');
  });
  add('loadMe begun during a pending save cannot apply the pre-save server preferences', async h => {
    const save = h.actions().updatePreferences({ locale: 'ar' }); h.render();
    const load = h.actions().refreshProfiles();
    const meReq = await nextRequest(h, 'GET', '/v1/me');
    h.resolve(await nextRequest(h, 'PATCH'), { preferences: { locale: 'ar' } }); await save; h.render();
    await finishLoad(h, { user: user('ACCOUNT-A'), preferences: { locale: 'en' } }, [self], meReq);
    await load;
    assert.equal(h.state().preferences.locale, 'ar');
    assert.equal(h.directions.at(-1), 'ar');
  });
  add('loadMe before a local choice preserves that choice but still refreshes valid profile data', async h => {
    const load = h.actions().refreshProfiles();
    h.resolve(await nextRequest(h, 'GET', '/v1/me'), { user: user('ACCOUNT-A'), preferences: { locale: 'en' } });
    const profilesReq = await nextRequest(h, 'GET', '/v1/profiles');
    const save = h.actions().updatePreferences({ locale: 'ar' }); h.render();
    h.resolve(await nextRequest(h, 'PATCH'), { preferences: { locale: 'ar' } }); await save; h.render();
    h.resolve(profilesReq, { profiles: [{ ...self, displayName: 'Updated valid profile' }] }); await load;
    assert.equal(h.state().preferences.locale, 'ar');
    assert.equal(h.state().activeProfile.displayName, 'Updated valid profile');
    assert.equal(h.directions.at(-1), 'ar');
  });
  add('logout/login fences old responses and an old save queue cannot block the new account', async h => {
    const old = h.actions().updatePreferences({ locale: 'ar' });
    const oldReq = await nextRequest(h, 'PATCH');
    const queued = h.actions().updatePreferences({ highContrast: true });
    const oldSecond = h.pending('PATCH').find(r => r !== oldReq);
    await h.actions().signOut(); h.render();
    const login = h.actions().signInWithTokens({ accessToken: 'SYNTHETIC-B', refreshToken: 'SYNTHETIC-R-B' });
    const bSelf = { ...self, id: 'SELF-B' };
    await finishLoad(h, { user: user('ACCOUNT-B'), preferences: { locale: 'en', highContrast: false } }, [bSelf]);
    await login; h.render();
    assert.equal(h.state().user.id, 'ACCOUNT-B');
    assert.equal(h.state().preferences.locale, 'en');
    const fresh = h.actions().updatePreferences({ textScale: 1.2 });
    await until(() => h.pending('PATCH').some(r => r.payload.textScale === 1.2));
    h.resolve(h.pending('PATCH').find(r => r.payload.textScale === 1.2), { preferences: { locale: 'en', text_scale: 1.2 } });
    await fresh;
    h.resolve(oldReq, { preferences: { locale: 'ar' } }); await old; await flush();
    if (oldSecond) h.resolve(oldSecond, { preferences: { locale: 'ar', high_contrast: true } });
    await queued;
    assert.equal(h.state().preferences.locale, 'en');
    assert.equal(h.state().preferences.textScale, 1.2);
    assert.equal(h.state().preferences.highContrast, false);
    const lastOldDispatch = h.requests.findIndex(r => r.payload?.highContrast === true);
    const logoutDispatch = h.requests.findIndex(r => r.route === '/v1/auth/logout');
    assert.ok(lastOldDispatch === -1 || lastOldDispatch < logoutDispatch, 'old queued write crossed to the new session');
  });
  add('a real signOut fences the late old network failure', async h => {
    const old = h.actions().updatePreferences({ locale: 'ar' });
    const req = await nextRequest(h, 'PATCH');
    await h.actions().signOut(); h.render();
    h.reject(req, new NetworkError('synthetic previous-session failure')); await old;
    assert.equal(h.state().signedIn, false);
    assert.equal(h.state().offline, false);
  });
  add('a current network failure still marks offline and keeps accessibility immediately usable', async h => {
    const save = h.actions().updatePreferences({ textScale: 1.2 });
    assert.equal(h.state().preferences.textScale, 1.2);
    h.reject(await nextRequest(h, 'PATCH'), new NetworkError('synthetic offline')); await save;
    assert.equal(h.state().offline, true);
    assert.equal(h.state().preferences.textScale, 1.2);
  });
  add('a rejected save never deadlocks the next save', async h => {
    const a = h.actions().updatePreferences({ locale: 'ar' }); h.render();
    const b = h.actions().updatePreferences({ locale: 'en' });
    h.reject(await nextRequest(h, 'PATCH'), new NetworkError('synthetic offline')); await a;
    h.resolve(await nextRequest(h, 'PATCH'), { preferences: { locale: 'en' } }); await b;
    assert.equal(h.state().preferences.locale, 'en');
  });
  add('signed-out language choice makes no authenticated request', async h => {
    await h.actions().updatePreferences({ locale: 'ar' });
    assert.equal(h.state().preferences.locale, 'ar');
    assert.equal(h.requests.length, 0);
  }, { state: { signedIn: false, user: null, profiles: [], activeProfile: null } });
  add('fresh loadMe with no overlapping save applies server preferences normally', async h => {
    const load = h.actions().refreshProfiles();
    await finishLoad(h, { user: user('ACCOUNT-A'), preferences: { locale: 'ar', textScale: 1.3 } }); await load;
    assert.equal(h.state().preferences.locale, 'ar');
    assert.equal(h.state().preferences.textScale, 1.3);
  });
  return cases;
}
module.exports = { makeProvider, scenarios, NetworkError };
