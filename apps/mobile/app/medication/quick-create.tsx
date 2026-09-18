import React, { useMemo, useRef, useState } from 'react';
import { View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Banner, Button, Card, Divider, Field, Row, Screen, SectionTitle, Txt } from '@/components/ui';
import { DateField, isValidLocalDate, todayLocalDate } from '@/components/DateField';
import { MultiPicker, Picker } from '@/components/Picker';
import { DoseUnitPicker } from '@/components/DoseUnitPicker';
import { ProfileSwitcher } from '@/components/ProfileSwitcher';
import { TimeField, isValidTime } from '@/components/TimeField';
import { useI18n } from '@/i18n';
import { useTheme } from '@/hooks/useTheme';
import { useApp } from '@/state/app-store';
import { profileScopeKey, useRequestScope } from '@/hooks/useRequestScope';
import { api, ApiError, NetworkError } from '@/api/client';
import { newClientEventId } from '@/storage/offline-queue';
import { clearMedicationDrafts, getMedicationPrefillDraft } from '@/storage/medication-draft';
import { setMedicationDetailRouteIntent } from '@/navigation/private-navigation';
import type { MedicationView } from '@/api/types';
import { MEDICATION_FORMS, FORM_DOSE_UNITS, MAX_DAILY_TIMES, MAX_DOSE_QUANTITY, parseMedicationNumber, type DoseUnit, type MessageKey, type MedicationForm, type StrengthUnit } from '@dawaee/shared';

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

  const [notes, setNotes] = useState('');
  const [name, setName] = useState(prefill.name ?? '');
  const [doseQuantity, setDoseQuantity] = useState('1');
  const [form, setForm] = useState<MedicationForm>(prefill.form ?? 'tablet');
  const [doseUnit, setDoseUnit] = useState<DoseUnit>(FORM_DOSE_UNITS[prefill.form ?? 'tablet'][0]!);
  const [unitNeedsReview, setUnitNeedsReview] = useState(false);
  const saveInFlight = useRef(false);
  const createIntent = useRef<{ input: string; id: string } | null>(null);
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

  const formOptions = useMemo(
    () => MEDICATION_FORMS.map((value) => ({ value, label: t(`form.${value}` as MessageKey) })),
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
    if (!activeProfile || !canAdd || saveInFlight.current) return;
    const trimmedName = name.trim();
    if (!trimmedName) {
      setNameError(t('medication.nameRequired'));
      return;
    }
    const quantity = parseMedicationNumber(doseQuantity);
    if (!Number.isFinite(quantity) || quantity <= 0 || quantity > MAX_DOSE_QUANTITY || unitNeedsReview || weekdays.length === 0 || times.length === 0 || times.length > MAX_DAILY_TIMES || times.some((time) => !isValidTime(time))) {
      setError(t('error.validation_failed'));
      return;
    }
    if (new Set(times).size !== times.length) {
      setError(t('schedule.duplicateTime'));
      return;
    }
    if (!isValidLocalDate(startDate) || (endDate && (!isValidLocalDate(endDate) || endDate < startDate))) {
      setError(t('error.validation_failed'));
      return;
    }
    const stockQty = remainingQuantity.trim() === '' ? null : parseMedicationNumber(remainingQuantity);
    if (stockQty !== null && (!Number.isFinite(stockQty) || stockQty < 0)) {
      setError(t('error.validation_failed'));
      return;
    }

    const isCurrent = captureSave();
    saveInFlight.current = true;
    setSaving(true);
    setError(null);
    setNameError(null);
    try {
      const input = {
        patientProfileId: activeProfile.id,
        name: trimmedName,
        brandName: prefill.brandName ?? null,
        genericName: prefill.genericName ?? null,
        form,
        strengthValue: prefill.strengthValue ?? null,
        strengthUnit: prefill.strengthUnit ?? null,
        manufacturer: prefill.manufacturer ?? null,
        barcode: prefill.barcode ?? null,
        imageKey: prefill.imageKey ?? null,
        instructions: prefill.instructions ?? null,
        notes: notes.trim() || null,
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
      };
      const serialized = JSON.stringify(input);
      if (createIntent.current?.input !== serialized) {
        createIntent.current = { input: serialized, id: newClientEventId() };
      }
      const created = await api.post<{ medication: MedicationView }>('/v1/medications', {
        ...input, clientRequestId: createIntent.current.id,
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
      saveInFlight.current = false;
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
              <Field
                label={t('medication.name')}
                value={name}
                onChangeText={(value) => {
                  setName(value);
                  setDuplicate(false);
                }}
                error={nameError}
                autoFocus={!prefill.name}
              />
              <Picker wrap label={t('medication.form')} options={formOptions} value={form} onChange={(next) => {
                setForm(next);
                setUnitNeedsReview(!FORM_DOSE_UNITS[next].includes(doseUnit));
              }} />
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
                label={arabic ? 'كمية الجرعة في كل مرة (يمكنك كتابة كمية أخرى)' : 'Amount per dose (or enter another amount)'}
                value={doseQuantity}
                onChangeText={setDoseQuantity}
                keyboardType="decimal-pad"
              />
              <Txt variant="caption">{t('medication.amountShortcuts')}</Txt>
              <DoseUnitPicker form={form} value={doseUnit} onChange={(unit) => { setDoseUnit(unit); setUnitNeedsReview(false); }} />
              {unitNeedsReview ? <Banner tone="warning" title={t('medication.reviewUnit')}
                action={<Button tone="secondary" label={t('medication.keepUnit')} onPress={() => setUnitNeedsReview(false)} />} /> : null}
              <Txt variant="caption" color={theme.colors.ink500}>
                {t('medication.amountSeparateFromTimes')}
              </Txt>
            </Card>

            <Field label={t('medication.notes')} value={notes} onChangeText={setNotes}
          multiline maxLength={2000} hint={t('notes.medicationHint')} />

        <SectionTitle>{t('schedule.title')}</SectionTitle>
            <Card>
              <Txt weight="bold">{t('schedule.dailyTimesCount', { count: formatNumber(times.length), max: formatNumber(MAX_DAILY_TIMES) })}</Txt>
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
                <Row key={`time-${index}`} gap={theme.spacing.sm} align="flex-end">
                  <View style={{ flex: 1 }}>
                    <TimeField
                      label={`${t('schedule.times')} ${formatNumber(index + 1)}`}
                      value={time}
                      onChange={(value) => setTimes((current) => current.map((entry, position) => position === index ? value : entry))}
                      error={!isValidTime(time) ? t('schedule.invalidTime') : times.filter((entry) => entry === time).length > 1 ? t('schedule.duplicateTime') : null}
                    />
                  </View>
                  {times.length > 1 ? (
                    <Button label={t('common.remove')} tone="ghost" fullWidth={false} onPress={() => setTimes((current) => current.filter((_, position) => position !== index))} />
                  ) : null}
                </Row>
              ))}
              {times.length < MAX_DAILY_TIMES ? <Button label={t('schedule.addTime')} tone="secondary" onPress={() => setTimes((current) => [...current, ''])} /> : null}
            </Card>

            <Card>
              <DateField label={t('schedule.startDate')} value={startDate} onChange={setStartDate} />
              <DateField label={t('schedule.endDate')} value={endDate} onChange={setEndDate} optional />
            </Card>

            <SectionTitle>{t('stock.title')}</SectionTitle>
            <Card>
              <Field
                label={`${t('stock.currentQuantity')} (${t(`unit.${doseUnit}` as MessageKey)})`}
                value={remainingQuantity}
                onChangeText={setRemainingQuantity}
                keyboardType="decimal-pad"
                placeholder={t('stock.enterNewQuantity')}
                hint={t('common.optional')}
              />
              <Picker label={t('stock.thresholdLabel')} options={thresholdOptions} value={thresholdDays} onChange={setThresholdDays} />
            </Card>

            <Button testID="save-medication" label={t('common.save')} size="large" loading={saving} onPress={() => void save()} />
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
