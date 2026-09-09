import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProfileSummary } from '../src/api/types.js';
import type { Preferences } from '../src/state/app-store.js';

const stored = new Map<string, string>();

vi.mock('../src/storage/secure-cache.js', () => ({
  readSlot: async (slot: { plaintextKey: string }, userId: string) =>
    stored.get(`${slot.plaintextKey}:${userId}`) ?? null,
  writeSlot: async (slot: { plaintextKey: string }, userId: string, value: string) => {
    stored.set(`${slot.plaintextKey}:${userId}`, value);
    return { ok: true } as const;
  },
}));

const bootstrap = await import('../src/storage/offline-bootstrap.js');

const ALICE = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const BOB = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const key = (userId: string) => `${bootstrap.OFFLINE_BOOTSTRAP_SLOT.plaintextKey}:${userId}`;

const preferences: Preferences = {
  locale: 'ar',
  numeralSystem: 'latn',
  calendarSystem: 'gregory',
  elderlyMode: false,
  textScale: 1,
  highContrast: false,
  voiceRemindersEnabled: false,
  voiceConfirmationEnabled: false,
  showMedicationInNotifications: false,
  appLockEnabled: true,
  appLockAreas: ['reports'],
  quietHoursStart: '22:00',
  quietHoursEnd: '06:00',
  defaultSnoozeMinutes: 10,
  lowStockThresholdDays: 7,
  expiryWarningDays: 30,
};

const selfProfile: ProfileSummary = {
  id: '11111111-1111-4111-8111-111111111111',
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

const caregiverProfile: ProfileSummary = {
  ...selfProfile,
  id: '22222222-2222-4222-8222-222222222222',
  displayName: 'Dependent B',
  isSelf: false,
  role: 'caregiver',
  permissions: ['medications:read'],
};

beforeEach(() => stored.clear());

describe('encrypted offline bootstrap is account-owned state, not cached authority', () => {
  it('round-trips App Lock/privacy state and only the owned self profile', async () => {
    const written = await bootstrap.writeOfflineBootstrap(ALICE, {
      version: 1,
      user: { id: ALICE, displayName: 'Alice', phoneE164: null },
      preferences,
      selfProfile,
    });
    expect(written).toBe(true);

    const restored = await bootstrap.readOfflineBootstrap(ALICE);
    expect(restored).not.toBeNull();
    expect(restored?.preferences.appLockEnabled).toBe(true);
    expect(restored?.preferences.appLockAreas).toEqual(['reports']);
    expect(restored?.preferences.showMedicationInNotifications).toBe(false);
    expect(restored?.selfProfile?.id).toBe(selfProfile.id);
    expect(restored?.selfProfile?.role).toBe('owner');
    expect(restored?.selfProfile?.permissions).toBeNull();
    expect(restored).not.toHaveProperty('credentialVerifiedAt');
  });

  it('never persists delegated caregiver/dependent access as offline authority', async () => {
    await bootstrap.writeOfflineBootstrap(ALICE, {
      version: 1,
      user: { id: ALICE, displayName: 'Alice', phoneE164: null },
      preferences,
      selfProfile: caregiverProfile,
    });

    const raw = JSON.parse(stored.get(key(ALICE))!);
    expect(raw.selfProfile).toBeNull();
    expect(await bootstrap.readOfflineBootstrap(ALICE)).toMatchObject({ selfProfile: null });
  });

  it('rejects a snapshot whose embedded account does not match the restored session owner', async () => {
    stored.set(key(ALICE), JSON.stringify({
      version: 1,
      user: { id: BOB, displayName: 'Bob', phoneE164: null },
      preferences,
      selfProfile,
    }));

    expect(await bootstrap.readOfflineBootstrap(ALICE)).toBeNull();
  });

  it('fails closed on malformed lock configuration or an unknown snapshot version', async () => {
    stored.set(key(ALICE), JSON.stringify({
      version: 1,
      user: { id: ALICE, displayName: 'Alice', phoneE164: null },
      preferences: { ...preferences, appLockAreas: ['not-a-real-area'] },
      selfProfile,
    }));
    expect(await bootstrap.readOfflineBootstrap(ALICE)).toBeNull();

    stored.set(key(ALICE), JSON.stringify({
      version: 2,
      user: { id: ALICE, displayName: 'Alice', phoneE164: null },
      preferences,
      selfProfile,
    }));
    expect(await bootstrap.readOfflineBootstrap(ALICE)).toBeNull();
  });

  it('refuses to write a snapshot into a different account namespace', async () => {
    const written = await bootstrap.writeOfflineBootstrap(ALICE, {
      version: 1,
      user: { id: BOB, displayName: 'Bob', phoneE164: null },
      preferences,
      selfProfile,
    });
    expect(written).toBe(false);
    expect(stored.size).toBe(0);
  });
});
