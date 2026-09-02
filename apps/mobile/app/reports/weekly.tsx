import React, { useCallback, useEffect, useState } from 'react';
import { ScrollView, Share, View } from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  Badge, Banner, Button, Card, Divider, EmptyState, Loading, Row, SafetyNote, SectionTitle, Txt,
} from '@/components/ui';
import { useI18n } from '@/i18n';
import { useTheme } from '@/hooks/useTheme';
import { useApp } from '@/state/app-store';
import { api, ApiError, NetworkError } from '@/api/client';
import { DOSE_STATUS_COLORS, errorMessageKey, type MessageKey } from '@dawaee/shared';

/**
 * The weekly family report.
 *
 * Written for a son or daughter checking in, not for a clinician: the counts,
 * the medications behind them, and whether anything is about to run out. The
 * share action produces the same thing as plain text, because that is what
 * actually gets sent in a family WhatsApp group.
 */

interface ReportSummary {
  from: string;
  to: string;
  scheduled: number;
  taken: number;
  takenOnTime: number;
  takenLate: number;
  skipped: number;
  missed: number;
  pending: number;
  adherencePercent: number | null;
}

interface WeeklyReport {
  meta: {
    patientName: string;
    timezone: string;
    from: string;
    to: string;
    generatedAt: string;
    audience: 'family';
  };
  summary: ReportSummary;
  daily: Array<{ date: string; scheduled: number; taken: number; missed: number; adherencePercent: number | null }>;
  medications: Array<{ name: string; strength: string | null; form: string; summary: ReportSummary }>;
  stockOutlook: Array<{
    medicationName: string;
    unit: string;
    remaining: number | null;
    daysRemaining: number | null;
    runoutDate: string | null;
    needsRefill: boolean;
  }>;
}

export default function WeeklyReportScreen() {
  const { t, formatDate, formatTime, formatNumber } = useI18n();
  const theme = useTheme();
  const { activeProfile, offline, setOffline } = useApp();

  const [report, setReport] = useState<WeeklyReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [shareError, setShareError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!activeProfile) return;
    setError(null);
    try {
      const res = await api.get<WeeklyReport>('/v1/reports/weekly', { profileId: activeProfile.id });
      setReport(res);
      setOffline(false);
    } catch (err) {
      if (err instanceof NetworkError) {
        setOffline(true);
      } else if (err instanceof ApiError) {
        const key = errorMessageKey(err.code);
        setError(key ? t(key) : err.message);
      } else {
        setError(t('error.internal_error'));
      }
    } finally {
      setLoading(false);
    }
  }, [activeProfile, setOffline, t]);

  useEffect(() => { setLoading(true); void load(); }, [load]);

  const timezone = report?.meta.timezone ?? activeProfile?.timezone ?? 'UTC';
  const dateIso = (date: string) => `${date}T12:00:00Z`;
  const percentText = (value: number | null) =>
    value === null ? null : formatNumber(value / 100, { style: 'percent', maximumFractionDigits: 1 });

  const shareReport = useCallback(async () => {
    if (!report) return;
    setShareError(null);
    const period = t('common.dateRange', {
      from: formatDate(dateIso(report.summary.from), timezone),
      to: formatDate(dateIso(report.summary.to), timezone),
    });
    const lines = [
      t('reports.weeklyFamily'),
      t('reports.patient', { name: report.meta.patientName }),
      period,
      '',
      `${t('adherence.scheduled')}: ${formatNumber(report.summary.scheduled)}`,
      `${t('adherence.taken')}: ${formatNumber(report.summary.taken)}`,
      `${t('adherence.late')}: ${formatNumber(report.summary.takenLate)}`,
      `${t('adherence.missed')}: ${formatNumber(report.summary.missed)}`,
      `${t('adherence.percent')}: ${percentText(report.summary.adherencePercent) ?? t('common.none')}`,
      '',
      t('reports.byMedication'),
      ...report.medications.map((medication) =>
        `- ${medication.name}: ${t('history.daySummary', {
          taken: formatNumber(medication.summary.taken),
          scheduled: formatNumber(medication.summary.scheduled),
        })}`),
      '',
      t('reports.stockOutlook'),
      ...(report.stockOutlook.length === 0
        ? [t('reports.noStockTracking')]
        : report.stockOutlook.map((item) =>
          `- ${item.medicationName}: ${item.remaining === null
            ? t('common.none')
            : t('stock.remaining', { qty: formatNumber(item.remaining), unit: item.unit })}${
            item.needsRefill ? ` (${t('reports.needsRefill')})` : ''}`)),
      '',
      t('adherence.disclaimer'),
      t('reports.disclaimer'),
    ];

    try {
      await Share.share({ title: t('reports.shareSubject'), message: lines.join('\n') });
    } catch {
      setShareError(t('reports.shareFailed'));
    }
  }, [report, t, formatDate, formatNumber, timezone]);

  if (!activeProfile) {
    return (
      <SafeAreaView style={{ flex: 1 }}>
        <EmptyState title={t('reports.weeklyFamily')} body={t('error.not_found')} />
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
          <Txt variant="h2" weight="bold" accessibilityRole="header" style={{ flex: 1 }}>
            {t('reports.weeklyFamily')}
          </Txt>
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
        {shareError ? <Banner tone="warning" title={shareError} /> : null}

        {loading ? (
          <Loading label={t('common.loading')} />
        ) : !report ? (
          <EmptyState title={t('reports.weeklyEmpty')} />
        ) : (
          <>
            <Card style={{ gap: theme.spacing.sm }}>
              <Txt variant="bodyLarge" weight="bold">{t('reports.patient', { name: report.meta.patientName })}</Txt>
              <Txt variant="bodySmall" color={theme.colors.ink500}>
                {t('common.dateRange', {
                  from: formatDate(dateIso(report.summary.from), timezone),
                  to: formatDate(dateIso(report.summary.to), timezone),
                })}
              </Txt>
              <Txt variant="caption" color={theme.colors.ink500}>
                {t('reports.generatedAt', {
                  datetime: `${formatDate(report.meta.generatedAt, timezone)} ${formatTime(report.meta.generatedAt, timezone)}`,
                })}
              </Txt>

              <Divider />

              <Txt variant="bodySmall" weight="medium" color={theme.colors.ink700}>{t('adherence.percent')}</Txt>
              <Txt variant="h1" weight="bold" color={theme.colors.primary700}>
                {percentText(report.summary.adherencePercent) ?? t('adherence.noPercent')}
              </Txt>
              <SafetyNote textKey="adherence.disclaimer" />

              <Row wrap gap={theme.spacing.md}>
                <Metric label={t('adherence.scheduled')} value={formatNumber(report.summary.scheduled)} />
                <Metric label={t('adherence.taken')} value={formatNumber(report.summary.taken)} />
                <Metric label={t('adherence.late')} value={formatNumber(report.summary.takenLate)} />
                <Metric label={t('adherence.missed')} value={formatNumber(report.summary.missed)} />
              </Row>
            </Card>

            <Button label={t('common.share')} tone="secondary" onPress={() => void shareReport()} />

            <SectionTitle>{t('reports.byMedication')}</SectionTitle>
            {report.medications.length === 0 ? (
              <Card><Txt variant="body" color={theme.colors.ink500}>{t('reports.weeklyEmpty')}</Txt></Card>
            ) : (
              report.medications.map((medication) => (
                <Card key={`${medication.name}-${medication.strength ?? ''}`} style={{ gap: theme.spacing.xs }}>
                  <Row style={{ justifyContent: 'space-between' }} gap={theme.spacing.sm}>
                    <Txt variant="bodyLarge" weight="bold" style={{ flex: 1 }} numberOfLines={2}>{medication.name}</Txt>
                    <Txt variant="bodyLarge" weight="bold" color={theme.colors.primary700}>
                      {percentText(medication.summary.adherencePercent) ?? t('common.none')}
                    </Txt>
                  </Row>
                  <Txt variant="bodySmall" color={theme.colors.ink500}>
                    {[medication.strength, t(`form.${medication.form}` as MessageKey)].filter(Boolean).join(' · ')}
                  </Txt>
                  <Row wrap gap={theme.spacing.md}>
                    <Metric label={t('adherence.scheduled')} value={formatNumber(medication.summary.scheduled)} />
                    <Metric label={t('adherence.taken')} value={formatNumber(medication.summary.taken)} />
                    <Metric label={t('adherence.late')} value={formatNumber(medication.summary.takenLate)} />
                    <Metric label={t('adherence.missed')} value={formatNumber(medication.summary.missed)} />
                  </Row>
                </Card>
              ))
            )}

            <SectionTitle>{t('reports.stockOutlook')}</SectionTitle>
            {report.stockOutlook.length === 0 ? (
              <Card><Txt variant="body" color={theme.colors.ink500}>{t('reports.noStockTracking')}</Txt></Card>
            ) : (
              report.stockOutlook.map((item) => (
                <Card key={item.medicationName} style={{ gap: theme.spacing.xs }}>
                  <Row style={{ justifyContent: 'space-between' }} gap={theme.spacing.sm}>
                    <Txt variant="bodyLarge" weight="bold" style={{ flex: 1 }} numberOfLines={2}>{item.medicationName}</Txt>
                    <Badge
                      label={item.needsRefill ? t('reports.needsRefill') : t('reports.stockTracked')}
                      fg={item.needsRefill ? DOSE_STATUS_COLORS.missed.fg : DOSE_STATUS_COLORS.taken.fg}
                      bg={item.needsRefill ? DOSE_STATUS_COLORS.missed.bg : DOSE_STATUS_COLORS.taken.bg}
                    />
                  </Row>
                  {item.remaining !== null ? (
                    <Txt variant="bodySmall" color={theme.colors.ink700}>
                      {t('stock.remaining', { qty: formatNumber(item.remaining), unit: item.unit })}
                    </Txt>
                  ) : null}
                  {item.daysRemaining !== null ? (
                    <Txt variant="bodySmall" color={theme.colors.ink500}>
                      {t('stock.runsOutIn', { days: formatNumber(item.daysRemaining) })}
                    </Txt>
                  ) : null}
                  {item.runoutDate ? (
                    <Txt variant="caption" color={theme.colors.ink500}>
                      {formatDate(dateIso(item.runoutDate), timezone)}
                    </Txt>
                  ) : null}
                </Card>
              ))
            )}

            <SafetyNote textKey="reports.disclaimer" />
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
