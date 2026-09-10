import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Loading } from '@/components/ui';
import { MedicationDetailView, type MedicationDetail, type StockResponse } from '@/components/MedicationDetailView';
import { useI18n } from '@/i18n';
import { useRequestScope } from '@/hooks/useRequestScope';
import { useApp } from '@/state/app-store';
import { api, ApiError, NetworkError } from '@/api/client';
import type { DoseView, MedicationScheduleView, MedicationView } from '@/api/types';
import type { MessageKey, ScheduleRule } from '@dawaee/shared';

const RECORDED: ReadonlySet<DoseView['status']> = new Set(['taken', 'taken_late', 'skipped', 'missed']);
const HISTORY_DAYS = 30;

function shiftDate(date: string, days: number): string {
  const shifted = new Date(`${date}T12:00:00Z`);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

export default function MedicationDetailScreen() {
  const params = useLocalSearchParams<{ id?: string }>();
  const medicationId = params.id;
  const { t, formatNumber, formatWeekday, isRtl } = useI18n();
  const { activeProfile, setOffline } = useApp();
  const requestScope = useRequestScope(`${activeProfile?.id ?? 'none'}:${medicationId ?? 'none'}`);

  const [medication, setMedication] = useState<MedicationDetail | null>(null);
  const [schedules, setSchedules] = useState<MedicationScheduleView[]>([]);
  const [stock, setStock] = useState<StockResponse | null>(null);
  const [doses, setDoses] = useState<DoseView[]>([]);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const separator = isRtl ? '، ' : ', ';

  const describeError = useCallback((err: unknown): string => {
    if (err instanceof NetworkError) return t('notifications.offlineBanner');
    if (err instanceof ApiError) {
      const key = `error.${err.code}` as MessageKey;
      const message = t(key);
      return message === key ? t('error.internal_error') : message;
    }
    return t('error.internal_error');
  }, [t]);

  const load = useCallback(async () => {
    if (!medicationId || !activeProfile) return;
    const isCurrent = requestScope.begin();
    try {
      const today = new Date().toISOString().slice(0, 10);
      const [detail, stockRes, history] = await Promise.all([
        api.get<{ medication: MedicationDetail; schedules: MedicationScheduleView[] }>(`/v1/medications/${medicationId}`),
        api.get<StockResponse>(`/v1/medications/${medicationId}/stock`).catch(() => null),
        api.get<{ doses: DoseView[] }>('/v1/doses', {
          profileId: activeProfile.id,
          medicationId,
          from: shiftDate(today, -HISTORY_DAYS),
          to: today,
          limit: 20,
        }).catch(() => ({ doses: [] })),
      ]);

      if (!isCurrent()) return;
      setMedication(detail.medication);
      setSchedules(detail.schedules);
      setStock(stockRes);
      setDoses(history.doses.filter((dose) => RECORDED.has(dose.status)));
      setOffline(false);

      if (detail.medication.imageKey) {
        const signed = await api
          .get<{ url: string }>('/v1/uploads/url', { objectKey: detail.medication.imageKey })
          .catch(() => null);
        if (!isCurrent()) return;
        setImageUrl(signed?.url ?? null);
      } else {
        setImageUrl(null);
      }
    } catch (err) {
      if (!isCurrent()) return;
      if (err instanceof NetworkError) setOffline(true);
      setError(describeError(err));
    } finally {
      if (isCurrent()) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [activeProfile, describeError, medicationId, requestScope, setOffline]);

  useEffect(() => { void load(); }, [load]);

  const weekdayLabels = useMemo(
    () => ['2024-01-07', '2024-01-08', '2024-01-09', '2024-01-10', '2024-01-11', '2024-01-12', '2024-01-13']
      .map((date) => formatWeekday(`${date}T12:00:00Z`, 'UTC')),
    [formatWeekday],
  );

  const summarize = useCallback((rule: ScheduleRule): string => {
    switch (rule.kind) {
      case 'fixed_times':
        return t('schedule.previewFixed', { count: formatNumber(rule.times.length), times: rule.times.join(separator) });
      case 'interval':
        return rule.activeFrom && rule.activeUntil
          ? t('schedule.previewIntervalWindow', {
            hours: formatNumber(rule.everyHours), from: rule.activeFrom, until: rule.activeUntil,
          })
          : t('schedule.previewInterval', { hours: formatNumber(rule.everyHours), time: rule.anchorTime });
      case 'days_of_week':
        return t('schedule.previewWeekly', {
          days: rule.weekdays.map((day) => weekdayLabels[day] ?? String(day)).join(separator),
          times: rule.times.join(separator),
        });
      case 'cycle':
        return t('schedule.previewCycle', {
          on: formatNumber(rule.daysOn), off: formatNumber(rule.daysOff), times: rule.times.join(separator),
        });
      case 'as_needed':
        return rule.maxPerDay !== undefined && rule.minHoursBetween !== undefined
          ? t('schedule.previewAsNeededLimits', { max: formatNumber(rule.maxPerDay), hours: formatNumber(rule.minHoursBetween) })
          : t('schedule.previewAsNeeded');
      default:
        return '';
    }
  }, [formatNumber, separator, t, weekdayLabels]);

  const setStatus = async (status: MedicationView['status']) => {
    if (!medicationId) return;
    setBusy(true);
    setError(null);
    try {
      await api.patch(`/v1/medications/${medicationId}`, { status });
      if (status === 'archived') {
        router.replace('/(tabs)/medications');
        return;
      }
      await load();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (force: boolean) => {
    if (!medicationId) return;
    setBusy(true);
    setError(null);
    try {
      await api.delete(`/v1/medications/${medicationId}`, force ? { force: 'true' } : undefined);
      setConfirmingDelete(false);
      router.replace('/(tabs)/medications');
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <SafeAreaView style={{ flex: 1 }}><Loading /></SafeAreaView>;

  return (
    <MedicationDetailView
      medication={medication}
      schedules={schedules}
      stock={stock}
      doses={doses}
      imageUrl={imageUrl}
      refreshing={refreshing}
      busy={busy}
      error={error}
      confirmingDelete={confirmingDelete}
      onConfirmingDeleteChange={setConfirmingDelete}
      onRefresh={() => { setRefreshing(true); void load(); }}
      onSetStatus={setStatus}
      onRemove={remove}
      summarize={summarize}
    />
  );
}
