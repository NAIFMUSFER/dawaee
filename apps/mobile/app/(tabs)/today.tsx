import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshControl, ScrollView, View } from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Banner, Button, Card, EmptyState, Loading, SafetyNote, SectionTitle, Txt } from '@/components/ui';
import { DoseCard } from '@/components/DoseCard';
import { ProfileSwitcher } from '@/components/ProfileSwitcher';
import { useI18n } from '@/i18n';
import { useTheme } from '@/hooks/useTheme';
import { useApp } from '@/state/app-store';
import { api, NetworkError } from '@/api/client';
import type { DoseView, TodayResponse } from '@/api/types';
import type { CachedSchedule } from '@/storage/offline-queue';
import { applyQueuedToCache, cacheSchedule, enqueue, newClientEventId, readCachedSchedule, readQueue } from '@/storage/offline-queue';
import { inspectCapability, rescheduleLocalNotifications } from '@/notifications';
import { SnoozeSheet } from '@/components/SnoozeSheet';

function localDateIn(timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

function cachedDoseToView(d: CachedSchedule['doses'][number]): DoseView {
  return {
    id: d.id,
    medicationId: '',
    scheduleId: '',
    scheduledAt: d.scheduledAt,
    scheduledLocalDate: d.scheduledLocalDate,
    scheduledLocalTime: d.scheduledLocalTime,
    scheduledTimezone: '',
    doseQuantity: d.doseQuantity,
    doseUnit: d.doseUnit as DoseView['doseUnit'],
    status: d.status as DoseView['status'],
    minutesLate: null,
    snoozedUntil: null,
    snoozeCount: 0,
    confirmedAt: null,
    escalationStage: 0,
    medication: {
      name: d.medicationName,
      form: 'tablet',
      imageKey: null,
      strengthValue: null,
      strengthUnit: null,
      foodInstruction: d.foodInstruction as DoseView['medication']['foodInstruction'],
      instructions: null,
    },
  };
}

export default function TodayScreen() {
  const { t, formatDate } = useI18n();
  const theme = useTheme();
  const { activeProfile, user, preferences, deviceId, offline, setOffline, pendingSyncCount, syncNow } = useApp();
  const arabic = preferences.locale === 'ar';
  const canAddMedication = Boolean(activeProfile && (activeProfile.isSelf || activeProfile.permissions?.includes('add_medication')));
  const canConfirmDose = Boolean(activeProfile && (activeProfile.isSelf || activeProfile.permissions?.includes('confirm_dose')));

  const [data, setData] = useState<TodayResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busyDoseId, setBusyDoseId] = useState<string | null>(null);
  const [snoozeFor, setSnoozeFor] = useState<DoseView | null>(null);
  const [notificationWarning, setNotificationWarning] = useState<string | null>(null);
  const [exactAlarmsUnavailable, setExactAlarmsUnavailable] = useState(false);
  const [localOverrides, setLocalOverrides] = useState<Record<string, DoseView['status']>>({});

  const load = useCallback(async () => {
    if (!activeProfile) return;
    try {
      const res = await api.get<TodayResponse>('/v1/today', { profileId: activeProfile.id });
      setData(res);
      setOffline(false);

      await cacheSchedule({
        profileId: activeProfile.id,
        cachedAt: new Date().toISOString(),
        timezone: res.timezone,
        doses: [...res.today, ...res.prefetch].map((d) => ({
          id: d.id, scheduledAt: d.scheduledAt, scheduledLocalTime: d.scheduledLocalTime,
          scheduledLocalDate: d.scheduledLocalDate, medicationName: d.medication.name,
          doseQuantity: d.doseQuantity, doseUnit: d.doseUnit,
          foodInstruction: d.medication.foodInstruction, status: d.status,
        })),
      });

      // Direct local medication reminders belong only to the signed-in patient's
      // own profile. A caregiver viewing another profile must not silently turn
      // that patient's schedule into reminders on the caregiver's phone.
      if (activeProfile.isSelf) {
        const schedule = await rescheduleLocalNotifications(
          [...res.today, ...res.prefetch], preferences.locale,
          {
            voiceEnabled: preferences.voiceRemindersEnabled,
            showMedication: preferences.showMedicationInNotifications,
          },
        );
        setExactAlarmsUnavailable(schedule.exactAlarmsUnavailable);
      } else {
        setExactAlarmsUnavailable(false);
      }
    } catch (err) {
      if (err instanceof NetworkError) {
        setOffline(true);
        const cached = await readCachedSchedule(activeProfile.id);
        if (cached && !data) {
          const queued = await readQueue();
          const merged = applyQueuedToCache(cached, queued);
          const localDate = localDateIn(cached.timezone);
          const views = merged.doses.map(cachedDoseToView);
          setData({
            profileId: merged.profileId,
            localDate,
            timezone: merged.timezone,
            serverTime: merged.cachedAt,
            next:
              views.find((d) => d.status === 'upcoming' || d.status === 'due' || d.status === 'pending_confirmation') ??
              null,
            today: views.filter((d) => d.scheduledLocalDate === localDate),
            prefetch: views.filter((d) => d.scheduledLocalDate > localDate),
            prefetchDays: 7,
          });
        }
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [activeProfile, preferences.locale, preferences.voiceRemindersEnabled, preferences.showMedicationInNotifications, setOffline, data]);

  useEffect(() => {
    setData(null);
    setLocalOverrides({});
    setSnoozeFor(null);
    setLoading(true);
    void load();
  }, [activeProfile?.id]);

  useEffect(() => {
    void (async () => {
      const cap = await inspectCapability();
      if (cap.supported && !cap.permissionGranted) setNotificationWarning(t('notifications.disabledTitle'));
    })();
  }, [t]);

  const undo = useCallback(async (dose: DoseView) => {
    if (!canConfirmDose) return;
    setBusyDoseId(dose.id);
    try {
      await api.post(`/v1/doses/${dose.id}/undo`, {});
      setLocalOverrides((o) => {
        const next = { ...o };
        delete next[dose.id];
        return next;
      });
      await load();
    } catch (err) {
      if (err instanceof NetworkError) setOffline(true);
      else setNotificationWarning(t('today.undoFailed'));
    } finally {
      setBusyDoseId(null);
    }
  }, [canConfirmDose, load, setOffline, t]);

  const act = useCallback(
    async (dose: DoseView, action: 'taken' | 'skip') => {
      if (!canConfirmDose) return;
      setBusyDoseId(dose.id);
      const clientEventId = newClientEventId();
      const at = new Date().toISOString();
      setLocalOverrides((o) => ({ ...o, [dose.id]: action === 'taken' ? 'taken' : 'skipped' }));

      try {
        if (action === 'taken') {
          await api.post(`/v1/doses/${dose.id}/taken`, { clientEventId, method: 'app', deviceId, takenAt: at });
        } else {
          await api.post(`/v1/doses/${dose.id}/skip`, { clientEventId, deviceId });
        }
        await load();
      } catch (err) {
        if (err instanceof NetworkError) {
          await enqueue(
            action === 'taken'
              ? { type: 'taken', doseOccurrenceId: dose.id, at, clientEventId }
              : { type: 'skipped', doseOccurrenceId: dose.id, at, clientEventId },
          );
          setOffline(true);
        } else {
          setLocalOverrides((o) => {
            const next = { ...o };
            delete next[dose.id];
            return next;
          });
        }
      } finally {
        setBusyDoseId(null);
      }
    },
    [canConfirmDose, deviceId, load, setOffline],
  );

  const snooze = useCallback(async (dose: DoseView, minutes: number) => {
    if (!canConfirmDose) return;
    setSnoozeFor(null);
    setBusyDoseId(dose.id);
    const clientEventId = newClientEventId();
    try {
      await api.post(`/v1/doses/${dose.id}/snooze`, { minutes, clientEventId, deviceId });
      await load();
    } catch (err) {
      if (err instanceof NetworkError) {
        await enqueue({ type: 'snoozed', doseOccurrenceId: dose.id, at: new Date().toISOString(), clientEventId, minutes });
        setOffline(true);
      }
    } finally {
      setBusyDoseId(null);
    }
  }, [canConfirmDose, deviceId, load, setOffline]);

  const greeting = useMemo(() => {
    const hour = new Date().getHours();
    const key = hour < 12 ? 'greeting.morning' : hour < 17 ? 'greeting.afternoon' : 'greeting.evening';
    return t(key, { name: activeProfile?.displayName ?? user?.displayName ?? '' });
  }, [activeProfile?.displayName, user?.displayName, t]);

  const withOverride = (d: DoseView): DoseView =>
    localOverrides[d.id] ? { ...d, status: localOverrides[d.id]! } : d;

  if (loading && !data) return <SafeAreaView style={{ flex: 1 }}><Loading /></SafeAreaView>;

  const todayList = (data?.today ?? []).map(withOverride);
  const nextAnyDay = data?.next ? withOverride(data.next) : null;
  const next = nextAnyDay && data && nextAnyDay.scheduledLocalDate === data.localDate ? nextAnyDay : null;
  const allDone = todayList.length > 0 && todayList.every((d) => !['upcoming', 'due', 'pending_confirmation', 'snoozed'].includes(d.status));

  return (
    <SafeAreaView style={{ flex: 1 }}>
      <ScrollView
        style={{ flex: 1, backgroundColor: theme.colors.background }}
        contentContainerStyle={{ padding: theme.spacing.lg, gap: theme.spacing.md, paddingBottom: theme.spacing.xxxl }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); void load(); }} />}
      >
        <View style={{ gap: 2 }}>
          <Txt variant="h2" weight="bold" accessibilityRole="header">{greeting}</Txt>
          {data ? (
            <Txt variant="bodySmall" color={theme.colors.ink500}>
              {formatDate(`${data.localDate}T12:00:00Z`, data.timezone, { weekday: 'long', day: 'numeric', month: 'long' })}
            </Txt>
          ) : null}
        </View>

        <ProfileSwitcher />
        {activeProfile && !activeProfile.isSelf ? (
          <Banner
            tone="info"
            title={arabic ? `أنت تتابع الآن: ${activeProfile.displayName}` : `You are now viewing: ${activeProfile.displayName}`}
            body={canConfirmDose
              ? (arabic ? 'يمكنك تأكيد الجرعات حسب الصلاحية الممنوحة لك.' : 'You can confirm doses under your granted permission.')
              : (arabic ? 'هذا الملف للمتابعة فقط؛ لا يمكنك تأكيد الجرعات.' : 'This profile is view-only for dose confirmation.')}
          />
        ) : null}

        {offline ? (
          <Banner
            tone="warning"
            title={t('notifications.offlineBanner')}
            body={pendingSyncCount > 0 ? `${pendingSyncCount}` : undefined}
            action={<Button label={t('common.retry')} tone="ghost" fullWidth={false} onPress={() => void syncNow()} />}
          />
        ) : null}

        {notificationWarning ? <Banner tone="danger" title={notificationWarning} body={t('notifications.disabledBody')} /> : null}
        {exactAlarmsUnavailable ? (
          <Banner tone="warning" title={t('notifications.exactAlarmsOff')} body={t('notifications.exactAlarmsOffBody')} />
        ) : null}

        {next ? (
          <>
            <SectionTitle>{t('today.nextMedication')}</SectionTitle>
            <DoseCard
              dose={next}
              prominent
              busy={busyDoseId === next.id}
              onTaken={canConfirmDose ? () => void act(next, 'taken') : undefined}
              onUndo={canConfirmDose ? () => void undo(next) : undefined}
              onSnooze={canConfirmDose ? () => setSnoozeFor(next) : undefined}
              onSkip={canConfirmDose ? () => void act(next, 'skip') : undefined}
            />
          </>
        ) : allDone || nextAnyDay ? (
          <Card><Txt variant="h3" weight="bold" align="center">{t('today.allDone')}</Txt></Card>
        ) : null}

        <SectionTitle>{t('today.title')}</SectionTitle>
        {todayList.length === 0 ? (
          <EmptyState
            title={t('today.noMedications')}
            action={canAddMedication ? <Button label={t('medication.add')} onPress={() => router.push('/medication/add')} fullWidth={false} /> : undefined}
          />
        ) : (
          <View style={{ gap: theme.spacing.sm }}>
            {todayList.map((dose) => (
              <DoseCard
                key={dose.id}
                dose={dose}
                busy={busyDoseId === dose.id}
                onUndo={canConfirmDose ? () => void undo(dose) : undefined}
                onPress={() => router.push(`/medication/${dose.medicationId}`)}
              />
            ))}
          </View>
        )}

        <SafetyNote textKey="missed.guidance" />
      </ScrollView>

      {snoozeFor && canConfirmDose ? (
        <SnoozeSheet
          defaultMinutes={preferences.defaultSnoozeMinutes}
          onSelect={(m) => void snooze(snoozeFor, m)}
          onClose={() => setSnoozeFor(null)}
        />
      ) : null}
    </SafeAreaView>
  );
}