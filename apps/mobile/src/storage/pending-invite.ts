import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

/**
 * A caregiver invitation waiting for the recipient to sign in.
 *
 * The invitation token is a bearer capability. It must survive the short
 * sign-in/sign-up detour, but it must not be persisted in plaintext. Native
 * builds therefore use SecureStore. Web has no keychain equivalent, so it is
 * deliberately memory-only there; a reload asks the person to reopen the
 * invitation link rather than leaving a capability token in browser storage.
 *
 * `LEGACY_KEY` is the plaintext AsyncStorage key used by older builds. It is
 * read only for one-way migration and is never written again.
 */
const SECURE_KEY = 'app.dawaee.mobile.pendingInvitationToken.v1';
const LEGACY_KEY = 'dawaee.pendingInvitationToken';

let memoryPendingInvite: string | null = null;

interface SecureStoreModule {
  getItemAsync: (key: string, options?: { keychainAccessible?: unknown }) => Promise<string | null>;
  setItemAsync: (key: string, value: string, options?: { keychainAccessible?: unknown }) => Promise<void>;
  deleteItemAsync: (key: string, options?: { keychainAccessible?: unknown }) => Promise<void>;
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

function secureOptions(store: SecureStoreModule): { keychainAccessible?: unknown } {
  const level = store.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY;
  return level === undefined ? {} : { keychainAccessible: level };
}

async function removeLegacy(): Promise<void> {
  await AsyncStorage.removeItem(LEGACY_KEY).catch(() => undefined);
}

/**
 * Tokens this app process has already tried to redeem.
 *
 * Module scope, not component state, because the accept screen can mount on
 * both sides of the auth detour. One process-wide claim prevents two mounts
 * from burning the same single-use invitation twice.
 */
const attempted = new Set<string>();

export function claimInviteAttempt(token: string): boolean {
  if (attempted.has(token)) return false;
  attempted.add(token);
  return true;
}

export async function stashPendingInvite(token: string): Promise<void> {
  memoryPendingInvite = token;

  const store = secureStore();
  if (!store) {
    // Browser: memory-only by policy. Also erase any plaintext copy an older
    // web build may have left behind.
    await removeLegacy();
    return;
  }

  // No AsyncStorage fallback. If the keychain write fails, the token remains
  // available only for this process; reopening the original invitation link is
  // safer than persisting a bearer capability in plaintext.
  await store.setItemAsync(SECURE_KEY, token, secureOptions(store)).catch(() => undefined);
  await removeLegacy();
}

/** The waiting token, if any. Does not consume it. */
export async function peekPendingInvite(): Promise<string | null> {
  if (memoryPendingInvite) return memoryPendingInvite;

  const store = secureStore();
  if (!store) {
    await removeLegacy();
    return null;
  }

  const options = secureOptions(store);
  const secureValue = await store.getItemAsync(SECURE_KEY, options).catch(() => null);
  if (secureValue) {
    memoryPendingInvite = secureValue;
    await removeLegacy();
    return secureValue;
  }

  // One-time migration from the old plaintext key. Write the secure copy first
  // when possible, then erase the plaintext copy. Even if SecureStore is
  // temporarily unavailable, the legacy copy is deleted and kept only in
  // process memory for the current auth detour.
  const legacy = await AsyncStorage.getItem(LEGACY_KEY).catch(() => null);
  if (!legacy) return null;

  memoryPendingInvite = legacy;
  await store.setItemAsync(SECURE_KEY, legacy, options).catch(() => undefined);
  await removeLegacy();
  return legacy;
}

/** Forget a used, expired or refused invitation everywhere it could exist. */
export async function clearPendingInvite(): Promise<void> {
  memoryPendingInvite = null;
  const store = secureStore();
  if (store) {
    await store.deleteItemAsync(SECURE_KEY, secureOptions(store)).catch(() => undefined);
  }
  await removeLegacy();
}

/**
 * Where to go after signing in.
 *
 * The invitation wins over the normal landing screen: this person opened a
 * link to be let into someone's care circle, and finishing that is what they
 * came for.
 */
export async function landingAfterAuth(): Promise<'/caregiver/accept' | '/(tabs)/today'> {
  return (await peekPendingInvite()) ? '/caregiver/accept' : '/(tabs)/today';
}
