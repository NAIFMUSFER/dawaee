import React, { useMemo, useState } from 'react';
import { View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Badge, Banner, Button, Card, Divider, Field, Row, SafetyNote, Screen, SectionTitle, Txt } from '@/components/ui';
import { Picker } from '@/components/Picker';
import { DateField, isValidLocalDate, todayLocalDate } from '@/components/DateField';
import { useI18n } from '@/i18n';
import { useTheme } from '@/hooks/useTheme';
import { useApp } from '@/state/app-store';
import { api, ApiError, NetworkError } from '@/api/client';
import type { MedicationView } from '@/api/types';
import {
  FOOD_INSTRUCTIONS, MEDICATION_FORMS, STRENGTH_UNITS,
  type FoodInstruction, type MedicationForm, type MessageKey, type StrengthUnit,
} from '@dawaee/shared';
import type { ConfirmPayload } from './capture';

/**
 * Confirm what the analysis read.
 *
 * This is the safety gate of the whole capture flow. Every value on this
 * screen is a *suggestion*: it arrives pre-filled but editable, it is labelled
 * with where it came from and how sure the reader was, and nothing is written
 * to the server until the user presses confirm. A field the model was unsure
 * about is called out rather than quietly accepted — a wrong strength read off
 * a blurry box is exactly the failure this screen exists to catch.
 */

/** Below this the reading is shown in a warning tone and called out in words. */
const CONFIDENCE_FLOOR = 0.75;

interface DuplicateMatch {
  medicationId: string;
  medicationName: string;
  score: number;
}

function parsePayload(raw: string | undefined): ConfirmPayload | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const candidate = parsed as Partial<ConfirmPayload>;
    if (typeof candidate.imageKey !== 'string' || typeof candidate.detected !== 'object' || !candidate.detected) {
      return null;
    }
    return {
      imageKey: candidate.imageKey,
      kind: candidate.kind === 'prescription' ? 'prescription' : 'medication_label',
      detected: candidate.detected,
      rawText: typeof candidate.rawText === 'string' ? candidate.rawText : '',
      remainingLines: typeof candidate.remainingLines === 'number' ? candidate.remainingLines : 0,
    };
  } catch {
    return null;
  }
}

/** Only accepts a reading that is already a valid wire value for the enum. */
function asEnum<T extends string>(allowed: readonly T[], value: string | undefined): T | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  return allowed.find((option) => option === normalized) ?? null;
}

export default function ConfirmMedicationScreen() {
  const params = useLocalSearchParams<{ data?: string }>();
  const payload = useMemo(() => parsePayload(params.data), [params.data]);

  const { t, formatNumber } = useI18n();
  const theme = useTheme();
  const { activeProfile } = useApp();

  const detected = payload?.detected ?? {};
  const reading = (key: string): string => detected[key]?.value ?? '';

  const [name, setName] = useState(reading('name'));
  const [brandName, setBrandName] = useState(reading('brandName'));
  const [genericName, setGenericName] = useState(reading('genericName'));
  const [form, setForm] = useState<MedicationForm>(asEnum(MEDICATION_FORMS, reading('form')) ?? 'tablet');
  const [strengthValue, setStrengthValue] = useState(reading('strengthValue'));
  const [strengthUnit, setStrengthUnit] = useState<StrengthUnit>(asEnum(STRENGTH_UNITS, reading('strengthUnit')) ?? 'mg');
  const [manufacturer, setManufacturer] = useState(reading('manufacturer'));
  const [barcode, setBarcode] = useState(reading('barcode'));
  const [expiryDate, setExpiryDate] = useState(
    isValidLocalDate(reading('expiryDate')) ? reading('expiryDate') : '',
  );
  const [instructions, setInstructions] = useState(reading('instructions'));
  const [foodInstruction, setFoodInstruction] = useState<FoodInstruction>('no_preference');

  const [duplicates, setDuplicates] = useState<DuplicateMatch[] | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const formOptions = useMemo(
    () => MEDICATION_FORMS.map((value) => ({ value, label: t(`form.${value}` as MessageKey) })),
    [t],
  );
  const strengthUnitOptions = useMemo(
    () => STRENGTH_UNITS.map((value) => ({ value, label: t(`strengthUnit.${value}` as MessageKey) })),
    [t],
  );
  const foodOptions = useMemo(
    () => FOOD_INSTRUCTIONS.map((value) => ({
      value,
      label: value === 'no_preference' ? t('food.noPreference') : t(`food.${value}` as MessageKey),
    })),
    [t],
  );

  const save = async (acknowledgeDuplicate: boolean) => {
    if (!activeProfile) return;
    const trimmed = name.trim();
    if (!trimmed) {
      setNameError(t('medication.nameRequired'));
      return;
    }
    setNameError(null);
    setError(null);
    setSaving(true);

    const strength = strengthValue.trim() === '' ? null : Number(strengthValue.replace(',', '.'));

    try {
      if (!acknowledgeDuplicate) {
        const check = await api.post<{ duplicates: DuplicateMatch[]; hasDuplicates: boolean }>(
          '/v1/medications/check-duplicate',
          {
            patientProfileId: activeProfile.id,
            name: trimmed,
            strengthValue: strength,
            strengthUnit: strength === null ? null : strengthUnit,
            barcode: barcode.trim() || null,
          },
        );
        if (check.hasDuplicates) {
          setDuplicates(check.duplicates);
          setSaving(false);
          return;
        }
      }

      const created = await api.post<{ medication: MedicationView }>('/v1/medications', {
        patientProfileId: activeProfile.id,
        name: trimmed,
        brandName: brandName.trim() || null,
        genericName: genericName.trim() || null,
        form,
        strengthValue: strength !== null && Number.isFinite(strength) ? strength : null,
        strengthUnit: strength !== null && Number.isFinite(strength) ? strengthUnit : null,
        manufacturer: manufacturer.trim() || null,
        barcode: barcode.trim() || null,
        imageKey: payload?.imageKey ?? null,
        instructions: instructions.trim() || null,
        foodInstruction,
        startDate: todayLocalDate(activeProfile.timezone),
        expiryDate: expiryDate && isValidLocalDate(expiryDate) ? expiryDate : null,
        // The user has just read every value back, so the record is theirs —
        // the model's output was only ever a draft.
        identitySource: 'ocr_confirmed_by_user',
        ...(acknowledgeDuplicate ? { acknowledgeDuplicate: true } : {}),
      });

      router.replace(`/medication/schedule?medicationId=${created.medication.id}&mode=create`);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'duplicate_medication') {
        const meta = err.meta as { duplicates?: DuplicateMatch[] } | undefined;
        setDuplicates(meta?.duplicates ?? []);
      } else if (err instanceof NetworkError) {
        setError(t('notifications.offlineBanner'));
      } else if (err instanceof ApiError) {
        const key = `error.${err.code}` as MessageKey;
        const message = t(key);
        setError(message === key ? t('error.internal_error') : message);
      } else {
        setError(t('error.internal_error'));
      }
    } finally {
      setSaving(false);
    }
  };

  if (!payload) {
    return (
      <SafeAreaView style={{ flex: 1 }}>
        <Screen>
          <Txt variant="h2" weight="bold" accessibilityRole="header">{t('medication.confirmIdentity')}</Txt>
          <Banner tone="warning" title={t('medication.nothingDetected')} />
          <Button
            label={t('medication.manualEntry')}
            size="large"
            onPress={() => router.replace('/medication/edit?mode=create')}
          />
          <Button label={t('common.back')} tone="ghost" onPress={() => router.back()} />
        </Screen>
      </SafeAreaView>
    );
  }

  const nothingDetected = Object.keys(detected).length === 0;

  return (
    <SafeAreaView style={{ flex: 1 }}>
      <Screen>
        <Txt variant="h2" weight="bold" accessibilityRole="header">{t('medication.confirmIdentity')}</Txt>

        <Banner tone="warning" title={t('medication.aiDisclaimer')} />

        {nothingDetected ? <Banner tone="info" title={t('medication.nothingDetected')} /> : null}

        {payload.remainingLines > 0 ? (
          <Banner
            tone="info"
            title={t('capture.prescriptionMultiple', { count: formatNumber(payload.remainingLines + 1) })}
          />
        ) : null}

        {duplicates ? (
          <Banner
            tone="warning"
            title={t('medication.duplicateTitle')}
            body={t('medication.duplicateWarning')}
            action={
              <View style={{ gap: theme.spacing.sm, marginTop: theme.spacing.sm }}>
                {duplicates.map((duplicate) => (
                  <Button
                    key={duplicate.medicationId}
                    label={`${t('medication.viewExisting')} · ${duplicate.medicationName}`}
                    tone="secondary"
                    onPress={() => router.replace(`/medication/${duplicate.medicationId}`)}
                  />
                ))}
                <Button
                  label={t('medication.addAnyway')}
                  tone="danger"
                  loading={saving}
                  onPress={() => { setAcknowledged(true); void save(true); }}
                />
              </View>
            }
          />
        ) : null}

        {error ? <Banner tone="danger" title={error} /> : null}

        <Card>
          <Provenance source={detected.name} />
          <Field
            label={t('medication.name')}
            value={name}
            onChangeText={setName}
            error={nameError}
            autoFocus={!name}
          />
        </Card>

        <Card>
          <Provenance source={detected.brandName} />
          <Field label={t('medication.brandName')} value={brandName} onChangeText={setBrandName} />
          <Divider />
          <Provenance source={detected.genericName} />
          <Field label={t('medication.genericName')} value={genericName} onChangeText={setGenericName} />
        </Card>

        <Card>
          <Provenance source={detected.form} />
          <Picker label={t('medication.form')} options={formOptions} value={form} onChange={setForm} />
        </Card>

        <Card>
          <Provenance source={detected.strengthValue} />
          <Field
            label={t('medication.strengthValue')}
            value={strengthValue}
            onChangeText={setStrengthValue}
            keyboardType="decimal-pad"
          />
          <Provenance source={detected.strengthUnit} />
          <Picker
            label={t('medication.strengthUnit')}
            options={strengthUnitOptions}
            value={strengthUnit}
            onChange={setStrengthUnit}
          />
        </Card>

        <Card>
          <Provenance source={detected.manufacturer} />
          <Field label={t('medication.manufacturer')} value={manufacturer} onChangeText={setManufacturer} />
          <Divider />
          <Provenance source={detected.barcode} />
          <Field label={t('medication.barcode')} value={barcode} onChangeText={setBarcode} keyboardType="number-pad" />
        </Card>

        <Card>
          <Provenance source={detected.expiryDate} />
          <DateField label={t('medication.expiryDate')} value={expiryDate} onChange={setExpiryDate} optional />
        </Card>

        <Card>
          <Provenance source={detected.instructions} />
          <Field label={t('medication.instructions')} value={instructions} onChangeText={setInstructions} multiline />
          <Divider />
          <Picker
            label={t('medication.foodInstruction')}
            options={foodOptions}
            value={foodInstruction}
            onChange={setFoodInstruction}
          />
        </Card>

        {payload.rawText ? (
          <>
            <SectionTitle>{t('medication.rawText')}</SectionTitle>
            <Card>
              <Txt variant="bodySmall" color={theme.colors.ink500}>{payload.rawText}</Txt>
            </Card>
          </>
        ) : null}

        <Button
          label={t('medication.confirmSave')}
          size="large"
          loading={saving}
          onPress={() => void save(acknowledged)}
          testID="confirm-medication"
        />
        <Button label={t('common.cancel')} tone="ghost" onPress={() => router.back()} />

        <SafetyNote textKey="safety.notMedicalAdvice" />
      </Screen>
    </SafeAreaView>
  );
}

/**
 * The provenance label the brief requires on every machine-read value: what
 * produced it and how sure the reader was. A low reading is given a warning
 * tone *and* a sentence, because colour alone must never carry a status.
 */
function Provenance({ source }: { source: { value: string; confidence: number } | undefined }) {
  const theme = useTheme();
  const { t, formatNumber } = useI18n();
  if (!source) return null;

  const low = source.confidence < CONFIDENCE_FLOOR;
  const percent = formatNumber(Math.round(source.confidence * 100));
  return (
    <View style={{ gap: theme.spacing.xxs }}>
      <Row wrap gap={theme.spacing.xs}>
        <Badge
          label={t('medication.detectedByAi')}
          fg={low ? theme.colors.warning700 : theme.colors.info700}
          bg={low ? theme.colors.warning100 : theme.colors.info100}
        />
        <Badge
          label={t('medication.confidence', { percent })}
          fg={low ? theme.colors.warning700 : theme.colors.ink700}
          bg={low ? theme.colors.warning100 : theme.colors.ink100}
        />
      </Row>
      {low ? (
        <Txt variant="caption" weight="medium" color={theme.colors.warning700}>{t('medication.lowConfidence')}</Txt>
      ) : null}
    </View>
  );
}
