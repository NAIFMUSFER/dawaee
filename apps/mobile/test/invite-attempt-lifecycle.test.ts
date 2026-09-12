import { describe, expect, it, vi } from 'vitest';

const asyncStore = new Map<string, string>();
const secureStore = new Map<string, string>();

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (key: string) => asyncStore.get(key) ?? null,
    setItem: async (key: string, value: string) => { asyncStore.set(key, value); },
    removeItem: async (key: string) => { asyncStore.delete(key); },
  },
}));
vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
vi.mock('expo-secure-store', () => ({
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 1,
  getItemAsync: async (key: string) => secureStore.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => { secureStore.set(key, value); },
  deleteItemAsync: async (key: string) => { secureStore.delete(key); },
}));

const pending = await import('../src/storage/pending-invite.js');
const releaseInviteAttempt = (pending as typeof pending & {
  releaseInviteAttempt?: (token: string) => void;
}).releaseInviteAttempt;

describe('caregiver invitation attempt claim lifecycle', () => {
  it('holds the claim across ordinary cleanup so a successful single-use invite cannot double-submit', async () => {
    const token = 'tok-success-claim';
    expect(pending.claimInviteAttempt(token)).toBe(true);
    expect(pending.claimInviteAttempt(token)).toBe(false);
    await pending.clearPendingInvite();
    expect(pending.claimInviteAttempt(token)).toBe(false);
  });

  it('can explicitly release a permanently refused token so reopening the same link can reach the API again', async () => {
    const token = 'tok-permanent-refusal';
    expect(pending.claimInviteAttempt(token)).toBe(true);
    await pending.stashPendingInvite(token);

    // This models invitation_invalid / expired / already-used after the request
    // has settled. The stored bearer is forgotten, but the duplicate-submit
    // claim must be released separately; clearPendingInvite itself deliberately
    // cannot do that because the success path also calls it.
    await pending.clearPendingInvite();
    expect(releaseInviteAttempt, 'permanent refusal needs an explicit claim-release operation').toBeTypeOf('function');
    releaseInviteAttempt?.(token);

    await pending.stashPendingInvite(token); // user opens the same link again
    expect(pending.claimInviteAttempt(token)).toBe(true);
  });
});
