import { createRequire } from 'node:module';
import { fileURLToPath, URL } from 'node:url';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { makeProvider, NetworkError } = require('./preference-provider-lifecycle.cjs') as {
  makeProvider: (store: string, notifications: string, options?: Record<string, unknown>) => any;
  NetworkError: new (message?: string) => Error;
};

async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !predicate(); i++) await Promise.resolve();
  expect(predicate()).toBe(true);
}

describe('offline notification-privacy preference durability', () => {
  it('retries a failed hide-medication-names intent before accepting a server refresh', async () => {
    const store = fileURLToPath(new URL('../src/state/app-store.tsx', import.meta.url));
    const notifications = fileURLToPath(new URL('../src/notifications/index.ts', import.meta.url));
    const h = makeProvider(store, notifications, {
      preferences: { showMedicationInNotifications: true },
    });

    const save = h.actions().updatePreferences({ showMedicationInNotifications: false });
    await until(() => h.pending('PATCH', '/v1/me/preferences').length > 0);
    const first = h.pending('PATCH', '/v1/me/preferences')[0];
    h.reject(first, new NetworkError('synthetic offline before server commit'));
    await save;
    h.render();

    expect(h.state().preferences.showMedicationInNotifications).toBe(false);
    expect(h.state().offline).toBe(true);

    const sync = h.actions().syncNow();
    await until(() =>
      h.requests.filter((r: any) => r.method === 'PATCH' && r.route === '/v1/me/preferences').length > 1
      || h.pending('GET', '/v1/me').length > 0,
    );

    const preferenceWrites = h.requests.filter(
      (r: any) => r.method === 'PATCH' && r.route === '/v1/me/preferences',
    );
    expect(preferenceWrites).toHaveLength(2);
    expect(preferenceWrites[1].payload).toEqual({ showMedicationInNotifications: false });

    // Once the privacy intent is durably accepted, the normal refresh may run.
    h.resolve(preferenceWrites[1], { preferences: { showMedicationInNotifications: false } });
    await until(() => h.pending('GET', '/v1/me').length > 0);
    h.resolve(h.pending('GET', '/v1/me')[0], {
      user: { id: 'ACCOUNT-A', displayName: 'ACCOUNT-A', phoneE164: null },
      preferences: { showMedicationInNotifications: false },
    });
    await until(() => h.pending('GET', '/v1/profiles').length > 0);
    h.resolve(h.pending('GET', '/v1/profiles')[0], {
      profiles: [{ id: 'SELF-A', isSelf: true, role: 'owner', displayName: 'Self', permissions: null }],
    });
    await sync;

    expect(h.state().preferences.showMedicationInNotifications).toBe(false);
  });
});
