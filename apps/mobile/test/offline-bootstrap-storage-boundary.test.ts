import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OfflineBootstrapSnapshot } from '../src/storage/offline-bootstrap.js';

// Keep the actual bootstrap parser, secure-cache migration and production AES
// implementation. Only physical disk/key persistence and Expo randomness are
// adapted to this Node test; this is not a handset or AppLockGate E2E test.
const state = vi.hoisted(() => ({
  disk: new Map<string, string>(),
  keys: new Map<string, Uint8Array>(),
  failWrites: false,
  failRemoves: false,
  failEncryptedRead: false,
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (key: string) => {
      if (state.failEncryptedRead && key.endsWith('.enc.v1')) throw new Error('controlled read failure');
      return state.disk.get(key) ?? null;
    },
    setItem: async (key: string, value: string) => {
      if (state.failWrites) throw new Error('controlled write failure');
      state.disk.set(key, value);
    },
    removeItem: async (key: string) => {
      if (state.failRemoves) throw new Error('controlled remove failure');
      state.disk.delete(key);
    },
    multiRemove: async (keys: string[]) => { for (const key of keys) state.disk.delete(key); },
    getAllKeys: async () => [...state.disk.keys()],
  },
}));

vi.mock('../src/storage/cache-key.js', () => ({
  KEY_VERSION: 1,
  CacheKeyUnavailable: class CacheKeyUnavailable extends Error {},
  getOrCreateCacheKey: async (userId: string) => {
    if (!state.keys.has(userId)) state.keys.set(userId, new Uint8Array(randomBytes(32)));
    return state.keys.get(userId)!;
  },
}));

vi.mock('expo-crypto', () => ({
  getRandomBytes: (count: number) => new Uint8Array(randomBytes(count)),
}));

const bootstrap = await import('../src/storage/offline-bootstrap.js');
const cache = await import('../src/storage/secure-cache.js');
const ALICE = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const BOB = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const PLAIN = 'dawaee.offlineBootstrap';
const encryptedKey = (userId: string) => `${PLAIN}.${userId}.enc.v1`;

function snapshot(): OfflineBootstrapSnapshot {
  return {
    version: 1,
    user: { id: ALICE, displayName: 'Synthetic Alice', phoneE164: null },
    preferences: {
      locale: 'en', numeralSystem: 'latn', calendarSystem: 'gregory',
      elderlyMode: false, textScale: 1, highContrast: false,
      voiceRemindersEnabled: false, voiceConfirmationEnabled: false,
      showMedicationInNotifications: false, appLockEnabled: true,
      appLockAreas: ['reports'], quietHoursStart: null, quietHoursEnd: null,
      defaultSnoozeMinutes: 10, lowStockThresholdDays: 7, expiryWarningDays: 30,
    },
    selfProfile: {
      id: '11111111-1111-4111-8111-111111111111', displayName: 'Synthetic self',
      isSelf: true, role: 'owner', permissions: null, timezone: 'Asia/Riyadh',
      homeTimezone: 'Asia/Riyadh', travelPolicy: 'ask', birthYear: null, avatarKey: null,
    },
  };
}

beforeEach(() => {
  state.disk.clear();
  state.keys.clear();
  state.failWrites = false;
  state.failRemoves = false;
  state.failEncryptedRead = false;
});

describe('offline bootstrap accepts authenticated ciphertext, never legacy plaintext', () => {
  it('rejects plaintext carrying a forged lock-off setting and does not authenticate it by migration', async () => {
    const untrusted = snapshot();
    untrusted.preferences.appLockEnabled = false;
    state.disk.set(PLAIN, JSON.stringify(untrusted));

    expect(await bootstrap.readOfflineBootstrap(ALICE)).toBeNull();
    expect(state.disk.has(encryptedKey(ALICE))).toBe(false);
  });

  it('removes residual plaintext in a namespace that has no plaintext predecessor', async () => {
    state.disk.set(PLAIN, JSON.stringify(snapshot()));
    await bootstrap.readOfflineBootstrap(ALICE);
    expect(state.disk.has(PLAIN)).toBe(false);
  });

  it('does not restore plaintext when an earlier authenticated copy is missing', async () => {
    expect(await bootstrap.writeOfflineBootstrap(ALICE, snapshot())).toBe(true);
    state.disk.delete(encryptedKey(ALICE));
    state.disk.set(PLAIN, JSON.stringify(snapshot()));

    expect(await bootstrap.readOfflineBootstrap(ALICE)).toBeNull();
    expect(state.disk.has(encryptedKey(ALICE))).toBe(false);
  });

  it('does not downgrade an encrypted read failure into plaintext acceptance', async () => {
    expect(await bootstrap.writeOfflineBootstrap(ALICE, snapshot())).toBe(true);
    state.disk.set(PLAIN, JSON.stringify(snapshot()));
    state.failEncryptedRead = true;
    expect(await bootstrap.readOfflineBootstrap(ALICE)).toBeNull();
  });

  it('still rejects plaintext if removal of that plaintext fails', async () => {
    state.disk.set(PLAIN, JSON.stringify(snapshot()));
    state.failRemoves = true;
    expect(await bootstrap.readOfflineBootstrap(ALICE)).toBeNull();
    expect(state.disk.has(encryptedKey(ALICE))).toBe(false);
  });

  it('round-trips legitimate ciphertext with the real production crypto module', async () => {
    expect(await bootstrap.writeOfflineBootstrap(ALICE, snapshot())).toBe(true);
    expect(state.disk.has(PLAIN)).toBe(false);
    expect(state.disk.get(encryptedKey(ALICE))).toBeDefined();
    expect(state.disk.get(encryptedKey(ALICE))).not.toContain('Synthetic Alice');
    const restored = await bootstrap.readOfflineBootstrap(ALICE);
    expect(restored?.preferences.appLockEnabled).toBe(true);
    expect(restored?.selfProfile?.id).toBe(snapshot().selfProfile?.id);
    expect(restored).not.toHaveProperty('credentialVerifiedAt');
  });

  it('cannot restore another account ciphertext copied into its namespace', async () => {
    expect(await bootstrap.writeOfflineBootstrap(ALICE, snapshot())).toBe(true);
    state.disk.set(encryptedKey(BOB), state.disk.get(encryptedKey(ALICE))!);
    expect(await bootstrap.readOfflineBootstrap(BOB)).toBeNull();
  });

  it('preserves migration for the genuine legacy offline dose queue', async () => {
    const slot = { plaintextKey: 'dawaee.offlineQueue' };
    const unsent = JSON.stringify([{ clientEventId: 'SYNTHETIC-UNSENT', type: 'taken' }]);
    state.disk.set(slot.plaintextKey, unsent);
    expect(await cache.readSlot(slot, ALICE)).toBe(unsent);
    expect(state.disk.has(slot.plaintextKey)).toBe(false);
    expect(await cache.readSlot(slot, ALICE)).toBe(unsent);
  });

  it('does not discard unsent legacy queue data when its migration write fails', async () => {
    const slot = { plaintextKey: 'dawaee.offlineQueue' };
    const unsent = JSON.stringify([{ clientEventId: 'SYNTHETIC-UNSENT', type: 'taken' }]);
    state.disk.set(slot.plaintextKey, unsent);
    state.failWrites = true;
    expect(await cache.readSlot(slot, ALICE)).toBe(unsent);
    expect(state.disk.get(slot.plaintextKey)).toBe(unsent);
  });
});
