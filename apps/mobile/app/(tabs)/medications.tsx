import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshControl, ScrollView, View } from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Badge, Banner, Button, Card, EmptyState, Loading, Row, Txt } from '@/components/ui';
import { Picker } from '@/components/Picker';
import { useI18n } from '@/i18n';
import { useTheme } from '@/hooks/useTheme';
import { useApp } from '@/state/app-store';
import { api, NetworkError } from '@/api/client';
import type { DoseView, MedicationView, TodayResponse } from '@/api/types';
import type { MessageKey } from '@dawaee/shared';

/**
 * The medication list.
 *
 * The next dose time comes from `/v1/today` rather than being recomputed from
 * the schedule rules on the device: the server already materialised the
 * occurrences, and a second implementation of the expansion here could drift
 * from the one that actually fires the reminders.
 */

type Filter = 'active' | 'paused' | 'all';

const ACTIONABLE: ReadonlySet<DoseView['status']> = new Set(['upcoming', 'due', 'pending_confirmation', 'snoozed']);

export default function MedicationsScreen() {
  const { t, formatNumber, formatTime, formatDate, formatMeasure } = useI18n();
  const theme = useTheme();
  const { activeProfile, offline, setOffline } = useApp();

  const [filter, setFilter] = useState<Filter>('active');
  const [medications, setMedications] = useState<MedicationView[]>([]);
  const [nextDoses, setNextDoses] = useState<Record<string, DoseView>>({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (selected: Filter) => {
    if (!activeProfile) return;
    try {
      const [list, today] = await Promise.all([
        api.get<{ medications: MedicationView[] }>('/v1/medications', {
          profileId: activeProfile.id,
          status: selected === 'all' ? undefined : selected,
        }),
        api.get<TodayResponse>('/v1/today', { profileId: activeProfile.id }),
      ]);

      const soonest: Record<string, DoseView> = {};
      for (const dose of [...today.today, ...today.prefetch]) {
        if (!ACTIONABLE.has(dose.status)) continue;
        const current = soonest[dose.medicationId];
        if (!current || dose.scheduledAt < current.scheduledAt) soonest[dose.medicationId] = dose;
      }

      setMedications(list.medications);
      setNextDoses(soonest);
      setOffline(false);
    } catch (err) {
      if (err instanceof NetworkError) setOffline(true);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [activeProfile, setOffline]);

  useEffect(() => { void load(filter); }, [load, filter]);

  const filterOptions = useMemo(
    () => [
      { value: 'active' as const, label: t('medication.status.active') },
      { value: 'paused' as const, label: t('medication.status.paused') },
      { value: 'all' as const, label: t('common.all') },
    ],
    [t],
  );

  const describe = (medication: MedicationView): string => {
    const strength = medication.strengthValue !== null
      ? formatMeasure(medication.strengthValue, medication.strengthUnit ? `strengthUnit.${medication.strengthUnit}` : undefined)
      : null;
    return [strength, t(`form.${medication.form}` as MessageKey)].filter(Boolean).join(' · ');
  };

  const nextDoseText = (medication: MedicationView): string => {
    const dose = nextDoses[medication.id];
    if (!dose) return t('medication.noSchedule');
    const time = formatTime(dose.scheduledAt, dose.scheduledTimezone);
    const isToday = dose.scheduledLocalDate === new Date().toISOString().slice(0, 10);
    return isToday
      ? time
      : `${formatDate(dose.scheduledAt, dose.scheduledTimezone, { day: 'numeric', month: 'short' })} · ${time}`;
  };

  if (loading && medications.length === 0) {
    return <SafeAreaView style={{ flex: 1 }}><Loading label={t('common.loading')} /></SafeAreaView>;
  }

  return (
    <SafeAreaView style={{ flex: 1 }}>
      <ScrollView
        style={{ flex: 1, backgroundColor: theme.colors.background }}
        contentContainerStyle={{ padding: theme.spacing.lg, gap: theme.spacing.md, paddingBottom: theme.spacing.xxxl }}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); void load(filter); }} />
        }
      >
        <Txt variant="h2" weight="bold" accessibilityRole="header">{t('medication.listTitle')}</Txt>

        {offline ? <Banner tone="warning" title={t('notifications.offlineBanner')} /> : null}

        <Button
          label={t('medication.add')}
          size="large"
          onPress={() => router.push('/medication/add')}
          accessibilityHint={t('medication.addHow')}
          testID="add-medication"
        />

        <Picker
          label={t('common.filter')}
          options={filterOptions}
          value={filter}
          onChange={(next) => { setLoading(true); setFilter(next); }}
        />

        {medications.length === 0 ? (
          <EmptyState
            title={filter === 'active' ? t('medication.empty') : t('medication.emptyFiltered')}
            body={filter === 'active' ? t('medication.emptyBody') : undefined}
            action={
              <Button
                label={t('medication.add')}
                fullWidth={false}
                onPress={() => router.push('/medication/add')}
              />
            }
          />
        ) : (
          <View style={{ gap: theme.spacing.sm }}>
            {medications.map((medication) => {
              const low = medication.stockForecast?.isLow === true;
              const label = [
                medication.name,
                describe(medication),
                `${t('medication.nextDose')}: ${nextDoseText(medication)}`,
                low ? t('stock.lowBadge') : null,
              ].filter(Boolean).join('، ');

              return (
                <Card
                  key={medication.id}
                  accessibilityLabel={label}
                  onPress={() => router.push(`/medication/${medication.id}`)}
                >
                  <Row style={{ justifyContent: 'space-between' }} gap={theme.spacing.md} align="flex-start">
                    <View style={{ flex: 1, gap: 2 }}>
                      <Txt variant="bodyLarge" weight="bold" numberOfLines={2}>{medication.name}</Txt>
                      <Txt variant="bodySmall" color={theme.colors.ink500}>{describe(medication)}</Txt>
                    </View>
                    <View style={{ alignItems: 'flex-end', gap: theme.spacing.xs }}>
                      <Txt variant="caption" color={theme.colors.ink500}>{t('medication.nextDose')}</Txt>
                      <Txt variant="bodyLarge" weight="bold" color={theme.colors.primary700}>
                        {nextDoseText(medication)}
                      </Txt>
                    </View>
                  </Row>

                  {low || medication.status !== 'active' ? (
                    <Row wrap gap={theme.spacing.sm}>
                      {medication.status !== 'active' ? (
                        <Badge
                          label={t(`medication.status.${medication.status}` as MessageKey)}
                          fg={theme.colors.ink700}
                          bg={theme.colors.ink100}
                        />
                      ) : null}
                      {low ? (
                        <Badge
                          label={t('stock.lowBadge')}
                          fg={theme.colors.warning700}
                          bg={theme.colors.warning100}
                        />
                      ) : null}
                    </Row>
                  ) : null}
                </Card>
              );
            })}
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
