import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { fromBase64, generateKey, KEY_BYTES, toBase64 } from './crypto.js';

/**
 * The key that protects the local medication cache, and the identity it is
 * bound to.
 *
 * ── WHERE IT LIVES ────────────────────────────────────────────────────────
 *
 * The same place as the session tokens: `expo-secure-store`, the iOS Keychain
 * and Android's Keystore-backed EncryptedSharedPreferences. Never AsyncStorage
 * — a key stored beside the ciphertext it protects is not a key, it is a
 * decoration — and never derived from the device id, the install id, or
 * anything else an attacker holding the phone can also read. 256 bits from the
 * platform CSPRNG, and nothing else.
 *
 * ── ACCESSIBILITY ─────────────────────────────────────────────────────────
 *
 * `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`, for the same reasons as the session
 * token and one more that is specific to this key.
 *
 * The reminder's "Taken" and "Skip" buttons are handled without opening the
 * app, from the lock screen, and that handler queues the action when the
 * network is down. If the key were `WHEN_UNLOCKED` the queue write would fail
 * at exactly that moment and the confirmation would be lost — the dose marked
 * missed, the family alerted. `AFTER_FIRST_UNLOCK` keeps it readable while the
 * screen is locked and unreadable on a phone seized powered-off.
 *
 * `requireAuthentication` is NOT set, and this is the point the audit asked
 * about directly: putting a biometric prompt on the key would mean the
 * headless notification handler cannot write to the queue without a person
 * present, which defeats the feature it exists to support. The App Lock is not
 * weakened to achieve this — it is a separate layer, applied to the UI, and it
 * keeps working exactly as specified. Nothing here claims biometric binding.
 *
 * ── BACKUP / RESTORE ──────────────────────────────────────────────────────
 *
 * `_THIS_DEVICE_ONLY` keeps the key out of an encrypted iCloud backup, and
 * `android.allowBackup=false` keeps app data out of Android Auto Backup. So a
 * restore onto a new phone arrives with neither the key nor, on Android, the
 * ciphertext. That is the intended outcome: PHI cached on the old device does
 * not silently reappear on the new one, and the server rebuilds it after a
 * sign-in.
 *
 * ── ACCOUNT BINDING ───────────────────────────────────────────────────────
 *
 * One key per user, under a key name that contains the user id. Two accounts
 * on a shared phone — a parent and an adult child, which is precisely the
 * situation this app's family features create — must not be able to read each
 * other's cache, and a single device-wide key would let exactly that happen
 * the moment a stale cache outlived a sign-out. Binding it to the account makes
 * the isolation structural rather than something sign-out has to remember.
 */

const KEY_PREFIX = 'dawaee.cacheKey.v1.';

/**
 * Bumped only when the key material's meaning changes. It is recorded in every
 * envelope, so ciphertext written under an older generation is recognised as
 * undecryptable-by-design rather than reported as corruption.
 */
export const KEY_VERSION = 1;

interface SecureStoreModule {
  getItemAsync: (key: string, options?: object) => Promise<string | null>;
  setItemAsync: (key: string, value: string, options?: object) => Promise<void>;
  deleteItemAsync: (key: string, options?: object) => Promise<void>;
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY?: unknown;
}

function secureStore(): SecureStoreModule | null {
  if (Platform.OS === 'web') return null;
  const mod = SecureStore as Partial<SecureStoreModule>;
  if (
    typeof mod.getItemAsync !== 'function'
    || typeof mod.setItemAsync !== 'function'
    || typeof mod.deleteItemAsync !== 'function'
  ) return null;
  return mod as SecureStoreModule;
}

function accessOptions(store: SecureStoreModule): object {
  const level = store.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY;
  return level === undefined ? {} : { keychainAccessible: level };
}

/**
 * SecureStore key names are restricted to alphanumerics, `.`, `-` and `_`.
 * User ids are UUIDs, which qualify, but the value is checked rather than
 * trusted: a name that fails validation at the platform layer would surface as
 * a write error at sign-in, and an unvalidated identifier reaching a key name
 * is how one account ends up reading another's entry.
 */
function keyNameFor(userId: string): string {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(userId)) throw new CacheKeyUnavailable('bad identity');
  return `${KEY_PREFIX}${userId}`;
}

export class CacheKeyUnavailable extends Error {
  constructor(readonly reason: string) {
    super(`local cache key unavailable (${reason})`);
    this.name = 'CacheKeyUnavailable';
  }
}

/**
 * The key for this user, creating one on first use.
 *
 * Returns null when there is no secure store — web, or a build without the
 * native module. Null means "do not persist", never "persist in the clear":
 * every caller treats it as a refusal, which is what makes the whole design
 * fail closed rather than fall back.
 */
export async function getOrCreateCacheKey(userId: string): Promise<Uint8Array | null> {
  const store = secureStore();
  if (!store) return null;
  const name = keyNameFor(userId);
  const opts = accessOptions(store);

  let existing: string | null = null;
  try {
    existing = await store.getItemAsync(name, opts);
  } catch {
    // Keystore invalidated (passcode or biometric enrolment changed), or the
    // entry is unreadable. Do NOT mint a replacement here: that would silently
    // orphan every existing ciphertext and look identical to a first run. The
    // caller decides, and `resetCacheKey` is the deliberate way to do it.
    throw new CacheKeyUnavailable('unreadable');
  }

  if (existing) {
    const bytes = fromBase64(existing);
    if (bytes.length === KEY_BYTES) return bytes;
    // A wrong-sized key is not usable and not repairable.
    throw new CacheKeyUnavailable('malformed');
  }

  const fresh = generateKey();
  try {
    await store.setItemAsync(name, toBase64(fresh), opts);
  } catch {
    throw new CacheKeyUnavailable('write failed');
  }
  return fresh;
}

/** The key if one exists, without creating one. */
export async function peekCacheKey(userId: string): Promise<Uint8Array | null> {
  const store = secureStore();
  if (!store) return null;
  try {
    const raw = await store.getItemAsync(keyNameFor(userId), accessOptions(store));
    if (!raw) return null;
    const bytes = fromBase64(raw);
    return bytes.length === KEY_BYTES ? bytes : null;
  } catch {
    return null;
  }
}

/**
 * Destroy this user's key.
 *
 * Called on sign-out, and it is what makes sign-out meaningful: without the
 * key, every cached record for that account is unreadable ciphertext whatever
 * else fails to be cleaned up. Best effort, because a failure here must never
 * trap someone in a session they are trying to leave — the caller deletes the
 * ciphertext too, so both would have to fail for anything to survive, and even
 * then what survives is undecryptable once the key goes on a later attempt.
 */
export async function destroyCacheKey(userId: string): Promise<void> {
  const store = secureStore();
  if (!store) return;
  await store.deleteItemAsync(keyNameFor(userId), accessOptions(store)).catch(() => undefined);
}

/**
 * Throw the key away and mint a new one.
 *
 * The recovery path for a key that has become permanently unusable: an Android
 * Keystore entry invalidated by a passcode change, a corrupted secure store, a
 * restore onto a different device. Everything encrypted under the old key
 * becomes permanently unreadable, which is the correct and only safe outcome —
 * the alternative would be some weaker fallback, and there is no such thing as
 * a safe insecure fallback for a medication history. The cached schedule is
 * rebuilt from the server on the next sync; unsent queued actions are lost,
 * which is documented rather than hidden.
 */
export async function resetCacheKey(userId: string): Promise<Uint8Array | null> {
  await destroyCacheKey(userId);
  const store = secureStore();
  if (!store) return null;
  const fresh = generateKey();
  try {
    await store.setItemAsync(keyNameFor(userId), toBase64(fresh), accessOptions(store));
  } catch {
    throw new CacheKeyUnavailable('write failed');
  }
  return fresh;
}
