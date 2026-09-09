import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { fileURLToPath, URL } from 'node:url';
import { describe, expect, it } from 'vitest';

class NetworkError extends Error {}

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
    user: null,
    profiles: [],
    activeProfile: null,
    deviceId: '',
    offline: false,
    pendingSyncCount: 0,
  };
  const stateRef = { current: state as typeof state & { user: { id: string } | null } };
  const sessionGeneration = { current: 0 };
  const authCleanupInFlight = { current: Promise.resolve() };
  let cacheOwner: string | null = null;
  let loadMeCalls = 0;

  const setState = (updater: ((s: typeof state) => typeof state) | typeof state) => {
    state = typeof updater === 'function' ? updater(state) : updater;
    stateRef.current = state;
  };

  const context = {
    getDeviceId: async () => 'device-a',
    loadStoredSession: async () => hasStoredSession,
    // Supplied for the eventual bounded fix. The baseline effect does not use
    // it; an extra name in the VM cannot change baseline behaviour.
    getRestoredSessionUserId: () => hasStoredSession ? 'ACCOUNT-A' : null,
    setUnauthenticatedHandler: () => undefined,
    stateRef,
    sessionGeneration,
    authCleanupInFlight,
    setCacheOwner: (userId: string | null) => { cacheOwner = userId; },
    setState,
    cancelAllLocalNotifications: async () => undefined,
    purgeLocalCaches: async () => undefined,
    destroyCacheKey: async () => undefined,
    loadMe: async () => {
      loadMeCalls++;
      throw new NetworkError('airplane mode');
    },
    isSignedIn: () => hasStoredSession,
    queueSize: async () => 0,
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
    // readCachedSchedule/readQueue deliberately return nothing while their
    // owner is null. A cold start that claims to be signed in/offline therefore
    // cannot actually use the encrypted schedule or queued dose actions unless
    // bootstrap restores this owner independently of the network.
    expect(result.cacheOwner).toBe('ACCOUNT-A');
  });

  it('positive control: a device with no stored session does not bind any cache owner', async () => {
    const result = await boot(appStore, false);
    expect(result.loadMeCalls).toBe(0);
    expect(result.state.signedIn).toBe(false);
    expect(result.cacheOwner).toBeNull();
  });
});
