import AsyncStorage from '@react-native-async-storage/async-storage';
import { clearSlot, readSlot, writeSlot } from './secure-cache.js';
import type { CacheSlot } from './secure-cache.js';

/**
 * "Remind me tomorrow" on the low-stock banner.
 *
 * This used to be one AsyncStorage entry per medication, named
 * `dawaee.lowStockSnoozedUntil.<medicationId>`. The stored VALUE was only a
 * date, which is why it survived the first pass — but the KEY was the leak.
 * Anyone reading the storage file learned how many medications the person
 * takes, which specific ones are running out, and — because the id is stable —
 * could correlate the same medication across a backup taken months apart. Key
 * names are not protected by encrypting values, and a directory listing of a
 * medication cabinet is health information whether or not anything is written
 * inside the entries.
 *
 * It is now one encrypted record for the whole map, in the same per-account
 * store as the queue and the schedule: `{ [medicationId]: 'YYYY-MM-DD' }`. The
 * medication ids move inside the ciphertext, where they were always supposed
 * to be, and the number of entries stops being visible too.
 */

const SLOT: CacheSlot = { plaintextKey: 'dawaee.lowStockSnooze' };

/**
 * The prefix the old per-medication keys used. Nothing writes it any more; it
 * exists so the migration can find what earlier builds left behind, and it is
 * the ONLY prefix the sweep will touch — enumeration is scoped to keys this app
 * demonstrably owns rather than to everything in the store.
 */
const LEGACY_PREFIX = 'dawaee.lowStockSnoozedUntil.';

export { SLOT as LOW_STOCK_SLOT, LEGACY_PREFIX as LOW_STOCK_LEGACY_PREFIX };

type SnoozeMap = Record<string, string>;

function parse(raw: string | null): SnoozeMap {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: SnoozeMap = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      // A date, and nothing else. Anything malformed is dropped rather than
      // trusted into a comparison that decides whether a low-stock warning is
      // shown to a patient who is about to run out.
      if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Drop entries whose date has passed.
 *
 * Expiration is enforced on every read rather than only at the comparison
 * site, so the record shrinks by itself. Without this, a patient who snoozed
 * forty medications over a year would carry forty ids in the ciphertext
 * forever — still encrypted, but pointlessly, and every one of them is an id
 * that a future decryption failure or key compromise would expose.
 */
function prune(map: SnoozeMap, today: string): SnoozeMap {
  const out: SnoozeMap = {};
  for (const [id, until] of Object.entries(map)) if (today < until) out[id] = until;
  return out;
}

/**
 * Fold any legacy per-medication keys into the map, then delete them.
 *
 * Same ordering discipline as every other migration here, and for the same
 * reason: build the merged value, persist it, and only then remove the
 * originals. A crash before the write leaves the legacy keys untouched and the
 * next launch retries; a crash after it leaves duplicates that the next launch
 * removes. Nothing is destroyed before its replacement is stored.
 *
 * ENCRYPTED WINS. A legacy key and an encrypted entry for the same medication
 * means the encrypted one was written later — the plaintext path stopped being
 * written the moment this build shipped — so the encrypted value is kept and
 * the legacy one is discarded, never merged over the top. Otherwise a snooze
 * the patient had already cancelled by refilling could come back and suppress a
 * warning about a medication that had genuinely run out.
 *
 * Enumeration is limited to `LEGACY_PREFIX`. `getAllKeys` returns everything
 * in the app's store including other libraries' entries, and a broad sweep that
 * guessed at ownership is how a migration deletes somebody else's data.
 */
async function migrateLegacy(userId: string, current: SnoozeMap): Promise<SnoozeMap> {
  let allKeys: readonly string[];
  try {
    allKeys = await AsyncStorage.getAllKeys();
  } catch {
    return current;
  }
  const legacy = allKeys.filter((k) => k.startsWith(LEGACY_PREFIX));
  if (legacy.length === 0) return current;

  const merged: SnoozeMap = { ...current };
  let found = 0;
  for (const key of legacy) {
    const medicationId = key.slice(LEGACY_PREFIX.length);
    if (!medicationId) continue;
    const until = await AsyncStorage.getItem(key).catch(() => null);
    if (until === null || !/^\d{4}-\d{2}-\d{2}$/.test(until)) continue;
    found += 1;
    // Encrypted state already knows about this medication: keep it.
    if (merged[medicationId] === undefined) merged[medicationId] = until;
  }

  if (found > 0) {
    const result = await writeSlot(SLOT, userId, JSON.stringify(merged));
    // Persist first. A failure here leaves the legacy keys exactly where they
    // are — the only copy — and the migration retries on the next read.
    if (!result.ok) return merged;
  }

  // Best effort, and never fatal: if this fails the keys stay, the encrypted
  // record already holds their contents, and the next launch tries again. The
  // merge above is what keeps a repeatedly-failing cleanup harmless, because a
  // legacy key can never overwrite the encrypted value it was folded into.
  await AsyncStorage.multiRemove([...legacy]).catch(() => undefined);
  return merged;
}

/**
 * Every medication currently snoozed, keyed by id.
 *
 * Migrates and prunes on the way. Returns an empty map rather than throwing
 * when the record cannot be read: a decryption failure must not stop a stock
 * screen from rendering, and the conservative outcome of an empty map is that
 * the low-stock warning SHOWS — which is the safe direction to fail for a
 * patient about to run out of a medication.
 */
export async function readSnoozes(userId: string | null, today: string): Promise<SnoozeMap> {
  if (!userId) return {};
  let stored: SnoozeMap;
  try {
    stored = parse(await readSlot(SLOT, userId));
  } catch {
    stored = {};
  }
  const merged = await migrateLegacy(userId, stored);
  return prune(merged, today);
}

/** The date this medication is snoozed until, or null. */
export async function readSnooze(
  userId: string | null, medicationId: string, today: string,
): Promise<string | null> {
  return (await readSnoozes(userId, today))[medicationId] ?? null;
}

/**
 * Snooze one medication until `until`.
 *
 * A failure is swallowed deliberately, unlike a queued dose action: the worst
 * case here is that the banner reappears, which errs toward warning the patient
 * about low stock rather than away from it.
 */
export async function setSnooze(
  userId: string | null, medicationId: string, until: string, today: string,
): Promise<void> {
  if (!userId) return;
  const map = await readSnoozes(userId, today);
  map[medicationId] = until;
  await writeSlot(SLOT, userId, JSON.stringify(map));
}

/** Forget one medication's snooze — what a refill does. */
export async function clearSnooze(
  userId: string | null, medicationId: string, today: string,
): Promise<void> {
  if (!userId) return;
  const map = await readSnoozes(userId, today);
  if (map[medicationId] === undefined) return;
  delete map[medicationId];
  await writeSlot(SLOT, userId, JSON.stringify(map));
}

/**
 * Remove this user's snooze record and any legacy keys.
 *
 * Called from the sign-out purge. The legacy keys are swept unconditionally
 * because they were never account-scoped in the first place — that was part of
 * the defect — so the only safe thing to do with one at sign-out is delete it.
 */
export async function purgeSnoozes(userId: string | null): Promise<void> {
  if (userId) await clearSlot(SLOT, userId);
  try {
    const all = await AsyncStorage.getAllKeys();
    const legacy = all.filter((k) => k.startsWith(LEGACY_PREFIX));
    if (legacy.length) await AsyncStorage.multiRemove([...legacy]);
  } catch {
    // Best effort; a failure must not block sign-out.
  }
}
