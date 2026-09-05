import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

/**
 * Where the session tokens live.
 *
 * They used to live in AsyncStorage, which on Android is an unencrypted
 * SQLite database inside the app sandbox and on iOS an unencrypted plist. Both
 * are readable from an ADB backup, from a rooted or jailbroken device, and
 * from a forensic image of a phone that is merely powered off — no passcode
 * required in the last case. What was sitting there was a refresh token with a
 * long life, which is enough to mint access tokens for the account
 * indefinitely: a lost phone was a lost account, and for this app an account is
 * somebody's diagnosis-adjacent medication list.
 *
 * They now live in `expo-secure-store`, which is the iOS Keychain and the
 * Android Keystore-backed EncryptedSharedPreferences. Both are encrypted with
 * a key held by hardware the app cannot extract, and both are unavailable
 * until the device has been unlocked once since boot.
 *
 * Two design decisions worth stating, because they are what the rest of the
 * file falls out of:
 *
 * ONE ENTRY, NOT TWO. The access token and the refresh token are written
 * together as a single JSON value under a single key. Two keys would mean two
 * writes, and a crash or a kill between them leaves a new access token beside
 * a stale refresh token — which after a rotation is a refresh token the server
 * has already invalidated, so the next launch is a signed-out user who did
 * nothing wrong. One key makes the pair atomic at the platform's own level.
 *
 * NO FALLBACK. If the secure store cannot be written, this throws and the
 * caller fails. It never writes the token somewhere else instead. A fallback
 * to AsyncStorage would mean the exact vulnerability this file exists to close
 * would reappear silently on whichever devices the secure path failed on —
 * which are, by definition, the ones nobody is testing.
 */

const SECURE_KEY = 'dawaee.session.v1';

/**
 * The keys the tokens used to be written to, kept only so they can be found
 * and destroyed. Nothing writes these any more.
 */
const LEGACY_ACCESS_KEY = 'dawaee.accessToken';
const LEGACY_REFRESH_KEY = 'dawaee.refreshToken';

export interface SessionTokens {
  accessToken: string;
  refreshToken: string;
}

/**
 * A secure-store operation failed.
 *
 * Carries a reason and never a value. Token strings must not reach an error
 * message, because error messages reach crash reporters, `console` in a dev
 * build, and any `catch` that decides to render `err.message` on screen.
 */
export class TokenStoreUnavailable extends Error {
  constructor(readonly reason: string) {
    super(`secure token storage unavailable (${reason})`);
    this.name = 'TokenStoreUnavailable';
  }
}

interface SecureStoreModule {
  getItemAsync: (key: string) => Promise<string | null>;
  setItemAsync: (key: string, value: string) => Promise<void>;
  deleteItemAsync: (key: string) => Promise<void>;
}

/**
 * The keychain, or null when this platform has none.
 *
 * Never on web. `expo-secure-store` does ship a web entry point, but it is
 * literally `export default {}` — the module imports without error and then
 * every call fails on a missing method. Treating web as "no secure store"
 * explicitly, rather than discovering it through a thrown error at the moment
 * someone signs in, is the difference between a designed behaviour and a bug.
 *
 * The shape is checked rather than assumed for the same reason: a build where
 * the native module was not linked would otherwise reach `setItemAsync` and
 * throw something the caller has to interpret. A missing method means no
 * secure store, and no secure store means fail closed.
 */
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

/**
 * Whether tokens survive an app restart on this platform.
 *
 * False on web, and that is the intended behaviour rather than a limitation
 * being tolerated. The browser offers `localStorage` and `sessionStorage`, and
 * both are plain text readable by any script that reaches the page — a single
 * cross-site scripting bug would hand over a refresh token that mints access
 * to the account for as long as it lives. There is no browser equivalent of
 * the Keychain, so the honest choice is not to persist a long-lived credential
 * in a browser at all: the web session is held in memory for as long as the
 * tab lives, and a reload asks for the password again. The cost is one extra
 * sign-in after a reload; the alternative cost is every XSS becoming a full
 * account takeover of a medical record.
 *
 * A function rather than a constant so it answers for the platform it is asked
 * on, not the one the module happened to load under.
 */
export function persistsAcrossRestart(): boolean {
  return secureStore() !== null;
}

/** Best effort, and deliberately so — see `migrateLegacyTokens`. */
async function removeLegacy(): Promise<void> {
  await AsyncStorage.multiRemove([LEGACY_ACCESS_KEY, LEGACY_REFRESH_KEY]).catch(() => undefined);
}

function parse(raw: string | null): SessionTokens | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<SessionTokens>;
    if (typeof parsed.accessToken !== 'string' || typeof parsed.refreshToken !== 'string') return null;
    if (!parsed.accessToken || !parsed.refreshToken) return null;
    return { accessToken: parsed.accessToken, refreshToken: parsed.refreshToken };
  } catch {
    // A corrupt entry is a signed-out user, not a crash on launch.
    return null;
  }
}

/**
 * Move a pre-existing AsyncStorage session into the secure store, once.
 *
 * Ordering is the whole algorithm, and each step is chosen for what happens if
 * the process dies immediately after it:
 *
 *  1. Read the secure store FIRST. If a session is already there it wins,
 *     unconditionally, and the legacy keys are deleted without being read.
 *     This is what stops an old token from overwriting a newer one: after any
 *     rotation the secure copy is current and the AsyncStorage copy is a
 *     fossil of whatever was valid before the upgrade, and writing the fossil
 *     over the current pair would sign the user out on their next launch. The
 *     secure store is the only source of truth the moment it holds anything.
 *
 *  2. Write before deleting. A crash between the two leaves the token in both
 *     places — recoverable, because the next launch takes step 1 and deletes
 *     the leftover. A crash between a delete and a write would leave it in
 *     neither, which is a signed-out user with no way back but the password.
 *     So the duplicate window is accepted and the gap window is designed out.
 *
 *  3. Deletion is best effort and never fails the migration. If it fails —
 *     storage full, a platform quirk — the tokens are already secure, and the
 *     leftover is deleted on the next launch by step 1. Every path through
 *     this function converges on "legacy keys gone" within one more launch.
 *
 * Idempotent by construction: run it a hundred times and after the first the
 * legacy keys do not exist, so steps 2 and 3 never execute again.
 */
export async function migrateLegacyTokens(): Promise<SessionTokens | null> {
  const store = secureStore();
  if (!store) {
    // No secure store on this platform (web). Legacy tokens must still not be
    // left sitting in browser storage where the old build put them.
    await removeLegacy();
    return null;
  }

  // 1.
  let existing: SessionTokens | null = null;
  try {
    existing = parse(await store.getItemAsync(SECURE_KEY));
  } catch {
    // Unreadable secure store: fail closed. Do NOT fall through to the legacy
    // keys — that would resurrect a plaintext token as a workaround for the
    // very failure that should sign the user out.
    return null;
  }
  if (existing) {
    await removeLegacy();
    return existing;
  }

  // 2.
  const [access, refresh] = await Promise.all([
    AsyncStorage.getItem(LEGACY_ACCESS_KEY).catch(() => null),
    AsyncStorage.getItem(LEGACY_REFRESH_KEY).catch(() => null),
  ]);
  if (!access || !refresh) {
    // A half-written legacy pair is not a session. Clear it rather than
    // leaving one plaintext token behind for nothing.
    if (access || refresh) await removeLegacy();
    return null;
  }

  const tokens: SessionTokens = { accessToken: access, refreshToken: refresh };
  try {
    await store.setItemAsync(SECURE_KEY, JSON.stringify(tokens));
  } catch {
    // The secure write failed. Leave the legacy keys exactly as they are and
    // report no session: the user signs in again, which re-runs the write
    // through the normal path. Returning the legacy tokens here would let the
    // app keep running on plaintext credentials indefinitely.
    return null;
  }

  // 3.
  await removeLegacy();
  return tokens;
}

/** The stored session, or null. Runs the one-time migration on the way. */
export async function readSession(): Promise<SessionTokens | null> {
  return migrateLegacyTokens();
}

/**
 * Persist a session. One key, one write, no fallback.
 *
 * Throws on failure so that a sign-in which cannot be persisted is reported
 * rather than silently producing an app that signs the user out on next
 * launch — or, worse, one that quietly writes the token somewhere weaker.
 */
export async function writeSession(tokens: SessionTokens): Promise<void> {
  const store = secureStore();
  if (!store) {
    if (Platform.OS === 'web') return; // Intentional: in-memory only.
    throw new TokenStoreUnavailable('module unavailable');
  }
  try {
    await store.setItemAsync(SECURE_KEY, JSON.stringify(tokens));
  } catch {
    // Never mention what failed to write.
    throw new TokenStoreUnavailable('write failed');
  }
}

/**
 * Forget the session everywhere it could be.
 *
 * Both the secure entry and the legacy keys, because a sign-out on a device
 * that upgraded before the migration ever ran must not leave a working refresh
 * token in plaintext behind it. Best effort throughout: a failure here must
 * never trap someone in a session they are trying to leave.
 */
export async function clearStoredSession(): Promise<void> {
  const store = secureStore();
  if (store) await store.deleteItemAsync(SECURE_KEY).catch(() => undefined);
  await removeLegacy();
}
