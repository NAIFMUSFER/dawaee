import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Modal, Pressable, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Banner, Button, Card, Divider, Field, Loading, Row, Screen, SectionTitle, Txt } from '@/components/ui';
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

/**
 * The manual medication form — create and edit in one screen, because the two
 * differ only in where the values start and where they are sent.
 *
 * Two server-side guards get a real interface here rather than a generic
 * error: a possible duplicate on create, and a high-risk change on edit. Both
 * are advisory — the server states what it noticed, the patient decides, and
 * the retry carries their decision explicitly.
 */

interface DuplicateMatch {
  medicationId: string;
  medicationName: string;
}

interface HighRiskPrompt {
  changes: string[];
  before: { name?: string | null; strengthValue?: number | null };
}

interface Draft {
  name: string;
  brandName: string;
  genericName: string;
  form: MedicationForm;
  strengthValue: string;
  strengthUnit: StrengthUnit;
  manufacturer: string;
  barcode: string;
  instructions: string;
  doctorInstructions: string;
  foodInstruction: FoodInstruction;
  notes: string;
  startDate: string;
  endDate: string;
  expiryDate: string;
}

function emptyDraft(timezone: string | undefined): Draft {
  return {
    name: '', brandName: '', genericName: '', form: 'tablet',
    strengthValue: '', strengthUnit: 'mg', manufacturer: '', barcode: '',
    instructions: '', doctorInstructions: '', foodInstruction: 'no_preference', notes: '',
    startDate: todayLocalDate(timezone), endDate: '', expiryDate: '',
  };
}

function applyPrefill(draft: Draft, raw: string | undefined): Draft {
  if (!raw) return draft;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return draft;
    const source = parsed as Record<string, unknown>;
    const text = (key: string): string | null => (typeof source[key] === 'string' ? source[key] : null);
    return {
      ...draft,
      name: text('name') ?? draft.name,
      brandName: text('brandName') ?? draft.brandName,
      genericName: text('genericName') ?? draft.genericName,
      form: MEDICATION_FORMS.find((f) => f === source.form) ?? draft.form,
      strengthValue: typeof source.strengthValue === 'number' ? String(source.strengthValue) : draft.strengthValue,
      strengthUnit: STRENGTH_UNITS.find((u) => u === source.strengthUnit) ?? draft.strengthUnit,
      manufacturer: text('manufacturer') ?? draft.manufacturer,
      barcode: text('barcode') ?? draft.barcode,
      instructions: text('instructions') ?? draft.instructions,
    };
  } catch {
    return draft;
  }
}

function fromMedication(medication: MedicationView, timezone: string | undefined): Draft {
  return {
    ...emptyDraft(timezone),
    name: medication.name,
    brandName: medication.brandName ?? '',
    genericName: medication.genericName ?? '',
    form: medication.form,
    strengthValue: medication.strengthValue === null ? '' : String(medication.strengthValue),
    strengthUnit: medication.strengthUnit ?? 'mg',
    instructions: medication.instructions ?? '',
    doctorInstructions: medication.doctorInstructions ?? '',
    foodInstruction: medication.foodInstruction,
    notes: medication.notes ?? '',
    startDate: medication.startDate,
    endDate: medication.endDate ?? '',
    expiryDate: medication.expiryDate ?? '',
  };
}

export default function EditMedicationScreen() {
  const params = useLocalSearchParams<{ mode?: string; id?: string; prefill?: string }>();
  const isEdit = params.mode === 'edit' && Boolean(params.id);
  const medicationId = params.id;

  const { t, formatNumber, formatMeasure } = useI18n();
  const theme = useTheme();
  const { activeProfile } = useApp();

  const [draft, setDraft] = useState<Draft>(() =>
    applyPrefill(emptyDraft(activeProfile?.timezone), params.prefill));
  const [loading, setLoading] = useState(isEdit);
  const [saving, setSaving] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [duplicates, setDuplicates] = useState<DuplicateMatch[] | null>(null);
  const [highRisk, setHighRisk] = useState<HighRiskPrompt | null>(null);

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));

  useEffect(() => {
    if (!isEdit || !medicationId) return;
    void (async () => {
      try {
        const res = await api.get<{ medication: MedicationView }>(`/v1/medications/${medicationId}`);
        setDraft(fromMedication(res.medication, activeProfile?.timezone));
      } catch (err) {
        setError(err instanceof NetworkError ? t('notifications.offlineBanner') : t('error.internal_error'));
      } finally {
        setLoading(false);
      }
    })();
  }, [activeProfile?.timezone, isEdit, medicationId, t]);

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

  const describeError = useCallback((err: unknown): string => {
    if (err instanceof NetworkError) return t('notifications.offlineBanner');
    if (err instanceof ApiError) {
      const key = `error.${err.code}` as MessageKey;
      const message = t(key);
      return message === key ? t('error.internal_error') : message;
    }
    return t('error.internal_error');
  }, [t]);

  const body = () => {
    const strength = draft.strengthValue.trim() === '' ? null : Number(draft.strengthValue.replace(',', '.'));
    const valid = strength !== null && Number.isFinite(strength) && strength > 0;
    return {
      name: draft.name.trim(),
      brandName: draft.brandName.trim() || null,
      genericName: draft.genericName.trim() || null,
      form: draft.form,
      strengthValue: valid ? strength : null,
      strengthUnit: valid ? draft.strengthUnit : null,
      manufacturer: draft.manufacturer.trim() || null,
      barcode: draft.barcode.trim() || null,
      instructions: draft.instructions.trim() || null,
      doctorInstructions: draft.doctorInstructions.trim() || null,
      foodInstruction: draft.foodInstruction,
      notes: draft.notes.trim() || null,
      startDate: draft.startDate,
      endDate: draft.endDate && isValidLocalDate(draft.endDate) ? draft.endDate : null,
      expiryDate: draft.expiryDate && isValidLocalDate(draft.expiryDate) ? draft.expiryDate : null,
    };
  };

  const save = async (options: { acknowledgeDuplicate?: boolean; confirmHighRiskChange?: boolean } = {}) => {
    if (!activeProfile) return;
    if (!draft.name.trim()) {
      setNameError(t('medication.nameRequired'));
      return;
    }
    setNameError(null);
    setError(null);
    setSaving(true);

    try {
      if (isEdit && medicationId) {
        await api.patch(`/v1/medications/${medicationId}`, {
          ...body(),
          ...(options.confirmHighRiskChange ? { confirmHighRiskChange: true } : {}),
        });
        setHighRisk(null);
        router.replace(`/medication/${medicationId}`);
        return;
      }

      const created = await api.post<{ medication: MedicationView }>('/v1/medications', {
        patientProfileId: activeProfile.id,
        ...body(),
        identitySource: 'user',
        ...(options.acknowledgeDuplicate ? { acknowledgeDuplicate: true } : {}),
      });
      // A medication with no schedule never reminds anyone, so creating one
      // hands straight over to the schedule builder rather than to the detail.
      router.replace(`/medication/schedule?medicationId=${created.medication.id}&mode=create`);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'duplicate_medication') {
        const meta = err.meta as { duplicates?: DuplicateMatch[] } | undefined;
        setDuplicates(meta?.duplicates ?? []);
      } else if (err instanceof ApiError && err.code === 'high_risk_confirmation_required') {
        const meta = err.meta as HighRiskPrompt | undefined;
        setHighRisk({ changes: meta?.changes ?? [], before: meta?.before ?? {} });
      } else {
        setError(describeError(err));
      }
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <SafeAreaView style={{ flex: 1 }}><Loading /></SafeAreaView>;

  const afterValue = (change: string): string => {
    if (change === 'medication_identity') return draft.name.trim();
    if (change === 'strength') {
      return draft.strengthValue.trim()
        ? formatMeasure(Number(draft.strengthValue.replace(',', '.')), `strengthUnit.${draft.strengthUnit}`)
        : t('common.none');
    }
    return '';
  };

  const beforeValue = (change: string): string => {
    if (change === 'medication_identity') return highRisk?.before.name ?? t('common.none');
    if (change === 'strength') {
      const value = highRisk?.before.strengthValue;
      return value === null || value === undefined ? t('common.none') : formatNumber(value);
    }
    return '';
  };

  return (
    <SafeAreaView style={{ flex: 1 }}>
      <Screen>
        <Txt variant="h2" weight="bold" accessibilityRole="header">
          {isEdit ? t('medication.editTitle') : t('medication.createTitle')}
        </Txt>

        {error ? <Banner tone="danger" title={error} /> : null}

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
                  onPress={() => void save({ acknowledgeDuplicate: true })}
                />
              </View>
            }
          />
        ) : null}

        <Card>
          <Field
            label={t('medication.name')}
            value={draft.name}
            onChangeText={(value) => set('name', value)}
            error={nameError}
            autoFocus={!isEdit && !draft.name}
          />
          <Divider />
          <Field label={t('medication.brandName')} value={draft.brandName} onChangeText={(v) => set('brandName', v)} />
          <Field label={t('medication.genericName')} value={draft.genericName} onChangeText={(v) => set('genericName', v)} />
        </Card>

        <Card>
          <Picker label={t('medication.form')} options={formOptions} value={draft.form} onChange={(v) => set('form', v)} />
          <Divider />
          <Field
            label={t('medication.strengthValue')}
            value={draft.strengthValue}
            onChangeText={(v) => set('strengthValue', v)}
            keyboardType="decimal-pad"
          />
          <Picker
            label={t('medication.strengthUnit')}
            options={strengthUnitOptions}
            value={draft.strengthUnit}
            onChange={(v) => set('strengthUnit', v)}
          />
        </Card>

        <Card>
          <Field label={t('medication.manufacturer')} value={draft.manufacturer} onChangeText={(v) => set('manufacturer', v)} />
          <Field
            label={t('medication.barcode')}
            value={draft.barcode}
            onChangeText={(v) => set('barcode', v)}
            keyboardType="number-pad"
          />
        </Card>

        <SectionTitle>{t('medication.instructions')}</SectionTitle>
        <Card>
          <Field
            label={t('medication.instructions')}
            value={draft.instructions}
            onChangeText={(v) => set('instructions', v)}
            multiline
          />
          <Field
            label={t('medication.doctorInstructions')}
            value={draft.doctorInstructions}
            onChangeText={(v) => set('doctorInstructions', v)}
            multiline
          />
          <Divider />
          <Picker
            label={t('medication.foodInstruction')}
            options={foodOptions}
            value={draft.foodInstruction}
            onChange={(v) => set('foodInstruction', v)}
          />
          <Field label={t('medication.notes')} value={draft.notes} onChangeText={(v) => set('notes', v)} multiline />
        </Card>

        <Card>
          <DateField label={t('schedule.startDate')} value={draft.startDate} onChange={(v) => set('startDate', v)} />
          <DateField label={t('schedule.endDate')} value={draft.endDate} onChange={(v) => set('endDate', v)} optional />
          <DateField label={t('medication.expiryDate')} value={draft.expiryDate} onChange={(v) => set('expiryDate', v)} optional />
        </Card>

        <Button
          label={t('common.save')}
          size="large"
          loading={saving}
          onPress={() => void save()}
          testID="save-medication"
        />
        <Button label={t('common.cancel')} tone="ghost" onPress={() => router.back()} />
      </Screen>

      {highRisk ? (
        <Modal transparent animationType="fade" visible onRequestClose={() => setHighRisk(null)}>
          <Pressable
            onPress={() => setHighRisk(null)}
            accessibilityLabel={t('common.close')}
            style={{ flex: 1, backgroundColor: theme.colors.overlay, justifyContent: 'center', padding: theme.spacing.lg }}
          >
            <Pressable
              onPress={(event) => event.stopPropagation()}
              style={{
                backgroundColor: theme.colors.surface,
                borderRadius: theme.radius.xl,
                padding: theme.spacing.lg,
                gap: theme.spacing.md,
              }}
            >
              <Txt variant="h3" weight="bold" accessibilityRole="header">{t('medication.highRiskTitle')}</Txt>
              {highRisk.changes.map((change) => (
                <View key={change} style={{ gap: theme.spacing.xxs }}>
                  <Txt variant="bodyLarge" weight="bold">{t(`medication.change.${change}` as MessageKey)}</Txt>
                  <Txt variant="body" color={theme.colors.ink700}>
                    {t('medication.changeFromTo', { from: beforeValue(change), to: afterValue(change) })}
                  </Txt>
                </View>
              ))}
              <Row gap={theme.spacing.md}>
                <View style={{ flex: 1 }}>
                  <Button label={t('common.cancel')} tone="secondary" onPress={() => setHighRisk(null)} />
                </View>
                <View style={{ flex: 1 }}>
                  <Button
                    label={t('medication.confirmChange')}
                    tone="danger"
                    loading={saving}
                    onPress={() => void save({ confirmHighRiskChange: true })}
                  />
                </View>
              </Row>
            </Pressable>
          </Pressable>
        </Modal>
      ) : null}
    </SafeAreaView>
  );
}
