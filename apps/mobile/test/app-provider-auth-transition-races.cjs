/**
 * Executes the complete checked-in AppProvider with controlled auth-transition
 * boundaries. This is a provider-level race harness, not a native handset or
 * real API/RLS test. All identities and responses are synthetic.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require(process.env.TYPESCRIPT_PATH || 'typescript');

const self = (account = 'A') => ({
  id: `SELF-${account}`,
  displayName: `Self ${account}`,
  isSelf: true,
  role: 'owner',
  timezone: 'Asia/Riyadh',
  permissions: null,
});
const me = (account = 'A') => ({
  user: { id: `ACCOUNT-${account}`, displayName: `User ${account}`, phoneE164: null },
  preferences: { locale: 'en', showMedicationInNotifications: false },
});
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function flush() { for (let i = 0; i < 80; i++) await Promise.resolve(); }
async function until(predicate) {
  for (let i = 0; i < 240 && !predicate(); i++) await Promise.resolve();
  assert.ok(predicate(), 'expected controlled auth boundary was not reached');
}
const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));

function makeProvider(file) {
  const h = {
    requests: [], owners: [], purgeCalls: [], keyCalls: [], clearCalls: [], storeCalls: [],
    deviceCalls: 0, cancelCalls: 0,
    device: async () => 'SYNTHETIC-DEVICE',
    mutation: async () => ({}),
    purge: async () => undefined,
    destroyKey: async () => undefined,
    cancel: async () => undefined,
  };
  const slots = [];
  let cursor = 0;
  let currentUser = 'ACCOUNT-A';
  const hooks = {
    createContext: () => ({ Provider: 'Provider' }),
    useContext: () => null,
    useState: initial => {
      const i = cursor++;
      if (!(i in slots)) slots[i] = {
        ...initial,
        ready: true,
        signedIn: true,
        user: me('A').user,
        profiles: [self('A')],
        activeProfile: self('A'),
      };
      return [slots[i], next => { slots[i] = typeof next === 'function' ? next(slots[i]) : next; }];
    },
    useRef: initial => {
      const i = cursor++;
      if (!(i in slots)) slots[i] = { current: initial };
      return slots[i];
    },
    useMemo: (fn, deps) => {
      const i = cursor++;
      if (!slots[i] || !same(slots[i].deps, deps)) slots[i] = { deps, value: fn() };
      return slots[i].value;
    },
    useCallback: (fn, deps) => hooks.useMemo(() => fn, deps),
    // Auth-transition scenarios start from an already mounted provider.
    useEffect: (_effect, _deps) => { cursor++; },
  };

  const request = (method, route, payload) => {
    const entry = { method, route, payload, account: currentUser, done: method !== 'GET' };
    h.requests.push(entry);
    if (method !== 'GET') return h.mutation(entry);
    const gate = deferred();
    Object.assign(entry, gate, { done: false });
    return gate.promise;
  };

  const imports = {
    react: hooks,
    'react/jsx-runtime': {
      jsx: (type, props) => ({ type, props }),
      jsxs: (type, props) => ({ type, props }),
    },
    'expo-localization': { getLocales: () => [{ languageCode: 'en' }] },
    '../api/client.js': {
      api: {
        get: route => request('GET', route),
        patch: (route, payload) => request('PATCH', route, payload),
        delete: route => request('DELETE', route),
        post: (route, payload) => request('POST', route, payload),
      },
      NetworkError: class NetworkError extends Error {},
      isSignedIn: () => currentUser !== null,
      getDeviceId: () => { h.deviceCalls++; return h.device(); },
      loadStoredSession: async () => true,
      setUnauthenticatedHandler: () => {},
      clearSession: async () => { h.clearCalls.push(currentUser); currentUser = null; },
      storeSession: async tokens => { h.storeCalls.push(tokens.accessToken); currentUser = tokens.accessToken; },
    },
    '../api/restored-session-owner.js': { getRestoredSessionUserId: async () => currentUser },
    '../storage/offline-queue.js': {
      setCacheOwner: id => h.owners.push(id),
      purgeLocalCaches: id => { h.purgeCalls.push(id); return h.purge(id); },
      flushQueue: async () => ({ offline: false }),
      queueSize: async () => 0,
    },
    '../storage/cache-key.js': {
      destroyCacheKey: id => { h.keyCalls.push(id); return h.destroyKey(id); },
    },
    '../notifications/index.js': {
      cancelAllLocalNotifications: () => { h.cancelCalls++; return h.cancel(); },
      rebuildRemindersFromCache: async () => undefined,
    },
    '../i18n/index.js': { applyNativeDirection: () => ({ restartRequired: false }) },
  };

  const source = fs.readFileSync(file, 'utf8');
  const result = ts.transpileModule(source, {
    fileName: file,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
    },
  });
  const exports = {};
  vm.runInNewContext(result.outputText, {
    exports, Date, console,
    require: id => {
      if (!(id in imports)) throw new Error(`unmocked provider dependency: ${id}`);
      return imports[id];
    },
  }, { filename: file });

  let value;
  h.render = () => {
    cursor = 0;
    value = exports.AppProvider({ children: null }).props.value;
    return value;
  };
  h.actions = () => value;
  h.state = () => slots[0];
  h.currentUser = () => currentUser;
  h.pending = route => h.requests.filter(r => r.method === 'GET' && r.route === route && !r.done);
  h.reply = (entry, body) => {
    assert.ok(entry, 'expected pending request');
    entry.done = true;
    entry.resolve(body);
  };
  h.render();
  return h;
}

async function completeLogin(h, account = 'B') {
  await until(() => h.pending('/v1/me').length > 0);
  const meReq = h.pending('/v1/me').at(-1);
  h.reply(meReq, me(account));
  await until(() => h.pending('/v1/profiles').length > 0);
  const profilesReq = h.pending('/v1/profiles').at(-1);
  h.reply(profilesReq, { profiles: [self(account)] });
  await flush();
}

async function finishOrderedLogin(h, login, releaseOldTransition) {
  await flush();
  const startedEarly = h.pending('/v1/me').length > 0;
  if (startedEarly) {
    await completeLogin(h, 'B');
    await login;
    h.render();
  }
  releaseOldTransition();
  await flush();
  if (!startedEarly) await completeLogin(h, 'B');
  await login;
  h.render();
}

function assertBIsCurrent(h) {
  assert.equal(h.currentUser(), 'ACCOUNT-B', 'old sign-out cleared the newer stored session');
  assert.equal(h.state().signedIn, true, 'old sign-out replaced the newer signed-in UI state');
  assert.equal(h.state().user?.id, 'ACCOUNT-B', 'old sign-out replaced the newer account state');
  const bMutations = h.requests.filter(r => r.account === 'ACCOUNT-B' && (r.method === 'DELETE' || r.method === 'POST'));
  assert.deepEqual(bMutations.map(r => `${r.method} ${r.route}`), [], 'old sign-out dispatched destructive requests with B credentials');
}

function scenarios(file) {
  const cases = [];
  const add = (name, run) => cases.push({ name, run: () => run(makeProvider(file)) });

  add('a sign-in started during delayed sign-out device lookup must run only after sign-out finishes', async h => {
    const gate = deferred();
    h.device = () => gate.promise;
    const logout = h.actions().signOut();
    await until(() => h.deviceCalls === 1);
    const login = h.actions().signInWithTokens({ accessToken: 'ACCOUNT-B', refreshToken: 'R-B' });
    await finishOrderedLogin(h, login, () => gate.resolve('SYNTHETIC-DEVICE'));
    await logout;
    h.render();
    assertBIsCurrent(h);
  });

  add('a late logout HTTP response cannot clear a newer account', async h => {
    const gate = deferred();
    h.mutation = entry => entry.method === 'POST' && entry.route === '/v1/auth/logout' ? gate.promise : Promise.resolve({});
    const logout = h.actions().signOut();
    await until(() => h.requests.some(r => r.method === 'POST' && r.route === '/v1/auth/logout'));
    const login = h.actions().signInWithTokens({ accessToken: 'ACCOUNT-B', refreshToken: 'R-B' });
    await finishOrderedLogin(h, login, () => gate.resolve({}));
    await logout;
    h.render();
    assertBIsCurrent(h);
  });

  add('a sign-in during old-account cache erasure cannot be signed out by the old cleanup tail', async h => {
    const gate = deferred();
    h.purge = id => id === 'ACCOUNT-A' ? gate.promise : Promise.resolve();
    const logout = h.actions().signOut();
    await until(() => h.purgeCalls.includes('ACCOUNT-A'));
    const login = h.actions().signInWithTokens({ accessToken: 'ACCOUNT-B', refreshToken: 'R-B' });
    await finishOrderedLogin(h, login, () => gate.resolve());
    await logout;
    h.render();
    assertBIsCurrent(h);
    assert.equal(h.owners.at(-1), 'ACCOUNT-B', 'old cleanup detached the new account cache owner');
  });

  return cases;
}

module.exports = { scenarios };

if (require.main === module) (async () => {
  let failed = 0;
  for (const scenario of scenarios(process.argv[2])) {
    try {
      await scenario.run();
      console.log(`PASS ${scenario.name}`);
    } catch (error) {
      failed++;
      console.error(`FAIL ${scenario.name}`);
      console.error(error && error.stack || error);
    }
  }
  if (failed) process.exitCode = 1;
})();
