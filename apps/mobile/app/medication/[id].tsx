import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Image, Modal, Pressable, RefreshControl, ScrollView, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Badge, Banner, Button, Card, Divider, Loading, Row, SafetyNote, SectionTitle, Txt } from '@/components/ui';
import { useI18n } from '@/i18n';
import { useTheme } from '@/hooks/useTheme';
import { useApp } from '@/state/app-store';
import { api, ApiError, NetworkError } from '@/api/client';
import type { DoseView, MedicationScheduleView, MedicationView } from '@/api/types';
import { statusColors } from '@/theme';
import type { DoseUnit, MessageKey, ScheduleRule, StockForecast } from '@dawaee/shared';

/**
 * Everything known about one medication.
 *
 * The screen is deliberately explicit about provenance and about stock: a
 * patient looking at a record that a photo produced should be able to see that
 * it came from a photo and that they confirmed it, and a record that is about
 * to run out should say so here rather than only in a notification.
 */

type MedicationDetail = Omit<MedicationView, 'schedules' | 'stock' | 'stockForecast'> & {
  manufacturer: string | null;
  barcode: string | null;
};

interface StockResponse {
  stock: {
    unit: DoseUnit;
    remainingQuantity: number | null;
    lowStockThresholdDays: number | null;
    lastRefillAt: string | null;
  } | null;
  forecast: StockForecast | null;
}

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

  const { t, formatDate, formatNumber, formatTime, formatWeekday, isRtl, formatMeasure } = useI18n();
  const theme = useTheme();
  const { activeProfile, setOffline } = useApp();

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

      setMedication(detail.medication);
      setSchedules(detail.schedules);
      setStock(stockRes);
      setDoses(history.doses.filter((dose) => RECORDED.has(dose.status)));
      setOffline(false);

      if (detail.medication.imageKey) {
        const signed = await api
          .get<{ url: string }>('/v1/uploads/url', { objectKey: detail.medication.imageKey })
          .catch(() => null);
        setImageUrl(signed?.url ?? null);
      } else {
        setImageUrl(null);
      }
    } catch (err) {
      if (err instanceof NetworkError) setOffline(true);
      setError(describeError(err));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [activeProfile, describeError, medicationId, setOffline]);

  useEffect(() => { void load(); }, [load]);

  const weekdayLabels = useMemo(
    () => ['2024-01-07', '2024-01-08', '2024-01-09', '2024-01-10', '2024-01-11', '2024-01-12', '2024-01-13']
      .map((date) => formatWeekday(`${date}T12:00:00Z`, 'UTC')),
    [formatWeekday],
  );

  /** One sentence per schedule, in the same words the builder previewed. */
  const summarize = useCallback((rule: ScheduleRule): string => {
    switch (rule.kind) {
      case 'fixed_times':
        return t('schedule.previewFixed', {
          count: formatNumber(rule.times.length), times: rule.times.join(separator),
        });
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
          ? t('schedule.previewAsNeededLimits', {
            max: formatNumber(rule.maxPerDay), hours: formatNumber(rule.minHoursBetween),
          })
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

  if (!medication) {
    return (
      <SafeAreaView style={{ flex: 1 }}>
        <View style={{ padding: theme.spacing.lg, gap: theme.spacing.md }}>
          <Banner tone="danger" title={error ?? t('error.not_found')} />
          <Button label={t('common.back')} tone="ghost" onPress={() => router.back()} />
        </View>
      </SafeAreaView>
    );
  }

  const strength = medication.strengthValue !== null
    ? formatMeasure(medication.strengthValue, medication.strengthUnit ? `strengthUnit.${medication.strengthUnit}` : undefined)
    : null;
  const forecast = stock?.forecast ?? null;
  const hasHistory = doses.length > 0;

  return (
    <SafeAreaView style={{ flex: 1 }}>
      <ScrollView
        style={{ flex: 1, backgroundColor: theme.colors.background }}
        contentContainerStyle={{ padding: theme.spacing.lg, gap: theme.spacing.md, paddingBottom: theme.spacing.xxxl }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); void load(); }} />}
      >
        <Txt variant="h2" weight="bold" accessibilityRole="header">{medication.name}</Txt>

        {error ? <Banner tone="danger" title={error} /> : null}

        <Card>
          {imageUrl ? (
            <Image
              source={{ uri: imageUrl }}
              accessibilityLabel={t('medication.imageAlt', { name: medication.name })}
              resizeMode="cover"
              style={{
                width: '100%',
                height: theme.elderlyMode ? 260 : 200,
                borderRadius: theme.radius.md,
                backgroundColor: theme.colors.ink100,
              }}
            />
          ) : (
            <View style={{
              height: theme.elderlyMode ? 160 : 120,
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: theme.radius.md,
              backgroundColor: theme.colors.surfaceAlt,
            }}>
              <Txt variant="h1">💊</Txt>
              <Txt variant="caption" color={theme.colors.ink500}>{t('medication.noImage')}</Txt>
            </View>
          )}

          <Row wrap gap={theme.spacing.sm}>
            <Badge
              label={t(`medication.status.${medication.status}` as MessageKey)}
              fg={medication.status === 'active' ? theme.colors.success700 : theme.colors.ink700}
              bg={medication.status === 'active' ? theme.colors.success100 : theme.colors.ink100}
            />
            {forecast?.isLow ? (
              <Badge label={t('stock.lowBadge')} fg={theme.colors.warning700} bg={theme.colors.warning100} />
            ) : null}
          </Row>
        </Card>

        <SectionTitle>{t('medication.identity')}</SectionTitle>
        <Card>
          <DetailRow label={t('medication.form')} value={t(`form.${medication.form}` as MessageKey)} />
          {strength ? <DetailRow label={t('medication.strength')} value={strength} /> : null}
          {medication.brandName ? <DetailRow label={t('medication.brandName')} value={medication.brandName} /> : null}
          {medication.genericName ? <DetailRow label={t('medication.genericName')} value={medication.genericName} /> : null}
          {medication.manufacturer ? <DetailRow label={t('medication.manufacturer')} value={medication.manufacturer} /> : null}
          {medication.barcode ? <DetailRow label={t('medication.barcode')} value={medication.barcode} /> : null}
          {medication.foodInstruction !== 'no_preference' ? (
            <DetailRow
              label={t('medication.foodInstruction')}
              value={t(`food.${medication.foodInstruction}` as MessageKey)}
            />
          ) : null}
          {medication.instructions ? (
            <DetailRow label={t('medication.instructions')} value={medication.instructions} />
          ) : null}
          {medication.doctorInstructions ? (
            <DetailRow label={t('medication.doctorInstructions')} value={medication.doctorInstructions} />
          ) : null}
          {medication.expiryDate ? (
            <DetailRow
              label={t('medication.expiryDate')}
              value={formatDate(`${medication.expiryDate}T12:00:00Z`, activeProfile?.timezone)}
            />
          ) : null}
          <Divider />
          <Txt variant="caption" color={theme.colors.ink500}>{t('medication.provenance')}</Txt>
          <Badge
            label={t(`medication.source.${medication.identitySource}` as MessageKey)}
            fg={theme.colors.info700}
            bg={theme.colors.info100}
          />
        </Card>

        <SectionTitle
          action={
            <Button
              label={schedules.length > 0 ? t('schedule.change') : t('schedule.add')}
              tone="ghost"
              fullWidth={false}
              onPress={() => router.push(
                schedules.length > 0
                  ? `/medication/schedule?medicationId=${medication.id}&mode=edit`
                  : `/medication/schedule?medicationId=${medication.id}&mode=create`,
              )}
            />
          }
        >
          {t('schedule.title')}
        </SectionTitle>
        {schedules.length === 0 ? (
          <Card><Txt variant="body" color={theme.colors.ink500}>{t('schedule.none')}</Txt></Card>
        ) : (
          schedules.map((schedule) => (
            <Card
              key={schedule.id}
              onPress={() => router.push(
                `/medication/schedule?medicationId=${medication.id}&mode=edit&scheduleId=${schedule.id}`,
              )}
              accessibilityLabel={summarize(schedule.rule)}
            >
              <Txt variant="bodyLarge" weight="medium">{summarize(schedule.rule)}</Txt>
              <Txt variant="bodySmall" color={theme.colors.ink500}>
                {t('schedule.dosePerTime', {
                  qty: formatNumber(schedule.doseQuantity),
                  unit: t(`unit.${schedule.doseUnit}` as MessageKey),
                })}
              </Txt>
              {!schedule.active ? (
                <Badge label={t('schedule.inactive')} fg={theme.colors.ink700} bg={theme.colors.ink100} />
              ) : null}
            </Card>
          ))
        )}

        <SectionTitle
          action={
            <Button
              label={t('stock.markRefilled')}
              tone="ghost"
              fullWidth={false}
              onPress={() => router.push(`/medication/stock?medicationId=${medication.id}`)}
            />
          }
        >
          {t('stock.title')}
        </SectionTitle>
        <Card>
          {stock?.stock && stock.stock.remainingQuantity !== null ? (
            <>
              <Txt variant="h3" weight="bold">
                {t('stock.remaining', {
                  qty: formatNumber(stock.stock.remainingQuantity),
                  unit: t(`unit.${stock.stock.unit}` as MessageKey),
                })}
              </Txt>
              {forecast?.daysRemaining !== null && forecast !== null ? (
                <Txt variant="body" color={forecast.isLow ? theme.colors.warning700 : theme.colors.ink500}>
                  {t('stock.runsOutIn', { days: formatNumber(forecast.daysRemaining) })}
                </Txt>
              ) : (
                <Txt variant="bodySmall" color={theme.colors.ink500}>{t('stock.unknownDays')}</Txt>
              )}
              {forecast?.runoutDate ? (
                <Txt variant="bodySmall" color={theme.colors.ink500}>
                  {t('stock.runsOutOn', {
                    date: formatDate(`${forecast.runoutDate}T12:00:00Z`, activeProfile?.timezone),
                  })}
                </Txt>
              ) : null}
            </>
          ) : (
            <Txt variant="body" color={theme.colors.ink500}>{t('stock.notTracked')}</Txt>
          )}
        </Card>

        <SectionTitle>{t('medication.recentDoses')}</SectionTitle>
        {doses.length === 0 ? (
          <Card><Txt variant="body" color={theme.colors.ink500}>{t('medication.noDoseHistory')}</Txt></Card>
        ) : (
          <Card>
            {doses.map((dose, index) => {
              const colors = statusColors(dose.status);
              return (
                <View key={dose.id} style={{ gap: theme.spacing.xs }}>
                  {index > 0 ? <Divider /> : null}
                  <Row style={{ justifyContent: 'space-between' }} gap={theme.spacing.md}>
                    <View style={{ flex: 1 }}>
                      <Txt variant="body" weight="medium">
                        {formatDate(dose.scheduledAt, dose.scheduledTimezone, { day: 'numeric', month: 'short' })}
                      </Txt>
                      <Txt variant="bodySmall" color={theme.colors.ink500}>
                        {formatTime(dose.scheduledAt, dose.scheduledTimezone)}
                      </Txt>
                    </View>
                    <Badge label={t(`dose.status.${dose.status}` as MessageKey)} fg={colors.fg} bg={colors.bg} />
                  </Row>
                </View>
              );
            })}
          </Card>
        )}

        <SectionTitle>{t('common.edit')}</SectionTitle>
        <Button
          label={t('common.edit')}
          onPress={() => router.push(`/medication/edit?mode=edit&id=${medication.id}`)}
        />
        <Button
          label={t('refill.title')}
          tone="secondary"
          onPress={() => router.push(`/medication/stock?medicationId=${medication.id}`)}
        />
        <Button
          label={medication.status === 'paused' ? t('medication.resume') : t('medication.pause')}
          tone="secondary"
          loading={busy}
          onPress={() => void setStatus(medication.status === 'paused' ? 'active' : 'paused')}
        />
        {medication.status !== 'archived' ? (
          <Button
            label={t('medication.archive')}
            tone="secondary"
            loading={busy}
            onPress={() => void setStatus('archived')}
          />
        ) : null}
        <Button label={t('medication.deleteTitle')} tone="danger" onPress={() => setConfirmingDelete(true)} />

        <SafetyNote textKey="safety.notMedicalAdvice" />
      </ScrollView>

      {confirmingDelete ? (
        <Modal transparent animationType="fade" visible onRequestClose={() => setConfirmingDelete(false)}>
          <Pressable
            onPress={() => setConfirmingDelete(false)}
            accessibilityLabel={t('common.close')}
            style={{ flex: 1, backgroundColor: theme.colors.overlay, justifyContent: 'center', padding: theme.spacing.lg }}
          >
            <Pressable
              onPress={(event) => event.stopPropagation()}
              style={{
                backgroundColor: theme.colors.surface,
                borderRadius: theme.radius.xl,
                padding: theme.spacing.lg,
                gap: theme.spacing.md,
              }}
            >
              <Txt variant="h3" weight="bold" accessibilityRole="header">{t('medication.deleteTitle')}</Txt>
              <Txt variant="body">
                {hasHistory
                  ? t('medication.deleteConfirm', { name: medication.name })
                  : t('medication.deleteSimpleConfirm', { name: medication.name })}
              </Txt>
              {hasHistory ? (
                <Button
                  label={t('medication.archiveInstead')}
                  size="large"
                  loading={busy}
                  onPress={() => { setConfirmingDelete(false); void setStatus('archived'); }}
                />
              ) : null}
              <Button
                label={t('common.delete')}
                tone="danger"
                loading={busy}
                onPress={() => void remove(hasHistory)}
              />
              <Button label={t('common.cancel')} tone="ghost" onPress={() => setConfirmingDelete(false)} />
            </Pressable>
          </Pressable>
        </Modal>
      ) : null}
    </SafeAreaView>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  const theme = useTheme();
  return (
    <Row style={{ justifyContent: 'space-between' }} gap={theme.spacing.md} align="flex-start">
      <Txt variant="bodySmall" color={theme.colors.ink500}>{label}</Txt>
      <View style={{ flex: 1 }}>
        <Txt variant="body" weight="medium" align="end">{value}</Txt>
      </View>
    </Row>
  );
}
