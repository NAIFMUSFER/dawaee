import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ScrollView } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Banner, Button, Loading, Txt } from '@/components/ui';
import { useI18n } from '@/i18n';
import { useApp } from '@/state/app-store';
import { api, ApiError, NetworkError } from '@/api/client';
import { useAppLock } from '@/security/AppLockGate';
import { useRequestScope } from '@/hooks/useRequestScope';
import {
  clearCaregiverNotificationIntent, getCaregiverNotificationIntent,
  isCaregiverNotificationIntentCurrent, subscribeCaregiverNotificationIntent,
  type CaregiverNotificationIntent,
} from '@/notifications/caregiver-intent';

interface ResolvedNotification {
  kind: 'escalation' | 'daily_summary' | 'weekly_summary';
  patientProfileId: string;
  patientDisplayName: string;
}
type Phase = 'loading' | 'ready' | 'selecting' | 'offline' | 'unavailable' | 'error';

function validNotification(value: ResolvedNotification | undefined): value is ResolvedNotification {
  return !!value && ['escalation', 'daily_summary', 'weekly_summary'].includes(value.kind)
    && typeof value.patientProfileId === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.patientProfileId)
    && typeof value.patientDisplayName === 'string' && value.patientDisplayName.trim().length > 0;
}

/** The fixed route alone has no selection. Only an account-bound native tap
 * can supply one; neither route parameters nor the active profile identify it. */
export default function CaregiverNotificationLandingScreen() {
  const { ready, signedIn, user } = useApp();
  const snapshot = useSyncExternalStore(
    subscribeCaregiverNotificationIntent, getCaregiverNotificationIntent, () => null,
  );
  const intent = ready && signedIn && user?.id === snapshot?.userId ? snapshot : null;
  return <NotificationView key={`${user?.id ?? ''}:${intent?.revision ?? 'none'}`} intent={intent} />;
}

function NotificationView({ intent }: { intent: CaregiverNotificationIntent | null }) {
  const { t } = useI18n();
  const { profiles, activeProfile, refreshProfiles, setActiveProfile } = useApp();
  const lock = useAppLock();
  const blocked = lock.locked || lock.needsArea('caregivers');
  const focused = useRef(false);
  const [phase, setPhase] = useState<Phase>(intent ? 'loading' : 'unavailable');
  const [resolved, setNotification] = useState<(ResolvedNotification & { current: () => boolean }) | null>(null);
  const [pendingProfileId, setPendingProfileId] = useState<string | null>(null);
  const { begin } = useRequestScope(JSON.stringify([intent?.userId, intent?.revision, blocked]));

  useFocusEffect(useCallback(() => {
    focused.current = true;
    return () => {
      focused.current = false;
      clearCaregiverNotificationIntent(intent);
    };
  }, [intent]));

  const load = useCallback(async (openDashboard = false) => {
    if (!intent || blocked || !focused.current || !isCaregiverNotificationIntentCurrent(intent)) return;
    const requestCurrent = begin();
    const current = () => requestCurrent() && focused.current && isCaregiverNotificationIntentCurrent(intent);
    setPhase('loading');
    setNotification(null);
    setPendingProfileId(null);
    try {
      const response = await api.post<{ notification: ResolvedNotification }>(
        '/v1/caregivers/notification/resolve', { deliveryId: intent.deliveryId },
      );
      if (!current()) return;
      if (!validNotification(response?.notification)) { setPhase('unavailable'); return; }
      // Refresh the exact patient's current role/permissions before selection.
      // Never let a missing profile fall through to the dashboard's first one.
      await refreshProfiles();
      if (!current()) return;
      setNotification({ ...response.notification, current });
      setPendingProfileId(openDashboard ? response.notification.patientProfileId : null);
      setPhase(openDashboard ? 'selecting' : 'ready');
    } catch (error) {
      if (!current()) return;
      setNotification(null);
      setPendingProfileId(null);
      setPhase(error instanceof NetworkError ? 'offline'
        : error instanceof ApiError && ['not_found', 'forbidden', 'unauthorized', 'session_changed'].includes(error.code)
          ? 'unavailable' : 'error');
    }
  }, [intent, blocked, begin, refreshProfiles]);

  useEffect(() => { void load(); }, [load]);

  // A lock/focus/request transition hides the last resolved identity in the
  // very first render, before the next loading effect can run.
  const notification = resolved?.current() ? resolved : null;
  const patient = notification
    ? profiles.find((profile) => profile.id === notification.patientProfileId && profile.role === 'caregiver')
    : undefined;
  const permitted = !!patient?.permissions?.includes('receive_notifications')
    && (notification?.kind === 'escalation'
      || (!!patient.permissions.includes('view_adherence') && !!patient.permissions.includes('view_schedule')));

  useEffect(() => {
    if (!pendingProfileId || !intent || blocked || !focused.current
      || !isCaregiverNotificationIntentCurrent(intent)) return;
    if (!patient || !permitted || patient.id !== pendingProfileId) {
      setPendingProfileId(null);
      setNotification(null);
      setPhase('unavailable');
      return;
    }
    if (activeProfile?.id !== patient.id || activeProfile.role !== 'caregiver') {
      setActiveProfile(patient.id);
      return;
    }
    // Wait for the selected profile to reach app context before mounting the
    // existing permission-gated dashboard. This action never confirms a dose.
    focused.current = false;
    clearCaregiverNotificationIntent(intent);
    router.replace('/caregiver/dashboard');
  }, [pendingProfileId, intent, blocked, patient, permitted, activeProfile, setActiveProfile]);

  const close = () => {
    focused.current = false;
    clearCaregiverNotificationIntent(intent);
    router.back();
  };

  // The gate keeps children mounted; do not fetch or expose identity underneath
  // it, including to screen readers. Unlock starts a fresh authenticated read.
  if (blocked) return null;
  const displayPhase = notification && !permitted ? 'unavailable'
    : (phase === 'ready' || phase === 'selecting') && !notification ? 'loading' : phase;
  return (
    <SafeAreaView style={{ flex: 1 }}>
      <ScrollView contentContainerStyle={{ padding: 20, gap: 16 }}>
        <Txt variant="h1" weight="bold" accessibilityRole="header">{t('caregiver.notificationTitle')}</Txt>
        {displayPhase === 'loading' || displayPhase === 'selecting' ? (
          <Loading label={t('caregiver.notificationLoading')} />
        ) : displayPhase === 'ready' && notification ? (
          <>
            <Txt variant="h2" weight="bold">{notification.patientDisplayName}</Txt>
            <Txt>{t(notification.kind === 'escalation' ? 'caregiver.notificationEscalation'
              : notification.kind === 'daily_summary' ? 'caregiver.notificationDaily' : 'caregiver.notificationWeekly')}</Txt>
            <Banner tone="info" title={t('caregiver.notificationCaution')} />
            <Button label={t('caregiver.notificationOpen')} onPress={() => void load(true)} />
          </>
        ) : (
          <>
            <Txt accessibilityRole="alert">{t(displayPhase === 'offline' ? 'caregiver.notificationOffline'
              : displayPhase === 'unavailable' ? 'caregiver.notificationUnavailable' : 'caregiver.notificationError')}</Txt>
            {intent && <Button label={t('common.retry')} onPress={() => void load()} />}
          </>
        )}
        <Button label={t('common.back')} tone="ghost" fullWidth={false} onPress={close} />
      </ScrollView>
    </SafeAreaView>
  );
}
