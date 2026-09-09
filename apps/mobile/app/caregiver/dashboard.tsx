import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshControl, ScrollView, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  Badge, Banner, Button, Card, Divider, EmptyState, Loading, Row, SafetyNote, SectionTitle, Txt,
} from '@/components/ui';
import { useI18n } from '@/i18n';
import { useTheme } from '@/hooks/useTheme';
import { useApp } from '@/state/app-store';
import { api, ApiError, NetworkError } from '@/api/client';
import type { AdherenceResponse, DoseView, ProfileSummary, TodayResponse } from '@/api/types';
import { statusColors } from '@/theme';
import type { CaregiverPermission, DoseStatus } from '@dawaee/shared';

/**
 * The caregiver's view of a patient.
 *
 * Deliberately restrained. A caregiver is not a second patient: they get what
 * they need to decide whether to pick up the phone — what is late, by how
 * long, what is coming — and nothing the patient did not share. Every section
 * is gated on the permission that backs it, so a revoked grant simply removes
 * the section rather than showing an error.
 */

const ACTIVE_STATUSES: readonly DoseStatus[] = ['upcoming', 'due', 'pending_confirmation', 'snoozed'];

const STATUS_GLYPHS: Record<DoseStatus, string> = {
  upcoming: '○',
  due: '◉',
  pending_confirmation: '◉',
  snoozed: '⏱',
  taken: '✓',
  taken_late: '✓',
  skipped: '⤫',
  missed: '✕',
  cancelled: '–',
};

const ADHERENCE_DAYS = 7;

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export default function CaregiverDashboardScreen() {
  const { profileId } = useLocalSearchParams<{ profileId?: string }>();
  const { t, formatDate, formatNumber, formatTime } = useI18n();
  const theme = useTheme();
  const { profiles, activeProfile, offline, setOffline } = useApp();

  const followed = useMemo(() => profiles.filter((p) => p.role === 'caregiver'), [profiles]);

  const patient = useMemo<ProfileSummary | null>(() => {
    if (profileId) return profiles.find((p) => p.id === profileId) ?? null;
    if (activeProfile && activeProfile.role === 'caregiver') return activeProfile;
    return followed[0] ?? null;
  }, [activeProfile, followed, profileId, profiles]);

  const [today, setToday] = useState<TodayResponse | null>(null);
  const [adherence, setAdherence] = useState<AdherenceResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const can = useCallback(
    (permission: CaregiverPermission): boolean =>
      patient === null ? false : patient.permissions === null || patient.permissions.includes(permission),
    [patient],
  );

  const describe = useCallback((err: unknown): string => {
    if (!(err instanceof ApiError)) return t('error.internal_error');
    const key = `error.${err.code}` as 'error.internal_error';
    const text = t(key);
    return text === key ? err.message : text;
  }, [t]);

  const load = useCallback(async () => {
    if (!patient) {
      setLoading(false);
      return;
    }
    const canSeeSchedule = patient.permissions === null || patient.permissions.includes('view_schedule');
    const canSeeAdherence = patient.permissions === null || patient.permissions.includes('view_adherence');
    const to = new Date();
    const from = new Date(to.getTime() - (ADHERENCE_DAYS - 1) * 86_400_000);

    try {
      const [todayRes, adherenceRes] = await Promise.all([
        canSeeSchedule ? api.get<TodayResponse>('/v1/today', { profileId: patient.id }) : Promise.resolve(null),
        canSeeAdherence
          ? api.get<AdherenceResponse>('/v1/adherence', { profileId: patient.id, from: isoDate(from), to: isoDate(to) })
          : Promise.resolve(null),
      ]);
      setToday(todayRes);
      setAdherence(adherenceRes);
      setError(null);
      setOffline(false);
    } catch (err) {
      if (err instanceof NetworkError) setOffline(true);
      else setError(describe(err));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [describe, patient, setOffline]);

  useEffect(() => { void load(); }, [load]);

  const doses = today?.today ?? [];
  const now = Date.now();
  // Promise.all deliberately commits the two caregiver reads together. On a
  // cold initial request, an HTTP failure therefore leaves both payloads null.
  // That state is not evidence that the patient has no doses or stopped
  // sharing adherence, so never translate it into either clinical empty state.
  // Existing payloads from a previous successful load may remain visible next
  // to the error banner; only the no-data failure case is suppressed here.
  const loadFailedWithoutClinicalData = error !== null && today === null && adherence === null;

  const lateDoses = useMemo(
    () => doses
      .filter((d) => d.status === 'missed' || d.status === 'taken_late'
        || (ACTIVE_STATUSES.includes(d.status) && Date.parse(d.scheduledAt) < now))
      .sort((a, b) => Date.parse(a.scheduledAt) - Date.parse(b.scheduledAt)),
    [doses, now],
  );
  const upcoming = useMemo(
    () => doses
      .filter((d) => ACTIVE_STATUSES.includes(d.status) && Date.parse(d.scheduledAt) >= now)
      .sort((a, b) => Date.parse(a.scheduledAt) - Date.parse(b.scheduledAt)),
    [doses, now],
  );

  const minutesLate = (dose: DoseView): number =>
    dose.minutesLate ?? Math.max(0, Math.round((now - Date.parse(dose.scheduledAt)) / 60_000));

  if (loading) return <SafeAreaView style={{ flex: 1 }}><Loading label={t('common.loading')} /></SafeAreaView>;

  if (!patient) {
    return (
      <SafeAreaView style={{ flex: 1 }}>
        <EmptyState
          title={t('caregiver.dashboard')}
          body={t('caregiver.noPatients')}
          action={<Button label={t('common.back')} fullWidth={false} onPress={() => router.back()} />}
        />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1 }}>
      <ScrollView
        style={{ flex: 1, backgroundColor: theme.colors.background }}
        contentContainerStyle={{ padding: theme.spacing.lg, gap: theme.spacing.md, paddingBottom: theme.spacing.xxxl }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); void load(); }} />}
      >
        <Row style={{ justifyContent: 'space-between' }}>
          <View style={{ flex: 1, gap: 2 }}>
            <Txt variant="h1" weight="bold" accessibilityRole="header" numberOfLines={1}>
              {t('caregiver.followingPatient', { name: patient.displayName })}
            </Txt>
            {today ? (
              <Txt variant="bodySmall" color={theme.colors.ink500}>
                {formatDate(`${today.localDate}T12:00:00Z`, today.timezone, { weekday: 'long', day: 'numeric', month: 'long' })}
              </Txt>
            ) : null}
          </View>
          <Button label={t('common.back')} tone="ghost" fullWidth={false} onPress={() => router.back()} />
        </Row>

        {followed.length > 1 ? (
          <View style={{ gap: theme.spacing.xs }}>
            <Txt variant="caption" color={theme.colors.ink500}>{t('caregiver.choosePatient')}</Txt>
            <Row wrap gap={theme.spacing.sm}>
              {followed.map((p) => (
                <Button
                  key={p.id}
                  label={`${p.id === patient.id ? '✓ ' : ''}${p.displayName}`}
                  tone={p.id === patient.id ? 'primary' : 'secondary'}
                  fullWidth={false}
                  onPress={() => router.setParams({ profileId: p.id })}
                />
              ))}
            </Row>
          </View>
        ) : null}

        {offline ? <Banner tone="warning" title={t('notifications.offlineBanner')} /> : null}
        {error ? (
          <Banner
            tone="danger"
            title={error}
            action={<Button label={t('common.retry')} tone="ghost" fullWidth={false} onPress={() => void load()} />}
          />
        ) : null}

        {!loadFailedWithoutClinicalData && lateDoses.length > 0 ? (
          <>
            <SectionTitle>{t('caregiver.needsAttention')}</SectionTitle>
            <View style={{ gap: theme.spacing.sm }}>
              {lateDoses.map((dose) => (
                <Card key={dose.id}>
                  <Row style={{ justifyContent: 'space-between' }} gap={theme.spacing.md}>
                    <View style={{ flex: 1, gap: 2 }}>
                      <Txt variant="bodyLarge" weight="bold" numberOfLines={1}>
                        {can('view_medications') ? dose.medication.name : t('caregiver.medicationHidden')}
                      </Txt>
                      <Txt variant="bodySmall" color={theme.colors.danger700}>
                        {t('dose.lateBy', { minutes: formatNumber(minutesLate(dose)) })}
                      </Txt>
                    </View>
                    <View style={{ alignItems: 'flex-end', gap: theme.spacing.xs }}>
                      <Txt variant="bodyLarge" weight="bold">
                        {formatTime(dose.scheduledAt, dose.scheduledTimezone)}
                      </Txt>
                      <Badge
                        label={t(`dose.status.${dose.status}` as 'dose.status.missed')}
                        fg={statusColors(dose.status).fg}
                        bg={statusColors(dose.status).bg}
                      />
                    </View>
                  </Row>
                </Card>
              ))}
            </View>
          </>
        ) : null}

        <SectionTitle>{t('today.title')}</SectionTitle>
        {loadFailedWithoutClinicalData ? null : !can('view_schedule') ? (
          <Banner tone="info" title={t('caregiver.notShared', { name: patient.displayName })} />
        ) : doses.length === 0 ? (
          <EmptyState title={t('caregiver.noDosesToday')} />
        ) : (
          <Card>
            {doses.map((dose, index) => (
              <View key={dose.id}>
                {index > 0 ? <Divider /> : null}
                <Row style={{ justifyContent: 'space-between' }} gap={theme.spacing.md}>
                  <Txt variant="h3" color={statusColors(dose.status).fg}>{STATUS_GLYPHS[dose.status]}</Txt>
                  <View style={{ flex: 1 }}>
                    <Txt variant="body" numberOfLines={1}>
                      {can('view_medications') ? dose.medication.name : t('caregiver.medicationHidden')}
                    </Txt>
                  </View>
                  <View style={{ alignItems: 'flex-end', gap: 2 }}>
                    <Txt variant="body" weight="bold">{formatTime(dose.scheduledAt, dose.scheduledTimezone)}</Txt>
                    <Txt variant="caption" color={statusColors(dose.status).fg}>
                      {t(`dose.status.${dose.status}` as 'dose.status.taken')}
                    </Txt>
                  </View>
                </Row>
              </View>
            ))}
          </Card>
        )}

        {!loadFailedWithoutClinicalData && can('view_schedule') && upcoming.length > 0 ? (
          <>
            <SectionTitle>{t('today.upcoming')}</SectionTitle>
            <Card>
              {upcoming.map((dose, index) => (
                <View key={dose.id}>
                  {index > 0 ? <Divider /> : null}
                  <Row style={{ justifyContent: 'space-between' }} gap={theme.spacing.md}>
                    <View style={{ flex: 1 }}>
                      <Txt variant="body" numberOfLines={1}>
                        {can('view_medications') ? dose.medication.name : t('caregiver.medicationHidden')}
                      </Txt>
                    </View>
                    <Txt variant="body" weight="bold">{formatTime(dose.scheduledAt, dose.scheduledTimezone)}</Txt>
                  </Row>
                </View>
              ))}
            </Card>
          </>
        ) : null}

        {!loadFailedWithoutClinicalData && can('view_schedule') && lateDoses.length === 0 && doses.length > 0 ? (
          <Banner tone="success" title={t('caregiver.nothingLate')} />
        ) : null}

        <SectionTitle>{t('caregiver.weeklyAdherence')}</SectionTitle>
        {loadFailedWithoutClinicalData ? null : !can('view_adherence') || !adherence ? (
          <Banner tone="info" title={t('caregiver.notShared', { name: patient.displayName })} />
        ) : (
          <Card>
            <Row style={{ justifyContent: 'space-between' }}>
              <Txt variant="bodyLarge" weight="medium">{t('adherence.percent')}</Txt>
              <Txt variant="h2" weight="bold" color={theme.colors.primary700}>
                {adherence.summary.adherencePercent === null
                  ? t('common.none')
                  : `\u2068${formatNumber(adherence.summary.adherencePercent)}%\u2069`}
              </Txt>
            </Row>
            <Divider />
            <Row style={{ justifyContent: 'space-between' }} wrap gap={theme.spacing.md}>
              <Stat label={t('adherence.scheduled')} value={formatNumber(adherence.summary.scheduled)} />
              <Stat label={t('adherence.taken')} value={formatNumber(adherence.summary.taken)} />
              <Stat label={t('adherence.late')} value={formatNumber(adherence.summary.takenLate)} />
              <Stat label={t('adherence.missed')} value={formatNumber(adherence.summary.missed)} />
            </Row>

            {/* Names are a stricter grant than the numbers: when they are held back the
                breakdown is omitted entirely rather than shown as anonymous rows. */}
            {adherence.byMedicationWithheld ? (
              <Txt variant="caption" color={theme.colors.ink500}>{t('caregiver.medicationHidden')}</Txt>
            ) : adherence.byMedication.length > 0 ? (
              <View style={{ gap: theme.spacing.xs, marginTop: theme.spacing.sm }}>
                {adherence.byMedication.map((entry) => (
                  <Row key={entry.medicationId} style={{ justifyContent: 'space-between' }} gap={theme.spacing.md}>
                    <View style={{ flex: 1 }}>
                      <Txt variant="bodySmall" numberOfLines={1}>{entry.medicationName}</Txt>
                    </View>
                    <Txt variant="bodySmall" weight="bold">
                      {entry.summary.adherencePercent === null
                        ? t('common.none')
                        : `\u2068${formatNumber(entry.summary.adherencePercent)}%\u2069`}
                    </Txt>
                  </Row>
                ))}
              </View>
            ) : null}
          </Card>
        )}

        <SafetyNote textKey="adherence.disclaimer" />
      </ScrollView>
    </SafeAreaView>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  const theme = useTheme();
  return (
    <View style={{ gap: 2, minWidth: 72 }}>
      <Txt variant="caption" color={theme.colors.ink500}>{label}</Txt>
      <Txt variant="h3" weight="bold">{value}</Txt>
    </View>
  );
}
