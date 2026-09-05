import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import * as Localization from 'expo-localization';
import type { Locale } from '@dawaee/shared';
import { api, clearSession, getDeviceId, isSignedIn, loadStoredSession, NetworkError, setUnauthenticatedHandler, storeSession } from '../api/client.js';
import type { ProfileSummary } from '../api/types.js';
import { flushQueue, queueSize } from '../storage/offline-queue.js';
import { applyNativeDirection } from '../i18n/index.js';
import { cancelAllLocalNotifications } from '../notifications/index.js';

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

  const loadMe = useCallback(async () => {
    const me = await api.get<{
      user: { id: string; displayName: string; phoneE164: string | null };
      preferences: Preferences;
    }>('/v1/me');
    const profilesRes = await api.get<{ profiles: ProfileSummary[] }>('/v1/profiles');
    if (!mounted.current) return;

    const { restartRequired } = applyNativeDirection(me.preferences.locale);
    setState((s) => ({
      ...s,
      signedIn: true,
      user: me.user,
      preferences: { ...DEFAULT_PREFERENCES, ...me.preferences },
      profiles: profilesRes.profiles,
      activeProfile:
        profilesRes.profiles.find((p) => p.id === s.activeProfile?.id) ??
        profilesRes.profiles.find((p) => p.isSelf) ??
        profilesRes.profiles[0] ??
        null,
      restartRequiredForRtl: restartRequired,
    }));
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const deviceId = await getDeviceId();
      const hasSession = await loadStoredSession();
      setUnauthenticatedHandler(() => {
        setState((s) => ({ ...s, signedIn: false, user: null, profiles: [], activeProfile: null }));
      });

      if (!hasSession) {
        if (!cancelled) setState((s) => ({ ...s, ready: true, deviceId }));
        return;
      }
      try {
        await loadMe();
      } catch {
        // A cold start with no network must not sign the user out; the cached
        // schedule still drives Today and local reminders.
        if (!cancelled) setState((s) => ({ ...s, offline: true, signedIn: true }));
      }
      const pending = await queueSize();
      if (!cancelled) setState((s) => ({ ...s, ready: true, deviceId, pendingSyncCount: pending }));
    })();
    return () => { cancelled = true; };
  }, [loadMe]);

  const syncNow = useCallback(async () => {
    const deviceId = await getDeviceId();
    const result = await flushQueue(deviceId);
    const pending = await queueSize();
    if (!mounted.current) return;
    setState((s) => ({ ...s, offline: result.offline, pendingSyncCount: pending }));
    if (!result.offline) await loadMe().catch(() => undefined);
  }, [loadMe]);

  const actions = useMemo<AppActions>(() => ({
    signInWithTokens: async (tokens) => {
      await storeSession(tokens);
      await loadMe();
      // The only place `credentialVerifiedAt` is ever set. Both auth screens
      // call this immediately after the server accepted a password, so it marks
      // a fresh credential and nothing else — not a restored session, not a
      // silent refresh, not a route change. The app lock's recovery route keys
      // off it for exactly that reason.
      setState((s) => ({ ...s, ready: true, credentialVerifiedAt: Date.now() }));
    },
    signOut: async () => {
      // Deactivate this device FIRST, while the token still authorises it.
      // Signing out used to leave the push registration live, so medication
      // reminders naming the patient's drugs kept arriving on a phone they had
      // signed out of — including one they had sold or lost. Best effort: a
      // failure here must not trap someone in a session they are trying to
      // leave, and cancelling the local schedule below still silences this
      // device either way.
      const deviceId = await getDeviceId();
      await api.delete(`/v1/devices/push-token/${encodeURIComponent(deviceId)}`).catch(() => undefined);
      await cancelAllLocalNotifications().catch(() => undefined);
      await api.post('/v1/auth/logout').catch(() => undefined);
      await clearSession();
      setState((s) => ({ ...s, signedIn: false, user: null, profiles: [], activeProfile: null }));
    },
    refreshProfiles: loadMe,
    setActiveProfile: (profileId) => {
      setState((s) => ({ ...s, activeProfile: s.profiles.find((p) => p.id === profileId) ?? s.activeProfile }));
    },
    updatePreferences: async (patch) => {
      // Optimistic: accessibility changes must feel instant to someone who
      // enabled them because the text was too small to read.
      setState((s) => ({ ...s, preferences: { ...s.preferences, ...patch } }));
      if (patch.locale) {
        const { restartRequired } = applyNativeDirection(patch.locale);
        setState((s) => ({ ...s, restartRequiredForRtl: restartRequired }));
      }

      // The language screen runs before anyone has an account. There is no
      // server-side "me" to write to yet, and calling anyway earned a 401 that
      // the old catch-all below read as "offline" — so choosing Arabic raised
      // an offline banner on a perfectly healthy connection. The choice is
      // kept locally and travels with the sign-up request instead.
      if (!isSignedIn()) return;

      try {
        const res = await api.patch<{ preferences: Preferences }>('/v1/me/preferences', patch);
        setState((s) => ({ ...s, preferences: { ...s.preferences, ...res.preferences } }));
      } catch (err) {
        // Only a request that never reached the server means offline. A
        // rejection from the server is a different failure and must not put
        // the whole app into its cached-data mode.
        if (err instanceof NetworkError) setState((s) => ({ ...s, offline: true }));
      }
    },
    syncNow,
    setOffline: (offline) => setState((s) => ({ ...s, offline })),
  }), [loadMe, syncNow]);

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
