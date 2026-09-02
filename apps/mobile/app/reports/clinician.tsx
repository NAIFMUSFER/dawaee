import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ScrollView, Share, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  Badge, Banner, Button, Card, Divider, EmptyState, Field, Loading, Row, SafetyNote, SectionTitle, Txt,
} from '@/components/ui';
import { useI18n } from '@/i18n';
import { useTheme } from '@/hooks/useTheme';
import { useApp } from '@/state/app-store';
import { api, ApiError, NetworkError } from '@/api/client';
import type { MedicationView } from '@/api/types';
import {
  DOSE_STATUS_COLORS, errorMessageKey, type DoseStatus, type MessageKey, type ScheduleRule,
} from '@dawaee/shared';
import { addDays, daysBetween } from '@dawaee/core';

/**
 * The doctor / pharmacist report.
 *
 * Deliberately inert: medications, schedules, and the confirmation record for a
 * chosen period. No flag, no highlight of a "bad" week, no advice — the reader
 * is the clinician, and the interpretation is theirs. The only colour used is
 * the dose-status token already defined for the app, always beside its label.
 */

/** The API rejects anything longer; the picker refuses it before the request. */
const MAX_RANGE_DAYS = 400;
const PRESETS = [30, 90, 180] as const;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const COLUMN = { date: 124, time: 82, medication: 150, dose: 96, status: 124, confirmed: 104 } as const;

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

interface ClinicianReport {
  meta: {
    patientName: string;
    timezone: string;
    from: string;
    to: string;
    generatedAt: string;
    audience: 'clinician';
  };
  summary: ReportSummary;
  medications: Array<{ name: string; strength: string | null; form: string; summary: ReportSummary }>;
  doses: Array<{
    medicationName: string;
    scheduledDate: string;
    scheduledTime: string;
    dose: string;
    status: DoseStatus;
    confirmedAt: string | null;
  }>;
}

function todayIn(timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

function firstParam(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function isValidDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export default function ClinicianReportScreen() {
  const { t, formatDate, formatTime, formatNumber } = useI18n();
  const theme = useTheme();
  const { activeProfile, offline, setOffline } = useApp();
  const params = useLocalSearchParams<{ from?: string; to?: string }>();
  const profileTimezone = activeProfile?.timezone ?? 'UTC';

  const [from, setFrom] = useState<string>(() => firstParam(params.from) ?? addDays(todayIn(profileTimezone), -29));
  const [to, setTo] = useState<string>(() => firstParam(params.to) ?? todayIn(profileTimezone));
  const [report, setReport] = useState<ClinicianReport | null>(null);
  const [medications, setMedications] = useState<MedicationView[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shareError, setShareError] = useState<string | null>(null);

  const rangeError = useMemo(() => {
    if (!isValidDate(from) || !isValidDate(to)) return t('reports.rangeInvalid');
    if (to < from) return t('reports.rangeOrder');
    if (daysBetween(from, to) + 1 > MAX_RANGE_DAYS) {
      return t('reports.rangeTooLong', { days: formatNumber(MAX_RANGE_DAYS) });
    }
    return null;
  }, [from, to, t, formatNumber]);

  const load = useCallback(async () => {
    if (!activeProfile || rangeError) return;
    setLoading(true);
    setError(null);
    try {
      // The report payload carries strength and form but not the schedule, so
      // the current schedules come from the medication list and are matched by
      // name — the same name the report itself prints.
      const [reportRes, medRes] = await Promise.all([
        api.get<ClinicianReport>('/v1/reports/clinician', { profileId: activeProfile.id, from, to }),
        api.get<{ medications: MedicationView[] }>('/v1/medications', { profileId: activeProfile.id }),
      ]);
      setReport(reportRes);
      setMedications(medRes.medications);
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
  }, [activeProfile, from, to, rangeError, setOffline, t]);

  // A range arriving from the hub is already chosen; build it without a tap,
  // but only the first time — afterwards the range belongs to the user.
  const [autoLoaded, setAutoLoaded] = useState(false);
  useEffect(() => {
    if (autoLoaded || !firstParam(params.from) || !firstParam(params.to)) return;
    setAutoLoaded(true);
    void load();
  }, [autoLoaded, params.from, params.to, load]);

  const timezone = report?.meta.timezone ?? profileTimezone;
  const dateIso = (date: string) => `${date}T12:00:00Z`;

  /** A wall-clock HH:mm carries no offset; formatting it as UTC prints it verbatim. */
  const wallClock = useCallback(
    (date: string, time: string) => formatTime(`${date}T${time.slice(0, 5)}:00Z`, 'UTC'),
    [formatTime],
  );

  const scheduleText = useCallback((medicationName: string): string => {
    const match = medications.find((medication) => medication.name === medicationName);
    const schedules = match?.schedules.filter((schedule) => schedule.active) ?? [];
    if (schedules.length === 0) return t('schedule.noSchedule');
    return schedules.map((schedule) => describeRule(schedule.rule)).join(' · ');

    function describeRule(rule: ScheduleRule): string {
      switch (rule.kind) {
        case 'fixed_times':
          return rule.times.map((time) => formatTime(`2000-01-01T${time}:00Z`, 'UTC')).join(' · ');
        case 'interval':
          return t('schedule.everyHours', { hours: formatNumber(rule.everyHours) });
        case 'days_of_week':
          return [
            rule.weekdays.map((day) => t(`weekday.short.${day}` as MessageKey)).join(' '),
            rule.times.map((time) => formatTime(`2000-01-01T${time}:00Z`, 'UTC')).join(' · '),
          ].filter(Boolean).join(' — ');
        case 'cycle':
          return t('schedule.cycleDetail', {
            on: formatNumber(rule.daysOn),
            off: formatNumber(rule.daysOff),
          });
        case 'as_needed':
          return t('schedule.asNeeded');
      }
    }
  }, [medications, t, formatNumber, formatTime]);

  const shareReport = useCallback(async () => {
    if (!report) return;
    setShareError(null);
    const lines = [
      t('reports.doctor'),
      t('reports.patient', { name: report.meta.patientName }),
      t('common.dateRange', {
        from: formatDate(dateIso(report.summary.from), timezone),
        to: formatDate(dateIso(report.summary.to), timezone),
      }),
      '',
      t('reports.medications'),
      ...report.medications.map((medication) =>
        `- ${[medication.name, medication.strength, t(`form.${medication.form}` as MessageKey)].filter(Boolean).join(' ')} — ${scheduleText(medication.name)}`),
      '',
      t('reports.confirmationHistory'),
      ...report.doses.map((dose) => [
        formatDate(dateIso(dose.scheduledDate), timezone),
        wallClock(dose.scheduledDate, dose.scheduledTime),
        dose.medicationName,
        dose.dose,
        t(`dose.status.${dose.status}` as MessageKey),
        dose.confirmedAt ? formatTime(dose.confirmedAt, timezone) : t('common.none'),
      ].join(' | ')),
      '',
      `${t('adherence.scheduled')}: ${formatNumber(report.summary.scheduled)}`,
      `${t('adherence.taken')}: ${formatNumber(report.summary.taken)}`,
      `${t('adherence.onTime')}: ${formatNumber(report.summary.takenOnTime)}`,
      `${t('adherence.late')}: ${formatNumber(report.summary.takenLate)}`,
      `${t('adherence.missed')}: ${formatNumber(report.summary.missed)}`,
      '',
      t('reports.factualOnly'),
      t('reports.disclaimer'),
    ];

    try {
      await Share.share({ title: t('reports.shareSubject'), message: lines.join('\n') });
    } catch {
      setShareError(t('reports.shareFailed'));
    }
  }, [report, t, formatDate, formatTime, formatNumber, timezone, wallClock, scheduleText]);

  if (!activeProfile) {
    return (
      <SafeAreaView style={{ flex: 1 }}>
        <EmptyState title={t('reports.doctor')} body={t('error.not_found')} />
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
          <Txt variant="h2" weight="bold" accessibilityRole="header" style={{ flex: 1 }}>{t('reports.doctor')}</Txt>
          <Button label={t('common.back')} tone="ghost" fullWidth={false} onPress={() => router.back()} />
        </Row>

        {offline ? <Banner tone="warning" title={t('notifications.offlineBanner')} /> : null}
        {error ? <Banner tone="danger" title={error} /> : null}
        {shareError ? <Banner tone="warning" title={shareError} /> : null}

        <Card style={{ gap: theme.spacing.md }}>
          <Txt variant="bodySmall" color={theme.colors.ink500}>{t('reports.doctorDescription')}</Txt>
          <Field
            label={t('reports.from')}
            value={from}
            onChangeText={setFrom}
            hint={t('reports.dateHint')}
            maxLength={10}
            keyboardType="number-pad"
          />
          <Field
            label={t('reports.to')}
            value={to}
            onChangeText={setTo}
            hint={t('reports.dateHint')}
            maxLength={10}
            keyboardType="number-pad"
            error={rangeError}
          />
          <Row wrap gap={theme.spacing.sm}>
            {PRESETS.map((days) => (
              <View key={days} style={{ flex: 1, minWidth: 110 }}>
                <Button
                  label={t('common.lastDays', { days: formatNumber(days) })}
                  tone="secondary"
                  onPress={() => {
                    const end = todayIn(profileTimezone);
                    setFrom(addDays(end, -(days - 1)));
                    setTo(end);
                  }}
                />
              </View>
            ))}
          </Row>
          <Button label={t('reports.generate')} onPress={() => void load()} disabled={Boolean(rangeError)} loading={loading} />
        </Card>

        {loading ? <Loading label={t('common.loading')} /> : null}

        {!loading && !report && !error ? (
          <EmptyState title={t('reports.doctor')} body={t('reports.doctorDescription')} />
        ) : null}

        {!loading && report ? (
          <>
            <Card style={{ gap: theme.spacing.xs }}>
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
              <Banner tone="info" title={t('reports.factualOnly')} />
            </Card>

            <Button label={t('common.share')} tone="secondary" onPress={() => void shareReport()} />

            <SectionTitle>{t('reports.medications')}</SectionTitle>
            {report.medications.length === 0 ? (
              <Card><Txt variant="body" color={theme.colors.ink500}>{t('reports.noDoses')}</Txt></Card>
            ) : (
              report.medications.map((medication) => (
                <Card key={`${medication.name}-${medication.strength ?? ''}`} style={{ gap: theme.spacing.xs }}>
                  <Txt variant="bodyLarge" weight="bold">{medication.name}</Txt>
                  <Txt variant="bodySmall" color={theme.colors.ink700}>
                    {[medication.strength, t(`form.${medication.form}` as MessageKey)].filter(Boolean).join(' · ')}
                  </Txt>
                  <Txt variant="bodySmall" color={theme.colors.ink500}>{scheduleText(medication.name)}</Txt>
                </Card>
              ))
            )}

            <SectionTitle>{t('reports.confirmationHistory')}</SectionTitle>
            {report.doses.length === 0 ? (
              <Card><Txt variant="body" color={theme.colors.ink500}>{t('reports.noDoses')}</Txt></Card>
            ) : (
              <Card style={{ paddingHorizontal: theme.spacing.sm }}>
                <ScrollView horizontal showsHorizontalScrollIndicator>
                  <View>
                    <Row gap={theme.spacing.sm} style={{ paddingVertical: theme.spacing.xs }}>
                      <HeaderCell width={COLUMN.date} label={t('reports.colDate')} />
                      <HeaderCell width={COLUMN.time} label={t('reports.colTime')} />
                      <HeaderCell width={COLUMN.medication} label={t('reports.colMedication')} />
                      <HeaderCell width={COLUMN.dose} label={t('reports.colDose')} />
                      <HeaderCell width={COLUMN.status} label={t('reports.colStatus')} />
                      <HeaderCell width={COLUMN.confirmed} label={t('reports.colConfirmedAt')} />
                    </Row>
                    <Divider />
                    {report.doses.map((dose, index) => {
                      const colors = DOSE_STATUS_COLORS[dose.status] ?? DOSE_STATUS_COLORS.upcoming;
                      return (
                        <View key={`${dose.scheduledDate}-${dose.scheduledTime}-${dose.medicationName}-${index}`}>
                          <Row gap={theme.spacing.sm} align="flex-start" style={{ paddingVertical: theme.spacing.xs }}>
                            <View style={{ width: COLUMN.date }}>
                              <Txt variant="bodySmall">{formatDate(dateIso(dose.scheduledDate), timezone)}</Txt>
                            </View>
                            <View style={{ width: COLUMN.time }}>
                              <Txt variant="bodySmall">{wallClock(dose.scheduledDate, dose.scheduledTime)}</Txt>
                            </View>
                            <View style={{ width: COLUMN.medication }}>
                              <Txt variant="bodySmall" numberOfLines={2}>{dose.medicationName}</Txt>
                            </View>
                            <View style={{ width: COLUMN.dose }}>
                              <Txt variant="bodySmall">{dose.dose}</Txt>
                            </View>
                            <View style={{ width: COLUMN.status }}>
                              <Badge label={t(`dose.status.${dose.status}` as MessageKey)} fg={colors.fg} bg={colors.bg} />
                            </View>
                            <View style={{ width: COLUMN.confirmed }}>
                              <Txt variant="bodySmall">
                                {dose.confirmedAt ? formatTime(dose.confirmedAt, timezone) : t('common.none')}
                              </Txt>
                            </View>
                          </Row>
                          <Divider />
                        </View>
                      );
                    })}
                  </View>
                </ScrollView>
              </Card>
            )}

            <SectionTitle>{t('adherence.title')}</SectionTitle>
            <Card>
              <Row wrap gap={theme.spacing.md}>
                <Metric label={t('adherence.scheduled')} value={formatNumber(report.summary.scheduled)} />
                <Metric label={t('adherence.taken')} value={formatNumber(report.summary.taken)} />
                <Metric label={t('adherence.onTime')} value={formatNumber(report.summary.takenOnTime)} />
                <Metric label={t('adherence.late')} value={formatNumber(report.summary.takenLate)} />
                <Metric label={t('adherence.missed')} value={formatNumber(report.summary.missed)} />
                <Metric label={t('dose.status.skipped')} value={formatNumber(report.summary.skipped)} />
              </Row>
              <SafetyNote textKey="adherence.disclaimer" />
            </Card>

            <SafetyNote textKey="reports.disclaimer" />
          </>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

function HeaderCell({ width, label }: { width: number; label: string }) {
  const theme = useTheme();
  return (
    <View style={{ width }}>
      <Txt variant="caption" weight="bold" color={theme.colors.ink500}>{label}</Txt>
    </View>
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
