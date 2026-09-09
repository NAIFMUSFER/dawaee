import { createRequire } from 'node:module';
import { fileURLToPath, URL } from 'node:url';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
interface Preferences {
  locale: string;
  appLockEnabled: boolean;
  showMedicationInNotifications: boolean;
  [key: string]: unknown;
}
interface PendingRequest {
  completed: boolean;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}
interface Harness {
  loadMe: () => Promise<void>;
  updatePreferences: (patch: Partial<Preferences>) => Promise<void>;
  pending: (method?: string, route?: string) => PendingRequest[];
  resolve: (request: PendingRequest, value: unknown) => void;
  state: () => { user: { id: string }; profiles: Array<{ id: string }>; preferences: Preferences };
  bootstrapWrites: Array<{ preferences: Preferences }>;
  nativeDirections: string[];
  sessionGeneration: { current: number };
  replaceState: (state: Record<string, unknown>) => void;
}
const { makeHarness } = require('./preference-scope-races.cjs') as {
  makeHarness: (source: string, options?: {
    preferences?: Partial<Preferences>;
    onBootstrapWrite?: (snapshot: unknown, sequence: number) => Promise<void>;
  }) => Harness;
};
const source = fileURLToPath(new URL('../src/state/app-store.tsx', import.meta.url));
const SELF = { id: 'SELF', displayName: 'Self', role: 'owner', isSelf: true, permissions: null };
const defaults: Preferences = {
  locale: 'en', numeralSystem: 'latn', calendarSystem: 'gregory', elderlyMode: false,
  textScale: 1, highContrast: false, voiceRemindersEnabled: false,
  voiceConfirmationEnabled: false, showMedicationInNotifications: false,
  appLockEnabled: false, appLockAreas: [], quietHoursStart: null, quietHoursEnd: null,
  defaultSnoozeMinutes: 10, lowStockThresholdDays: 7, expiryWarningDays: 30,
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
async function until(predicate: () => boolean) {
  for (let turn = 0; turn < 100; turn++) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error('controlled persistence boundary was not reached');
}
async function beginRead(h: Harness, preferences: Preferences) {
  const done = h.loadMe();
  await until(() => h.pending('GET', '/v1/me').length > 0);
  h.resolve(h.pending('GET', '/v1/me')[0]!, {
    user: { id: 'ACCOUNT-A', displayName: 'A', phoneE164: null }, preferences,
  });
  await until(() => h.pending('GET', '/v1/profiles').length > 0);
  h.resolve(h.pending('GET', '/v1/profiles')[0]!, {
    profiles: [SELF, { ...SELF, id: 'NEW-OWNED-PROFILE', isSelf: false }],
  });
  await until(() => h.bootstrapWrites.length === 1);
  // Returning the promise inside an object keeps the held operation in flight.
  return { done };
}
async function acknowledge(h: Harness, patch: Partial<Preferences>) {
  await until(() => h.pending('PATCH').length > 0);
  h.resolve(h.pending('PATCH')[0]!, { preferences: { ...defaults, ...patch } });
}

describe('loadMe rechecks preference intent after offline snapshot persistence', () => {
  for (const [name, initial, patch] of [
    ['notification disclosure opt-out', { showMedicationInNotifications: true }, { showMedicationInNotifications: false }],
    ['enabling App Lock', { appLockEnabled: false }, { appLockEnabled: true }],
    ['new locale and native direction', { locale: 'ar' }, { locale: 'en' }],
  ] as const) {
    it(`a delayed snapshot write cannot undo ${name}`, async () => {
      const gate = deferred();
      const h = makeHarness(source, {
        preferences: initial,
        onBootstrapWrite: async (_snapshot, sequence) => { if (sequence === 1) await gate.promise; },
      });
      const read = await beginRead(h, { ...defaults, ...initial });
      const update = h.updatePreferences(patch);
      await acknowledge(h, patch);
      await update;
      for (const [key, value] of Object.entries(patch)) expect(h.state().preferences[key]).toBe(value);
      gate.resolve();
      await read.done;
      for (const [key, value] of Object.entries(patch)) expect(h.state().preferences[key]).toBe(value);
      // Do not fix the preference race by discarding the valid profile update.
      expect(h.state().profiles.map((p) => p.id)).toEqual(['SELF', 'NEW-OWNED-PROFILE']);
      if ('locale' in patch) expect(h.nativeDirections).toEqual(['en']);
    });
  }

  it('preserves the newer optimistic privacy intent even while its PATCH is pending', async () => {
    const gate = deferred();
    const h = makeHarness(source, {
      preferences: { showMedicationInNotifications: true },
      onBootstrapWrite: async (_snapshot, sequence) => { if (sequence === 1) await gate.promise; },
    });
    const read = await beginRead(h, { ...defaults, showMedicationInNotifications: true });
    const patch = { showMedicationInNotifications: false };
    const update = h.updatePreferences(patch);
    gate.resolve();
    await read.done;
    const observed = h.state().preferences.showMedicationInNotifications;
    await acknowledge(h, patch);
    await update;
    expect(observed).toBe(false);
  });

  it('positive control: a delayed current snapshot still commits server preferences', async () => {
    const gate = deferred();
    const h = makeHarness(source, {
      onBootstrapWrite: async () => gate.promise,
    });
    const server = { ...defaults, locale: 'ar', appLockEnabled: true };
    const read = await beginRead(h, server);
    gate.resolve();
    await read.done;
    expect(h.state().preferences.locale).toBe('ar');
    expect(h.state().preferences.appLockEnabled).toBe(true);
    expect(h.nativeDirections).toEqual(['ar']);
  });

  it('retains the existing session fence when an account changes during a snapshot write', async () => {
    const gate = deferred();
    const h = makeHarness(source, { onBootstrapWrite: async () => gate.promise });
    const read = await beginRead(h, { ...defaults, locale: 'ar' });
    h.sessionGeneration.current++;
    h.replaceState({ user: { id: 'ACCOUNT-B' }, preferences: defaults, profiles: [] });
    gate.resolve();
    await read.done;
    expect(h.state().user.id).toBe('ACCOUNT-B');
    expect(h.state().profiles).toEqual([]);
    expect(h.state().preferences.locale).toBe('en');
    expect(h.nativeDirections).toEqual([]);
  });
});
