import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import type { AppState, Preferences } from '../src/state/app-store.js';
import type { ProfileSummary } from '../src/api/types.js';

type Failure = { at: string; status: number | 'network' | 'malformed' };
const ACCOUNT = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const SELF: ProfileSummary = {
  id: '11111111-1111-4111-8111-111111111111', displayName: 'Synthetic patient',
  isSelf: true, timezone: 'Asia/Riyadh', homeTimezone: 'Asia/Riyadh',
  travelPolicy: 'follow_local_time', birthYear: 1950, avatarKey: null,
  role: 'owner', permissions: null,
};
const PREFERENCES: Preferences = {
  locale: 'ar', numeralSystem: 'latn', calendarSystem: 'gregory',
  elderlyMode: false, textScale: 1, highContrast: false,
  voiceRemindersEnabled: false, voiceConfirmationEnabled: false,
  showMedicationInNotifications: false, appLockEnabled: true,
  appLockAreas: ['reports'], quietHoursStart: null, quietHoursEnd: null,
  defaultSnoozeMinutes: 10, lowStockThresholdDays: 7, expiryWarningDays: 30,
};
const USER = { id: ACCOUNT, displayName: 'Synthetic account', phoneE164: null };

function loadModule(file: string, mocks: Record<string, unknown>, globals: Record<string, unknown> = {}) {
  const module = { exports: {} };
  const source = ts.transpileModule(readFileSync(file, 'utf8'), {
    fileName: file,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true,
    },
  }).outputText;
  vm.runInNewContext(source, {
    module, exports: module.exports, console, URL, Response, AbortController,
    setTimeout, clearTimeout,
    process: { env: { EXPO_PUBLIC_API_URL: 'https://qa.invalid', EXPO_PUBLIC_DEMO: '0' } },
    require: (name: string) => {
      if (!(name in mocks)) throw new Error(`Unexpected test dependency: ${name}`);
      return mocks[name];
    },
    ...globals,
  }, { filename: file });
  return module.exports;
}

/**
 * Execute the complete, unmodified AppProvider AND API client. Only React host
 * hooks, HTTP, keychain/cache and native APIs are synthetic. This is not a React
 * renderer, live backend, encryption test or physical-device lifecycle test.
 */
async function boot(failure?: Failure, hasStoredSession = true) {
  let tokens: { accessToken: string; refreshToken: string } | null = hasStoredSession
    ? { accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh' } : null;
  let tokenClears = 0;
  let snapshotReads = 0;
  let snapshotWrites = 0;
  let cancellations = 0;
  let cacheOwner: string | null = null;
  const purged: Array<string | null> = [];
  const destroyed: string[] = [];
  const requested: string[] = [];
  const client = loadModule(fileURLToPath(new URL('../src/api/client.ts', import.meta.url)), {
    '@react-native-async-storage/async-storage': {
      getItem: async () => 'synthetic-device', setItem: async () => undefined,
    },
    'expo-constants': {},
    './token-store.js': {
      readSession: async () => tokens,
      writeSession: async (next: NonNullable<typeof tokens>) => { tokens = next; },
      clearStoredSession: async () => { tokenClears++; tokens = null; },
    },
  }, {
    fetch: async (url: string) => {
      const path = new URL(url).pathname;
      requested.push(path);
      if (failure?.at === '/v1/auth/refresh' && path === '/v1/me') {
        return new Response(JSON.stringify({ error: { code: 'token_expired' } }), { status: 401 });
      }
      if (failure?.at === path) {
        if (failure.status === 'network') throw new TypeError('Synthetic transport failure');
        if (failure.status === 'malformed') return new Response('{}', { status: 200 });
        return new Response(JSON.stringify({
          error: { code: failure.status === 401 ? 'unauthenticated' : 'internal_error', message: 'Synthetic HTTP failure' },
        }), { status: failure.status });
      }
      if (path === '/v1/me') return new Response(JSON.stringify({ user: USER, preferences: PREFERENCES }));
      if (path === '/v1/profiles') return new Response(JSON.stringify({ profiles: [SELF] }));
      throw new Error(`Unexpected HTTP request: ${path}`);
    },
  }) as typeof import('../src/api/client.js');

  let state!: AppState;
  const effects: Array<() => unknown> = [];
  const cleanups: Array<() => void> = [];
  const react = {
    createContext: () => ({ Provider: 'provider' }),
    useState: (initial: AppState) => {
      state = initial;
      return [state, (update: AppState | ((previous: AppState) => AppState)) => {
        state = typeof update === 'function' ? update(state) : update;
      }];
    },
    useRef: (current: unknown) => ({ current }),
    useEffect: (effect: () => unknown) => { effects.push(effect); },
    useCallback: (callback: unknown) => callback,
    useMemo: (factory: () => unknown) => factory(),
    useContext: () => { throw new Error('No consumer is mounted in this harness'); },
  };
  const provider = loadModule(fileURLToPath(new URL('../src/state/app-store.tsx', import.meta.url)), {
    react,
    'react/jsx-runtime': { jsx: (_type: unknown, props: unknown) => props },
    'expo-localization': { getLocales: () => [{ languageCode: 'ar' }] },
    '../api/client.js': client,
    '../api/restored-session-owner.js': { getRestoredSessionUserId: async () => hasStoredSession ? ACCOUNT : null },
    '../storage/offline-queue.js': {
      flushQueue: async () => ({ offline: false }),
      purgeLocalCaches: async (owner: string | null) => { purged.push(owner); },
      queueSize: async () => 2,
      setCacheOwner: (owner: string | null) => { cacheOwner = owner; },
      readOfflineBootstrap: async () => {
        snapshotReads++;
        return { version: 1, user: USER, preferences: PREFERENCES, selfProfile: SELF };
      },
      writeOfflineBootstrap: async () => { snapshotWrites++; return true; },
    },
    '../i18n/index.js': { applyNativeDirection: () => ({ restartRequired: false }) },
    '../notifications/index.js': {
      cancelAllLocalNotifications: async () => { cancellations++; },
      rebuildRemindersFromCache: async () => undefined,
    },
    '../storage/cache-key.js': { destroyCacheKey: async (owner: string) => { destroyed.push(owner); } },
  }) as typeof import('../src/state/app-store.js');
  provider.AppProvider({ children: null });
  for (const effect of effects) {
    const cleanup = effect();
    if (typeof cleanup === 'function') cleanups.push(cleanup as () => void);
  }
  try {
    for (let attempt = 0; attempt < 100 && !state.ready; attempt++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    if (!state.ready) throw new Error('Bootstrap did not settle');
    await new Promise<void>((resolve) => setImmediate(resolve));
    return {
      state, snapshotReads, snapshotWrites, cacheOwner, requested,
      sessionRetained: client.isSignedIn(), tokenClears, cancellations, purged, destroyed,
    };
  } finally {
    for (const cleanup of cleanups) cleanup();
  }
}

describe('cold-start errors cannot silently become cached authorization', () => {
  const denials: Failure[] = [
    { at: '/v1/me', status: 403 },
    { at: '/v1/me', status: 429 },
    { at: '/v1/me', status: 500 },
    { at: '/v1/me', status: 503 },
    { at: '/v1/profiles', status: 403 },
    { at: '/v1/profiles', status: 503 },
    { at: '/v1/auth/refresh', status: 503 },
    { at: '/v1/me', status: 'malformed' },
  ];
  it.each(denials)('does not restore PHI after $at returns $status', async (failure) => {
    const result = await boot(failure);
    expect(result.requested).toContain(failure.at);
    expect(result.snapshotReads).toBe(0);
    expect(result.state.offline).toBe(false);
    expect(result.state.signedIn).toBe(false);
    expect(result.state.user).toBeNull();
    expect(result.state.profiles).toEqual([]);
    expect(result.state.activeProfile).toBeNull();
    // A service error is not logout either. Preserve credentials and queued
    // actions so retry/re-authentication can recover without destructive loss.
    expect(result.sessionRetained).toBe(true);
    expect(result.tokenClears).toBe(0);
    expect(result.purged).toEqual([]);
    expect(result.destroyed).toEqual([]);
  });

  it.each(['/v1/me', '/v1/profiles', '/v1/auth/refresh'])(
    'positive control: genuine transport failure at %s still restores locked offline state',
    async (at) => {
      const result = await boot({ at, status: 'network' });
      expect(result.snapshotReads).toBe(1);
      expect(result.state.signedIn).toBe(true);
      expect(result.state.offline).toBe(true);
      expect(result.state.user?.id).toBe(ACCOUNT);
      expect(result.state.activeProfile?.id).toBe(SELF.id);
      expect(result.state.preferences.appLockEnabled).toBe(true);
      expect(result.state.preferences.showMedicationInNotifications).toBe(false);
      expect(result.state.credentialVerifiedAt).toBeNull();
      expect(result.state.pendingSyncCount).toBe(2);
      expect(result.sessionRetained).toBe(true);
      expect(result.tokenClears).toBe(0);
    },
  );

  it('positive control: a successful online bootstrap persists, not restores, its snapshot', async () => {
    const result = await boot();
    expect(result.state.signedIn).toBe(true);
    expect(result.state.offline).toBe(false);
    expect(result.state.user?.id).toBe(ACCOUNT);
    expect(result.snapshotReads).toBe(0);
    expect(result.snapshotWrites).toBe(1);
  });

  it('positive control: a device without credentials never reads an account snapshot', async () => {
    const result = await boot(undefined, false);
    expect(result.requested).toEqual([]);
    expect(result.snapshotReads).toBe(0);
    expect(result.cacheOwner).toBeNull();
    expect(result.state.signedIn).toBe(false);
  });

  it('explicit cold-start session rejection destroys the restored account cache key', async () => {
    const result = await boot({ at: '/v1/me', status: 401 });
    expect(result.sessionRetained).toBe(false);
    expect(result.tokenClears).toBe(1);
    expect(result.cancellations).toBe(1);
    expect(result.cacheOwner).toBeNull();
    expect(result.snapshotReads).toBe(0);
    expect(result.state.signedIn).toBe(false);
    // The UI has not loaded /v1/me yet, so state.user is still null. Privacy
    // cleanup must use the owner recovered from the stored session rather than
    // passing null and leaving that account's encryption key in secure storage.
    expect(result.purged).toEqual([ACCOUNT]);
    expect(result.destroyed).toEqual([ACCOUNT]);
  });
});
