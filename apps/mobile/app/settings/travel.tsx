import React, { useCallback, useEffect, useState } from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  Banner, Button, Card, Divider, EmptyState, Loading, Row, SafetyNote, Screen, SectionTitle, Txt,
} from '@/components/ui';
import { useI18n } from '@/i18n';
import { useTheme } from '@/hooks/useTheme';
import { useApp } from '@/state/app-store';
import { api, ApiError, NetworkError } from '@/api/client';
import type { DoseView, TodayResponse } from '@/api/types';

/**
 * Travel mode.
 *
 * The one thing this screen must never do is move a medication time on its own.
 * Detecting a new timezone only *offers* a choice — the check endpoint records
 * the prompt and changes nothing — and the preview below shows, dose by dose,
 * what each option would do to today before the patient commits to it.
 *
 * "Keep home time" leaves the instants alone, so the reminders arrive at a
 * different hour on this phone's clock. "Convert to local time" keeps the
 * familiar clock numbers and moves the instants. Both are legitimate; which one
 * is safe depends on the medication, which is a question for the patient's
 * doctor and not for this app.
 */

type TimezoneCheck =
  | { changed: false }
  | { changed: true; from: string; to: string; offsetShiftHours: number };

type Decision = 'keep_home_time' | 'follow_local_time' | 'dismiss';

function deviceTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Riyadh';
  } catch {
    return 'Asia/Riyadh';
  }
}

export default function TravelScreen() {
  const { t, formatNumber, formatTime } = useI18n();
  const theme = useTheme();
  const { activeProfile, refreshProfiles } = useApp();

  const [check, setCheck] = useState<TimezoneCheck | null>(null);
  const [doses, setDoses] = useState<DoseView[]>([]);
  const [loading, setLoading] = useState(true);
  const [offline, setOffline] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [applying, setApplying] = useState<Decision | null>(null);
  const [applied, setApplied] = useState(false);

  const detected = deviceTimezone();

  const load = useCallback(async () => {
    if (!activeProfile) return;
    setLoading(true);
    setError(null);
    try {
      const [result, today] = await Promise.all([
        api.post<TimezoneCheck>(`/v1/profiles/${activeProfile.id}/timezone-check`, { deviceTimezone: detected }),
        api.get<TodayResponse>('/v1/today', { profileId: activeProfile.id }),
      ]);
      setCheck(result);
      setDoses(today.today);
      setOffline(false);
    } catch (err) {
      if (err instanceof NetworkError) setOffline(true);
      else if (err instanceof ApiError) setError(t('travel.checkFailed'));
      else setError(t('error.internal_error'));
    } finally {
      setLoading(false);
    }
  }, [activeProfile, detected, t]);

  useEffect(() => { void load(); }, [load]);

  const decide = async (decision: Decision) => {
    if (!activeProfile) return;
    setApplying(decision);
    setError(null);
    try {
      await api.post(`/v1/profiles/${activeProfile.id}/timezone-decision`, {
        detectedTimezone: detected,
        decision,
      });
      await refreshProfiles();
      setApplied(true);
      await load();
    } catch (err) {
      if (err instanceof NetworkError) setOffline(true);
      else setError(t('travel.checkFailed'));
    } finally {
      setApplying(null);
    }
  };

  if (!activeProfile) {
    return (
      <SafeAreaView style={{ flex: 1 }}>
        <Screen><EmptyState title={t('settings.switchProfile')} /></Screen>
      </SafeAreaView>
    );
  }

  const changed = check?.changed === true;

  return (
    <SafeAreaView style={{ flex: 1 }}>
      <Screen>
        <Row style={{ justifyContent: 'space-between' }}>
          <Txt variant="h1" weight="bold" accessibilityRole="header">{t('settings.travelMode')}</Txt>
          <Button label={t('common.back')} tone="ghost" fullWidth={false} onPress={() => router.back()} />
        </Row>

        {offline ? (
          <Banner
            tone="warning"
            title={t('notifications.offlineBanner')}
            action={<Button label={t('common.retry')} tone="ghost" fullWidth={false} onPress={() => void load()} />}
          />
        ) : null}
        {error ? <Banner tone="danger" title={error} /> : null}
        {applied ? <Banner tone="success" title={t('travel.applied')} /> : null}

        <Card>
          <Row style={{ justifyContent: 'space-between' }} gap={theme.spacing.md}>
            <Txt variant="bodySmall" color={theme.colors.ink500}>{t('travel.scheduleTimezone')}</Txt>
            <Txt variant="bodyLarge" weight="medium">{activeProfile.timezone}</Txt>
          </Row>
          <Divider />
          <Row style={{ justifyContent: 'space-between' }} gap={theme.spacing.md}>
            <Txt variant="bodySmall" color={theme.colors.ink500}>{t('travel.deviceTimezone')}</Txt>
            <Txt variant="bodyLarge" weight="medium">{detected}</Txt>
          </Row>
          <Divider />
          <Row style={{ justifyContent: 'space-between' }} gap={theme.spacing.md}>
            <Txt variant="bodySmall" color={theme.colors.ink500}>{t('travel.homeTimezone')}</Txt>
            <Txt variant="bodyLarge" weight="medium">{activeProfile.homeTimezone}</Txt>
          </Row>
        </Card>

        {loading && !check ? <Loading label={t('common.loading')} /> : null}

        {check && !changed ? (
          <Banner tone="success" title={t('travel.matching')} />
        ) : null}

        {changed && check.changed ? (
          <>
            <Banner
              tone="info"
              title={t('travel.title')}
              body={t('travel.body', { timezone: detected })}
            />
            <Txt variant="bodyLarge" weight="bold">{t('travel.nothingChanges')}</Txt>
            <Txt variant="bodySmall" color={theme.colors.ink500}>
              {t('travel.offsetShift', { hours: formatNumber(check.offsetShiftHours) })}
            </Txt>

            <SectionTitle>{t('travel.previewTitle')}</SectionTitle>
            {doses.length === 0 ? (
              <Txt variant="bodySmall" color={theme.colors.ink500}>{t('travel.previewNoDoses')}</Txt>
            ) : (
              <Card>
                <Row style={{ justifyContent: 'space-between' }} gap={theme.spacing.md}>
                  <Txt variant="caption" color={theme.colors.ink500} style={{ flex: 2 }}>
                    {t('medication.name')}
                  </Txt>
                  <Txt variant="caption" color={theme.colors.ink500} style={{ flex: 1 }}>
                    {t('travel.keepHome')}
                  </Txt>
                  <Txt variant="caption" color={theme.colors.ink500} style={{ flex: 1 }}>
                    {t('travel.followLocal')}
                  </Txt>
                </Row>
                {doses.map((dose) => (
                  <View key={dose.id} style={{ gap: theme.spacing.xs }}>
                    <Divider />
                    <Row style={{ justifyContent: 'space-between' }} gap={theme.spacing.md}>
                      <Txt variant="bodySmall" numberOfLines={1} style={{ flex: 2 }}>{dose.medication.name}</Txt>
                      {/* Same instant, read on this phone's clock. */}
                      <Txt variant="bodySmall" weight="medium" style={{ flex: 1 }}>
                        {formatTime(dose.scheduledAt, detected)}
                      </Txt>
                      {/* Same clock numbers as at home, now meaning local time. */}
                      <Txt variant="bodySmall" weight="medium" style={{ flex: 1 }}>
                        {formatTime(`1970-01-01T${dose.scheduledLocalTime}:00Z`, 'UTC')}
                      </Txt>
                    </Row>
                  </View>
                ))}
              </Card>
            )}

            <Card>
              <Txt variant="bodySmall" color={theme.colors.ink500}>{t('travel.keepHomeExplain')}</Txt>
              <Button
                label={t('travel.keepHome')}
                size="large"
                loading={applying === 'keep_home_time'}
                onPress={() => void decide('keep_home_time')}
              />
              <Divider />
              <Txt variant="bodySmall" color={theme.colors.ink500}>{t('travel.followLocalExplain')}</Txt>
              <Button
                label={t('travel.followLocal')}
                size="large"
                tone="secondary"
                loading={applying === 'follow_local_time'}
                onPress={() => void decide('follow_local_time')}
              />
              <Divider />
              <Txt variant="bodySmall" color={theme.colors.ink500}>{t('travel.reviewHint')}</Txt>
              <Button
                label={t('travel.review')}
                tone="ghost"
                loading={applying === 'dismiss'}
                onPress={() => void decide('dismiss')}
              />
            </Card>
          </>
        ) : null}

        <SafetyNote textKey="safety.notMedicalAdvice" />
      </Screen>
    </SafeAreaView>
  );
}
