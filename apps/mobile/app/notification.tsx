import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { router, useFocusEffect } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Banner, Button, Loading, Screen, Txt } from '@/components/ui';
import { useApp } from '@/state/app-store';
import { useI18n } from '@/i18n';
import { useAppLock } from '@/security/AppLockGate';
import { hasProfilePermission } from '@/security/profile-permissions';
import { api, NetworkError } from '@/api/client';
import type { DoseView } from '@/api/types';
import { useRequestScope } from '@/hooks/useRequestScope';
import { readCachedSchedule } from '@/storage/offline-queue';
import {
  clearPatientReminderIntent, getPatientReminderIntent, isPatientReminderIntentCurrent,
  subscribePatientReminderIntent, type PatientReminderIntent,
} from '@/notifications/patient-intent';

/** A tap carries an occurrence selection in account-bound memory, never a URL. */
export default function PatientReminderScreen() {
  const { user, ready, signedIn } = useApp();
  const selected = useSyncExternalStore(subscribePatientReminderIntent, getPatientReminderIntent, () => null);
  const intent = ready && signedIn && selected?.userId === user?.id ? selected : null;
  return <ReminderView key={`${user?.id}:${intent?.revision}`} intent={intent} />;
}

function ReminderView({ intent }: { intent: PatientReminderIntent | null }) {
  const { t } = useI18n();
  const { profiles, activeProfile, refreshProfiles, setActiveProfile } = useApp();
  const lock = useAppLock();
  const selfId = profiles.find(profile => profile.isSelf && profile.role === 'owner')?.id;
  const focused = useRef(false);
  const [selected, setSelected] = useState<{ profileId: string; current: () => boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { begin } = useRequestScope(`${intent?.userId}:${intent?.revision}:${lock.locked}`);
  useFocusEffect(useCallback(() => {
    focused.current = true;
    return () => { focused.current = false; clearPatientReminderIntent(intent); };
  }, [intent]));

  const load = useCallback(async () => {
    if (!intent || lock.locked || !focused.current || !isPatientReminderIntentCurrent(intent)) return;
    const requestCurrent = begin();
    const current = () => requestCurrent() && focused.current && isPatientReminderIntentCurrent(intent);
    setError(null);
    setSelected(null);
    try {
      // The authenticated dose read resolves its actual patient, including an
      // owned dependent. Never infer identity from whichever profile is open.
      const profileId = intent.doseId
        ? (await api.get<{ dose: DoseView }>(`/v1/doses/${intent.doseId}`)).dose.patientProfileId
        : selfId; // Older grouped notifications had no occurrence metadata.
      if (!current()) return;
      if (!profileId) { setError(t('error.not_found')); return; }
      await refreshProfiles();
      if (current()) setSelected({ profileId, current });
    } catch (err) {
      if (!current()) return;
      // Offline recovery is restricted to the authenticated patient's own
      // encrypted snapshot, just like cold-start Today.
      if (err instanceof NetworkError && selfId) {
        const cached = await readCachedSchedule(selfId);
        if (!current()) return;
        if (cached && (!intent.doseId || cached.doses.some(dose => dose.id === intent.doseId))) {
          setSelected({ profileId: selfId, current });
          return;
        }
      }
      setError(t(err instanceof NetworkError ? 'notifications.offlineBanner' : 'error.not_found'));
    }
  }, [intent, lock.locked, begin, selfId, refreshProfiles, t]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!selected?.current() || !intent || lock.locked) return;
    const patient = profiles.find(profile => profile.id === selected.profileId);
    if (!hasProfilePermission(patient, 'view_schedule') || !hasProfilePermission(patient, 'view_medications')) {
      setSelected(null);
      setError(t('error.forbidden'));
      return;
    }
    if (activeProfile?.id !== selected.profileId) { setActiveProfile(selected.profileId); return; }
    focused.current = false;
    clearPatientReminderIntent(intent);
    router.replace('/(tabs)/today');
  }, [selected, intent, lock.locked, profiles, activeProfile?.id, setActiveProfile, t]);

  if (lock.locked) return null;
  return <SafeAreaView style={{ flex: 1 }}><Screen>
    <Txt variant="h2" weight="bold">{t('today.title')}</Txt>
    {!intent ? <Banner tone="warning" title={t('error.not_found')} />
      : error ? <><Banner tone="warning" title={error} /><Button label={t('common.retry')} onPress={() => void load()} /></>
        : <Loading label={t('common.loading')} />}
    <Button label={t('common.back')} tone="ghost" onPress={() => {
      focused.current = false; clearPatientReminderIntent(intent); router.back();
    }} />
  </Screen></SafeAreaView>;
}
