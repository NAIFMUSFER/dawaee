import React, { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { AppState as RNAppState, View } from 'react-native';
import type { AppStateStatus } from 'react-native';
import { router, usePathname } from 'expo-router';
import { PALETTE } from '@dawaee/shared';
import { Banner, Button, Loading, Txt } from '@/components/ui';
import { useI18n } from '@/i18n';
import { useApp } from '@/state/app-store';
import { checkLocalAuth, verifyLocally } from './local-auth';
import type { LocalAuthAvailability } from './local-auth';
import {
  areaForPath,
  areaNeedsVerification,
  INITIAL_LOCK_STATE,
  isLockExemptPath,
  lockReducer,
} from './lock-state';
import type { AppStatus } from './lock-state';

/**
 * The app lock, enforced.
 *
 * The setting existed and did nothing. `appLockEnabled` was written by the
 * settings screen, read back by the settings screen to render "On", and no
 * other code in the app ever consulted it — so a patient who turned it on was
 * told their medication history was protected while anyone holding the
 * unlocked phone could read all of it, plus their caregivers, their emergency
 * card and their reports. A security control that reports itself as active
 * while doing nothing is worse than an absent one, because it stops the person
 * from taking the precautions they would otherwise take.
 *
 * Enforcement lives here, wrapping the router, for one reason: a gate placed on
 * screens is a gate with holes. A deep link (`dawaee://` or the invitation
 * URL), a notification tap that opens straight to a dose, a `router.replace`
 * from anywhere — each of those mounts a screen without passing through
 * whichever screen was supposed to be doing the checking. Above the `<Stack>`,
 * every route in the app renders underneath the overlay, whatever opened it.
 */

interface AppLockApi {
  /** True while the whole-app lock is showing. */
  locked: boolean;
  /** Does this area still need its own verification? */
  needsArea: (area: string) => boolean;
  /** Prompt for an area. Resolves true if the OS said yes. */
  verifyArea: (area: string, prompt: string, cancel: string) => Promise<boolean>;
}

const AppLockContext = createContext<AppLockApi>({
  locked: false,
  needsArea: () => false,
  verifyArea: async () => true,
});

export const useAppLock = (): AppLockApi => useContext(AppLockContext);

function toStatus(s: AppStateStatus): AppStatus {
  if (s === 'active') return 'active';
  if (s === 'background') return 'background';
  return 'inactive';
}

export function AppLockGate({ children }: { children: React.ReactNode }) {
  const { t } = useI18n();
  const { preferences, signedIn, ready, signOut } = useApp();
  const pathname = usePathname();

  const [state, dispatch] = useReducer(lockReducer, INITIAL_LOCK_STATE);
  const [verifying, setVerifying] = useState(false);
  const [failed, setFailed] = useState(false);
  const [availability, setAvailability] = useState<LocalAuthAvailability | null>(null);

  /**
   * The lock protects a session. Signed out there is nothing behind it, and a
   * lock over the sign-in screen is a trap with no key — so it engages only
   * once preferences have actually loaded AND someone is signed in.
   */
  const enabled = ready && signedIn && preferences.appLockEnabled;

  // Not an effect. `configure` has to be applied in the same render that first
  // reports `enabled`, because an effect runs AFTER the browser or the native
  // view has already painted that frame — and that frame is today's doses.
  const effective = useMemo(
    () => lockReducer(state, { type: 'configure', enabled }),
    [state, enabled],
  );
  useEffect(() => {
    if (effective !== state) dispatch({ type: 'configure', enabled });
  }, [effective, state, enabled]);

  /**
   * A fresh sign-in clears the lock for this session.
   *
   * This is the recovery path, and the app is unsafe without it: preferences
   * live on the server, so a patient whose sensor has failed would sign out,
   * sign back in with their password, and be locked out again by the very
   * setting they were trying to escape — permanently unable to open their own
   * medication schedule on a working phone. A password is a stronger factor
   * than a device biometric, so presenting one is sufficient.
   */
  const wasSignedIn = useRef(signedIn);
  useEffect(() => {
    if (signedIn && !wasSignedIn.current) dispatch({ type: 'signedIn' });
    wasSignedIn.current = signedIn;
  }, [signedIn]);

  useEffect(() => {
    const sub = RNAppState.addEventListener('change', (next) => {
      dispatch({ type: 'appStatus', status: toStatus(next), now: Date.now() });
    });
    return () => sub.remove();
  }, []);

  useEffect(() => {
    if (!enabled) { setAvailability(null); return; }
    let alive = true;
    void checkLocalAuth().then((a) => { if (alive) setAvailability(a); });
    return () => { alive = false; };
  }, [enabled]);

  const unlock = useCallback(async () => {
    setFailed(false);
    setVerifying(true);
    try {
      const ok = await verifyLocally(t('applock.unlockPrompt'), t('common.cancel'));
      if (ok) dispatch({ type: 'verified' });
      else setFailed(true);
    } finally {
      setVerifying(false);
    }
  }, [t]);

  const verifyArea = useCallback(
    async (area: string, prompt: string, cancel: string) => {
      const ok = await verifyLocally(prompt, cancel);
      if (ok) dispatch({ type: 'areaVerified', area });
      return ok;
    },
    [],
  );

  const api = useMemo<AppLockApi>(
    () => ({
      locked: effective.phase !== 'unlocked',
      needsArea: (area: string) =>
        areaNeedsVerification(effective, preferences.appLockAreas, area),
      verifyArea,
    }),
    [effective, preferences.appLockAreas, verifyArea],
  );

  // The paramedic card is never covered — see isLockExemptPath.
  const exempt = isLockExemptPath(pathname ?? '');
  const phase = exempt ? 'unlocked' : effective.phase;

  /**
   * The per-area gate, resolved from the route in the same place as the
   * whole-app one. The settings screen promised "verification is asked before
   * opening these areas only" and nothing asked; asking here rather than
   * inside each of the fifteen screens means a deep link, a notification, or a
   * screen added next month cannot route around it.
   */
  const area = exempt || phase !== 'unlocked' ? null : areaForPath(pathname ?? '');
  const areaLocked = area !== null && api.needsArea(area);

  const verifyCurrentArea = useCallback(async () => {
    if (area === null) return;
    setFailed(false);
    setVerifying(true);
    try {
      const ok = await verifyArea(area, t('applock.areaPrompt'), t('common.cancel'));
      if (!ok) setFailed(true);
    } finally {
      setVerifying(false);
    }
  }, [area, verifyArea, t]);

  /**
   * Children stay mounted underneath. Unmounting them would discard a
   * half-written medication form every time the phone rang, and — worse for a
   * lock — remounting on unlock replays every screen's data fetch, which is a
   * visible flash of skeletons that leaks which screen was open.
   */
  return (
    <AppLockContext.Provider value={api}>
      <View style={{ flex: 1 }}>
        {children}

        {/*
          Area gate. Drawn over the screen the same way, so the protected
          content is never on screen behind a dismissible sheet — and never in
          a screenshot.
        */}
        {phase === 'unlocked' && areaLocked ? (
          <View
            accessibilityViewIsModal
            style={{
              position: 'absolute',
              top: 0, left: 0, right: 0, bottom: 0,
              backgroundColor: PALETTE.background,
              alignItems: 'stretch',
              justifyContent: 'center',
              padding: 24,
              gap: 16,
            }}
          >
            <Txt variant="h1" weight="bold" accessibilityRole="header" align="center">
              {t('applock.areaLockedTitle')}
            </Txt>
            <Txt variant="body" color={PALETTE.ink500} align="center">
              {t('applock.areasHint')}
            </Txt>
            {failed ? <Banner tone="danger" title={t('applock.unlockFailed')} /> : null}
            {verifying ? <Loading label={t('common.loading')} /> : (
              <Button label={t('applock.unlock')} size="large" onPress={() => void verifyCurrentArea()} />
            )}
            <Button label={t('common.back')} tone="ghost" onPress={() => router.back()} />
          </View>
        ) : null}

        {phase === 'unlocked' ? null : (
          <View
            accessibilityViewIsModal
            importantForAccessibility="yes"
            style={{
              position: 'absolute',
              top: 0, left: 0, right: 0, bottom: 0,
              backgroundColor: PALETTE.background,
              // stretch, not center: the buttons below are full-width by
              // default, and a centred cross-axis would collapse them to their
              // label width — a 40pt tap target on the one screen an elderly
              // patient has to hit before anything else works.
              alignItems: 'stretch',
              justifyContent: 'center',
              padding: 24,
              gap: 16,
            }}
          >
            {/*
              The `covered` phase draws nothing but the opaque ground. This is
              the frame the OS photographs for the task switcher, and an unlock
              button in it is both useless — nobody is there to press it — and
              a hint about what the app is.
            */}
            {phase === 'locked' ? (
              <>
                <Txt variant="h1" weight="bold" accessibilityRole="header" align="center">
                  {t('applock.lockedTitle')}
                </Txt>
                <Txt variant="body" color={PALETTE.ink500} align="center">
                  {t('applock.lockedBody')}
                </Txt>

                {failed ? <Banner tone="danger" title={t('applock.unlockFailed')} /> : null}

                {availability !== null && availability !== 'ready' ? (
                  <Banner
                    tone="warning"
                    title={t('applock.unavailableTitle')}
                    body={t('applock.lockedOutBody')}
                  />
                ) : null}

                {verifying ? <Loading label={t('common.loading')} /> : (
                  <Button label={t('applock.unlock')} size="large" onPress={() => void unlock()} />
                )}

                {/*
                  Always offered, not only after a failure. Someone whose
                  fingerprint has stopped being recognised needs the way out to
                  be visible before they have tried and failed five times with
                  a dose overdue.
                */}
                <Button
                  label={t('applock.signOutEscape')}
                  tone="ghost"
                  onPress={() => { void signOut(); }}
                />
              </>
            ) : null}
          </View>
        )}
      </View>
    </AppLockContext.Provider>
  );
}
