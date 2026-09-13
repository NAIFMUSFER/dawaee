import React, { useMemo, useState } from 'react';
import { View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Banner, Button, Card, Divider, Field, Row, Screen, SectionTitle, Txt } from '@/components/ui';
import { DateField, isValidLocalDate, todayLocalDate } from '@/components/DateField';
import { MultiPicker, Picker } from '@/components/Picker';
import { ProfileSwitcher } from '@/components/ProfileSwitcher';
import { TimeField, isValidTime } from '@/components/TimeField';
import { useI18n } from '@/i18n';
import { useTheme } from '@/hooks/useTheme';
import { useApp } from '@/state/app-store';
import { profileScopeKey, useRequestScope } from '@/hooks/useRequestScope';
import { api, ApiError, NetworkError } from '@/api/client';
import { clearMedicationDrafts, getMedicationPrefillDraft } from '@/storage/medication-draft';
import { setMedicationDetailRouteIntent } from '@/navigation/private-navigation';
import type { MedicationView } from '@/api/types';
import { DOSE_UNITS, type DoseUnit, type MessageKey, type MedicationForm, type StrengthUnit } from '@dawaee/shared';

const WEEKDAY_ANCHORS = [
  '2024-01-07', '2024-01-08', '2024-01-09', '2024-01-10', '2024-01-11', '2024-01-12', '2024-01-13',
] as const;
const THRESHOLD_CHOICES = ['3', '5', '7', '10', '14'] as const;
const DOSE_QUANTITY_CHOICES = ['0.5', '1', '1.5', '2', '3'] as const;

type Prefill = {
  name?: string;
  form?: MedicationForm;
  strengthValue?: number | null;
  strengthUnit?: StrengthUnit | null;
  brandName?: string | null;
  genericName?: string | null;
  manufacturer?: string | null;
  barcode?: string | null;
  instructions?: string | null;
  expiryDate?: string | null;
  imageKey?: string | null;
  identitySource?: 'user' | 'ocr_confirmed_by_user' | 'barcode_confirmed_by_user';
};

export default function QuickCreateMedicationScreen() {
  const { user, activeProfile } = useApp();
  return <QuickCreateMedicationProfileScreen key={profileScopeKey(user?.id, activeProfile)} />;
}

function QuickCreateMedicationProfileScreen() {
  const params = useLocalSearchParams<{ source?: string }>();
  const { activeProfile, preferences, user } = useApp();
  const prefill = useMemo<Prefill>(
    () => params.source === 'capture' && activeProfile
      ? (getMedicationPrefillDraft(activeProfile.id) ?? {})
      : {},
    [params.source, activeProfile?.id],
  );
  const { t, formatNumber, formatWeekday } = useI18n();
  const theme = useTheme();
  const arabic = preferences.locale === 'ar';
  const canAdd = Boolean(activeProfile && (activeProfile.isSelf || activeProfile.permissions?.includes('add_medication')));
  const { capture: captureSave } = useRequestScope();

  const [name, setName] = useState(prefill.name ?? '');
  const [doseQuantity, setDoseQuantity] = useState('1');
  const [doseUnit, setDoseUnit] = useState<DoseUnit>('tablet');
  const [times, setTimes] = useState<string[]>(['08:00']);
  const [weekdays, setWeekdays] = useState<string[]>(['0', '1', '2', '3', '4', '5', '6']);
  const [startDate, setStartDate] = useState(() => todayLocalDate(activeProfile?.timezone));
  const [endDate, setEndDate] = useState('');
  const [remainingQuantity, setRemainingQuantity] = useState('');
  const [thresholdDays, setThresholdDays] = useState(String(preferences.lowStockThresholdDays || 7));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const [duplicate, setDuplicate] = useState(false);

  const unitOptions = useMemo(
    () => DOSE_UNITS.map((value) => ({ value, label: t(`unit.${value}` as MessageKey) })),
    [t],
  );
  const weekdayOptions = useMemo(
    () => WEEKDAY_ANCHORS.map((date, index) => ({ value: String(index), label: formatWeekday(`${date}T12:00:00Z`, 'UTC') })),
    [formatWeekday],
  );
  const thresholdOptions = useMemo(
    () => THRESHOLD_CHOICES.map((value) => ({ value, label: formatNumber(Number(value)) })),
    [formatNumber],
  );

  const describeError = (err: unknown): string => {
    if (err instanceof NetworkError) return t('notifications.offlineBanner');
    if (err instanceof ApiError) {
      const key = `error.${err.code}` as MessageKey;
      const message = t(key);
      return message === key ? t('error.internal_error') : message;
    }
    return t('error.internal_error');
  };

  const save = async (acknowledgeDuplicate = false) => {
    if (!activeProfile || !canAdd) return;
    const trimmedName = name.trim();
    if (!trimmedName) {
      setNameError(t('medication.nameRequired'));
      return;
    }
    const quantity = Number(doseQuantity.replace(',', '.'));
    if (!Number.isFinite(quantity) || quantity <= 0 || weekdays.length === 0 || times.some((time) => !isValidTime(time))) {
      setError(t('error.validation_failed'));
      return;
    }
    if (!isValidLocalDate(startDate) || (endDate && (!isValidLocalDate(endDate) || endDate < startDate))) {
      setError(t('error.validation_failed'));
      return;
    }
    const stockQty = remainingQuantity.trim() === '' ? null : Number(remainingQuantity.replace(',', '.'));
    if (stockQty !== null && (!Number.isFinite(stockQty) || stockQty < 0)) {
      setError(t('error.validation_failed'));
      return;
    }

    const isCurrent = captureSave();
    setSaving(true);
    setError(null);
    setNameError(null);
    try {
      const created = await api.post<{ medication: MedicationView }>('/v1/medications', {
        patientProfileId: activeProfile.id,
        name: trimmedName,
        brandName: prefill.brandName ?? null,
        genericName: prefill.genericName ?? null,
        form: prefill.form ?? 'other',
        strengthValue: prefill.strengthValue ?? null,
        strengthUnit: prefill.strengthUnit ?? null,
        manufacturer: prefill.manufacturer ?? null,
        barcode: prefill.barcode ?? null,
        imageKey: prefill.imageKey ?? null,
        instructions: prefill.instructions ?? null,
        startDate,
        endDate: endDate || null,
        expiryDate: prefill.expiryDate ?? null,
        identitySource: prefill.identitySource ?? 'user',
        schedule: {
          rule: {
            kind: 'days_of_week',
            weekdays: weekdays.map(Number).sort((a, b) => a - b),
            times: [...times].sort(),
          },
          doseQuantity: quantity,
          doseUnit,
          timezone: activeProfile.timezone,
          startDate,
          endDate: endDate || null,
        },
        ...(stockQty === null ? {} : {
          stock: {
            trackingEnabled: true,
            initialQuantity: stockQty,
            unit: doseUnit,
            lowStockThresholdDays: Number(thresholdDays),
          },
        }),
        ...(acknowledgeDuplicate ? { acknowledgeDuplicate: true } : {}),
      });
      if (!isCurrent()) return;
      clearMedicationDrafts();
      if (!user) return;
      setMedicationDetailRouteIntent({
        userId: user.id,
        patientProfileId: activeProfile.id,
        medicationId: created.medication.id,
      });
      router.replace('/medication/detail');
    } catch (err) {
      if (!isCurrent()) return;
      if (err instanceof ApiError && err.code === 'duplicate_medication') {
        setDuplicate(true);
      } else {
        setError(describeError(err));
      }
    } finally {
      if (isCurrent()) setSaving(false);
    }
  };

  return (
    <SafeAreaView style={{ flex: 1 }}>
      <Screen>
        <Txt variant="h2" weight="bold" accessibilityRole="header">{t('medication.createTitle')}</Txt>
        <ProfileSwitcher compact />
        {activeProfile ? (
          <Banner
            tone="info"
            title={arabic ? `الدواء سيُضاف إلى: ${activeProfile.displayName}` : `Medication will be added to: ${activeProfile.displayName}`}
          />
        ) : null}
        {!canAdd ? (
          <Banner
            tone="warning"
            title={arabic ? 'لا تملك صلاحية إضافة دواء لهذا الملف' : 'You cannot add medication to this profile'}
          />
        ) : null}
        {error ? <Banner tone="danger" title={error} /> : null}
        {duplicate ? (
          <Banner
            tone="warning"
            title={t('medication.duplicateTitle')}
            body={t('medication.duplicateWarning')}
            action={<Button label={t('medication.addAnyway')} tone="danger" loading={saving} onPress={() => void save(true)} />}
          />
        ) : null}

        {canAdd ? (
          <>
            <Card>
              <Field label={t('medication.name')} value={name} onChangeText={setName} error={nameError} autoFocus={!prefill.name} />
            </Card>

            <SectionTitle>{t('medication.dose')}</SectionTitle>
            <Card>
              <Txt variant="bodySmall" weight="bold">
                {arabic ? 'كم تأخذ في كل مرة؟' : 'How much do you take each time?'}
              </Txt>
              <Row wrap gap={theme.spacing.sm}>
                {DOSE_QUANTITY_CHOICES.map((value) => (
                  <Button
                    key={value}
                    label={formatNumber(Number(value))}
                    tone={doseQuantity === value ? 'primary' : 'secondary'}
                    fullWidth={false}
                    onPress={() => setDoseQuantity(value)}
                  />
                ))}
              </Row>
              <Field
                label={arabic ? 'كمية أخرى' : 'Other amount'}
                value={doseQuantity}
                onChangeText={setDoseQuantity}
                keyboardType="decimal-pad"
              />
              <Picker label={arabic ? 'الوحدة' : 'Unit'} options={unitOptions} value={doseUnit} onChange={setDoseUnit} />
              <Txt variant="caption" color={theme.colors.ink500}>
                {arabic ? 'مثال: ٢ حبة في كل موعد. تُستخدم هذه الكمية أيضًا لحساب موعد نفاد الدواء.' : 'Example: 2 tablets at each scheduled time. This amount is also used to forecast when stock will run out.'}
              </Txt>
            </Card>

            <SectionTitle>{t('schedule.title')}</SectionTitle>
            <Card>
              <MultiPicker
                label={t('schedule.weekdays')}
                options={weekdayOptions}
                values={weekdays}
                onToggle={(value) => setWeekdays((current) => current.includes(value)
                  ? current.filter((day) => day !== value)
                  : [...current, value])}
                error={weekdays.length === 0 ? t('schedule.weekdaysRequired') : null}
              />
              <Divider />
              {times.map((time, index) => (
                <Row key={`${index}-${time}`} gap={theme.spacing.sm} align="flex-end">
                  <View style={{ flex: 1 }}>
                    <TimeField
                      label={`${t('schedule.times')} ${formatNumber(index + 1)}`}
                      value={time}
                      onChange={(value) => setTimes((current) => current.map((entry, position) => position === index ? value : entry))}
                      error={!isValidTime(time) ? t('schedule.invalidTime') : null}
                    />
                  </View>
                  {times.length > 1 ? (
                    <Button label={t('common.remove')} tone="ghost" fullWidth={false} onPress={() => setTimes((current) => current.filter((_, position) => position !== index))} />
                  ) : null}
                </Row>
              ))}
              {times.length < 12 ? <Button label={t('schedule.addTime')} tone="secondary" onPress={() => setTimes((current) => [...current, '08:00'])} /> : null}
            </Card>

            <Card>
              <DateField label={t('schedule.startDate')} value={startDate} onChange={setStartDate} />
              <DateField label={t('schedule.endDate')} value={endDate} onChange={setEndDate} optional />
            </Card>

            <SectionTitle>{t('stock.title')}</SectionTitle>
            <Card>
              <Field
                label={t('stock.currentQuantity')}
                value={remainingQuantity}
                onChangeText={setRemainingQuantity}
                keyboardType="decimal-pad"
                placeholder={t('stock.enterNewQuantity')}
                hint={t('common.optional')}
              />
              <Picker label={t('stock.thresholdLabel')} options={thresholdOptions} value={thresholdDays} onChange={setThresholdDays} />
            </Card>

            <Button label={t('common.save')} size="large" loading={saving} onPress={() => void save()} />
          </>
        ) : null}
        <Button
          label={t('common.cancel')}
          tone="ghost"
          onPress={() => {
            clearMedicationDrafts();
            router.back();
          }}
        />
      </Screen>
    </SafeAreaView>
  );
}
