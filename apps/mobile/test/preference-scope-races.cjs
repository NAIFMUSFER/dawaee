const fs = require('node:fs');
const vm = require('node:vm');
const ts = require(process.env.TYPESCRIPT_PATH || 'typescript');

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// An extracted async callback runs in another VM realm. Awaiting its adopted
// promise can require more than one microtask turn; do not mistake that host
// scheduling detail for a missing product request. Bounded and timer-free.
async function waitForRequest(h, method, route) {
  for (let turn = 0; turn < 20; turn++) {
    const request = h.pending(method, route)[0];
    if (request) return request;
    await Promise.resolve();
  }
  throw new Error(`request not issued: ${method} ${route}`);
}

class NetworkError extends Error {}

const DEFAULT_PREFERENCES = {
  locale: 'en', numeralSystem: 'latn', calendarSystem: 'gregory', elderlyMode: false,
  textScale: 1, highContrast: false, voiceRemindersEnabled: false,
  voiceConfirmationEnabled: false, showMedicationInNotifications: false,
  appLockEnabled: false, appLockAreas: [], quietHoursStart: null, quietHoursEnd: null,
  defaultSnoozeMinutes: 10, lowStockThresholdDays: 7, expiryWarningDays: 30,
};

function extractFunctions(file) {
  const sourceText = fs.readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, sourceText, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  let updatePreferences = null;
  let loadMe = null;
  function visit(node) {
    if (ts.isPropertyAssignment(node) && node.name.getText(sf) === 'updatePreferences') {
      updatePreferences = node.initializer.getText(sf);
    }
    if (ts.isVariableDeclaration(node) && node.name.getText(sf) === 'loadMe' && ts.isCallExpression(node.initializer)) {
      loadMe = node.initializer.arguments[0]?.getText(sf) || null;
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  if (!updatePreferences || !loadMe) throw new Error('could not extract app-store callbacks');
  return { updatePreferences, loadMe };
}

function makeHarness(file, options = {}) {
  const extracted = extractFunctions(file);
  let state = {
    ready: true, signedIn: true,
    user: { id: 'ACCOUNT-A', displayName: 'A', phoneE164: null },
    preferences: { ...DEFAULT_PREFERENCES, ...(options.preferences || {}) },
    profiles: options.profiles || [
      { id: 'SELF', displayName: 'Self', isSelf: true, role: 'owner', permissions: null },
    ],
    activeProfile: options.activeProfile || { id: 'SELF', displayName: 'Self', isSelf: true, role: 'owner', permissions: null },
    offline: false, restartRequiredForRtl: false,
  };
  const stateRef = { current: state };
  const mounted = { current: true };
  const sessionGeneration = { current: 7 };
  // Supplied even on the red baseline so the same harness executes the fix.
  const preferenceGeneration = { current: 0 };
  const preferenceWrites = { current: { session: -1, pending: 0, tail: Promise.resolve() } };
  let signedIn = true;
  const requests = [];
  const rebuilds = [];
  const cacheOwners = [];
  const bootstrapWrites = [];
  const nativeDirections = [];

  const request = (method, route, payload) => {
    const gate = deferred();
    requests.push({ method, route, payload, completed: false, ...gate });
    return gate.promise;
  };
  const api = {
    get: (route) => request('GET', route),
    patch: (route, payload) => request('PATCH', route, payload),
  };
  const setState = (updater) => {
    state = typeof updater === 'function' ? updater(state) : updater;
    stateRef.current = state;
  };

  // Mirror the provider's serialized per-session preference lane. These tests
  // extract callbacks from app-store.tsx rather than executing their enclosing
  // hook declarations, so every referenced closure dependency must be supplied
  // explicitly by the harness.
  const enqueuePreferenceServerWork = async (generation, operation) => {
    if (preferenceWrites.current.session !== generation) {
      preferenceWrites.current = { session: generation, pending: 0, tail: Promise.resolve() };
    }
    const writes = preferenceWrites.current;
    const idle = writes.pending === 0;
    writes.pending++;
    const run = async () => {
      try { return await operation(); }
      finally { writes.pending--; }
    };
    const work = idle ? run() : writes.tail.then(run, run);
    writes.tail = work.then(() => undefined, () => undefined);
    return work;
  };

  const context = {
    api, stateRef, mounted, sessionGeneration, preferenceGeneration, preferenceWrites,
    profileLoadGeneration: { current: 0 },
    signOutInFlight: { current: null },
    setState, DEFAULT_PREFERENCES, NetworkError,
    enqueuePreferenceServerWork,
    readPrivacyHideIntent: async () => ({ kind: 'none' }),
    markPrivacyHidePending: async () => 'synthetic-privacy-intent',
    cancelPrivacyHidePending: async () => undefined,
    acknowledgePrivacyHide: async () => undefined,
    isSignedIn: () => signedIn,
    setCacheOwner: (id) => cacheOwners.push(id),
    applyNativeDirection: (locale) => {
      nativeDirections.push(locale);
      return { restartRequired: false };
    },
    rebuildRemindersFromCache: async (profileId, locale, opts) => {
      rebuilds.push({ profileId, locale, opts });
      return { scheduled: profileId ? 1 : 0, failed: 0, exactAlarmsUnavailable: false };
    },
    // The extracted callbacks now persist the encrypted offline bootstrap after
    // successful online state changes. These race tests are intentionally about
    // request/session ordering rather than storage; provide a controlled async
    // boundary so the real callback can complete without turning persistence
    // into an undeclared ReferenceError. Dedicated offline-bootstrap tests cover
    // encryption, account binding and fail-closed behavior.
    persistOfflineBootstrap: async (user, preferences, selfProfile) => {
      const snapshot = { user, preferences, selfProfile };
      bootstrapWrites.push(snapshot);
      await options.onBootstrapWrite?.(snapshot, bootstrapWrites.length);
    },
    console,
  };
  const evaluate = (text) => {
    const compiled = ts.transpileModule(
      `globalThis.__candidate = (${text});`,
      {
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.None,
          jsx: ts.JsxEmit.ReactJSX,
        },
      },
    ).outputText;
    vm.runInNewContext(compiled, context, { filename: file });
    const candidate = context.__candidate;
    delete context.__candidate;
    return candidate;
  };
  const updatePreferences = evaluate(extracted.updatePreferences);
  const loadMe = evaluate(extracted.loadMe);

  return {
    updatePreferences, loadMe, requests, rebuilds, cacheOwners, bootstrapWrites, nativeDirections,
    state: () => state,
    sessionGeneration, preferenceGeneration,
    setSignedIn: (value) => { signedIn = value; },
    replaceState: (next) => { state = { ...state, ...next }; stateRef.current = state; },
    pending: (method, route) => requests.filter((r) => !r.completed && (!method || r.method === method) && (!route || r.route === route)),
    resolve: (req, value) => { req.completed = true; req.resolve(value); },
    reject: (req, error) => { req.completed = true; req.reject(error); },
  };
}

function selfProfile(id = 'SELF') {
  return { id, displayName: id, isSelf: true, role: 'owner', permissions: null };
}
function otherProfile(id = 'PATIENT', role = 'caregiver') {
  return { id, displayName: id, isSelf: false, role, permissions: role === 'caregiver' ? ['view_medications'] : null };
}

function scenarios(file) {
  return [
    {
      name: 'notification privacy rebuild targets the caller self profile even while viewing a caregiver patient',
      run: async () => {
        const self = selfProfile(); const other = otherProfile();
        const h = makeHarness(file, { profiles: [other, self], activeProfile: other });
        const p = h.updatePreferences({ showMedicationInNotifications: true });
        const req = h.pending('PATCH')[0];
        h.resolve(req, { preferences: { ...DEFAULT_PREFERENCES, showMedicationInNotifications: true } });
        await p;
        if (h.rebuilds.length !== 1 || h.rebuilds[0].profileId !== 'SELF') {
          throw new Error(`privacy rebuild used ${h.rebuilds[0]?.profileId}; expected caller SELF`);
        }
      },
    },
    {
      name: 'notification privacy rebuild targets caller self while an owned dependent is selected',
      run: async () => {
        const self = selfProfile(); const dependent = otherProfile('DEPENDENT', 'owner');
        const h = makeHarness(file, { profiles: [dependent, self], activeProfile: dependent });
        const p = h.updatePreferences({ voiceRemindersEnabled: true });
        h.resolve(h.pending('PATCH')[0], { preferences: { ...DEFAULT_PREFERENCES, voiceRemindersEnabled: true } });
        await p;
        if (h.rebuilds[0]?.profileId !== 'SELF') throw new Error(`dependent cache selected: ${h.rebuilds[0]?.profileId}`);
      },
    },
    {
      name: 'positive control: notification privacy rebuild still uses an active self profile',
      run: async () => {
        const self = selfProfile();
        const h = makeHarness(file, { profiles: [self], activeProfile: self });
        const p = h.updatePreferences({ showMedicationInNotifications: true });
        h.resolve(h.pending('PATCH')[0], { preferences: { ...DEFAULT_PREFERENCES, showMedicationInNotifications: true } });
        await p;
        if (h.rebuilds[0]?.profileId !== 'SELF') throw new Error('self rebuild was lost');
      },
    },
    {
      name: 'no caller-self profile never turns a selected foreign cache into local reminders',
      run: async () => {
        const other = otherProfile();
        const h = makeHarness(file, { profiles: [other], activeProfile: other });
        const p = h.updatePreferences({ showMedicationInNotifications: true });
        h.resolve(h.pending('PATCH')[0], { preferences: { ...DEFAULT_PREFERENCES, showMedicationInNotifications: true } });
        await p;
        if (h.rebuilds[0]?.profileId !== null) throw new Error(`foreign cache reached rebuild: ${h.rebuilds[0]?.profileId}`);
      },
    },
    {
      name: 'a delayed older locale PATCH response cannot overwrite a newer locale choice',
      run: async () => {
        const h = makeHarness(file, { preferences: { locale: 'en' } });
        const older = h.updatePreferences({ locale: 'ar' });
        const olderReq = h.pending('PATCH')[0];
        const newer = h.updatePreferences({ locale: 'en' });
        const newerReq = h.pending('PATCH').find((r) => r !== olderReq);
        if (newerReq) {
          h.resolve(newerReq, { preferences: { ...DEFAULT_PREFERENCES, locale: 'en' } });
          await newer;
        }
        h.resolve(olderReq, { preferences: { ...DEFAULT_PREFERENCES, locale: 'ar' } });
        await older;
        if (!newerReq) {
          h.resolve(await waitForRequest(h, 'PATCH', '/v1/me/preferences'), {
            preferences: { ...DEFAULT_PREFERENCES, locale: 'en' },
          });
          await newer;
        }
        if (h.state().preferences.locale !== 'en') throw new Error(`stale locale resurrected: ${h.state().preferences.locale}`);
      },
    },
    {
      name: 'a preference response from the previous authenticated session cannot alter the next account',
      run: async () => {
        const h = makeHarness(file, { preferences: { locale: 'en' } });
        const old = h.updatePreferences({ locale: 'ar' });
        const req = h.pending('PATCH')[0];
        h.sessionGeneration.current++;
        h.replaceState({ user: { id: 'ACCOUNT-B', displayName: 'B', phoneE164: null }, preferences: { ...DEFAULT_PREFERENCES, locale: 'en' } });
        h.resolve(req, { preferences: { ...DEFAULT_PREFERENCES, locale: 'ar' } });
        await old;
        if (h.state().preferences.locale !== 'en') throw new Error('old account response changed new account locale');
      },
    },
    {
      name: 'a stale NetworkError from the previous session cannot mark the next account offline',
      run: async () => {
        const h = makeHarness(file);
        const old = h.updatePreferences({ locale: 'ar' });
        const req = h.pending('PATCH')[0];
        h.sessionGeneration.current++;
        h.replaceState({ user: { id: 'ACCOUNT-B', displayName: 'B', phoneE164: null }, offline: false, preferences: { ...DEFAULT_PREFERENCES, locale: 'en' } });
        h.reject(req, new NetworkError('old request lost network'));
        await old;
        if (h.state().offline) throw new Error('old session network error contaminated new account state');
      },
    },
    {
      name: 'loadMe started before a preference change cannot restore its older preferences afterwards',
      run: async () => {
        const h = makeHarness(file, { preferences: { locale: 'en' } });
        const load = h.loadMe();
        const meReq = h.pending('GET', '/v1/me')[0];
        h.resolve(meReq, { user: { id: 'ACCOUNT-A', displayName: 'A', phoneE164: null }, preferences: { ...DEFAULT_PREFERENCES, locale: 'ar' } });
        const profilesReq = await waitForRequest(h, 'GET', '/v1/profiles');

        const update = h.updatePreferences({ locale: 'en' });
        const patchReq = h.pending('PATCH')[0];
        h.resolve(patchReq, { preferences: { ...DEFAULT_PREFERENCES, locale: 'en' } });
        await update;

        h.resolve(profilesReq, { profiles: [selfProfile()] });
        await load;
        if (h.state().preferences.locale !== 'en') throw new Error(`loadMe restored stale locale ${h.state().preferences.locale}`);
      },
    },
    {
      name: 'positive control: loadMe applies server preferences when no newer local preference intent exists',
      run: async () => {
        const h = makeHarness(file, { preferences: { locale: 'en' } });
        const load = h.loadMe();
        h.resolve(h.pending('GET', '/v1/me')[0], { user: { id: 'ACCOUNT-A', displayName: 'A', phoneE164: null }, preferences: { ...DEFAULT_PREFERENCES, locale: 'ar' } });
        h.resolve(await waitForRequest(h, 'GET', '/v1/profiles'), { profiles: [selfProfile()] });
        await load;
        if (h.state().preferences.locale !== 'ar') throw new Error('fresh loadMe preference was incorrectly suppressed');
      },
    },
  ];
}

module.exports = { scenarios, makeHarness, NetworkError };
