import React, { useEffect, useRef } from 'react';
import { useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { Alert, AppState, Platform, View } from 'react-native';
import { PrivacyModal as Modal } from '@/security/PrivacyModal';
import { AppProvider, useApp } from '@/state/app-store';
import { I18nProvider } from '@/i18n';
import { Loading, PreviewBanner } from '@/components/ui';
import { PALETTE, t } from '@dawaee/shared';
import { configureCategories, configureChannels, startNotificationActionListener, syncPushRegistration, resetPushRegistrationStatus, subscribeNotificationPermissionChanges } from '@/notifications';
import { DEMO_MODE } from '@/api/client';
import { AppLockGate } from '@/security/AppLockGate';
import { clearClinicalRouteIntents } from '@/navigation/private-navigation';
import { clearMedicationDrafts } from '@/storage/medication-draft';
import { startCaregiverNotificationListener } from '@/notifications/caregiver-navigation';
import { startGroupedNotificationListener } from '@/notifications/grouped-navigation';
import { bindCaregiverNotificationAccount, setCaregiverNotificationIntent } from '@/notifications/caregiver-intent';
import { bindPatientReminderAccount, setPatientReminderIntent } from '@/notifications/patient-intent';
import EmailVerificationScreen from './settings/email-verification';
import { needsEmailVerification } from '@/security/email-onboarding';
import { landingAfterAuth } from '@/storage/pending-invite';
import AppNavigator from '@/navigation/AppNavigator';
import WebAlertHost from '@/components/WebAlertHost';
import { NotificationHealthNotice } from '@/components/NotificationHealthNotice';
import { DeletionReceiptNotice, PendingDeletionScreen } from '@/components/AccountDeletionNotice';

/**
 * Root layout.
 *
 * Order matters: the app state resolves first (it holds the locale), then the
 * i18n provider wraps everything so the very first frame is already in the
 * right language and direction — no flash of English in an Arabic app.
 */
function Shell() {
  const {
    ready, preferences, signedIn, user, activeProfile, deviceId,
    syncNow: refreshAfterAction,
  } = useApp();
  const router = useRouter();
  const deletionPending = Boolean(signedIn && user?.deletionScheduledFor);
  const emailRequired = !deletionPending && !DEMO_MODE && needsEmailVerification(signedIn, user);
  const wasEmailRequired = useRef(false);
  const clinicalRouteScope = `${signedIn ? (user?.id ?? 'unknown') : 'signed-out'}:${activeProfile?.id ?? 'none'}`;
  const previousClinicalRouteScope = useRef<string | null>(null);
  const caregiverOwner = ready && signedIn && !deletionPending && user?.id ? user.id : null;
  bindCaregiverNotificationAccount(caregiverOwner);
  bindPatientReminderAccount(caregiverOwner);
  const caregiverSession = useRef({ owner: caregiverOwner, generation: 0 });
  if (caregiverSession.current.owner !== caregiverOwner) {
    caregiverSession.current = {
      owner: caregiverOwner,
      generation: caregiverSession.current.generation + 1,
    };
  }

  // This fence is deliberately synchronous. Clearing in useEffect is too late:
  // fixed-route children can read stale process-local ids or OCR medication
  // drafts before passive effects run. A speculative render may discard a
  // short-lived navigation selection/draft, which is the fail-closed outcome
  // for this privacy boundary; it never discards server data or persisted
  // clinical state.
  if (previousClinicalRouteScope.current !== clinicalRouteScope) {
    clearClinicalRouteIntents();
    clearMedicationDrafts();
    previousClinicalRouteScope.current = clinicalRouteScope;
  }

  useEffect(() => {
    let current = true;
    if (wasEmailRequired.current && !emailRequired && signedIn) {
      void landingAfterAuth().then(path => { if (current) router.replace(path); });
    }
    wasEmailRequired.current = emailRequired;
    return () => { current = false; };
  }, [emailRequired, signedIn, user?.id, router]);

  useEffect(() => {
    void configureChannels();
    void configureCategories(preferences.locale);
  }, [preferences.locale]);

  /** Tell the server which device to reach. */
  useEffect(() => {
    resetPushRegistrationStatus();
    if (!ready || !signedIn || deletionPending || !user?.id || emailRequired || !deviceId) return;
    const generation = caregiverSession.current.generation;
    let disposed = false;
    let registering = false;
    const current = () => !disposed && caregiverSession.current.generation === generation;
    const register = async (requestPermission: boolean) => {
      if (registering || !current()) return;
      registering = true;
      try { await syncPushRegistration(deviceId, { requestPermission, isCurrent: current }); }
      catch { /* Foreground/grant events retry transient token/provider errors. */ }
      finally { registering = false; }
    };
    // Registration may reuse an existing grant. The OS prompt belongs to the
    // explained onboarding/settings action, not the sign-in transition.
    void register(false);
    const unsubscribe = subscribeNotificationPermissionChanges(() => { void register(false); });
    const subscription = AppState.addEventListener('change', next => { if (next === 'active') void register(false); });
    return () => { disposed = true; unsubscribe(); subscription.remove(); };
  }, [ready, signedIn, deletionPending, emailRequired, deviceId, user?.id]);

  /** Keep the delivery selection in account-bound memory. The landing resolves
   * its patient through the authenticated API, after the app lock permits it. */
  useEffect(() => {
    if (!ready || !signedIn || deletionPending || !user?.id || Platform.OS === 'web') return;
    const generation = caregiverSession.current.generation;
    let cancelled = false;
    let stop: (() => void) | undefined;
    const isCurrent = () => !cancelled && caregiverSession.current.generation === generation;
    void import('expo-notifications').then((native) => {
      if (!isCurrent()) return;
      stop = startCaregiverNotificationListener(
        native,
        (selection) => {
          if (!isCurrent()) return;
          setCaregiverNotificationIntent(user.id, selection);
          router.replace('/caregiver/notification');
        },
        isCurrent,
      );
    }).catch(() => undefined);
    return () => { cancelled = true; stop?.(); };
  }, [ready, signedIn, deletionPending, user?.id, router]);

  /** Act on the reminder's own buttons. */
  useEffect(() => {
    if (!ready || !signedIn || deletionPending || !user?.id || emailRequired) return;
    let stop: (() => void) | undefined;
    let cancelled = false;
    const generation = caregiverSession.current.generation;
    void startNotificationActionListener(outcome => {
      if (outcome.rejected) Alert.alert(t(preferences.locale, 'today.actionSaveFailed'));
      void refreshAfterAction();
    },
      () => !cancelled && caregiverSession.current.generation === generation)
      .then((s) => { if (cancelled) s(); else stop = s; })
      .catch(() => undefined);
    return () => { cancelled = true; stop?.(); };
  }, [ready, signedIn, deletionPending, user?.id, emailRequired, refreshAfterAction, preferences.locale]);

  /**
   * A grouped reminder deliberately has no single-dose Taken/Snooze/Skip
   * action. Its only safe action is to open the list of doses that are due.
   *
   * Before this listener existed, tapping "3 medications are due" while the
   * app was already open on History/Settings launched Dawaee but left the user
   * on that screen. The notification payload has `doseIds`, not `doseId`, so
   * the single-dose action listener correctly ignored it — and nothing routed
   * the patient to the doses they were being asked to review.
   */
  useEffect(() => {
    if (!ready || !signedIn || deletionPending || !user?.id || Platform.OS === 'web') return;
    const generation = caregiverSession.current.generation;
    let cancelled = false;
    let stop: (() => void) | undefined;
    // Both default-tap listeners share the synchronous account-change fence.
    const isCurrent = () => !cancelled && caregiverSession.current.generation === generation;
    void import('expo-notifications').then((native) => {
      if (!isCurrent()) return;
      stop = startGroupedNotificationListener(
        native,
        (doseId) => {
          if (!isCurrent()) return;
          setPatientReminderIntent(user.id, { doseId });
          router.replace('/notification');
        },
        isCurrent,
      );
    }).catch(() => undefined);
    return () => { cancelled = true; stop?.(); };
  }, [ready, signedIn, deletionPending, user?.id, router]);

  return (
    <I18nProvider
      locale={preferences.locale}
      numeralSystem={preferences.numeralSystem}
      calendar={preferences.calendarSystem}
    >
      <StatusBar style="dark" />
      {DEMO_MODE ? (
        <PreviewBanner
          label={preferences.locale === 'en'
            ? 'Interface preview — sample data, no server attached'
            : 'معاينة الواجهة — بيانات تجريبية، بدون خادم'}
        />
      ) : null}
      {ready ? (
        <AppLockGate>
          <View style={{ flex: 1 }}>
          {deletionPending ? <PendingDeletionScreen /> : <AppNavigator />}
          {signedIn && !deletionPending && !emailRequired ? <NotificationHealthNotice /> : null}
          <DeletionReceiptNotice />
          <Modal visible={emailRequired} onRequestClose={() => undefined} animationType="none">
            {emailRequired ? <EmailVerificationScreen key={user?.id} /> : null}
          </Modal>
          <WebAlertHost scope={clinicalRouteScope} />
          </View>
        </AppLockGate>
      ) : (
        <View style={{ flex: 1, backgroundColor: PALETTE.background, justifyContent: 'center' }}>
          <Loading />
        </View>
      )}
    </I18nProvider>
  );
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <AppProvider>
        <Shell />
      </AppProvider>
    </SafeAreaProvider>
  );
}
