import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  Banner, Button, Card, Divider, EmptyState, Field, Loading, Row, SafetyNote, SectionTitle, Txt,
} from '@/components/ui';
import { useI18n } from '@/i18n';
import { useTheme } from '@/hooks/useTheme';
import { profileScopeKey } from '@/hooks/useRequestScope';
import { useApp } from '@/state/app-store';
import { api, ApiError, NetworkError } from '@/api/client';
import { SYMPTOM_TAGS, errorMessageKey, type MessageKey, type SymptomTag } from '@dawaee/shared';

/**
 * Post-dose notes and optional measurements.
 *
 * The hard rule on this screen is what it does NOT do: nothing here evaluates a
 * value. A blood pressure of 180/110 renders exactly like 118/76 — same type,
 * same weight, no colour, no badge, no ordering by severity. The app records
 * what the patient wrote and hands it back unchanged; judging it is a
 * clinician's job, and pretending otherwise would be the most dangerous feature
 * in the product.
 */

const MEASUREMENT_TYPES = ['blood_pressure', 'blood_glucose', 'weight', 'temperature'] as const;
type MeasurementType = (typeof MEASUREMENT_TYPES)[number];

const UNIT_OPTIONS: Record<MeasurementType, ReadonlyArray<{ value: string; labelKey: MessageKey }>> = {
  blood_pressure: [{ value: 'mmHg', labelKey: 'unit.mmHg' }],
  blood_glucose: [{ value: 'mmol/L', labelKey: 'unit.mmol_l' }, { value: 'mg/dL', labelKey: 'unit.mg_dl' }],
  weight: [{ value: 'kg', labelKey: 'unit.kg' }],
  temperature: [{ value: 'C', labelKey: 'unit.celsius' }],
};

const ALL_UNITS = Object.values(UNIT_OPTIONS).flat();

interface NoteRow {
  id: string;
  tags: SymptomTag[];
  text: string | null;
  recordedAt: string;
  doseOccurrenceId: string | null;
  medicationName: string | null;
}

interface MeasurementRow {
  id: string;
  type: string;
  valuePrimary: number;
  valueSecondary: number | null;
  unit: string;
  measuredAt: string;
  doseOccurrenceId: string | null;
  note: string | null;
}

function parseNumber(raw: string): number | null {
  const value = Number(raw.trim().replace(',', '.'));
  return raw.trim().length > 0 && Number.isFinite(value) ? value : null;
}

export default function NotesScreen() {
  const { user, activeProfile } = useApp();
  return <NotesProfileScreen key={profileScopeKey(user?.id, activeProfile)} />;
}

function NotesProfileScreen() {
  const { t, formatDate, formatTime, formatNumber } = useI18n();
  const theme = useTheme();
  const { activeProfile, offline, setOffline } = useApp();
  const timezone = activeProfile?.timezone ?? 'UTC';

  const [notes, setNotes] = useState<NoteRow[]>([]);
  const [measurements, setMeasurements] = useState<MeasurementRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [tags, setTags] = useState<SymptomTag[]>([]);
  const [noteText, setNoteText] = useState('');
  const [noteError, setNoteError] = useState<string | null>(null);
  const [savingNote, setSavingNote] = useState(false);

  const [type, setType] = useState<MeasurementType>('blood_pressure');
  const [unit, setUnit] = useState<string>('mmHg');
  const [primary, setPrimary] = useState('');
  const [secondary, setSecondary] = useState('');
  const [measurementError, setMeasurementError] = useState<string | null>(null);
  const [savingMeasurement, setSavingMeasurement] = useState(false);

  const describeError = useCallback((err: unknown): string => {
    if (err instanceof ApiError) {
      const key = errorMessageKey(err.code);
      return key ? t(key) : err.message;
    }
    return t('error.internal_error');
  }, [t]);

  const load = useCallback(async () => {
    if (!activeProfile) return;
    setError(null);
    try {
      const [noteRes, measurementRes] = await Promise.all([
        api.get<{ notes: NoteRow[] }>('/v1/notes', { profileId: activeProfile.id }),
        api.get<{ measurements: MeasurementRow[] }>('/v1/measurements', { profileId: activeProfile.id }),
      ]);
      setNotes(noteRes.notes);
      setMeasurements(measurementRes.measurements);
      setOffline(false);
    } catch (err) {
      if (err instanceof NetworkError) setOffline(true);
      else setError(describeError(err));
    } finally {
      setLoading(false);
    }
  }, [activeProfile, describeError, setOffline]);

  useEffect(() => { setLoading(true); void load(); }, [load]);

  const selectType = useCallback((next: MeasurementType) => {
    setType(next);
    setUnit(UNIT_OPTIONS[next][0]?.value ?? '');
    setSecondary('');
    setMeasurementError(null);
  }, []);

  const toggleTag = useCallback((tag: SymptomTag) => {
    setNoteError(null);
    setTags((current) => (current.includes(tag) ? current.filter((x) => x !== tag) : [...current, tag].slice(0, 8)));
  }, []);

  const saveNote = useCallback(async () => {
    if (!activeProfile) return;
    const text = noteText.trim();
    if (tags.length === 0 && text.length === 0) {
      setNoteError(t('notes.needContent'));
      return;
    }
    setSavingNote(true);
    setNoteError(null);
    try {
      await api.post('/v1/notes', { profileId: activeProfile.id, tags, text: text.length > 0 ? text : null });
      setTags([]);
      setNoteText('');
      await load();
    } catch (err) {
      setNoteError(err instanceof NetworkError ? t('notifications.offlineBanner') : describeError(err));
    } finally {
      setSavingNote(false);
    }
  }, [activeProfile, noteText, tags, t, load, describeError]);

  const saveMeasurement = useCallback(async () => {
    if (!activeProfile) return;
    const valuePrimary = parseNumber(primary);
    const valueSecondary = type === 'blood_pressure' ? parseNumber(secondary) : null;
    if (valuePrimary === null || (type === 'blood_pressure' && valueSecondary === null)) {
      setMeasurementError(t('measurements.invalidValue'));
      return;
    }
    setSavingMeasurement(true);
    setMeasurementError(null);
    try {
      await api.post(
        '/v1/measurements',
        { type, valuePrimary, valueSecondary, unit },
        { profileId: activeProfile.id },
      );
      setPrimary('');
      setSecondary('');
      await load();
    } catch (err) {
      setMeasurementError(err instanceof NetworkError ? t('notifications.offlineBanner') : describeError(err));
    } finally {
      setSavingMeasurement(false);
    }
  }, [activeProfile, primary, secondary, type, unit, t, load, describeError]);

  const unitLabel = useCallback(
    (stored: string) => {
      const match = ALL_UNITS.find((option) => option.value === stored);
      return match ? t(match.labelKey) : stored;
    },
    [t],
  );

  const measurementTypeLabel = useCallback(
    (stored: string) => {
      const known = MEASUREMENT_TYPES.find((value) => value === stored);
      return known ? t(`measurement.${known}` as MessageKey) : stored;
    },
    [t],
  );

  const stamp = useCallback(
    (iso: string) => `${formatDate(iso, timezone)} · ${formatTime(iso, timezone)}`,
    [formatDate, formatTime, timezone],
  );

  const orderedMeasurements = useMemo(
    () => [...measurements].sort((a, b) => b.measuredAt.localeCompare(a.measuredAt)),
    [measurements],
  );

  const unitChoices = UNIT_OPTIONS[type];

  if (!activeProfile) {
    return (
      <SafeAreaView style={{ flex: 1 }}>
        <EmptyState title={t('notes.hubTitle')} body={t('error.not_found')} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1 }}>
      <ScrollView
        style={{ flex: 1, backgroundColor: theme.colors.background }}
        contentContainerStyle={{ padding: theme.spacing.lg, gap: theme.spacing.md, paddingBottom: theme.spacing.xxxl }}
        keyboardShouldPersistTaps="handled"
      >
        <Row style={{ justifyContent: 'space-between' }} gap={theme.spacing.sm}>
          <Txt variant="h2" weight="bold" accessibilityRole="header" style={{ flex: 1 }}>{t('notes.hubTitle')}</Txt>
          <Button label={t('common.back')} tone="ghost" fullWidth={false} onPress={() => router.back()} />
        </Row>

        {offline ? <Banner tone="warning" title={t('notifications.offlineBanner')} /> : null}
        {error ? (
          <Banner
            tone="danger"
            title={error}
            action={<Button label={t('common.retry')} tone="ghost" fullWidth={false} onPress={() => { setLoading(true); void load(); }} />}
          />
        ) : null}

        {/* ------------------------------------------------------ notes */}
        <SectionTitle>{t('notes.title')}</SectionTitle>
        <Banner tone="info" title={t('notes.interpretationNotice')} />

        <Card style={{ gap: theme.spacing.md }}>
          <Txt variant="bodyLarge" weight="bold" accessibilityRole="header">{t('notes.compose')}</Txt>
          <Txt variant="bodySmall" color={theme.colors.ink700}>{t('notes.tagsLabel')}</Txt>
          <Row wrap gap={theme.spacing.sm}>
            {SYMPTOM_TAGS.map((tag) => (
              <Chip
                key={tag}
                label={t(`symptom.${tag}` as MessageKey)}
                selected={tags.includes(tag)}
                onPress={() => toggleTag(tag)}
              />
            ))}
          </Row>
          <Field
            label={t('notes.textLabel')}
            value={noteText}
            onChangeText={(value) => { setNoteText(value); setNoteError(null); }}
            hint={t('common.optional')}
            maxLength={2000}
            multiline
            error={noteError}
          />
          <Button label={t('notes.save')} onPress={() => void saveNote()} loading={savingNote} />
        </Card>

        {loading ? (
          <Loading label={t('common.loading')} />
        ) : notes.length === 0 ? (
          <EmptyState title={t('notes.empty')} />
        ) : (
          notes.map((note) => (
            <Card key={note.id} style={{ gap: theme.spacing.xs }}>
              <Txt variant="caption" color={theme.colors.ink500}>{stamp(note.recordedAt)}</Txt>
              {note.medicationName ? (
                <Txt variant="bodySmall" color={theme.colors.ink700}>
                  {t('notes.withMedication', { medication: note.medicationName })}
                </Txt>
              ) : null}
              {note.tags.length > 0 ? (
                <Row wrap gap={theme.spacing.xs}>
                  {note.tags.map((tag) => (
                    <View
                      key={tag}
                      style={{
                        backgroundColor: theme.colors.surfaceAlt,
                        borderRadius: theme.radius.pill,
                        borderWidth: theme.hairline,
                        borderColor: theme.colors.ink100,
                        paddingHorizontal: theme.spacing.md,
                        paddingVertical: theme.spacing.xs,
                      }}
                    >
                      <Txt variant="caption" color={theme.colors.ink700}>{t(`symptom.${tag}` as MessageKey)}</Txt>
                    </View>
                  ))}
                </Row>
              ) : null}
              {note.text ? <Txt variant="body">{note.text}</Txt> : null}
            </Card>
          ))
        )}

        <Divider />

        {/* ----------------------------------------------- measurements */}
        <SectionTitle>{t('measurements.title')}</SectionTitle>
        <Banner tone="info" title={t('measurements.interpretationNotice')} />

        <Card style={{ gap: theme.spacing.md }}>
          <Txt variant="bodyLarge" weight="bold" accessibilityRole="header">{t('measurements.compose')}</Txt>
          <Txt variant="bodySmall" color={theme.colors.ink700}>{t('measurements.typeLabel')}</Txt>
          <Row wrap gap={theme.spacing.sm}>
            {MEASUREMENT_TYPES.map((value) => (
              <Chip
                key={value}
                label={t(`measurement.${value}` as MessageKey)}
                selected={type === value}
                onPress={() => selectType(value)}
              />
            ))}
          </Row>

          {type === 'blood_pressure' ? (
            <>
              <Field
                label={t('measurements.systolic')}
                value={primary}
                onChangeText={(value) => { setPrimary(value); setMeasurementError(null); }}
                keyboardType="decimal-pad"
                maxLength={6}
              />
              <Field
                label={t('measurements.diastolic')}
                value={secondary}
                onChangeText={(value) => { setSecondary(value); setMeasurementError(null); }}
                keyboardType="decimal-pad"
                maxLength={6}
                error={measurementError}
              />
            </>
          ) : (
            <Field
              label={t('measurements.valueLabel')}
              value={primary}
              onChangeText={(value) => { setPrimary(value); setMeasurementError(null); }}
              keyboardType="decimal-pad"
              maxLength={8}
              error={measurementError}
            />
          )}

          {unitChoices.length > 1 ? (
            <>
              <Txt variant="bodySmall" color={theme.colors.ink700}>{t('measurements.unitLabel')}</Txt>
              <Row wrap gap={theme.spacing.sm}>
                {unitChoices.map((choice) => (
                  <Chip
                    key={choice.value}
                    label={t(choice.labelKey)}
                    selected={unit === choice.value}
                    onPress={() => setUnit(choice.value)}
                  />
                ))}
              </Row>
            </>
          ) : null}

          <Button label={t('measurements.save')} onPress={() => void saveMeasurement()} loading={savingMeasurement} />
        </Card>

        {loading ? (
          <Loading />
        ) : orderedMeasurements.length === 0 ? (
          <EmptyState title={t('measurements.empty')} />
        ) : (
          orderedMeasurements.map((measurement) => (
            <Card key={measurement.id} style={{ gap: theme.spacing.xs }}>
              <Txt variant="caption" color={theme.colors.ink500}>{stamp(measurement.measuredAt)}</Txt>
              <Txt variant="bodySmall" weight="medium" color={theme.colors.ink700}>
                {measurementTypeLabel(measurement.type)}
              </Txt>
              {measurement.valueSecondary === null ? (
                <Row gap={theme.spacing.xs} align="baseline">
                  <Txt variant="h3" weight="bold">{formatNumber(measurement.valuePrimary)}</Txt>
                  <Txt variant="bodySmall" color={theme.colors.ink500}>{unitLabel(measurement.unit)}</Txt>
                </Row>
              ) : (
                <Row wrap gap={theme.spacing.lg}>
                  <ValuePart
                    label={t('measurements.systolic')}
                    value={formatNumber(measurement.valuePrimary)}
                    unit={unitLabel(measurement.unit)}
                  />
                  <ValuePart
                    label={t('measurements.diastolic')}
                    value={formatNumber(measurement.valueSecondary)}
                    unit={unitLabel(measurement.unit)}
                  />
                </Row>
              )}
              {measurement.note ? <Txt variant="bodySmall">{measurement.note}</Txt> : null}
            </Card>
          ))
        )}

        <SafetyNote textKey="safety.notMedicalAdvice" />
      </ScrollView>
    </SafeAreaView>
  );
}

function ValuePart({ label, value, unit }: { label: string; value: string; unit: string }) {
  const theme = useTheme();
  return (
    <View accessible accessibilityLabel={`${label}: ${value} ${unit}`} style={{ gap: 2 }}>
      <Txt variant="caption" color={theme.colors.ink500}>{label}</Txt>
      <Row gap={theme.spacing.xs} align="baseline">
        <Txt variant="h3" weight="bold">{value}</Txt>
        <Txt variant="bodySmall" color={theme.colors.ink500}>{unit}</Txt>
      </Row>
    </View>
  );
}

function Chip({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  const theme = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected }}
      style={({ pressed }) => [
        {
          minHeight: Math.max(44, theme.touch - 8),
          paddingHorizontal: theme.spacing.md,
          justifyContent: 'center',
          borderRadius: theme.radius.pill,
          borderWidth: 2,
          borderColor: selected ? theme.colors.primary700 : theme.colors.ink200,
          backgroundColor: selected ? theme.colors.primary100 : theme.colors.surface,
        },
        pressed && { opacity: 0.85 },
      ]}
    >
      <Txt
        variant="bodySmall"
        weight={selected ? 'bold' : 'regular'}
        color={selected ? theme.colors.primary700 : theme.colors.ink700}
        numberOfLines={1}
      >
        {label}
      </Txt>
    </Pressable>
  );
}
