import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

function extractBootstrapRunner(file: string): string {
  const source = readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  let runner: string | null = null;

  const visit = (node: ts.Node): void => {
    if (
      ts.isArrowFunction(node)
      && node.getText(sf).startsWith('async')
      && node.getText(sf).includes('getDeviceId()')
      && node.getText(sf).includes('loadStoredSession()')
    ) {
      runner = node.getText(sf);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  if (!runner) throw new Error('could not find AppProvider bootstrap runner');
  return runner;
}

describe('cold-start device identity storage failure', () => {
  it('does not leave a signed-out patient stuck forever before the auth screen', async () => {
    const appStore = fileURLToPath(new URL('../src/state/app-store.tsx', import.meta.url));
    const runner = extractBootstrapRunner(appStore);
    const compiled = ts.transpileModule(
      `globalThis.__bootstrap = (${runner});`,
      { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } },
    ).outputText;

    let state = { ready: false, deviceId: '', signedIn: false };
    let sessionReads = 0;
    let cacheOwner: string | null = 'unexpected';
    const context = {
      cancelled: false,
      getDeviceId: async () => { throw new Error('synthetic AsyncStorage failure'); },
      loadStoredSession: async () => { sessionReads++; return false; },
      sessionGeneration: { current: 0 },
      getRestoredSessionUserId: async () => null,
      setCacheOwner: (owner: string | null) => { cacheOwner = owner; },
      setUnauthenticatedHandler: () => undefined,
      setState: (updater: typeof state | ((previous: typeof state) => typeof state)) => {
        state = typeof updater === 'function' ? updater(state) : updater;
      },
      console,
    } as Record<string, unknown>;

    vm.runInNewContext(compiled, context, { filename: appStore });
    const bootstrap = context.__bootstrap as () => Promise<void>;

    // getDeviceId intentionally refuses to mint an ephemeral identity when its
    // durable AsyncStorage write fails. That storage failure must not become an
    // infinite splash screen: a signed-out user still needs the auth surface.
    await expect(bootstrap()).resolves.toBeUndefined();
    expect(sessionReads).toBe(1);
    expect(cacheOwner).toBeNull();
    expect(state.ready).toBe(true);
    expect(state.signedIn).toBe(false);
    expect(state.deviceId).toBe('');
  });
});
