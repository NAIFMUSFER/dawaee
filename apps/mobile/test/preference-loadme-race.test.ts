import { createRequire } from 'node:module';
import { fileURLToPath, URL } from 'node:url';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { makeHarness } = require('./preference-scope-races.cjs') as {
  makeHarness: (appStore: string, options?: Record<string, unknown>) => {
    loadMe: () => Promise<void>;
    updatePreferences: (patch: Record<string, unknown>) => Promise<void>;
    pending: (method?: string, route?: string) => Array<{
      completed: boolean;
      resolve: (value: unknown) => void;
      reject: (error: unknown) => void;
    }>;
    resolve: (request: { completed: boolean; resolve: (value: unknown) => void }, value: unknown) => void;
    state: () => { preferences: { locale: string } };
  };
};

const DEFAULT_PREFERENCES = {
  locale: 'en', numeralSystem: 'latn', calendarSystem: 'gregory', elderlyMode: false,
  textScale: 1, highContrast: false, voiceRemindersEnabled: false,
  voiceConfirmationEnabled: false, showMedicationInNotifications: false,
  appLockEnabled: false, appLockAreas: [], quietHoursStart: null, quietHoursEnd: null,
  defaultSnoozeMinutes: 10, lowStockThresholdDays: 7, expiryWarningDays: 30,
};

const SELF = { id: 'SELF', displayName: 'Self', isSelf: true, role: 'owner', permissions: null };

async function waitForPending(
  h: ReturnType<typeof makeHarness>,
  method: string,
  route: string,
) {
  for (let i = 0; i < 30; i++) {
    const request = h.pending(method, route)[0];
    if (request) return request;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`request never started: ${method} ${route}`);
}

describe('bootstrap preference snapshot versus newer local intent', () => {
  const appStore = fileURLToPath(new URL('../src/state/app-store.tsx', import.meta.url));

  it('a loadMe started first cannot restore older preferences after a newer preference update commits', async () => {
    const h = makeHarness(appStore, { preferences: { locale: 'en' } });

    const load = h.loadMe();
    const meRequest = await waitForPending(h, 'GET', '/v1/me');
    h.resolve(meRequest, {
      user: { id: 'ACCOUNT-A', displayName: 'A', phoneE164: null },
      preferences: { ...DEFAULT_PREFERENCES, locale: 'ar' },
    });
    const profilesRequest = await waitForPending(h, 'GET', '/v1/profiles');

    const update = h.updatePreferences({ locale: 'en' });
    const patchRequest = await waitForPending(h, 'PATCH', '/v1/me/preferences');
    h.resolve(patchRequest, { preferences: { ...DEFAULT_PREFERENCES, locale: 'en' } });
    await update;
    expect(h.state().preferences.locale).toBe('en');

    h.resolve(profilesRequest, { profiles: [SELF] });
    await load;

    expect(h.state().preferences.locale).toBe('en');
  });

  it('positive control: loadMe still applies server preferences when no newer preference intent exists', async () => {
    const h = makeHarness(appStore, { preferences: { locale: 'en' } });
    const load = h.loadMe();
    const meRequest = await waitForPending(h, 'GET', '/v1/me');
    h.resolve(meRequest, {
      user: { id: 'ACCOUNT-A', displayName: 'A', phoneE164: null },
      preferences: { ...DEFAULT_PREFERENCES, locale: 'ar' },
    });
    const profilesRequest = await waitForPending(h, 'GET', '/v1/profiles');
    h.resolve(profilesRequest, { profiles: [SELF] });
    await load;

    expect(h.state().preferences.locale).toBe('ar');
  });
});
