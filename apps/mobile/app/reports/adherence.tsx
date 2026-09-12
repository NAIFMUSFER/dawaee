import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  Banner, Button, Card, Divider, EmptyState, Loading, Row, SafetyNote, SectionTitle, Txt,
} from '@/components/ui';
import { useI18n } from '@/i18n';
import { useTheme } from '@/hooks/useTheme';
import { profileScopeKey, useRequestScope } from '@/hooks/useRequestScope';
import { useApp } from '@/state/app-store';
import { api, ApiError, NetworkError } from '@/api/client';
import type { AdherenceResponse } from '@/api/types';
import { errorMessageKey } from '@dawaee/shared';
import { addDays } from '@dawaee/core';

/**
 * The adherence dashboard.
 *
 * The percentage is the most misreadable number in the product, so it never
 * appears without the counts it was computed from and without the disclaimer
 * sitting directly beneath it.
 *
 * The chart is drawn with plain views. A screen reader gets nothing from a row
 * of rectangles, so the whole chart is one accessible element carrying a
 * factual sentence — counts and dates, no judgement.
 */

const RANGES = [7, 30, 90] as const;
const CHART_HEIGHT = 120;
const BAR_WIDTH = 22;

function todayIn(timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

export default function AdherenceScreen() {
  const { user, activeProfile } = useApp();
  const key = profileScopeKey(user?.id, activeProfile);
  return <AdherenceProfileScreen key={key} />;
}

function AdherenceProfileScreen() {
  const { t, formatDate, formatNumber } = useI18n();
  const theme = useTheme();
  const { activeProfile, offline, setOffline } = useApp();
  const timezone = activeProfile?.timezone ?? 'UTC';

  const [days, setDays] = useState<(typeof RANGES)[number]>(30);
  const [data, setData] = useState<AdherenceResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const range = useMemo(() => {
    const to = todayIn(timezone);
    return { from: addDays(to, -(days - 1)), to };
  }, [days, timezone]);
  const requestScope = useRequestScope(`${activeProfile?.id ?? 'none'}:${range.from}:${range.to}`);

  const load = useCallback(async () => {
    if (!activeProfile) return;
    const isCurrent = requestScope.begin();
    if (!isCurrent()) return;
    setError(null);
    try {
      const res = await api.get<AdherenceResponse>('/v1/adherence', {
        profileId: activeProfile.id, from: range.from, to: range.to,
      });
      if (!isCurrent()) return;
      setData(res);
      setOffline(false);
    } catch (err) {
      if (!isCurrent()) return;
      if (err instanceof NetworkError) {
        setOffline(true);
      } else if (err instanceof ApiError) {
        const key = errorMessageKey(err.code);
        setError(key ? t(key) : err.message);
      } else {
        setError(t('error.internal_error'));
      }
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [activeProfile, range.from, range.to, requestScope, setOffline, t]);

  useEffect(() => { setLoading(true); void load(); }, [load]);

  const percentText = useCallback(
    (value: number | null) =>
      value === null ? null : formatNumber(value / 100, { style: 'percent', maximumFractionDigits: 1 }),
    [formatNumber],
  );

  const dateIso = (date: string) => `${date}T12:00:00Z`;

  const chartSummary = useMemo(() => {
    if (!data) return '';
    const missedDays = data.daily.filter((point) => point.missed > 0).length;
    return t('adherence.chartSummary', {
      from: formatDate(dateIso(data.summary.from), timezone),
      to: formatDate(dateIso(data.summary.to), timezone),
      taken: formatNumber(data.summary.taken),
      scheduled: formatNumber(data.summary.scheduled),
      missedDays: formatNumber(missedDays),
      days: formatNumber(data.daily.length),
    });
  }, [data, formatDate, formatNumber, t, timezone]);

  if (!activeProfile) {
    return (
      <SafeAreaView style={{ flex: 1 }}>
        <EmptyState title={t('adherence.title')} body={t('error.not_found')} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1 }}>
      <ScrollView
        style={{ flex: 1, backgroundColor: theme.colors.background }}
        contentContainerStyle={{ padding: theme.spacing.lg, gap: theme.spacing.md, paddingBottom: theme.spacing.xxxl }}
      >
        <Row style={{ justifyContent: 'space-between' }} gap={theme.spacing.sm}>
          <Txt variant="h2" weight="bold" accessibilityRole="header">{t('adherence.title')}</Txt>
          <Button label={t('common.back')} tone="ghost" fullWidth={false} onPress={() => router.back()} />
        </Row>

        {offline ? <Banner tone="warning" title={t('notifications.offlineBanner')} /> : null}
        {error ? (
          <Banner
            tone="danger"
            title={error}
            action={<Button label={t('common.retry')} tone="ghost" fullWidth={false} onPress={() => { setLoading(true); void load(); }} />}
          />
        ) : null}

        <Row gap={theme.spacing.sm}>
          {RANGES.map((value) => (
            <View key={value} style={{ flex: 1 }}>
              <RangeChip
                label={t('common.lastDays', { days: formatNumber(value) })}
                selected={days === value}
                onPress={() => setDays(value)}
              />
            </View>
          ))}
        </Row>

        {loading ? (
          <Loading label={t('common.loading')} />
        ) : !data ? (
          <EmptyState title={t('adherence.noData')} />
        ) : (
          <>
            <Card style={{ gap: theme.spacing.sm }}>
              <Txt variant="bodySmall" color={theme.colors.ink500}>
                {t('common.dateRange', {
                  from: formatDate(dateIso(data.summary.from), timezone),
                  to: formatDate(dateIso(data.summary.to), timezone),
                })}
              </Txt>

              <Txt variant="bodySmall" weight="medium" color={theme.colors.ink700}>{t('adherence.percent')}</Txt>
              {data.summary.adherencePercent === null ? (
                <Txt variant="h3" weight="bold" color={theme.colors.ink500}>{t('adherence.noPercent')}</Txt>
              ) : (
                <Txt variant="display" weight="bold" color={theme.colors.primary700}>
                  {percentText(data.summary.adherencePercent)}
                </Txt>
              )}

              {/* The disclaimer belongs beside the number, not at the bottom of
                  a screen the reader may never reach. */}
              <SafetyNote textKey="adherence.disclaimer" />

              <Divider />

              <Row wrap gap={theme.spacing.md}>
                <Metric label={t('adherence.scheduled')} value={formatNumber(data.summary.scheduled)} />
                <Metric label={t('adherence.taken')} value={formatNumber(data.summary.taken)} />
                <Metric label={t('adherence.onTime')} value={formatNumber(data.summary.takenOnTime)} />
                <Metric label={t('adherence.late')} value={formatNumber(data.summary.takenLate)} />
                <Metric label={t('adherence.missed')} value={formatNumber(data.summary.missed)} />
              </Row>
            </Card>

            <SectionTitle>{t('adherence.dailyBreakdown')}</SectionTitle>
            {data.daily.length === 0 ? (
              <Card><Txt variant="body" color={theme.colors.ink500}>{t('adherence.noData')}</Txt></Card>
            ) : (
              <Card style={{ gap: theme.spacing.sm }}>
                <View accessible accessibilityRole="image" accessibilityLabel={chartSummary}>
                  <Row align="flex-start" gap={theme.spacing.sm}>
                    <View style={{ height: CHART_HEIGHT, justifyContent: 'space-between' }}>
                      <Txt variant="caption" color={theme.colors.ink500}>{percentText(100)}</Txt>
                      <Txt variant="caption" color={theme.colors.ink500}>{percentText(50)}</Txt>
                      <Txt variant="caption" color={theme.colors.ink500}>{percentText(0)}</Txt>
                    </View>

                    <ScrollView
                      horizontal
                      showsHorizontalScrollIndicator
                      contentContainerStyle={{ gap: theme.spacing.xs, paddingBottom: theme.spacing.xs }}
                    >
                      {data.daily.map((point) => (
                        <View key={point.date} style={{ width: BAR_WIDTH, alignItems: 'center', gap: theme.spacing.xxs }}>
                          <View style={{
                            height: CHART_HEIGHT,
                            width: BAR_WIDTH,
                            justifyContent: 'flex-end',
                            backgroundColor: theme.colors.surfaceAlt,
                            borderRadius: theme.radius.sm,
                            overflow: 'hidden',
                          }}>
                            <View style={{
                              height: point.adherencePercent === null
                                ? 2
                                : Math.max(2, Math.round((point.adherencePercent / 100) * CHART_HEIGHT)),
                              backgroundColor: point.adherencePercent === null
                                ? theme.colors.ink200
                                : point.missed > 0 ? theme.colors.warning500 : theme.colors.success500,
                            }} />
                          </View>
                          <Txt variant="caption" color={theme.colors.ink500} align="center" numberOfLines={1}>
                            {formatNumber(Number(point.date.slice(8, 10)))}
                          </Txt>
                        </View>
                      ))}
                    </ScrollView>
                  </Row>
                </View>

                <Txt variant="caption" color={theme.colors.ink500}>{chartSummary}</Txt>
              </Card>
            )}

            {/* Withheld means the viewer is not permitted to see medication
                names at all — an empty section would imply there are none. */}
            {!data.byMedicationWithheld && data.byMedication.length > 0 ? (
              <>
                <SectionTitle>{t('adherence.byMedication')}</SectionTitle>
                {data.byMedication.map((row) => (
                  <Card key={row.medicationId} style={{ gap: theme.spacing.xs }}>
                    <Row style={{ justifyContent: 'space-between' }} gap={theme.spacing.sm}>
                      <Txt variant="bodyLarge" weight="bold" style={{ flex: 1 }} numberOfLines={2}>
                        {row.medicationName}
                      </Txt>
                      <Txt variant="bodyLarge" weight="bold" color={theme.colors.primary700}>
                        {percentText(row.summary.adherencePercent) ?? t('common.none')}
                      </Txt>
                    </Row>
                    <Row wrap gap={theme.spacing.md}>
                      <Metric label={t('adherence.scheduled')} value={formatNumber(row.summary.scheduled)} />
                      <Metric label={t('adherence.taken')} value={formatNumber(row.summary.taken)} />
                      <Metric label={t('adherence.late')} value={formatNumber(row.summary.takenLate)} />
                      <Metric label={t('adherence.missed')} value={formatNumber(row.summary.missed)} />
                    </Row>
                  </Card>
                ))}
              </>
            ) : null}

            <SafetyNote textKey="safety.notMedicalAdvice" />
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  const theme = useTheme();
  return (
    <View accessible accessibilityLabel={`${label}: ${value}`} style={{ minWidth: 76, gap: 2 }}>
      <Txt variant="caption" color={theme.colors.ink500}>{label}</Txt>
      <Txt variant="h3" weight="bold">{value}</Txt>
    </View>
  );
}

function RangeChip({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  const theme = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected }}
      style={({ pressed }) => [
        {
          minHeight: theme.touch,
          paddingHorizontal: theme.spacing.md,
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: theme.radius.lg,
          borderWidth: 2,
          borderColor: selected ? theme.colors.primary700 : theme.colors.ink200,
          backgroundColor: selected ? theme.colors.primary100 : theme.colors.surface,
        },
        pressed && { opacity: 0.85 },
      ]}
    >
      <Txt
        variant="bodySmall"
        weight={selected ? 'bold' : 'regular'}
        align="center"
        color={selected ? theme.colors.primary700 : theme.colors.ink700}
        numberOfLines={1}
      >
        {label}
      </Txt>
    </Pressable>
  );
}
