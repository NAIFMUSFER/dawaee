import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { fileURLToPath, URL } from 'node:url';
import { describe, expect, it } from 'vitest';

class NetworkError extends Error {}

const restoredSelfProfile = {
  id: 'PROFILE-A',
  displayName: 'Patient A',
  isSelf: true,
  timezone: 'Asia/Riyadh',
  homeTimezone: 'Asia/Riyadh',
  travelPolicy: 'follow_local_time',
  birthYear: 1950,
  avatarKey: null,
  role: 'owner',
  permissions: null,
};

const staleCaregiverProfile = {
  id: 'DEPENDENT-OLD',
  displayName: 'Revoked dependent',
  isSelf: false,
  timezone: 'Asia/Riyadh',
  homeTimezone: 'Asia/Riyadh',
  travelPolicy: 'follow_local_time',
  birthYear: 1945,
  avatarKey: null,
  role: 'caregiver',
  permissions: ['medications:read'],
};

function extractBootstrapEffect(file: string): string {
  const sourceText = readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, sourceText, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  let callback: string | null = null;

  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node)
      && node.expression.getText(sf) === 'useEffect'
      && node.arguments[0]
      && node.arguments[0].getText(sf).includes('loadStoredSession')
    ) {
      callback = node.arguments[0].getText(sf);
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  if (!callback) throw new Error('could not find the AppProvider bootstrap effect');
  return callback;
}

async function boot(file: string, hasStoredSession: boolean) {
  let state = {
    ready: false,
    signedIn: false,
    user: null as { id: string; displayName: string; phoneE164: string | null } | null,
    preferences: {
      locale: 'ar',
      appLockEnabled: false,
      appLockAreas: [] as string[],
      showMedicationInNotifications: false,
    },
    profiles: [] as Array<typeof restoredSelfProfile | typeof staleCaregiverProfile>,
    activeProfile: null as typeof restoredSelfProfile | typeof staleCaregiverProfile | null,
    deviceId: '',
    offline: false,
    pendingSyncCount: 0,
    credentialVerifiedAt: null as number | null,
  };
  const stateRef = { current: state };
  const sessionGeneration = { current: 0 };
  const authCleanupInFlight = { current: Promise.resolve() };
  const signOutInFlight = { current: null as Promise<void> | null };
  let cacheOwner: string | null = null;
  let loadMeCalls = 0;

  const setState = (updater: ((s: typeof state) => typeof state) | typeof state) => {
    state = typeof updater === 'function' ? updater(state) : updater;
    stateRef.current = state;
  };

  const context = {
    NetworkError,
    getDeviceId: async () => 'device-a',
    loadStoredSession: async () => hasStoredSession,
    getRestoredSessionUserId: () => hasStoredSession ? 'ACCOUNT-A' : null,
    // A valid encrypted snapshot from the last successful online bootstrap.
    // The red baseline does not consume it, so supplying it cannot change the
    // defect; the bounded fix may use it after the account owner is restored.
    readOfflineBootstrap: async () => hasStoredSession ? {
      user: { id: 'ACCOUNT-A', displayName: 'Account A', phoneE164: null },
      preferences: {
        locale: 'ar',
        appLockEnabled: true,
        appLockAreas: ['reports'],
        showMedicationInNotifications: false,
      },
      selfProfile: restoredSelfProfile,
      // A prior caregiver grant must never be authoritative offline. This is
      // deliberately present in the fixture to prove the runtime restores only
      // the owned self profile, not stale delegated access.
      profiles: [restoredSelfProfile, staleCaregiverProfile],
    } : null,
    setUnauthenticatedHandler: () => undefined,
    stateRef,
    sessionGeneration,
    authCleanupInFlight,
    signOutInFlight,
    setCacheOwner: (userId: string | null) => { cacheOwner = userId; },
    setState,
    cancelAllLocalNotifications: async () => undefined,
    purgeLocalCaches: async () => undefined,
    purgePrivacyHideIntents: async () => undefined,
    destroyCacheKey: async () => undefined,
    loadMe: async () => {
      loadMeCalls++;
      throw new NetworkError('airplane mode');
    },
    isSignedIn: () => hasStoredSession,
    queueSize: async () => 0,
    privacyHidePendingCount: async () => 0,
    enqueuePreferenceServerWork: async (_generation: number, operation: () => Promise<unknown>) => operation(),
    replayPendingPrivacyHide: async () => ({ offline: false, pending: false, blocked: false }),
    applyNativeDirection: () => ({ restartRequired: false }),
    console,
  } as Record<string, unknown>;

  const source = extractBootstrapEffect(file);
  const compiled = ts.transpileModule(
    `globalThis.__effect = (${source});`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None, jsx: ts.JsxEmit.ReactJSX } },
  ).outputText;
  vm.runInNewContext(compiled, context, { filename: file });
  const cleanup = (context.__effect as () => (() => void) | void)();

  for (let i = 0; i < 40 && !state.ready; i++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  cleanup?.();
  if (!state.ready) throw new Error('bootstrap never reached ready state');
  return { state, cacheOwner, loadMeCalls };
}

describe('offline process restart keeps the encrypted cache bound to its session owner', () => {
  const appStore = fileURLToPath(new URL('../src/state/app-store.tsx', import.meta.url));

  it('a restored session that cannot reach /v1/me still binds an account before entering offline mode', async () => {
    const result = await boot(appStore, true);

    expect(result.loadMeCalls).toBe(1);
    expect(result.state.signedIn).toBe(true);
    expect(result.state.offline).toBe(true);
    expect(result.cacheOwner).toBe('ACCOUNT-A');
  });

  it('restores the encrypted owned-self bootstrap so Today works and App Lock stays enforced offline', async () => {
    const result = await boot(appStore, true);

    // SECURITY: default preferences have appLockEnabled=false. If the offline
    // bootstrap restores only `signedIn`, AppLockGate computes enabled=false and
    // can paint cached medication PHI without the lock the patient enabled.
    expect(result.state.preferences.appLockEnabled).toBe(true);
    expect(result.state.preferences.appLockAreas).toEqual(['reports']);
    expect(result.state.credentialVerifiedAt).toBeNull();

    // FUNCTIONAL: Today requires an active profile id to open its encrypted
    // schedule. Restore only the owned self profile; never resurrect a cached
    // caregiver/dependent grant that may have been revoked while this phone was
    // offline.
    expect(result.state.user?.id).toBe('ACCOUNT-A');
    expect(result.state.profiles.map((profile) => profile.id)).toEqual(['PROFILE-A']);
    expect(result.state.activeProfile?.id).toBe('PROFILE-A');
  });

  it('positive control: a device with no stored session does not bind or restore anything', async () => {
    const result = await boot(appStore, false);
    expect(result.loadMeCalls).toBe(0);
    expect(result.state.signedIn).toBe(false);
    expect(result.cacheOwner).toBeNull();
    expect(result.state.user).toBeNull();
    expect(result.state.activeProfile).toBeNull();
    expect(result.state.preferences.appLockEnabled).toBe(false);
  });
});
