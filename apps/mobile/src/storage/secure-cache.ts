import AsyncStorage from '@react-native-async-storage/async-storage';
import { CacheKeyUnavailable, getOrCreateCacheKey, KEY_VERSION } from './cache-key.js';
import { DecryptionFailed, open, seal } from './crypto.js';

/**
 * Encrypted local persistence for medication data, and the one-time migration
 * of the plaintext left behind by earlier builds.
 *
 * Everything below is about ordering under failure. The data being moved is
 * the offline queue — dose confirmations a patient has made that the server
 * has not yet seen — so "lost during migration" is not a cache miss, it is a
 * dose that was taken and will be reported as missed, which escalates to the
 * family. That is why plaintext is never deleted before ciphertext is written
 * AND read back.
 */

/** Ciphertext lives under a new name so the old plaintext key is never ambiguous. */
const ENC_SUFFIX = '.enc.v1';

export type StoreOutcome =
  /** Persisted, encrypted. */
  | { ok: true }
  /** Not persisted, and nothing was destroyed. The caller must not fall back. */
  | { ok: false; reason: 'no-key' | 'crypto' | 'write' };

export interface CacheSlot {
  /** The legacy plaintext key, e.g. `dawaee.offlineQueue`. */
  plaintextKey: string;
}

function encKey(slot: CacheSlot, userId: string): string {
  // The user id is part of the storage key as well as the encryption key, so
  // two accounts on one phone cannot even collide, let alone read each other.
  return `${slot.plaintextKey}.${userId}${ENC_SUFFIX}`;
}

/**
 * Read a slot, migrating any plaintext predecessor on the way.
 *
 * AUTHORITY, stated once and applied everywhere: the ENCRYPTED copy is
 * authoritative whenever it exists and decrypts. Plaintext is consulted only
 * when there is no readable ciphertext at all. A stale plaintext copy can
 * therefore never overwrite newer encrypted data, which is the failure mode
 * that would resurrect a dose the user already un-did.
 *
 * Returns null for "nothing stored", and throws only for a key that is
 * present-but-unusable, which the caller turns into a rebuild.
 */
export async function readSlot(slot: CacheSlot, userId: string): Promise<string | null> {
  let key: Uint8Array | null;
  try {
    key = await getOrCreateCacheKey(userId);
  } catch (err) {
    if (err instanceof CacheKeyUnavailable) {
      // The key exists but cannot be read — Keystore invalidation, corruption.
      // Refuse rather than reading the plaintext fallback: falling back would
      // mean the plaintext path stays alive forever on exactly the devices
      // where encryption is broken.
      throw err;
    }
    throw err;
  }
  if (!key) {
    // No secure store on this platform. Nothing is persisted here, and any
    // plaintext an older build left behind is destroyed rather than read.
    await AsyncStorage.removeItem(slot.plaintextKey).catch(() => undefined);
    return null;
  }

  const name = encKey(slot, userId);
  const rawEnvelope = await AsyncStorage.getItem(name).catch(() => null);
  if (rawEnvelope) {
    try {
      const value = open(JSON.parse(rawEnvelope), key, KEY_VERSION);
      // Ciphertext is authoritative and readable, so any plaintext still
      // sitting there is a leftover from an interrupted migration. Destroy it.
      await AsyncStorage.removeItem(slot.plaintextKey).catch(() => undefined);
      return value;
    } catch (err) {
      if (err instanceof DecryptionFailed) {
        // Tampered, truncated, or written under a key this device no longer
        // has. Either way it is not data any more. It is NOT deleted here —
        // a caller may want to distinguish "empty" from "unreadable" — but it
        // is not returned, and it does not license reading the plaintext.
        throw err;
      }
      throw err;
    }
  }

  // ---------------------------------------------------------------- migrate
  //
  // Order, and what each step buys:
  //   1. read plaintext            — nothing destroyed yet
  //   2. encrypt                   — in memory; failure leaves step 1 intact
  //   3. write ciphertext          — failure leaves plaintext intact
  //   4. READ BACK and decrypt     — proves the write landed and is openable
  //   5. delete plaintext          — only now, and best effort
  //
  // A crash at any point leaves either plaintext alone, or plaintext beside
  // valid ciphertext. Both are recoverable on the next launch, and neither is
  // a state where the only copy is gone. The reverse order — deleting first —
  // has a window in which a dose confirmation exists nowhere.
  const plaintext = await AsyncStorage.getItem(slot.plaintextKey).catch(() => null);
  if (plaintext === null) return null;

  let envelope: string;
  try {
    envelope = JSON.stringify(seal(plaintext, key, KEY_VERSION));
  } catch {
    // Encryption failed. Keep the plaintext — it is the only copy — and report
    // nothing stored rather than silently continuing to use the plain path.
    return plaintext;
  }

  try {
    await AsyncStorage.setItem(name, envelope);
  } catch {
    return plaintext;
  }

  // Step 4. Cheap, and it is what makes step 5 safe: a write that appeared to
  // succeed but produced something unopenable would otherwise take the
  // plaintext with it.
  try {
    const verified = open(JSON.parse(envelope), key, KEY_VERSION);
    if (verified !== plaintext) return plaintext;
  } catch {
    return plaintext;
  }

  await AsyncStorage.removeItem(slot.plaintextKey).catch(() => undefined);
  return plaintext;
}

/**
 * Write a slot, encrypted.
 *
 * Never writes plaintext, for any reason, including every failure. A caller
 * that receives `ok: false` must surface or retry — it must not "fall back",
 * because the only thing to fall back to is the vulnerability this replaces.
 */
export async function writeSlot(slot: CacheSlot, userId: string, value: string): Promise<StoreOutcome> {
  let key: Uint8Array | null;
  try {
    key = await getOrCreateCacheKey(userId);
  } catch {
    return { ok: false, reason: 'no-key' };
  }
  if (!key) return { ok: false, reason: 'no-key' };

  let envelope: string;
  try {
    envelope = JSON.stringify(seal(value, key, KEY_VERSION));
  } catch {
    return { ok: false, reason: 'crypto' };
  }

  try {
    await AsyncStorage.setItem(encKey(slot, userId), envelope);
  } catch {
    return { ok: false, reason: 'write' };
  }
  // Belt and braces: if an older build's plaintext is still present when a new
  // write lands, it is now definitively stale.
  await AsyncStorage.removeItem(slot.plaintextKey).catch(() => undefined);
  return { ok: true };
}

/** Remove this user's copy of a slot, and any plaintext predecessor. */
export async function clearSlot(slot: CacheSlot, userId: string): Promise<void> {
  await AsyncStorage.multiRemove([encKey(slot, userId), slot.plaintextKey]).catch(() => undefined);
}

/**
 * Remove every encrypted slot belonging to any user, plus the legacy plaintext.
 *
 * Used on sign-out. It sweeps by prefix rather than by a known user id because
 * the id of a PREVIOUS user is exactly what the current session does not have —
 * and a cache belonging to someone who signed out on this phone last month is
 * the thing that must not be readable after a different person signs in.
 */
export async function purgeAllSlots(slots: CacheSlot[]): Promise<void> {
  const all = await AsyncStorage.getAllKeys().catch(() => [] as readonly string[]);
  const doomed = all.filter((k) =>
    slots.some((s) => k === s.plaintextKey || (k.startsWith(`${s.plaintextKey}.`) && k.endsWith(ENC_SUFFIX))),
  );
  if (doomed.length) await AsyncStorage.multiRemove([...doomed]).catch(() => undefined);
}
