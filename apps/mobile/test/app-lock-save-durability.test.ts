import { createRequire } from 'node:module';
import { fileURLToPath, URL } from 'node:url';
import { expect, it } from 'vitest';

const { makeProvider, NetworkError } = createRequire(import.meta.url)('./preference-provider-lifecycle.cjs');
const store = fileURLToPath(new URL('../src/state/app-store.tsx', import.meta.url));
const notifications = fileURLToPath(new URL('../src/notifications/index.ts', import.meta.url));
async function request(h: any) {
  for (let i = 0; i < 100 && !h.pending('PATCH').length; i++) await Promise.resolve();
  expect(h.pending('PATCH')).toHaveLength(1);
  return h.pending('PATCH')[0];
}

it.each([false, 'throw'])('reports failed local lock persistence (%s), even with successful HTTP', async failure => {
  const h = makeProvider(store, notifications, { writeOfflineBootstrap: async () => {
    if (failure === 'throw') throw new Error('storage unavailable');
    return false;
  } });
  const result = h.actions().updatePreferences({ appLockEnabled: true }).then(() => 'success', () => 'failed');
  h.resolve(await request(h), { preferences: { appLockEnabled: true } });
  expect(await result).toBe('failed');
  expect(h.state().preferences.appLockEnabled).toBe(true); // Keep protection in this process.
});

it('waits for the durable write before reporting success while offline', async () => {
  let finish!: (ok: boolean) => void;
  const stored = new Promise<boolean>(resolve => { finish = resolve; });
  const h = makeProvider(store, notifications, { writeOfflineBootstrap: () => stored });
  let settled = false;
  const save = h.actions().updatePreferences({ appLockEnabled: true }).then(() => { settled = true; });
  h.reject(await request(h), new NetworkError('offline'));
  for (let i = 0; i < 100; i++) await Promise.resolve();
  expect(settled).toBe(false);
  finish(true);
  await save;
  expect(h.state().preferences.appLockEnabled).toBe(true);
});

it('reports a server rejection for changed lock areas', async () => {
  const h = makeProvider(store, notifications);
  const result = h.actions().updatePreferences({ appLockAreas: ['history'] }).then(() => 'success', () => 'failed');
  h.reject(await request(h), new Error('HTTP 403'));
  expect(await result).toBe('failed');
  expect(h.state().offline).toBe(false);
});
