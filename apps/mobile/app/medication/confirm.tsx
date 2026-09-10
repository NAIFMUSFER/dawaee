import React, { useMemo, useState } from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Badge, Banner, Button, Card, Divider, Field, Row, Screen, Txt } from '@/components/ui';
import { Picker } from '@/components/Picker';
import { DateField, isValidLocalDate } from '@/components/DateField';
import { useI18n } from '@/i18n';
import { useTheme } from '@/hooks/useTheme';
import { useApp } from '@/state/app-store';
import {
  clearMedicationDrafts,
  getMedicationConfirmDraft,
  setMedicationPrefillDraft,
} from '@/storage/medication-draft';
import {
  MEDICATION_FORMS, STRENGTH_UNITS,
  type MedicationForm, type MessageKey, type StrengthUnit,
} from '@dawaee/shared';

const CONFIDENCE_FLOOR = 0.75;

function asEnum<T extends string>(allowed: readonly T[], value: string | undefined): T | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  return allowed.find((option) => option === normalized) ?? null;
}

export default function ConfirmMedicationScreen() {
  const { activeProfile } = useApp();
  // The draft is deliberately process-local and profile-bound. A reload or
  // profile switch fails closed instead of reconstructing health data from a URL.
  const payload = useMemo(
    () => activeProfile ? getMedicationConfirmDraft(activeProfile.id) : null,
    [activeProfile?.id],
  );
  const { t, formatNumber, locale } = useI18n();

  const detected = payload?.detected ?? {};
  const reading = (key: string): string => detected[key]?.value ?? '';

  const [name, setName] = useState(reading('name'));
  const [form, setForm] = useState<MedicationForm>(asEnum(MEDICATION_FORMS, reading('form')) ?? 'tablet');
  const [strengthValue, setStrengthValue] = useState(reading('strengthValue'));
  const [strengthUnit, setStrengthUnit] = useState<StrengthUnit>(asEnum(STRENGTH_UNITS, reading('strengthUnit')) ?? 'mg');
  const [expiryDate, setExpiryDate] = useState(isValidLocalDate(reading('expiryDate')) ? reading('expiryDate') : '');
  const [showMore, setShowMore] = useState(false);
  const [brandName, setBrandName] = useState(reading('brandName'));
  const [genericName, setGenericName] = useState(reading('genericName'));
  const [manufacturer, setManufacturer] = useState(reading('manufacturer'));
  const [barcode, setBarcode] = useState(reading('barcode'));
  const [instructions, setInstructions] = useState(reading('instructions'));
  const [nameError, setNameError] = useState<string | null>(null);

  const formOptions = useMemo(
    () => MEDICATION_FORMS.map((value) => ({ value, label: t(`form.${value}` as MessageKey) })),
    [t],
  );
  const strengthUnitOptions = useMemo(
    () => STRENGTH_UNITS.map((value) => ({ value, label: t(`strengthUnit.${value}` as MessageKey) })),
    [t],
  );
  const moreLabel = locale === 'ar' ? 'تفاصيل إضافية' : 'Additional details';

  const continueToSchedule = () => {
    if (!payload || !activeProfile || activeProfile.id !== payload.patientProfileId) return;
    const trimmed = name.trim();
    if (!trimmed) {
      setNameError(t('medication.nameRequired'));
      return;
    }
    const strength = strengthValue.trim() === '' ? null : Number(strengthValue.replace(',', '.'));
    setMedicationPrefillDraft({
      patientProfileId: payload.patientProfileId,
      name: trimmed,
      form,
      strengthValue: strength !== null && Number.isFinite(strength) ? strength : null,
      strengthUnit: strength !== null && Number.isFinite(strength) ? strengthUnit : null,
      brandName: brandName.trim() || null,
      genericName: genericName.trim() || null,
      manufacturer: manufacturer.trim() || null,
      barcode: barcode.trim() || null,
      instructions: instructions.trim() || null,
      expiryDate: expiryDate && isValidLocalDate(expiryDate) ? expiryDate : null,
      imageKey: payload.imageKey,
      identitySource: 'ocr_confirmed_by_user',
    });
    // Only a non-sensitive flow marker crosses the router boundary.
    router.replace('/medication/quick-create?source=capture');
  };

  const exitDraft = (destination: 'manual' | 'back') => {
    clearMedicationDrafts();
    if (destination === 'manual') router.replace('/medication/quick-create');
    else router.back();
  };

  if (!payload) {
    return (
      <SafeAreaView style={{ flex: 1 }}>
        <Screen>
          <Txt variant="h2" weight="bold" accessibilityRole="header">{t('medication.confirmIdentity')}</Txt>
          <Banner tone="warning" title={t('medication.nothingDetected')} />
          <Button label={t('medication.manualEntry')} size="large" onPress={() => exitDraft('manual')} />
          <Button label={t('common.back')} tone="ghost" onPress={() => exitDraft('back')} />
        </Screen>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1 }}>
      <Screen>
        <Txt variant="h2" weight="bold" accessibilityRole="header">{t('medication.confirmIdentity')}</Txt>
        <Banner tone="warning" title={t('medication.aiDisclaimer')} />
        {payload.remainingLines > 0 ? (
          <Banner tone="info" title={t('capture.prescriptionMultiple', { count: formatNumber(payload.remainingLines + 1) })} />
        ) : null}

        <Card>
          <Provenance source={detected.name} />
          <Field label={t('medication.name')} value={name} onChangeText={setName} error={nameError} autoFocus={!name} />
        </Card>

        <Card>
          <Provenance source={detected.form} />
          <Picker label={t('medication.form')} options={formOptions} value={form} onChange={setForm} />
          <Divider />
          <Provenance source={detected.strengthValue} />
          <Field label={t('medication.strengthValue')} value={strengthValue} onChangeText={setStrengthValue} keyboardType="decimal-pad" />
          <Provenance source={detected.strengthUnit} />
          <Picker label={t('medication.strengthUnit')} options={strengthUnitOptions} value={strengthUnit} onChange={setStrengthUnit} />
        </Card>

        {detected.expiryDate ? (
          <Card>
            <Provenance source={detected.expiryDate} />
            <DateField label={t('medication.expiryDate')} value={expiryDate} onChange={setExpiryDate} optional />
          </Card>
        ) : null}

        <Button label={showMore ? t('common.close') : moreLabel} tone="secondary" onPress={() => setShowMore((value) => !value)} />

        {showMore ? (
          <Card>
            <Field label={t('medication.brandName')} value={brandName} onChangeText={setBrandName} />
            <Field label={t('medication.genericName')} value={genericName} onChangeText={setGenericName} />
            <Field label={t('medication.manufacturer')} value={manufacturer} onChangeText={setManufacturer} />
            <Field label={t('medication.barcode')} value={barcode} onChangeText={setBarcode} keyboardType="number-pad" />
            <Field label={t('medication.instructions')} value={instructions} onChangeText={setInstructions} multiline />
          </Card>
        ) : null}

        <Button label={t('common.next')} size="large" onPress={continueToSchedule} />
        <Button label={t('common.cancel')} tone="ghost" onPress={() => exitDraft('back')} />
      </Screen>
    </SafeAreaView>
  );
}

function Provenance({ source }: { source: { value: string; confidence: number } | undefined }) {
  const theme = useTheme();
  const { t, formatNumber } = useI18n();
  if (!source) return null;
  const low = source.confidence < CONFIDENCE_FLOOR;
  const percent = formatNumber(Math.round(source.confidence * 100));
  return (
    <View style={{ gap: theme.spacing.xxs }}>
      <Row wrap gap={theme.spacing.xs}>
        <Badge label={t('medication.detectedByAi')} fg={low ? theme.colors.warning700 : theme.colors.info700} bg={low ? theme.colors.warning100 : theme.colors.ink100} />
        <Badge label={t('medication.confidence', { percent })} fg={low ? theme.colors.warning700 : theme.colors.ink500} bg={low ? theme.colors.warning100 : theme.colors.ink100} />
      </Row>
      {low ? <Txt variant="caption" color={theme.colors.warning700}>{t('medication.lowConfidence')}</Txt> : null}
    </View>
  );
}