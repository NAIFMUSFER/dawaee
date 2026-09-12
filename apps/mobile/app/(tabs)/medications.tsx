import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshControl, ScrollView, View } from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Badge, Banner, Button, Card, EmptyState, Loading, Row, Txt } from '@/components/ui';
import { Picker } from '@/components/Picker';
import { ProfileSwitcher } from '@/components/ProfileSwitcher';
import { useI18n } from '@/i18n';
import { useTheme } from '@/hooks/useTheme';
import { useApp } from '@/state/app-store';
import { profileScopeKey, useRequestScope } from '@/hooks/useRequestScope';
import { api, ApiError, NetworkError } from '@/api/client';
import type { DoseView, MedicationView, TodayResponse } from '@/api/types';
import type { MessageKey } from '@dawaee/shared';

type Filter = 'active' | 'paused' | 'all';
const ACTIONABLE: ReadonlySet<DoseView['status']> = new Set(['upcoming', 'due', 'pending_confirmation', 'snoozed']);

export default function MedicationsScreen() {
  const { user, activeProfile } = useApp();
  return <MedicationsProfileScreen key={profileScopeKey(user?.id, activeProfile)} />;
}

function MedicationsProfileScreen() {
  const { t, formatTime, formatDate, formatMeasure } = useI18n();
  const theme = useTheme();
  const { activeProfile, offline, setOffline, preferences } = useApp();
  const arabic = preferences.locale === 'ar';
  const canAdd = Boolean(activeProfile && (activeProfile.isSelf || activeProfile.permissions?.includes('add_medication')));

  const [filter, setFilter] = useState<Filter>('active');
  const [medications, setMedications] = useState<MedicationView[]>([]);
  const [nextDoses, setNextDoses] = useState<Record<string, DoseView>>({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [serviceUnavailable, setServiceUnavailable] = useState(false);

  const { begin: beginLoad } = useRequestScope(filter);

  const load = useCallback(async (selected: Filter) => {
    const isCurrent = beginLoad();
    if (!isCurrent()) return;
    if (!activeProfile) { setLoading(false); setRefreshing(false); return; }
    setLoading(true);
    setServiceUnavailable(false);
    try {
      const [list, today] = await Promise.all([
        api.get<{ medications: MedicationView[] }>('/v1/medications', {
          profileId: activeProfile.id,
          status: selected === 'all' ? undefined : selected,
        }),
        api.get<TodayResponse>('/v1/today', { profileId: activeProfile.id }),
      ]);
      if (!isCurrent()) return;
      const soonest: Record<string, DoseView> = {};
      for (const dose of [...today.today, ...today.prefetch]) {
        if (!ACTIONABLE.has(dose.status)) continue;
        const current = soonest[dose.medicationId];
        if (!current || dose.scheduledAt < current.scheduledAt) soonest[dose.medicationId] = dose;
      }
      setMedications(list.medications);
      setNextDoses(soonest);
      setServiceUnavailable(false);
      setOffline(false);
    } catch (err) {
      if (!isCurrent()) return;
      if (err instanceof NetworkError) {
        setOffline(true);
      } else if (err instanceof ApiError && err.status === 503) {
        // Render can answer 503 while a sleeping production instance wakes.
        // That is a server response, not an empty medication list and not a
        // transport-offline condition. Keep any previously loaded data and
        // show an explicit retry state instead of a false clinical empty state.
        setOffline(false);
        setServiceUnavailable(true);
      }
    } finally {
      if (isCurrent()) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [beginLoad, activeProfile, setOffline]);

  useEffect(() => { void load(filter); }, [load, filter]);

  const filterOptions = useMemo(() => [
    { value: 'active' as const, label: t('medication.status.active') },
    { value: 'paused' as const, label: t('medication.status.paused') },
    { value: 'all' as const, label: t('common.all') },
  ], [t]);

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
    return isToday ? time : `${formatDate(dose.scheduledAt, dose.scheduledTimezone, { day: 'numeric', month: 'short' })} · ${time}`;
  };

  return (
    <SafeAreaView style={{ flex: 1 }}>
      <ScrollView
        style={{ flex: 1, backgroundColor: theme.colors.background }}
        contentContainerStyle={{ padding: theme.spacing.lg, gap: theme.spacing.md, paddingBottom: theme.spacing.xxxl }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); void load(filter); }} />}
      >
        <Txt variant="h2" weight="bold" accessibilityRole="header">{t('medication.listTitle')}</Txt>
        <ProfileSwitcher />
        {activeProfile ? (
          <Txt variant="bodySmall" color={theme.colors.ink500}>
            {arabic ? `تعرض الآن أدوية: ${activeProfile.displayName}` : `Showing medications for: ${activeProfile.displayName}`}
          </Txt>
        ) : null}
        {offline ? <Banner tone="warning" title={t('notifications.offlineBanner')} /> : null}

        {canAdd ? (
          <Button
            label={t('medication.add')}
            size="large"
            onPress={() => router.push('/medication/add')}
            accessibilityHint={t('medication.addHow')}
            testID="add-medication"
          />
        ) : (
          <Banner
            tone="info"
            title={arabic ? 'هذا الملف للعرض فقط' : 'This profile is view-only'}
            body={arabic ? 'لم يمنحك المريض صلاحية إضافة الأدوية.' : 'The patient has not granted medication-add permission.'}
          />
        )}

        <Picker label={t('common.filter')} options={filterOptions} value={filter} onChange={(next) => { setLoading(true); setFilter(next); }} />

        {loading ? <Loading label={t('common.loading')} /> : serviceUnavailable ? (
          <Banner
            tone="warning"
            title={arabic ? 'الخدمة غير متاحة مؤقتاً' : 'Service temporarily unavailable'}
            body={arabic
              ? 'تعذر تحميل قائمة الأدوية الآن. أعد المحاولة بعد لحظات؛ لن نعرض قائمة فارغة بدلاً من البيانات.'
              : 'The medication list could not be loaded right now. Retry shortly; an empty list is not being shown in place of unavailable data.'}
            action={<Button label={t('common.retry')} tone="ghost" fullWidth={false} onPress={() => void load(filter)} />}
          />
        ) : medications.length === 0 ? (
          <EmptyState
            title={filter === 'active' ? t('medication.empty') : t('medication.emptyFiltered')}
            body={filter === 'active' ? t('medication.emptyBody') : undefined}
            action={canAdd ? <Button label={t('medication.add')} fullWidth={false} onPress={() => router.push('/medication/add')} /> : undefined}
          />
        ) : (
          <View style={{ gap: theme.spacing.sm }}>
            {medications.map((medication) => {
              const low = medication.stockForecast?.isLow === true;
              const label = [medication.name, describe(medication), `${t('medication.nextDose')}: ${nextDoseText(medication)}`, low ? t('stock.lowBadge') : null].filter(Boolean).join('، ');
              return (
                <Card key={medication.id} accessibilityLabel={label} onPress={() => router.push(`/medication/${medication.id}`)}>
                  <Row style={{ justifyContent: 'space-between' }} gap={theme.spacing.md} align="flex-start">
                    <View style={{ flex: 1, gap: 2 }}>
                      <Txt variant="bodyLarge" weight="bold" numberOfLines={2}>{medication.name}</Txt>
                      <Txt variant="bodySmall" color={theme.colors.ink500}>{describe(medication)}</Txt>
                    </View>
                    <View style={{ alignItems: 'flex-end', gap: theme.spacing.xs }}>
                      <Txt variant="caption" color={theme.colors.ink500}>{t('medication.nextDose')}</Txt>
                      <Txt variant="bodyLarge" weight="bold" color={theme.colors.primary700}>{nextDoseText(medication)}</Txt>
                    </View>
                  </Row>
                  {low || medication.status !== 'active' ? (
                    <Row wrap gap={theme.spacing.sm}>
                      {medication.status !== 'active' ? (
                        <Badge label={t(`medication.status.${medication.status}` as MessageKey)} fg={theme.colors.ink700} bg={theme.colors.ink100} />
                      ) : null}
                      {low ? <Badge label={t('stock.lowBadge')} fg={theme.colors.warning700} bg={theme.colors.warning100} /> : null}
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
