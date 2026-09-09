/**
 * Executes the checked-in TSX screen and request hook with controlled I/O.
 * Only React's hook slots/keyed root lifetime and host elements are simulated;
 * this is a deterministic screen-boundary regression, NOT a native renderer,
 * browser E2E, or proof of OS notification delivery. No runtime source is edited.
 */
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const ts = require(process.env.TYPESCRIPT_PATH || 'typescript');

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
class NetworkError extends Error {}
class ApiError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
const addDays = (date, days) => new Date(Date.parse(`${date}T12:00:00Z`) + days * 86400000).toISOString().slice(0, 10);

function createHarness(file, hookFile, profile = {}) {
  const h = { requests: [], cacheWrites: [], cachedReads: [], queued: [], notifications: [], offlineWrites: [], frames: [], dirty: false, effects: [], tree: null };
  h.app = {
    user: { id: 'synthetic-account', displayName: 'Caregiver' },
    activeProfile: { id: 'A', displayName: 'Patient A', timezone: 'Asia/Riyadh', isSelf: false, permissions: ['view_medications', 'view_adherence', 'confirm_dose'], ...profile },
    preferences: { locale: 'en', voiceRemindersEnabled: false, showMedicationInNotifications: false },
    deviceId: 'synthetic-device', pendingSyncCount: 0, offline: false,
    setOffline: (value) => { h.offlineWrites.push(value); h.app.offline = value; h.dirty = true; },
    syncNow: async () => undefined,
  };
  const i18n = Object.fromEntries(['t', 'formatTime', 'formatDate', 'formatMeasure', 'formatWeekday', 'formatNumber'].map((k) => [k, (value) => String(value)]));
  const theme = { colors: new Proxy({}, { get: () => '#000' }), spacing: new Proxy({}, { get: () => 4 }) };
  let frame;
  const slot = () => { const i = frame.cursor++; return [frame, i]; };
  const memo = (fn, deps) => {
    const [f, i] = slot();
    if (!f.slots[i] || !same(f.slots[i].deps, deps)) f.slots[i] = { deps, value: fn() };
    return f.slots[i].value;
  };
  const effect = (fn, deps) => {
    const [f, i] = slot();
    if (!f.slots[i] || !same(f.slots[i].deps, deps)) {
      const previous = f.slots[i];
      const cell = { deps, cleanup: previous?.cleanup };
      f.slots[i] = cell;
      h.effects.push(() => {
        if (!f.alive || f.slots[i] !== cell) return;
        cell.cleanup?.();
        cell.cleanup = fn();
      });
    }
  };
  const React = {
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    Fragment: 'Fragment',
    useState: (initial) => {
      const [f, i] = slot();
      if (!f.slots[i]) f.slots[i] = { value: typeof initial === 'function' ? initial() : initial };
      const cell = f.slots[i];
      return [cell.value, (next) => {
        if (!f.alive) return;
        const value = typeof next === 'function' ? next(cell.value) : next;
        if (!Object.is(value, cell.value)) { cell.value = value; h.dirty = true; }
      }];
    },
    useRef: (initial) => memo(() => ({ current: initial }), []),
    useMemo: memo,
    useCallback: (fn, deps) => memo(() => fn, deps),
    useEffect: effect,
    useLayoutEffect: effect,
  };
  const request = (method, route, payload) => {
    const gate = deferred();
    h.requests.push({ method, route, payload, ...gate });
    return gate.promise;
  };
  const hosts = new Proxy({}, { get: (_target, key) => key === '__esModule' ? true : String(key) });
  const modules = {
    react: { __esModule: true, default: React, ...React },
    'react-native': hosts,
    'react-native-safe-area-context': hosts,
    'expo-router': { router: { push: () => undefined } },
    '@/components/ui': hosts,
    '@/components/DoseCard': hosts,
    '@/components/ProfileSwitcher': hosts,
    '@/components/Picker': hosts,
    '@/components/SnoozeSheet': hosts,
    '@/i18n': { useI18n: () => i18n },
    '@/hooks/useTheme': { useTheme: () => theme },
    '@/state/app-store': { useApp: () => h.app },
    '@/api/client': { NetworkError, ApiError, api: { get: (route, query) => request('GET', route, query), post: (route, body) => request('POST', route, body) } },
    '@/storage/offline-queue': {
      cacheSchedule: async (value) => { h.cacheWrites.push(value); if (h.cacheWriter) await h.cacheWriter(value); },
      readCachedSchedule: async (id) => { h.cachedReads.push(id); return h.cacheReader ? h.cacheReader(id) : null; },
      readQueue: async () => h.queued,
      enqueue: async (value) => { h.queued.push(value); },
      applyQueuedToCache: (value) => value,
      newClientEventId: () => `event-${h.requests.length}`,
    },
    '@/notifications': {
      inspectCapability: async () => ({ supported: false }),
      rescheduleLocalNotifications: async (doses) => { h.notifications.push(doses); return { exactAlarmsUnavailable: false }; },
    },
    '@dawaee/shared': { DOSE_STATUS_COLORS: new Proxy({}, { get: () => ({ fg: '#000', bg: '#fff' }) }), errorMessageKey: (code) => `error.${code}` },
    '@dawaee/core': { addDays, weekdayOf: (date) => new Date(`${date}T12:00:00Z`).getUTCDay(), eachDate: (from, to) => {
      const result = []; for (let d = from; d <= to; d = addDays(d, 1)) result.push(d); return result;
    } },
  };
  const evaluate = (sourceFile) => {
    const code = ts.transpileModule(fs.readFileSync(sourceFile, 'utf8'), {
      fileName: sourceFile,
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, esModuleInterop: true },
    }).outputText;
    const exports = {};
    vm.runInNewContext(code, {
      exports, Date, Intl, console,
      require: (id) => {
        if (id === '@/hooks/useRequestScope') {
          if (!modules[id]) modules[id] = evaluate(hookFile || path.resolve(path.dirname(file), '../../src/hooks/useRequestScope.ts'));
        }
        if (!(id in modules)) throw new Error(`unmocked screen dependency: ${id}`);
        return modules[id];
      },
    }, { filename: sourceFile });
    return exports;
  };
  const Screen = evaluate(file).default;
  const disposeFrom = (depth) => {
    for (const f of h.frames.splice(depth)) {
      f.alive = false;
      for (const cell of f.slots) cell?.cleanup?.();
    }
  };
  h.render = (commitEffects = true) => {
    h.dirty = false;
    let type = Screen, props = {}, depth = 0, tree;
    // Evaluate the route and any keyed screen boundary, not presentation children.
    while (typeof type === 'function') {
      let f = h.frames[depth];
      if (!f || f.type !== type || f.key !== props.key) {
        disposeFrom(depth);
        f = { type, key: props.key, slots: [], cursor: 0, alive: true };
        h.frames[depth] = f;
      }
      frame = f; f.cursor = 0;
      tree = type(props);
      if (tree && typeof tree.type === 'function') { type = tree.type; props = tree.props; depth++; }
      else break;
    }
    h.tree = tree;
    if (commitEffects) { const pending = h.effects.splice(0); for (const run of pending) run(); }
    return tree;
  };
  h.flush = async () => {
    for (let i = 0; i < 40; i++) {
      await Promise.resolve();
      if (h.dirty && !h.disposed) h.render();
      else if (h.effects.length) { const pending = h.effects.splice(0); for (const run of pending) run(); }
    }
  };
  h.switchProfile = (id, commitEffects = true) => {
    h.app.activeProfile = id === null ? null : { ...h.app.activeProfile, id, displayName: `Patient ${id}` };
    h.render(commitEffects);
  };
  h.unmount = () => { h.disposed = true; disposeFrom(0); h.effects = []; h.dirty = false; };
  h.text = () => JSON.stringify(h.tree, (_key, value) => typeof value === 'function' ? value.name : value);
  h.find = (type, predicate = () => true) => {
    const walk = (value) => {
      if (!value || typeof value !== 'object') return null;
      if ((typeof value.type === 'function' ? value.type.name : value.type) === type && predicate(value.props)) return value.props;
      for (const child of Object.values(value)) { const found = walk(child); if (found) return found; }
      return null;
    };
    return walk(h.tree);
  };
  h.batch = () => h.requests.filter((r) => !r.completed);
  h.answer = (batch, label) => {
    const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    for (const r of batch) {
      r.completed = true;
      const dose = { id: `dose-${label}`, medicationId: `med-${label}`, scheduleId: `schedule-${label}`, scheduledAt: `${date}T09:00:00Z`, scheduledLocalDate: date, scheduledLocalTime: '12:00', scheduledTimezone: 'Asia/Riyadh', status: 'due', doseQuantity: 1, doseUnit: 'tablet', medication: { name: `SYNTHETIC-${label}-ONLY`, foodInstruction: 'none' } };
      const medication = { id: dose.medicationId, name: dose.medication.name, form: 'tablet', strengthValue: null, strengthUnit: null, status: r.payload?.status || 'active' };
      r.resolve(r.method === 'POST' ? {} : r.route === '/v1/today'
        ? { profileId: r.payload.profileId, localDate: date, timezone: 'Asia/Riyadh', serverTime: new Date().toISOString(), today: [dose], prefetch: [], next: dose, prefetchDays: 7 }
        : r.route === '/v1/doses' ? { doses: [dose] } : { medications: [medication] });
    }
  };
  h.fail = (batch, error = new NetworkError('controlled offline')) => {
    for (const r of batch) { r.completed = true; r.reject(error); }
  };
  h.render();
  return h;
}
module.exports = { createHarness, deferred, NetworkError, ApiError };
