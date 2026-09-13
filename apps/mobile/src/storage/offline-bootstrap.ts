import type { ProfileSummary } from '../api/types.js';
import type { Preferences } from '../state/app-store.js';
import { readSlot, writeSlot } from './secure-cache.js';
import type { CacheSlot } from './secure-cache.js';

/**
 * The minimum account-owned state needed to make a genuine offline process
 * restart both useful and safe.
 *
 * This is deliberately NOT a cache of `/v1/profiles`: delegated caregiver
 * access can be revoked while this phone is offline, so only the account's own
 * self profile is eligible for restoration. The slot is encrypted and scoped
 * by user id by `secure-cache`, exactly like the dose queue and Today cache.
 */
export const OFFLINE_BOOTSTRAP_SLOT: CacheSlot = {
  plaintextKey: 'dawaee.offlineBootstrap',
  // This slot did not exist in any plaintext release. Accepting an unscoped
  // predecessor would let arbitrary AsyncStorage data become authenticated
  // account/app-lock state during migration.
  migratePlaintext: false,
};

export interface OfflineBootstrapSnapshot {
  version: 1;
  user: { id: string; displayName: string; phoneE164: string | null };
  preferences: Preferences;
  selfProfile: ProfileSummary | null;
}

const APP_LOCK_AREAS = new Set(['history', 'caregivers', 'personal', 'reports', 'emergency']);
const LOCAL_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const TRAVEL_POLICIES = new Set(['keep_home_time', 'follow_local_time', 'ask']);

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function boundedString(value: unknown, min: number, max: number): value is string {
  return typeof value === 'string' && value.length >= min && value.length <= max;
}

function nullableString(value: unknown, max: number): value is string | null {
  return value === null || (typeof value === 'string' && value.length <= max);
}

function boundedNumber(value: unknown, min: number, max: number, integer = false): value is number {
  return typeof value === 'number'
    && Number.isFinite(value)
    && value >= min
    && value <= max
    && (!integer || Number.isInteger(value));
}

function localTimeOrNull(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && LOCAL_TIME.test(value));
}

function parsePreferences(value: unknown): Preferences | null {
  const p = record(value);
  if (!p) return null;
  if (p.locale !== 'ar' && p.locale !== 'en') return null;
  if (p.numeralSystem !== 'latn' && p.numeralSystem !== 'arab') return null;
  if (p.calendarSystem !== 'gregory' && p.calendarSystem !== 'islamic-umalqura') return null;
  if (typeof p.elderlyMode !== 'boolean') return null;
  if (!boundedNumber(p.textScale, 0.85, 2)) return null;
  if (typeof p.highContrast !== 'boolean') return null;
  if (typeof p.voiceRemindersEnabled !== 'boolean') return null;
  if (typeof p.voiceConfirmationEnabled !== 'boolean') return null;
  if (typeof p.showMedicationInNotifications !== 'boolean') return null;
  if (typeof p.appLockEnabled !== 'boolean') return null;
  if (!Array.isArray(p.appLockAreas)
      || !p.appLockAreas.every((area) => typeof area === 'string' && APP_LOCK_AREAS.has(area))) return null;
  if (!localTimeOrNull(p.quietHoursStart) || !localTimeOrNull(p.quietHoursEnd)) return null;
  if (!boundedNumber(p.defaultSnoozeMinutes, 1, 240, true)) return null;
  if (!boundedNumber(p.lowStockThresholdDays, 1, 60, true)) return null;
  if (!boundedNumber(p.expiryWarningDays, 1, 180, true)) return null;

  return {
    locale: p.locale,
    numeralSystem: p.numeralSystem,
    calendarSystem: p.calendarSystem,
    elderlyMode: p.elderlyMode,
    textScale: p.textScale,
    highContrast: p.highContrast,
    voiceRemindersEnabled: p.voiceRemindersEnabled,
    voiceConfirmationEnabled: p.voiceConfirmationEnabled,
    showMedicationInNotifications: p.showMedicationInNotifications,
    appLockEnabled: p.appLockEnabled,
    appLockAreas: [...p.appLockAreas] as string[],
    quietHoursStart: p.quietHoursStart,
    quietHoursEnd: p.quietHoursEnd,
    defaultSnoozeMinutes: p.defaultSnoozeMinutes,
    lowStockThresholdDays: p.lowStockThresholdDays,
    expiryWarningDays: p.expiryWarningDays,
  };
}

function parseUser(value: unknown): OfflineBootstrapSnapshot['user'] | null {
  const u = record(value);
  if (!u || !boundedString(u.id, 1, 128) || !boundedString(u.displayName, 1, 120)) return null;
  if (!nullableString(u.phoneE164, 24)) return null;
  return { id: u.id, displayName: u.displayName, phoneE164: u.phoneE164 };
}

function parseOwnedSelfProfile(value: unknown): ProfileSummary | null | undefined {
  if (value === null) return null;
  const p = record(value);
  if (!p) return undefined;

  // Delegated access is never authoritative offline. A stale caregiver row in
  // an encrypted cache is still stale authority, so fail the profile closed.
  if (p.isSelf !== true || p.role !== 'owner') return undefined;
  if (!boundedString(p.id, 1, 128) || !boundedString(p.displayName, 1, 80)) return undefined;
  if (!boundedString(p.timezone, 3, 64) || !boundedString(p.homeTimezone, 3, 64)) return undefined;
  if (typeof p.travelPolicy !== 'string' || !TRAVEL_POLICIES.has(p.travelPolicy)) return undefined;
  if (p.birthYear !== null && !boundedNumber(p.birthYear, 1900, new Date().getUTCFullYear(), true)) return undefined;
  if (!nullableString(p.avatarKey, 512)) return undefined;

  return {
    id: p.id,
    displayName: p.displayName,
    isSelf: true,
    timezone: p.timezone,
    homeTimezone: p.homeTimezone,
    travelPolicy: p.travelPolicy as ProfileSummary['travelPolicy'],
    birthYear: p.birthYear,
    avatarKey: p.avatarKey,
    role: 'owner',
    // An owner does not need delegated permission material. Never persist a
    // cached permission list and accidentally turn it into offline authority.
    permissions: null,
  };
}

/** Persist a canonical snapshot. Failure never falls back to plaintext. */
export async function writeOfflineBootstrap(
  userId: string,
  snapshot: OfflineBootstrapSnapshot,
): Promise<boolean> {
  if (snapshot.version !== 1 || snapshot.user.id !== userId) return false;
  const user = parseUser(snapshot.user);
  const preferences = parsePreferences(snapshot.preferences);
  if (!user || !preferences) return false;

  // Write callers may pass a stale delegated row by mistake. Sanitize it to no
  // profile rather than storing authority that cannot be revalidated offline.
  const parsedSelf = parseOwnedSelfProfile(snapshot.selfProfile);
  const selfProfile = parsedSelf === undefined ? null : parsedSelf;
  const canonical: OfflineBootstrapSnapshot = { version: 1, user, preferences, selfProfile };
  const result = await writeSlot(OFFLINE_BOOTSTRAP_SLOT, userId, JSON.stringify(canonical));
  return result.ok;
}

/** Read only a structurally valid snapshot bound to the restored session owner. */
export async function readOfflineBootstrap(expectedUserId: string): Promise<OfflineBootstrapSnapshot | null> {
  let raw: string | null;
  try {
    raw = await readSlot(OFFLINE_BOOTSTRAP_SLOT, expectedUserId);
  } catch {
    return null;
  }
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const root = record(parsed);
  if (!root || root.version !== 1) return null;
  const user = parseUser(root.user);
  const preferences = parsePreferences(root.preferences);
  const selfProfile = parseOwnedSelfProfile(root.selfProfile);
  if (!user || user.id !== expectedUserId || !preferences || selfProfile === undefined) return null;
  return { version: 1, user, preferences, selfProfile };
}
