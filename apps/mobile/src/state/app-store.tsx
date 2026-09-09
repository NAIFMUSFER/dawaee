import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import * as Localization from 'expo-localization';
import type { Locale } from '@dawaee/shared';
import { api, clearSession, getDeviceId, isSignedIn, loadStoredSession, NetworkError, setUnauthenticatedHandler, storeSession } from '../api/client.js';
import { getRestoredSessionUserId } from '../api/restored-session-owner.js';
import type { ProfileSummary } from '../api/types.js';
import {
  flushQueue, purgeLocalCaches, queueSize, readOfflineBootstrap,
  setCacheOwner, writeOfflineBootstrap,
} from '../storage/offline-queue.js';
import { applyNativeDirection } from '../i18n/index.js';
import { cancelAllLocalNotifications, rebuildRemindersFromCache } from '../notifications/index.js';
import { destroyCacheKey } from '../storage/cache-key.js';

/**
 * Application state: who is signed in, which patient profile is selected, and
 * the accessibility preferences that reshape the whole UI.
 *
 * Preferences live on the SERVER, not only on the device: an elderly patient
 * who gets a new phone should not have to rediscover elderly mode, and a
 * family member setting it up for them should have it stick.
 */

export interface Preferences {
  locale: Locale;
  numeralSystem: 'latn' | 'arab';
  calendarSystem: 'gregory' | 'islamic-umalqura';
  elderlyMode: boolean;
  textScale: number;
  highContrast: boolean;
  voiceRemindersEnabled: boolean;
  voiceConfirmationEnabled: boolean;
  showMedicationInNotifications: boolean;
  appLockEnabled: boolean;
  appLockAreas: string[];
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
  defaultSnoozeMinutes: number;
  lowStockThresholdDays: number;
  expiryWarningDays: number;
}

const DEFAULT_PREFERENCES: Preferences = {
  locale: 'ar',
  numeralSystem: 'latn',
  calendarSystem: 'gregory',
  elderlyMode: false,
  textScale: 1,
  highContrast: false,
  voiceRemindersEnabled: false,
  voiceConfirmationEnabled: false,
  // Private by default. A patient opts in to being named on their lock screen.
  showMedicationInNotifications: false,
  appLockEnabled: false,
  appLockAreas: [],
  quietHoursStart: null,
  quietHoursEnd: null,
  defaultSnoozeMinutes: 10,
  lowStockThresholdDays: 7,
  expiryWarningDays: 30,
};

export interface AppState {
  ready: boolean;
  signedIn: boolean;
  user: { id: string; displayName: string; phoneE164: string | null } | null;
  preferences: Preferences;
  profiles: ProfileSummary[];
  activeProfile: ProfileSummary | null;
  deviceId: string;
  offline: boolean;
  pendingSyncCount: number;
  restartRequiredForRtl: boolean;
  /**
   * When a password was last presented and accepted, epoch ms; null if none has
   * been in this process.
   *
   * Deliberately NOT the same thing as `signedIn`, and the distinction is a
   * security boundary rather than bookkeeping. `signedIn` becomes true whenever
   * a session exists — including the cold-start path, where a refresh token
   * read from storage is exchanged for a session with nobody present. The app
   * lock's recovery route must require an actual credential, so it watches this
   * and not `signedIn`; the first draft watched `signedIn` and, because a
   * restored session flips it from false to true, the lock cleared itself on
   * every cold start and enforced nothing at all.
   *
   * Set in exactly one place: `signInWithTokens`, which both auth screens call
   * immediately after the server accepted a password. Silent token refresh does
   * not touch it.
   */
  credentialVerifiedAt: number | null;
}

export interface AppActions {
  signInWithTokens: (tokens: { accessToken: string; refreshToken: string }) => Promise<void>;
  signOut: () => Promise<void>;
  refreshProfiles: () => Promise<void>;
  setActiveProfile: (profileId: string) => void;
  updatePreferences: (patch: Partial<Preferences>) => Promise<void>;
  syncNow: () => Promise<void>;
  setOffline: (offline: boolean) => void;
}

const AppContext = createContext<(AppState & AppActions) | null>(null);

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<AppState>({
    ready: false,
    signedIn: false,
    user: null,
    // Start from the device language so the very first screen is already right.
    preferences: {
      ...DEFAULT_PREFERENCES,
      locale: (Localization.getLocales()[0]?.languageCode === 'en' ? 'en' : 'ar') as Locale,
    },
    profiles: [],
    activeProfile: null,
    deviceId: '',
    offline: false,
    pendingSyncCount: 0,
    restartRequiredForRtl: false,
    credentialVerifiedAt: null,
  });

  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  /**
   * The latest state, readable from a callback that was memoised before it.
   *
   * `signOut` is built once by `useMemo` and therefore closes over the state of
   * the render that created it — which at that point had no user. It needs the
   * id of the person signing out in order to destroy THEIR encryption key, so
   * it reads through this ref rather than through the stale closure.
   */
  const stateRef = useRef(state);
  stateRef.current = state;

  /**
   * An async profile/bootstrap request belongs to exactly one authenticated
   * session. Logout, forced unauthentication and a fresh password sign-in all
   * bump this generation, making any response already in flight stale before
   * it can bind cache ownership or resurrect signed-in state.
   */
  const sessionGeneration = useRef(0);
  // A session fence alone does not order two reads within the same session.
  // An older profile list must not restore permissions a newer read removed.
  const profileLoadGeneration = useRef(0);
  const syncGeneration = useRef(0);

  /**
   * Preference writes are optimistic and may overlap. Only the newest local
   * intent may commit an asynchronous response/error back into app state; an
   * older response must not undo a newer privacy/accessibility choice.
   */
  const preferenceGeneration = useRef(0);
  const preferenceWrites = useRef({
    session: -1, pending: 0, tail: Promise.resolve() as Promise<void>,
  });

  /**
   * Sign-out/privacy cleanup is asynchronous. A very fast re-login must not
   * create a newer session or cache namespace while an older sign-out can still
   * clear credentials, erase cache data, or publish signed-out UI state.
   */
  const authCleanupInFlight = useRef<Promise<void>>(Promise.resolve());
  // An explicit logout keeps its credentials only for remote deregistration.
  // No new account may enter until its entire local privacy sweep has settled.
  const signOutInFlight = useRef<Promise<void> | null>(null);

  /**
   * Snapshot writes are serialized for the same reason preference PATCHes are:
   * an older write must never land after a newer App Lock/privacy choice. The
   * sign-out barriers below also await this tail before purging local storage,
   * so a late write cannot recreate encrypted account state after cleanup.
   */
  const offlineBootstrapWrites = useRef<Promise<void>>(Promise.resolve());
  const persistOfflineBootstrap = useCallback((
    user: { id: string; displayName: string; phoneE164: string | null },
    preferences: Preferences,
    selfProfile: ProfileSummary | null,
  ): Promise<void> => {
    const work = offlineBootstrapWrites.current
      .catch(() => undefined)
      .then(async () => {
        await writeOfflineBootstrap(user.id, { version: 1, user, preferences, selfProfile });
      })
      .catch(() => undefined);
    offlineBootstrapWrites.current = work;
    return work;
  }, []);

  const loadMe = useCallback(async () => {
    const generation = sessionGeneration.current;
    const request = ++profileLoadGeneration.current;
    const isCurrent = () => mounted.current && generation === sessionGeneration.current
      && request === profileLoadGeneration.current && isSignedIn();
    if (!isCurrent() || signOutInFlight.current) return;
    const preferenceSnapshot = preferenceGeneration.current;
    const preferencesPendingAtStart = preferenceWrites.current.session === generation
      && preferenceWrites.current.pending > 0;
    const me = await api.get<{
      user: { id: string; displayName: string; phoneE164: string | null };
      preferences: Preferences;
    }>('/v1/me');
    if (!isCurrent()) return;
    const profilesRes = await api.get<{ profiles: ProfileSummary[] }>('/v1/profiles');
    if (!isCurrent()) return;

    // Bind local encrypted storage to this account BEFORE any cache read or
    // write can happen. Every slot is keyed and encrypted per user, so this is
    // what keeps two people sharing a phone out of each other's medication
    // history — and it must be set before the first `readQueue`, not after.
    setCacheOwner(me.user.id);

    // Profile/bootstrap refreshes are allowed to finish after a preference
    // write, but their older preference snapshot is not. Otherwise a slow
    // /v1/profiles response can restore the pre-save locale/privacy settings
    // after the newer PATCH has already committed. Keep the profile refresh,
    // and apply only the preference portion if no newer local intent exists.
    // A GET started during a pending save may also read the pre-save row,
    // even if the save finishes before that GET response reaches this code.
    const preferencesAreCurrent = preferenceSnapshot === preferenceGeneration.current
      && !preferencesPendingAtStart
      && !(preferenceWrites.current.session === generation && preferenceWrites.current.pending > 0);
    const serverPreferences = { ...DEFAULT_PREFERENCES, ...me.preferences };
    const effectivePreferences = preferencesAreCurrent ? serverPreferences : stateRef.current.preferences;
    const ownedSelfProfile = profilesRes.profiles.find((p) => p.isSelf && p.role === 'owner') ?? null;

    // Write the encrypted offline bootstrap before reporting this refresh as
    // complete. If a logout starts while the write is in flight, its privacy
    // sweep waits for the same tail and purges it afterwards.
    await persistOfflineBootstrap(me.user, effectivePreferences, ownedSelfProfile);
    if (!isCurrent()) return;

    const restartRequired = preferencesAreCurrent
      ? applyNativeDirection(serverPreferences.locale).restartRequired
      : null;
    setState((s) => ({
      ...s,
      signedIn: true,
      user: me.user,
      preferences: preferencesAreCurrent ? serverPreferences : s.preferences,
      profiles: profilesRes.profiles,
      activeProfile:
        profilesRes.profiles.find((p) => p.id === s.activeProfile?.id) ??
        profilesRes.profiles.find((p) => p.isSelf) ??
        profilesRes.profiles[0] ??
        null,
      restartRequiredForRtl: preferencesAreCurrent ? restartRequired! : s.restartRequiredForRtl,
    }));
  }, [persistOfflineBootstrap]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Installation identity is useful for push and replay, but it is not an
      // authentication credential. If AsyncStorage is temporarily unavailable,
      // do not strand the user before session recovery or the sign-in screen.
      // getDeviceId clears its single-flight handle after failure, so later
      // push/sync callers can retry durable identity creation normally.
      const deviceId = await getDeviceId().catch(() => '');
      const hasSession = await loadStoredSession();
      const bootstrapGeneration = sessionGeneration.current;

      // `loadMe` normally binds this from /v1/me. On a genuine offline process
      // restart that request cannot complete, yet the product deliberately keeps
      // the stored session signed in so its encrypted schedule and queued dose
      // actions remain usable. Recover only the local account namespace from the
      // Keychain/Keystore-backed Dawaee token before the first cache operation.
      // Malformed/unfamiliar tokens resolve to null and storage stays fail-closed.
      const restoredUserId = hasSession ? await getRestoredSessionUserId() : null;
      setCacheOwner(restoredUserId);

      setUnauthenticatedHandler(async () => {
        // Explicit logout already owns the privacy sweep. A rejection of its
        // retiring credentials must not replace that barrier or invalidate a
        // newer login intent which is waiting for the same cleanup.
        if (signOutInFlight.current) return;
        // Invalidate every profile/bootstrap request that started under the
        // session the server has just rejected before doing any async cleanup.
        sessionGeneration.current++;
        // On a cold-start rejection /v1/me may never have populated React
        // state. The owner recovered from the secure session is still the
        // authoritative local namespace that must be purged and cryptoshredded.
        const previousUserId = stateRef.current.user?.id ?? restoredUserId ?? null;
        const precedingSnapshotWrites = offlineBootstrapWrites.current;
        setCacheOwner(null);
        setState((s) => ({ ...s, signedIn: false, user: null, profiles: [], activeProfile: null, credentialVerifiedAt: null }));

        const cleanup = (async () => {
          // A revoked/disabled session is still a sign-out on this physical
          // device. Cancel OS-held medication reminders and remove local PHI;
          // otherwise a shared/lost phone can keep displaying a former
          // account's reminders after the UI says it is signed out.
          await cancelAllLocalNotifications().catch(() => undefined);
          await precedingSnapshotWrites.catch(() => undefined);
          await purgeLocalCaches(previousUserId).catch(() => undefined);
          if (previousUserId) await destroyCacheKey(previousUserId).catch(() => undefined);
        })();
        authCleanupInFlight.current = cleanup;
        await cleanup;
      });

      if (!hasSession) {
        if (!cancelled) setState((s) => ({ ...s, ready: true, deviceId }));
        return;
      }
      try {
        await loadMe();
      } catch (err) {
        // Only a transport failure permits offline restoration. An HTTP denial,
        // service error or invalid response must not become cached authority.
        // Keep credentials and queued actions for recovery without exposing the
        // snapshot. Genuine offline starts retain the owned self profile and
        // preferences; credential verification remains process-local.
        if (
          err instanceof NetworkError
          && !cancelled
          && isSignedIn()
          && bootstrapGeneration === sessionGeneration.current
        ) {
          const snapshot = restoredUserId ? await readOfflineBootstrap(restoredUserId) : null;
          if (
            !cancelled
            && isSignedIn()
            && bootstrapGeneration === sessionGeneration.current
          ) {
            if (snapshot) {
              const profiles = snapshot.selfProfile ? [snapshot.selfProfile] : [];
              const { restartRequired } = applyNativeDirection(snapshot.preferences.locale);
              const restored = {
                signedIn: true,
                offline: true,
                user: snapshot.user,
                preferences: snapshot.preferences,
                profiles,
                activeProfile: snapshot.selfProfile,
                restartRequiredForRtl: restartRequired,
                credentialVerifiedAt: null,
              };
              stateRef.current = { ...stateRef.current, ...restored };
              setState((s) => ({ ...s, ...restored }));
            } else {
              setState((s) => ({ ...s, offline: true, signedIn: true }));
            }
          }
        }
      }
      const pending = await queueSize();
      if (!cancelled) setState((s) => ({ ...s, ready: true, deviceId, pendingSyncCount: pending }));
    })();
    return () => { cancelled = true; };
  }, [loadMe]);

  const syncNow = useCallback(async () => {
    const generation = sessionGeneration.current;
    const request = ++syncGeneration.current;
    const isCurrent = () => mounted.current && generation === sessionGeneration.current
      && request === syncGeneration.current && isSignedIn();
    if (!isCurrent() || signOutInFlight.current) return;
    const deviceId = await getDeviceId();
    if (!isCurrent()) return;
    const result = await flushQueue(deviceId);
    if (!isCurrent()) return;
    const pending = await queueSize();
    if (!isCurrent()) return;
    setState((s) => ({ ...s, offline: result.offline, pendingSyncCount: pending }));
    if (!result.offline) await loadMe().catch(() => undefined);
  }, [loadMe]);

  const actions = useMemo<AppActions>(() => ({
    signInWithTokens: async (tokens) => {
      // Capture intent BEFORE waiting. A later logout or login must supersede
      // this attempt even while earlier local privacy cleanup is still running.
      const generation = ++sessionGeneration.current;
      const isCurrent = () => mounted.current && generation === sessionGeneration.current;
      await authCleanupInFlight.current.catch(() => undefined);
      if (!isCurrent()) return;
      await storeSession(tokens);
      if (!isCurrent()) return;
      await loadMe();
      if (!isCurrent() || !isSignedIn()) return;
      // Only completion of this current password sign-in may unlock recovery.
      // A stale loadMe returning early is NOT fresh credential verification.
      setState((s) => ({ ...s, ready: true, credentialVerifiedAt: Date.now() }));
    },
    signOut: async () => {
      // Invalidate login/read/write intent immediately, including a login that
      // is waiting behind an already-running logout. Duplicate logout requests
      // share cleanup rather than performing another global sweep later.
      sessionGeneration.current++;
      if (signOutInFlight.current) return signOutInFlight.current;
      const previousUserId = stateRef.current.user?.id ?? null;
      const precedingCleanup = authCleanupInFlight.current;
      const precedingSnapshotWrites = offlineBootstrapWrites.current;
      setCacheOwner(null);
      stateRef.current = {
        ...stateRef.current, signedIn: false, user: null, profiles: [],
        activeProfile: null, credentialVerifiedAt: null,
      };
      setState((s) => ({
        ...s, signedIn: false, user: null, profiles: [],
        activeProfile: null, credentialVerifiedAt: null,
      }));

      // Invalidate OS-held reminders now, not after a device lookup or network
      // timeout. Retiring credentials are used only to deactivate remote push
      // and revoke this session, before clearing the credential store.
      const cancellation = cancelAllLocalNotifications().catch(() => undefined);
      const cleanup = (async () => {
        try {
          const deviceId = await getDeviceId().catch(() => null);
          if (deviceId) {
            await api.delete(`/v1/devices/push-token/${encodeURIComponent(deviceId)}`).catch(() => undefined);
          }
          await api.post('/v1/auth/logout').catch(() => undefined);
        } finally {
          // A keychain deletion failure must not skip cache/key destruction.
          // Both are best effort; no later login may overlap either operation.
          await clearSession().catch(() => undefined);
          await cancellation;
          await precedingCleanup.catch(() => undefined);
          await precedingSnapshotWrites.catch(() => undefined);
          await purgeLocalCaches(previousUserId).catch(() => undefined);
          if (previousUserId) await destroyCacheKey(previousUserId).catch(() => undefined);
        }
      })();
      signOutInFlight.current = cleanup;
      authCleanupInFlight.current = cleanup;
      try {
        await cleanup;
      } finally {
        if (signOutInFlight.current === cleanup) signOutInFlight.current = null;
      }
    },
    refreshProfiles: loadMe,
    setActiveProfile: (profileId) => {
      setState((s) => ({ ...s, activeProfile: s.profiles.find((p) => p.id === profileId) ?? s.activeProfile }));
    },
    updatePreferences: async (patch) => {
      if (!mounted.current) return;
      const generation = sessionGeneration.current;
      const preferenceIntent = ++preferenceGeneration.current;

      // Optimistic: accessibility changes must feel instant to someone who
      // enabled them because the text was too small to read.
      const before = stateRef.current.preferences;
      const next = { ...before, ...patch };
      // Event handlers can run twice before React renders. Publish the latest
      // preference intent to other handlers now, not only on the next render.
      stateRef.current = { ...stateRef.current, preferences: next };
      setState((s) => ({ ...s, preferences: { ...s.preferences, ...patch } }));

      // App Lock and notification privacy must survive a process death that
      // happens before the next network bootstrap. Persist the optimistic local
      // intent immediately, encrypted and owner-only; serialized writes ensure
      // two fast toggles cannot leave the older value on disk.
      const snapshotUser = stateRef.current.user;
      if (snapshotUser && isSignedIn() && !signOutInFlight.current) {
        const ownedSelfProfile = stateRef.current.profiles.find((p) => p.isSelf && p.role === 'owner') ?? null;
        void persistOfflineBootstrap(snapshotUser, next, ownedSelfProfile);
      }

      /**
       * A change to what notifications may say has to reach the notifications
       * that are ALREADY scheduled.
       *
       * Reminders are built up to a week ahead and their text is baked in at
       * scheduling time — the OS holds the rendered string, not a template. So
       * a patient who turns disclosure off would keep receiving named
       * reminders for days, from notifications created before they changed
       * their mind, and would reasonably conclude the setting does nothing.
       * Rebuilding from the cached window works offline and keeps the same
       * doses; only the wording changes.
       */
      const disclosureChanged =
        (patch.showMedicationInNotifications !== undefined
          && patch.showMedicationInNotifications !== before.showMedicationInNotifications)
        || (patch.voiceRemindersEnabled !== undefined
          && patch.voiceRemindersEnabled !== before.voiceRemindersEnabled);
      if (disclosureChanged) {
        // Account preferences govern this person's device, never the patient
        // currently being viewed. Check role too for older API self flags.
        const selfProfileId = stateRef.current.profiles.find((profile) => profile.isSelf && profile.role === 'owner')?.id ?? null;
        void rebuildRemindersFromCache(
          selfProfileId,
          next.locale,
          {
            voiceEnabled: next.voiceRemindersEnabled,
            showMedication: next.showMedicationInNotifications,
          },
        ).catch(() => undefined);
      }
      if (patch.locale) {
        const { restartRequired } = applyNativeDirection(patch.locale);
        setState((s) => ({ ...s, restartRequiredForRtl: restartRequired }));
      }

      // The language screen runs before anyone has an account. There is no
      // server-side "me" to write to yet, and calling anyway earned a 401 that
      // the old catch-all below read as "offline" — so choosing Arabic raised
      // an offline banner on a perfectly healthy connection. The choice is
      // kept locally and travels with the sign-up request instead.
      if (!isSignedIn() || signOutInFlight.current) return;

      // Serialize persistence as well as ignoring old responses: otherwise an
      // earlier PATCH can commit last and restore the old choice on next login.
      // A new session has its own tail so a stalled old request cannot block it.
      if (preferenceWrites.current.session !== generation) {
        preferenceWrites.current = { session: generation, pending: 0, tail: Promise.resolve() };
      }
      const writes = preferenceWrites.current;
      const idle = writes.pending === 0;
      writes.pending++;
      const save = async () => {
        try {
          if (!mounted.current || generation !== sessionGeneration.current || !isSignedIn() || signOutInFlight.current) return;
          const res = await api.patch<{ preferences: Preferences }>('/v1/me/preferences', patch);
          if (
            !mounted.current
            || generation !== sessionGeneration.current
            || preferenceIntent !== preferenceGeneration.current
            || !isSignedIn()
          ) return;

          // The response is a row snapshot, not a new intent for unrelated
          // fields. Accept only submitted fields that the response actually
          // provides; the optimistic patch remains for other fields.
          const savedPatch = Object.fromEntries(Object.keys(patch)
            .filter((key) => Object.prototype.hasOwnProperty.call(res.preferences, key))
            .map((key) => [key, res.preferences[key as keyof Preferences]])) as Partial<Preferences>;
          const savedPreferences = { ...stateRef.current.preferences, ...savedPatch };
          stateRef.current = {
            ...stateRef.current, preferences: savedPreferences,
          };
          setState((s) => ({ ...s, preferences: { ...s.preferences, ...savedPatch } }));
          const savedUser = stateRef.current.user;
          if (savedUser && !signOutInFlight.current) {
            const ownedSelfProfile = stateRef.current.profiles.find((p) => p.isSelf && p.role === 'owner') ?? null;
            void persistOfflineBootstrap(savedUser, savedPreferences, ownedSelfProfile);
          }
        } catch (err) {
          // A response/error from an older preference intent or authenticated
          // session belongs to that request, not to whoever is using the app now.
          if (
            !mounted.current
            || generation !== sessionGeneration.current
            || preferenceIntent !== preferenceGeneration.current
            || !isSignedIn()
          ) return;

          // Only a request that never reached the server means offline. A
          // rejection from the server is a different failure and must not put
          // the whole app into its cached-data mode.
          if (err instanceof NetworkError) setState((s) => ({ ...s, offline: true }));
        } finally {
          writes.pending--;
        }
      };
      const work = idle ? save() : writes.tail.then(save, save);
      writes.tail = work;
      await work;
    },
    syncNow,
    setOffline: (offline) => setState((s) => ({ ...s, offline })),
  }), [loadMe, persistOfflineBootstrap, syncNow]);

  const value = useMemo(() => ({ ...state, ...actions }), [state, actions]);
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppState & AppActions {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used inside AppProvider');
  return ctx;
}

/** Convenience for screens that cannot render without a selected profile. */
export function useActiveProfile(): ProfileSummary {
  const { activeProfile } = useApp();
  if (!activeProfile) throw new Error('no active patient profile selected');
  return activeProfile;
}