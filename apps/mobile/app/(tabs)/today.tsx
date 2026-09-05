import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshControl, ScrollView, View } from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Banner, Button, Card, EmptyState, Loading, SafetyNote, SectionTitle, Txt } from '@/components/ui';
import { DoseCard } from '@/components/DoseCard';
import { useI18n } from '@/i18n';
import { useTheme } from '@/hooks/useTheme';
import { useApp } from '@/state/app-store';
import { api, NetworkError } from '@/api/client';
import type { DoseView, TodayResponse } from '@/api/types';
import type { CachedSchedule } from '@/storage/offline-queue';
import { applyQueuedToCache, cacheSchedule, enqueue, newClientEventId, readCachedSchedule, readQueue } from '@/storage/offline-queue';
import { inspectCapability, rescheduleLocalNotifications } from '@/notifications';
import { SnoozeSheet } from '@/components/SnoozeSheet';

/**
 * Today — the screen that has to work when nothing else does.
 *
 * It shows what matters now and nothing else. Behind that simplicity:
 *  - the server's prefetch window is cached, so this renders offline
 *  - "Taken" is applied locally first and queued, so it never fails
 *  - local notifications are rebuilt from the same cache on every load
 */
/** The calendar date in the profile's own zone, not the device's. */
function localDateIn(timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

/**
 * Widens a cached dose back into the shape the screen renders.
 *
 * The cache deliberately stores only what Today displays, so the fields the
 * server would send but this screen never reads are filled with honest empties
 * rather than invented values — nothing here is presented to the patient as if
 * it came from the server.
 */
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

      // Rebuilt from the freshly cached window so a phone that loses signal
      // right after this still reminds on time.
      const schedule = await rescheduleLocalNotifications(
        [...res.today, ...res.prefetch], preferences.locale,
        { voiceEnabled: preferences.voiceRemindersEnabled },
      );

      // The scheduling attempt is the only thing that can discover Android has
      // taken exact alarms away. This used to be computed and discarded, so a
      // patient whose reminders had started arriving late was shown a screen
      // saying everything was fine.
      setExactAlarmsUnavailable(schedule.exactAlarmsUnavailable);
    } catch (err) {
      if (err instanceof NetworkError) {
        setOffline(true);
        const cached = await readCachedSchedule(activeProfile.id);
        if (cached && !data) {
          // Render from cache: a missing network must not blank the screen a
          // patient relies on. Actions taken while offline are still sitting
          // in the queue, so they are applied on top — otherwise a dose the
          // patient just confirmed would reappear as still due, and they
          // could take it twice.
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
  }, [activeProfile, preferences.locale, preferences.voiceRemindersEnabled, setOffline, data]);

  useEffect(() => { void load(); }, [activeProfile?.id]);

  useEffect(() => {
    void (async () => {
      const cap = await inspectCapability();
      if (cap.supported && !cap.permissionGranted) setNotificationWarning(t('notifications.disabledTitle'));
    })();
  }, [t]);

  /**
   * Reverse a confirmation the patient did not mean.
   *
   * The server has accepted this within a ten-minute window from the start,
   * and nothing ever called it. Deliberately NOT queued when offline: undo is
   * time-bounded, so a request replayed twenty minutes later would be refused
   * anyway, and silently queueing it would tell the patient their correction
   * was accepted when it was not. It says plainly that the window passed.
   */
  const undo = useCallback(async (dose: DoseView) => {
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
  }, [load, setOffline, t]);

  const act = useCallback(
    async (dose: DoseView, action: 'taken' | 'skip') => {
      setBusyDoseId(dose.id);
      const clientEventId = newClientEventId();
      const at = new Date().toISOString();

      // Optimistic locally, queued for the server. The patient's tap is never
      // lost to a bad connection.
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
    [deviceId, load, setOffline],
  );

  const snooze = useCallback(async (dose: DoseView, minutes: number) => {
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
  }, [deviceId, load, setOffline]);

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

  /**
   * The hero card, but only for a dose that belongs to today.
   *
   * The server's `next` is the next unresolved dose on any day. So the moment
   * a patient confirmed their last dose of the day, the hero swapped to
   * TOMORROW's — same medication, same time, indistinguishable at a glance —
   * still carrying a "Taken" button. One tap, at the exact moment of most
   * confusion, recorded a dose roughly twenty-four hours early. For an elderly
   * patient that is not a cosmetic problem.
   *
   * A dose on a later date is not hidden, it is simply not offered as
   * something to act on now: "you are done for today" is the honest thing to
   * show, and the timeline below still lists everything.
   */
  const next = nextAnyDay && data && nextAnyDay.scheduledLocalDate === data.localDate
    ? nextAnyDay
    : null;
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

        {offline ? (
          <Banner
            tone="warning"
            title={t('notifications.offlineBanner')}
            body={pendingSyncCount > 0 ? `${pendingSyncCount}` : undefined}
            action={<Button label={t('common.retry')} tone="ghost" fullWidth={false} onPress={() => void syncNow()} />}
          />
        ) : null}

        {notificationWarning ? (
          <Banner tone="danger" title={notificationWarning} body={t('notifications.disabledBody')} />
        ) : null}

        {exactAlarmsUnavailable ? (
          <Banner
            tone="warning"
            title={t('notifications.exactAlarmsOff')}
            body={t('notifications.exactAlarmsOffBody')}
          />
        ) : null}

        {next ? (
          <>
            <SectionTitle>{t('today.nextMedication')}</SectionTitle>
            <DoseCard
              dose={next}
              prominent
              busy={busyDoseId === next.id}
              onTaken={() => void act(next, 'taken')}
              onUndo={() => void undo(next)}
              onSnooze={() => setSnoozeFor(next)}
              onSkip={() => void act(next, 'skip')}
            />
          </>
        ) : allDone || nextAnyDay ? (
          <Card><Txt variant="h3" weight="bold" align="center">{t('today.allDone')}</Txt></Card>
        ) : null}

        <SectionTitle>{t('today.title')}</SectionTitle>
        {todayList.length === 0 ? (
          <EmptyState
            title={t('today.noMedications')}
            action={<Button label={t('medication.add')} onPress={() => router.push('/medication/add')} fullWidth={false} />}
          />
        ) : (
          <View style={{ gap: theme.spacing.sm }}>
            {todayList.map((dose) => (
              <DoseCard
                key={dose.id}
                dose={dose}
                busy={busyDoseId === dose.id}
                onUndo={() => void undo(dose)}
                onPress={() => router.push(`/medication/${dose.medicationId}`)}
              />
            ))}
          </View>
        )}

        <SafetyNote textKey="missed.guidance" />
      </ScrollView>

      {snoozeFor ? (
        <SnoozeSheet
          defaultMinutes={preferences.defaultSnoozeMinutes}
          onSelect={(m) => void snooze(snoozeFor, m)}
          onClose={() => setSnoozeFor(null)}
        />
      ) : null}
    </SafeAreaView>
  );
}
