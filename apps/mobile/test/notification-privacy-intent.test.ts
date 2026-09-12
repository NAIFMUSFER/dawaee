import { beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({
  values: new Map<string, string>(),
  failWrite: false,
  unreadable: false,
  purges: 0,
}));

vi.mock('../src/storage/secure-cache.js', () => ({
  readSlot: async (_slot: unknown, userId: string) => {
    if (fake.unreadable) throw new Error('synthetic unreadable ciphertext');
    return fake.values.get(userId) ?? null;
  },
  writeSlot: async (_slot: unknown, userId: string, value: string) => {
    if (fake.failWrite) return { ok: false, reason: 'write' };
    fake.values.set(userId, value);
    return { ok: true };
  },
  clearSlot: async (_slot: unknown, userId: string) => { fake.values.delete(userId); },
  purgeAllSlots: async () => { fake.values.clear(); fake.purges += 1; },
}));

import {
  NOTIFICATION_PRIVACY_INTENT_SLOT,
  acknowledgePrivacyHide,
  cancelPrivacyHidePending,
  markPrivacyHidePending,
  privacyHidePendingCount,
  purgePrivacyHideIntents,
  readPrivacyHideIntent,
} from '../src/storage/notification-privacy-intent.js';

beforeEach(() => {
  fake.values.clear();
  fake.failWrite = false;
  fake.unreadable = false;
  fake.purges = 0;
});

describe('notification privacy intent', () => {
  it('is encrypted-only and account scoped', async () => {
    expect(NOTIFICATION_PRIVACY_INTENT_SLOT.migratePlaintext).toBe(false);
    const token = await markPrivacyHidePending('ACCOUNT-A');
    expect(token).toBeTruthy();
    expect(await privacyHidePendingCount('ACCOUNT-A')).toBe(1);
    expect(await privacyHidePendingCount('ACCOUNT-B')).toBe(0);
    expect(await readPrivacyHideIntent('ACCOUNT-B')).toEqual({ kind: 'none' });
  });

  it('an old success cannot acknowledge a newer hide after an intervening opt-in', async () => {
    const first = await markPrivacyHidePending('ACCOUNT-A');
    expect(first).toBeTruthy();
    await cancelPrivacyHidePending('ACCOUNT-A');
    const latest = await markPrivacyHidePending('ACCOUNT-A');
    expect(latest).toBeTruthy();
    expect(latest).not.toBe(first);

    await acknowledgePrivacyHide('ACCOUNT-A', first!);
    expect(await readPrivacyHideIntent('ACCOUNT-A')).toEqual({ kind: 'pending', token: latest });

    await acknowledgePrivacyHide('ACCOUNT-A', latest!);
    expect(await readPrivacyHideIntent('ACCOUNT-A')).toEqual({ kind: 'none' });
  });

  it('does not claim durability when encrypted persistence fails', async () => {
    fake.failWrite = true;
    expect(await markPrivacyHidePending('ACCOUNT-A')).toBeNull();
    expect(await privacyHidePendingCount('ACCOUNT-A')).toBe(0);
  });

  it('fails private when an authenticated slot is unreadable', async () => {
    fake.unreadable = true;
    expect(await readPrivacyHideIntent('ACCOUNT-A')).toEqual({ kind: 'unreadable' });
    expect(await privacyHidePendingCount('ACCOUNT-A')).toBe(1);
  });

  it('sign-out sweep removes unresolved intents for every account', async () => {
    await markPrivacyHidePending('ACCOUNT-A');
    await markPrivacyHidePending('ACCOUNT-B');
    await purgePrivacyHideIntents();
    expect(fake.purges).toBe(1);
    expect(await privacyHidePendingCount('ACCOUNT-A')).toBe(0);
    expect(await privacyHidePendingCount('ACCOUNT-B')).toBe(0);
  });
});
