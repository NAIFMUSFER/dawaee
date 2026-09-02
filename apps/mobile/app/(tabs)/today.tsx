import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshControl, ScrollView, View } from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Banner, Button, Card, EmptyState, Loading, Row, SafetyNote, SectionTitle, Txt } from '@/components/ui';
import { DoseCard } from '@/components/DoseCard';
import { useI18n } from '@/i18n';
import { useTheme } from '@/hooks/useTheme';
import { useApp } from '@/state/app-store';
import { api, NetworkError } from '@/api/client';
import type { DoseView, TodayResponse } from '@/api/types';
import { cacheSchedule, enqueue, flushQueue, newClientEventId, readCachedSchedule, readQueue } from '@/storage/offline-queue';
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
      await rescheduleLocalNotifications([...res.today, ...res.prefetch], preferences.locale, {
        voiceEnabled: preferences.voiceRemindersEnabled,
      });
    } catch (err) {
      if (err instanceof NetworkError) {
        setOffline(true);
        const cached = await readCachedSchedule(activeProfile.id);
        if (cached && !data) {
          // Render from cache: a missing network must not blank the screen a
          // patient relies on.
          setData({
            profileId: cached.profileId,
            localDate: new Date().toISOString().slice(0, 10),
            timezone: cached.timezone,
            serverTime: cached.cachedAt,
            next: null,
            today: [],
            prefetch: [],
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

  const act = useCallback(
    async (dose: DoseView, action: 'taken' | 'skip', minutes?: number) => {
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
  const next = data?.next ? withOverride(data.next) : null;
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

        {next ? (
          <>
            <SectionTitle>{t('today.nextMedication')}</SectionTitle>
            <DoseCard
              dose={next}
              prominent
              busy={busyDoseId === next.id}
              onTaken={() => void act(next, 'taken')}
              onSnooze={() => setSnoozeFor(next)}
              onSkip={() => void act(next, 'skip')}
            />
          </>
        ) : allDone ? (
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
              <DoseCard key={dose.id} dose={dose} onPress={() => router.push(`/medication/${dose.medicationId}`)} />
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
