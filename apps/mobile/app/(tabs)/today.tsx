import { hasProfilePermission } from '@/security/profile-permissions';
import { IncomingInvitations } from '@/components/IncomingInvitations';
import { useScreenRefresh } from '@/hooks/useScreenRefresh';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, RefreshControl, ScrollView, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Banner, Button, Card, EmptyState, Loading, SafetyNote, SectionTitle, Txt } from '@/components/ui';
import { DoseCard } from '@/components/DoseCard';
import { ProfileSwitcher } from '@/components/ProfileSwitcher';
import { useI18n } from '@/i18n';
import { useTheme } from '@/hooks/useTheme';
import { useApp } from '@/state/app-store';
import { profileScopeKey, useRequestScope } from '@/hooks/useRequestScope';
import { api, NetworkError } from '@/api/client';
import type { DoseView, TodayResponse } from '@/api/types';
import type { CachedSchedule, QueuedAction } from '@/storage/offline-queue';
import { applyQueuedToDoses, cacheDose, cacheSchedule, enqueue, newClientEventId, readCachedSchedule, readQueue, subscribeQueueChanges } from '@/storage/offline-queue';
import { captureLocalReminderContext, inspectCapability, rescheduleLocalNotifications } from '@/notifications';
import { SnoozeSheet } from '@/components/SnoozeSheet';
import { DoseNotesSheet } from '@/components/DoseNotesSheet';
import { setMedicationDetailRouteIntent } from '@/navigation/private-navigation';
import { canActOnTodayDose, groupTodayDoses } from '@/notifications/today-groups';

function localDateIn(timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

function cachedDoseToView(d: CachedSchedule['doses'][number], timezone: string): DoseView {
  return {
    id: d.id,
    medicationId: d.medicationId ?? '',
    scheduleId: '',
    scheduledAt: d.scheduledAt,
    scheduledLocalDate: d.scheduledLocalDate,
    scheduledLocalTime: d.scheduledLocalTime,
    scheduledTimezone: d.scheduledTimezone || timezone,
    doseQuantity: d.doseQuantity,
    doseUnit: d.doseUnit as DoseView['doseUnit'],
    status: d.status as DoseView['status'],
    minutesLate: null,
    snoozedUntil: d.snoozedUntil ?? null,
    snoozeCount: 0,
    confirmedAt: d.confirmedAt ?? null,
    notes: d.notes ?? [],
    thresholds: d.thresholds,
    escalationStage: 0,
    medication: {
      name: d.medicationName,
      form: d.medicationForm ?? 'tablet',
      imageKey: d.imageKey ?? null,
      strengthValue: d.strengthValue ?? null,
      strengthUnit: d.strengthUnit ?? null,
      foodInstruction: d.foodInstruction as DoseView['medication']['foodInstruction'],
      instructions: d.instructions ?? null,
      notes: d.medicationNotes ?? null,
    },
  };
}

export default function TodayScreen() {
  const { user, activeProfile } = useApp();
  return <TodayProfileScreen key={profileScopeKey(user?.id, activeProfile)} />;
}

function TodayProfileScreen() {
  const { t, formatDate, formatTime } = useI18n();
  const theme = useTheme();
  const { activeProfile, user, preferences, deviceId, offline, setOffline, pendingSyncCount, syncNow, syncFailureCount, dismissSyncFailure } = useApp();
  const arabic = preferences.locale === 'ar';
  const canAddMedication = hasProfilePermission(activeProfile, 'add_medication');
  const canConfirmDose = hasProfilePermission(activeProfile, 'confirm_dose');
  const canReadNotes = hasProfilePermission(activeProfile, 'view_history');
  const canOpenNotes = canConfirmDose || canReadNotes;
  const canViewToday = hasProfilePermission(activeProfile, 'view_schedule')
    && hasProfilePermission(activeProfile, 'view_medications');

  const openMedication = (medicationId: string) => {
    if (!user || !activeProfile || !medicationId) return;
    setMedicationDetailRouteIntent({
      userId: user.id,
      patientProfileId: activeProfile.id,
      medicationId,
    });
    router.push('/medication/detail');
  };

  const [data, setData] = useState<TodayResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busyDoseId, setBusyDoseId] = useState<string | null>(null);
  const [notesFor, setNotesFor] = useState<DoseView | null>(null);
  const [snoozeFor, setSnoozeFor] = useState<DoseView | null>(null);
  const actionInFlight = useRef(new Set<string>());
  const [actionError, setActionError] = useState<string | null>(null);
  const [notificationWarning, setNotificationWarning] = useState<string | null>(null);
  const [exactAlarmsUnavailable, setExactAlarmsUnavailable] = useState(false);
  const [queuedActions, setQueuedActions] = useState<QueuedAction[]>([]);
  const [serviceUnavailable, setServiceUnavailable] = useState(false);
  const [now, setNow] = useState(Date.now);

  const { begin: beginLoad, capture: captureScope } = useRequestScope();

  const load = useCallback(async () => {
    const isCurrent = beginLoad();
    if (!isCurrent()) return;
    if (!activeProfile) { setLoading(false); setRefreshing(false); return; }
    // /v1/today contains medication identity as well as the schedule. Mirror the
    // server's composite read contract before any network or secure-cache read.
    // This also clears previously authorised data if caregiver permissions are
    // revoked while the same profile remains selected.
    if (!canViewToday) {
      setData(null);
      setExactAlarmsUnavailable(false);
      setServiceUnavailable(false);
      setLoading(false);
      setRefreshing(false);
      return;
    }
    setServiceUnavailable(false);
    const remindersAreCurrent = captureLocalReminderContext();
    try {
      const res = await api.get<TodayResponse>('/v1/today', { profileId: activeProfile.id });
      if (!isCurrent()) return;
      const queued = await readQueue();
      if (!isCurrent()) return;
      setQueuedActions(queued);
      setData(res);
      setServiceUnavailable(false);
      setOffline(false);

      await cacheSchedule({
        profileId: activeProfile.id,
        cachedAt: new Date().toISOString(),
        timezone: res.timezone,
        doses: [...res.today, ...res.prefetch].map(cacheDose),
      });

      if (!isCurrent()) return;

      // Direct local medication reminders belong only to the signed-in patient's
      // own profile. A caregiver viewing another profile must not silently turn
      // that patient's schedule into reminders on the caregiver's phone.
      if (activeProfile.isSelf) {
        // The HTTP/cache work may predate a privacy change or logout cancel.
        // Keep valid clinical data, but never recreate reminders with old options.
        if (!remindersAreCurrent()) return;
        const schedule = await rescheduleLocalNotifications(
          applyQueuedToDoses([...res.today, ...res.prefetch], queued), preferences.locale,
          {
            voiceEnabled: preferences.voiceRemindersEnabled,
            showMedication: preferences.showMedicationInNotifications,
          },
        );
        if (isCurrent()) setExactAlarmsUnavailable(schedule.exactAlarmsUnavailable);
      } else {
        setExactAlarmsUnavailable(false);
      }
    } catch (err) {
      if (!isCurrent()) return;
      if (err instanceof NetworkError) {
        setOffline(true);
        const cached = await readCachedSchedule(activeProfile.id);
        if (!isCurrent()) return;
        const queued = await readQueue();
        if (!isCurrent()) return;
        setQueuedActions(queued);
        if (cached) {
          // Keep the authoritative snapshot separate from pending decisions.
          // A rejected journal entry can then disappear without leaving its
          // optimistic Taken status baked into the offline screen data.
          const merged = cached;
          const localDate = localDateIn(cached.timezone);
          // Today and prefetch overlap, and this snapshot can outlive its
          // original local day. Keep occurrence identity unique and select in
          // chronological order rather than letting yesterday hide today's actions.
          const views = [...new Map(merged.doses.map((d) => [d.id, cachedDoseToView(d, merged.timezone)])).values()]
            .sort((a, b) => Date.parse(a.scheduledAt) - Date.parse(b.scheduledAt));
          setData({
            profileId: merged.profileId,
            localDate,
            timezone: merged.timezone,
            serverTime: merged.cachedAt,
            next:
              views.find((d) => d.scheduledLocalDate >= localDate
                && (d.status === 'upcoming' || d.status === 'due' || d.status === 'pending_confirmation')) ??
              null,
            today: views.filter((d) => d.scheduledLocalDate === localDate),
            prefetch: views.filter((d) => d.scheduledLocalDate > localDate),
            prefetchDays: 7,
          });
        }
      } else {
        // HTTP failures (including 429/500/503) and invalid responses are not
        // evidence of an empty schedule. Preserve data and expose retry.
        setOffline(false);
        setServiceUnavailable(true);
      }
    } finally {
      if (isCurrent()) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [beginLoad, activeProfile, canViewToday, preferences.locale, preferences.voiceRemindersEnabled, preferences.showMedicationInNotifications, setOffline, data]);

  useEffect(() => {
    setData(null);
    setQueuedActions([]);
    setSnoozeFor(null);
    setServiceUnavailable(false);
    setLoading(true);
  }, [activeProfile?.id, canViewToday]);

  useScreenRefresh(load, `${activeProfile?.id}:${canViewToday}`);

  useEffect(() => subscribeQueueChanges(() => {
    const current = captureScope();
    void readQueue().then(queue => {
      if (!current()) return;
      if (queue.length > 0) setQueuedActions(queue);
      void load();
    });
  }), [captureScope, load]);

  useEffect(() => {
    if (!activeProfile?.isSelf || !data || queuedActions.length === 0) return;
    void rescheduleLocalNotifications(
      applyQueuedToDoses([...data.today, ...data.prefetch], queuedActions), preferences.locale,
      { voiceEnabled: preferences.voiceRemindersEnabled, showMedication: preferences.showMedicationInNotifications },
    ).catch(() => undefined);
  }, [activeProfile?.isSelf, data, queuedActions, preferences.locale,
    preferences.voiceRemindersEnabled, preferences.showMedicationInNotifications]);

  useFocusEffect(useCallback(() => {
    const tick = () => setNow(Date.now());
    tick();
    const timer = setInterval(tick, 1000);
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') tick();
    });
    return () => { clearInterval(timer); subscription.remove(); };
  }, []));

  useFocusEffect(useCallback(() => {
    let active = true;
    let latest = 0;
    const inspect = async () => {
      const attempt = ++latest;
      try {
        const cap = await inspectCapability();
        if (!active || attempt !== latest) return;
        setNotificationWarning(cap.supported && !cap.permissionGranted
          ? t('notifications.disabledTitle') : null);
      } catch { /* An unreadable permission is not a denied permission. */ }
    };
    void inspect();
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void inspect();
    });
    return () => { active = false; subscription.remove(); };
  }, [t]));

  const undo = useCallback(async (dose: DoseView) => {
    const isCurrent = captureScope();
    if (!canConfirmDose || !isCurrent() || actionInFlight.current.has(dose.id)) return;
    actionInFlight.current.add(dose.id);
    setActionError(null);
    setBusyDoseId(dose.id);
    try {
      await api.post('/v1/dose/action', { doseId: dose.id, action: 'undo', clientEventId: `undo-${dose.id}-${dose.confirmedAt ?? 'unknown'}` });
      if (!isCurrent()) return;
      if (isCurrent()) await load();
    } catch (err) {
      if (!isCurrent()) return;
      if (err instanceof NetworkError) setOffline(true);
      setActionError(t('today.undoFailed'));
    } finally {
      actionInFlight.current.delete(dose.id);
      if (isCurrent()) setBusyDoseId(null);
    }
  }, [captureScope, canConfirmDose, load, setOffline, t]);

  const act = useCallback(
    async (dose: DoseView, action: 'taken' | 'skip') => {
      const isCurrent = captureScope();
      if (!canConfirmDose || !isCurrent() || !canActOnTodayDose(dose, Date.now()) || actionInFlight.current.has(dose.id)) return;
      actionInFlight.current.add(dose.id);
      setActionError(null);
      setBusyDoseId(dose.id);
      const clientEventId = newClientEventId();
      const at = new Date().toISOString();
      // Keep the saved status while a request is pending; only durable offline
      // queue entries get a clearly labelled pending-sync display.

      try {
        if (action === 'taken') {
          await api.post('/v1/dose/action', { doseId: dose.id, action: 'taken', clientEventId, method: 'app', deviceId, takenAt: at });
        } else {
          await api.post('/v1/dose/action', { doseId: dose.id, action: 'skip', clientEventId, deviceId, actionAt: at });
        }
        if (isCurrent()) await load();
      } catch (err) {
        if (err instanceof NetworkError) {
          try {
            await enqueue(
              action === 'taken'
                ? { type: 'taken', doseOccurrenceId: dose.id, at, clientEventId }
                : { type: 'skipped', doseOccurrenceId: dose.id, at, clientEventId },
            );
            if (isCurrent()) {
              setOffline(true);
              setQueuedActions(await readQueue());
            }
          } catch {
            if (isCurrent()) setActionError(t('today.actionSaveFailed'));
          }
        } else if (isCurrent()) {
          setActionError(t('today.actionSaveFailed'));
        }
      } finally {
        actionInFlight.current.delete(dose.id);
        if (isCurrent()) setBusyDoseId(null);
      }
    },
    [captureScope, canConfirmDose, deviceId, load, setOffline, t],
  );

  const snooze = useCallback(async (dose: DoseView, minutes: number) => {
    const isCurrent = captureScope();
    if (!canConfirmDose || !isCurrent() || !canActOnTodayDose(dose, Date.now()) || actionInFlight.current.has(dose.id)) return;
    const deadline = Date.now() + minutes * 60_000;
    if (!Number.isInteger(minutes) || minutes < 1 || deadline >= Date.parse(dose.scheduledAt)
      + (dose.thresholds?.missedAfterMinutes ?? 120) * 60_000) {
      setActionError(t('error.validation_failed'));
      return;
    }
    actionInFlight.current.add(dose.id);
    setActionError(null);
    setSnoozeFor(null);
    setBusyDoseId(dose.id);
    const clientEventId = newClientEventId();
    const at = new Date().toISOString();
    try {
      await api.post('/v1/dose/action', { doseId: dose.id, action: 'snooze', minutes, clientEventId, deviceId, actionAt: at });
      if (isCurrent()) await load();
    } catch (err) {
      if (err instanceof NetworkError) {
        try {
          await enqueue({ type: 'snoozed', doseOccurrenceId: dose.id, at, clientEventId, minutes });
          if (isCurrent()) { setOffline(true); setQueuedActions(await readQueue()); }
        } catch {
          if (isCurrent()) setActionError(t('today.actionSaveFailed'));
        }
      } else if (isCurrent()) {
        setActionError(t('today.actionSaveFailed'));
      }
    } finally {
      actionInFlight.current.delete(dose.id);
      if (isCurrent()) setBusyDoseId(null);
    }
  }, [captureScope, canConfirmDose, deviceId, load, setOffline, t]);

  const greeting = useMemo(() => {
    const hour = new Date().getHours();
    const key = hour < 12 ? 'greeting.morning' : hour < 17 ? 'greeting.afternoon' : 'greeting.evening';
    return t(key, { name: activeProfile?.displayName ?? user?.displayName ?? '' });
  }, [activeProfile?.displayName, user?.displayName, t]);

  const withOverride = (d: DoseView): DoseView => applyQueuedToDoses([d], queuedActions)[0]!;

  if (loading && !data) return <SafeAreaView style={{ flex: 1 }}><Loading /></SafeAreaView>;

  const todayList = (data?.today ?? []).map(withOverride);
  const groups = groupTodayDoses(todayList, now);

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
          canViewToday ? (
            <Banner
              tone="info"
              title={arabic ? `أنت تتابع الآن: ${activeProfile.displayName}` : `You are now viewing: ${activeProfile.displayName}`}
              body={canConfirmDose
                ? (arabic ? 'يمكنك تأكيد الجرعات حسب الصلاحية الممنوحة لك.' : 'You can confirm doses under your granted permission.')
                : (arabic ? 'هذا الملف للمتابعة فقط؛ لا يمكنك تأكيد الجرعات.' : 'This profile is view-only for dose confirmation.')}
            />
          ) : (
            <Banner
              tone="warning"
              title={arabic ? 'صلاحية صفحة اليوم غير متاحة' : 'Today is restricted for this profile'}
              body={arabic
                ? 'مستوى الوصول الحالي لا يتضمن تفاصيل الدواء اللازمة لعرض جرعات اليوم.'
                : 'This access level does not include the medication details required to show today’s doses.'}
            />
          )
        ) : null}

        <IncomingInvitations />
        {offline || pendingSyncCount > 0 ? (
          <Banner
            tone="warning"
            title={t(offline ? 'notifications.offlineBanner' : 'notifications.pendingSync')}
            body={pendingSyncCount > 0 ? `${pendingSyncCount}` : undefined}
            action={<Button label={t('common.retry')} tone="ghost" fullWidth={false} onPress={() => void syncNow()} />}
          />
        ) : null}

        {syncFailureCount > 0 ? <Banner tone="danger" title={t('notifications.syncFailed')}
          action={<Button label={t('common.close')} tone="ghost" fullWidth={false} onPress={dismissSyncFailure} />} /> : null}
        {actionError ? <Banner tone="danger" title={actionError} /> : null}
        {notificationWarning ? <Banner tone="danger" title={notificationWarning} body={t('notifications.disabledBody')} /> : null}
        {exactAlarmsUnavailable ? (
          <Banner tone="warning" title={t('notifications.exactAlarmsOff')} body={t('notifications.exactAlarmsOffBody')} />
        ) : null}

        {canViewToday ? (
          <>
            {serviceUnavailable ? (
              <Banner
                tone="warning"
                title={arabic ? 'الخدمة غير متاحة مؤقتاً' : 'Service temporarily unavailable'}
                body={arabic
                  ? 'تعذر تحميل جدول اليوم الآن. أعد المحاولة بعد لحظات؛ لن نعرض حالة فارغة بدلاً من الجرعات.'
                  : 'Today’s schedule could not be loaded right now. Retry shortly; an empty schedule is not being shown in place of unavailable data.'}
                action={<Button label={t('common.retry')} tone="ghost" fullWidth={false} onPress={() => void load()} />}
              />
            ) : todayList.length === 0 ? (
              <EmptyState
                title={t('today.noMedications')}
                action={canAddMedication ? <Button label={t('medication.add')} onPress={() => router.push('/medication/add')} fullWidth={false} /> : undefined}
              />
            ) : (
              <View style={{ gap: theme.spacing.lg }}>
                {groups.due.length > 0 ? <SectionTitle>{t('today.dueGroups')}</SectionTitle> : (
                  <Card><Txt align="center">{t('today.noDosesDue')}</Txt></Card>
                )}
                {groups.due.map(group => (
                  <View key={group.scheduledAt} testID="today-due-group" style={{ gap: theme.spacing.sm }}>
                    <SectionTitle>{t('today.timeGroup', { time: formatTime(group.scheduledAt, data?.timezone) })}</SectionTitle>
                    {group.doses.map(dose => (
                      <DoseCard key={dose.id} dose={dose} prominent busy={busyDoseId === dose.id}
                        onTaken={canConfirmDose ? () => void act(dose, 'taken') : undefined}
                        onUndo={canConfirmDose ? () => void undo(dose) : undefined}
                        onSnooze={canConfirmDose ? () => setSnoozeFor(dose) : undefined}
                        onSkip={canConfirmDose ? () => void act(dose, 'skip') : undefined}
                        onNote={canOpenNotes ? () => setNotesFor(dose) : undefined}
                      />
                    ))}
                  </View>
                ))}
                {groups.upcoming.length > 0 ? (
                  <>
                    <SectionTitle>{t('today.laterToday')}</SectionTitle>
                    <Txt color={theme.colors.ink500}>{t('today.confirmAtTime')}</Txt>
                    {groups.upcoming.map(group => (
                      <View key={group.scheduledAt} testID="today-upcoming-group" style={{ gap: theme.spacing.sm }}>
                        <SectionTitle>{t('today.timeGroup', { time: formatTime(group.scheduledAt, data?.timezone) })}</SectionTitle>
                        {group.doses.map(dose => (
                          <DoseCard key={dose.id} dose={dose} onNote={canOpenNotes ? () => setNotesFor(dose) : undefined} onPress={() => openMedication(dose.medicationId)} />
                        ))}
                      </View>
                    ))}
                  </>
                ) : null}
                {groups.recorded.length > 0 ? <SectionTitle>{t('today.recorded')}</SectionTitle> : null}
                {groups.recorded.map((dose) => (
                  <DoseCard
                    key={dose.id}
                    dose={dose}
                    busy={busyDoseId === dose.id}
                    onUndo={canConfirmDose ? () => void undo(dose) : undefined}
                    onNote={canOpenNotes ? () => setNotesFor(dose) : undefined}
                    onPress={() => openMedication(dose.medicationId)}
                  />
                ))}
              </View>
            )}

            <SafetyNote textKey="missed.guidance" />
          </>
        ) : null}
      </ScrollView>

      {notesFor && activeProfile && canOpenNotes ? (
        <DoseNotesSheet key={notesFor.id} profileId={activeProfile.id} dose={notesFor}
          canWrite={canConfirmDose} canRead={canReadNotes} onClose={() => setNotesFor(null)} />
      ) : null}
      {snoozeFor && canConfirmDose ? (
        <SnoozeSheet
          defaultMinutes={preferences.defaultSnoozeMinutes}
          maxMinutes={Math.max(0, Math.ceil((Date.parse(snoozeFor.scheduledAt)
            + (snoozeFor.thresholds?.missedAfterMinutes ?? 120) * 60_000 - now) / 60_000) - 1)}
          onSelect={(m) => void snooze(snoozeFor, m)}
          onClose={() => setSnoozeFor(null)}
        />
      ) : null}
    </SafeAreaView>
  );
}
