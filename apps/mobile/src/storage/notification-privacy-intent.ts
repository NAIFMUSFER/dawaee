import { clearSlot, purgeAllSlots, readSlot, writeSlot } from './secure-cache.js';
import type { CacheSlot } from './secure-cache.js';

/**
 * A durable, account-scoped marker for the one preference where losing an
 * offline write can disclose health information: hiding medication names from
 * notifications.
 *
 * This is intentionally not a general preference cache. The normal encrypted
 * offline bootstrap already remembers how the UI should look. This slot exists
 * only to remember that the server still owes us the privacy-narrowing write.
 */
export const NOTIFICATION_PRIVACY_INTENT_SLOT: CacheSlot = {
  plaintextKey: 'dawaee.notificationPrivacyIntent',
  // No released build ever stored this intent in plaintext. Never promote an
  // attacker-controlled unscoped AsyncStorage value into authenticated state.
  migratePlaintext: false,
};

export type PrivacyHideIntent =
  | { kind: 'none' }
  | { kind: 'pending'; token: string }
  | { kind: 'unreadable' };

let sequence = 0;
const tails = new Map<string, Promise<void>>();

function newToken(): string {
  // Equality nonce, not a credential. It only prevents an older successful
  // PATCH from acknowledging a newer hide intent after an intervening toggle.
  sequence = (sequence + 1) % Number.MAX_SAFE_INTEGER;
  return `${Date.now().toString(36)}-${sequence.toString(36)}-${Math.random().toString(36).slice(2)}`;
}

async function afterPriorMutation<T>(userId: string, operation: () => Promise<T>): Promise<T> {
  const prior = tails.get(userId) ?? Promise.resolve();
  let resolveTail!: () => void;
  const gate = new Promise<void>((resolve) => { resolveTail = resolve; });
  const chained = prior.then(() => gate, () => gate);
  tails.set(userId, chained);
  await prior.catch(() => undefined);
  try {
    return await operation();
  } finally {
    resolveTail();
    if (tails.get(userId) === chained) tails.delete(userId);
  }
}

async function readCurrent(userId: string): Promise<PrivacyHideIntent> {
  try {
    const raw = await readSlot(NOTIFICATION_PRIVACY_INTENT_SLOT, userId);
    if (!raw) return { kind: 'none' };
    if (raw.length < 8 || raw.length > 256) return { kind: 'unreadable' };
    return { kind: 'pending', token: raw };
  } catch {
    // If authenticated ciphertext exists but cannot be opened, fail private.
    // Treat it as unresolved rather than licensing a server preference that may
    // still expose the medication name.
    return { kind: 'unreadable' };
  }
}

/** Persist a new hide intent and return its acknowledgement token. */
export async function markPrivacyHidePending(userId: string): Promise<string | null> {
  return afterPriorMutation(userId, async () => {
    const token = newToken();
    const stored = await writeSlot(NOTIFICATION_PRIVACY_INTENT_SLOT, userId, token);
    return stored.ok ? token : null;
  });
}

/** A newer explicit opt-in cancels every older unresolved hide marker. */
export async function cancelPrivacyHidePending(userId: string): Promise<void> {
  await afterPriorMutation(userId, async () => {
    await clearSlot(NOTIFICATION_PRIVACY_INTENT_SLOT, userId);
  });
}

/**
 * Clear only the exact hide write that the server has accepted.
 *
 * The compare is load-bearing: false -> true -> false can overlap storage and
 * network work. A response to the first false must never clear the marker for
 * the final false.
 */
export async function acknowledgePrivacyHide(userId: string, token: string): Promise<void> {
  await afterPriorMutation(userId, async () => {
    const current = await readCurrent(userId);
    if (current.kind === 'pending' && current.token === token) {
      await clearSlot(NOTIFICATION_PRIVACY_INTENT_SLOT, userId);
    }
  });
}

/** Read after all earlier mutations for this account have settled. */
export async function readPrivacyHideIntent(userId: string): Promise<PrivacyHideIntent> {
  const prior = tails.get(userId);
  if (prior) await prior.catch(() => undefined);
  return readCurrent(userId);
}

export async function privacyHidePendingCount(userId: string | null): Promise<number> {
  if (!userId) return 0;
  const current = await readPrivacyHideIntent(userId);
  return current.kind === 'none' ? 0 : 1;
}

/**
 * Sign-out sweeps every account's slot, not just the account React happened to
 * have in memory. This mirrors the existing medication-cache privacy sweep and
 * prevents an old account's unresolved intent from surviving on a shared phone.
 */
export async function purgePrivacyHideIntents(): Promise<void> {
  await Promise.all([...tails.values()].map((tail) => tail.catch(() => undefined)));
  await purgeAllSlots([NOTIFICATION_PRIVACY_INTENT_SLOT]);
}
