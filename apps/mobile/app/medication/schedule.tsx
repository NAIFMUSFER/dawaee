import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Modal, Pressable, View } from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Banner, Button, Card, Divider, Field, Loading, Row, Screen, SectionTitle, Txt } from '@/components/ui';
import { MultiPicker, Picker } from '@/components/Picker';
import { DateField, isValidLocalDate, todayLocalDate } from '@/components/DateField';
import { useI18n } from '@/i18n';
import { useTheme } from '@/hooks/useTheme';
import { profileScopeKey, useRequestScope } from '@/hooks/useRequestScope';
import { useApp } from '@/state/app-store';
import { api, ApiError, NetworkError } from '@/api/client';
import type { MedicationScheduleView } from '@/api/types';
import {
  getMedicationScheduleRouteIntent,
  setMedicationDetailRouteIntent,
} from '@/navigation/private-navigation';
import {
  DOSE_UNITS, SCHEDULE_RULE_KINDS,
  type DoseUnit, type MessageKey, type ScheduleRule, type ScheduleRuleKind,
} from '@dawaee/shared';

/**
 * The schedule builder.
 *
 * All five rule kinds are edited in one place because they are one decision —
 * "when does this get taken" — and splitting them across screens makes
 * switching from "twice a day" to "every 8 hours" feel like starting over.
 *
 * The plain-language preview is the point of the screen: a rule the patient
 * cannot read back in a sentence is a rule they cannot check, and this is the
 * step where a mistake turns into a missed or doubled dose.
 */

const TIME_EXAMPLE = '08:00';

/** Sunday-first, matching the weekday numbering the rule schema uses. */
const WEEKDAY_ANCHORS = [
  '2024-01-07', '2024-01-08', '2024-01-09', '2024-01-10', '2024-01-11', '2024-01-12', '2024-01-13',
] as const;

function maskTime(raw: string): string {
  const digits = raw.replace(/\D/g, '').slice(0, 4);
  if (digits.length <= 2) return digits;
  return `${digits.slice(0, 2)}:${digits.slice(2)}`;
}

function isValidTime(value: string): boolean {
  if (!/^\d{2}:\d{2}$/.test(value)) return false;
  const hours = Number(value.slice(0, 2));
  const minutes = Number(value.slice(3, 5));
  return hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59;
}

interface HighRiskPrompt {
  changes: string[];
  before: { doseQuantity?: number; doseUnit?: string; rule?: ScheduleRule };
}

export default function ScheduleScreen() {
  const { user, activeProfile } = useApp();
  const intent = user && activeProfile
    ? getMedicationScheduleRouteIntent(user.id, activeProfile.id)
    : null;
  const medicationId = intent?.medicationId;
  const mode = intent?.mode ?? 'create';
  const scheduleId = intent?.scheduleId;

  const key = `${profileScopeKey(user?.id, activeProfile)}:${medicationId ?? 'none'}:${scheduleId ?? 'new'}:${mode}`;
  return <ScheduleProfileScreen key={key} medicationId={medicationId} mode={mode} selectedScheduleId={scheduleId} />;
}

function ScheduleProfileScreen({
  medicationId,
  mode,
  selectedScheduleId,
}: {
  medicationId?: string;
  mode: 'create' | 'edit';
  selectedScheduleId?: string;
}) {
  const isEdit = mode === 'edit';

  const { t, formatNumber, formatWeekday, isRtl } = useI18n();
  const theme = useTheme();
  const { activeProfile, user } = useApp();
  const { capture: captureSave } = useRequestScope();

  const [kind, setKind] = useState<ScheduleRuleKind>('fixed_times');
  const [times, setTimes] = useState<string[]>([TIME_EXAMPLE]);
  const [everyHours, setEveryHours] = useState('8');
  const [anchorTime, setAnchorTime] = useState(TIME_EXAMPLE);
  const [activeFrom, setActiveFrom] = useState('');
  const [activeUntil, setActiveUntil] = useState('');
  const [weekdays, setWeekdays] = useState<string[]>(['0']);
  const [daysOn, setDaysOn] = useState('21');
  const [daysOff, setDaysOff] = useState('7');
  const [cycleAnchorDate, setCycleAnchorDate] = useState(() => todayLocalDate(activeProfile?.timezone));
  const [maxPerDay, setMaxPerDay] = useState('');
  const [minHoursBetween, setMinHoursBetween] = useState('');

  const [doseQuantity, setDoseQuantity] = useState('1');
  const [doseUnit, setDoseUnit] = useState<DoseUnit>('tablet');
  const [startDate, setStartDate] = useState(() => todayLocalDate(activeProfile?.timezone));
  const [endDate, setEndDate] = useState('');

  const [scheduleId, setScheduleId] = useState<string | null>(selectedScheduleId ?? null);
  const [loading, setLoading] = useState(isEdit);
  const [saving, setSaving] = useState(false);
  const [validation, setValidation] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [highRisk, setHighRisk] = useState<HighRiskPrompt | null>(null);

  const separator = isRtl ? '، ' : ', ';

  const hydrate = useCallback((schedule: MedicationScheduleView) => {
    setScheduleId(schedule.id);
    setDoseQuantity(String(schedule.doseQuantity));
    setDoseUnit(schedule.doseUnit);
    setStartDate(schedule.startDate);
    setEndDate(schedule.endDate ?? '');
    const rule = schedule.rule;
    setKind(rule.kind);
    if (rule.kind === 'fixed_times') setTimes(rule.times.length > 0 ? [...rule.times] : [TIME_EXAMPLE]);
    if (rule.kind === 'interval') {
      setEveryHours(String(rule.everyHours));
      setAnchorTime(rule.anchorTime);
      setActiveFrom(rule.activeFrom ?? '');
      setActiveUntil(rule.activeUntil ?? '');
    }
    if (rule.kind === 'days_of_week') {
      setWeekdays(rule.weekdays.map(String));
      setTimes(rule.times.length > 0 ? [...rule.times] : [TIME_EXAMPLE]);
    }
    if (rule.kind === 'cycle') {
      setDaysOn(String(rule.daysOn));
      setDaysOff(String(rule.daysOff));
      setCycleAnchorDate(rule.cycleAnchorDate);
      setTimes(rule.times.length > 0 ? [...rule.times] : [TIME_EXAMPLE]);
    }
    if (rule.kind === 'as_needed') {
      setMaxPerDay(rule.maxPerDay === undefined ? '' : String(rule.maxPerDay));
      setMinHoursBetween(rule.minHoursBetween === undefined ? '' : String(rule.minHoursBetween));
    }
  }, []);

  useEffect(() => {
    if (!isEdit || !medicationId) return;
    void (async () => {
      try {
        const res = await api.get<{ schedules: MedicationScheduleView[] }>(`/v1/medications/${medicationId}`);
        const wanted = selectedScheduleId
          ? res.schedules.find((s) => s.id === selectedScheduleId)
          : res.schedules.find((s) => s.active) ?? res.schedules[0];
        if (wanted) hydrate(wanted);
      } catch (err) {
        setError(err instanceof NetworkError ? t('notifications.offlineBanner') : t('error.internal_error'));
      } finally {
        setLoading(false);
      }
    })();
  }, [hydrate, isEdit, medicationId, selectedScheduleId, t]);

  const kindOptions = useMemo(
    () => SCHEDULE_RULE_KINDS.map((value) => ({
      value,
      label: t(({
        fixed_times: 'schedule.fixedTimes',
        interval: 'schedule.interval',
        days_of_week: 'schedule.daysOfWeek',
        cycle: 'schedule.cycle',
        as_needed: 'schedule.asNeeded',
      } as const)[value]),
    })),
    [t],
  );

  const unitOptions = useMemo(
    () => DOSE_UNITS.map((value) => ({ value, label: t(`unit.${value}` as MessageKey) })),
    [t],
  );

  const weekdayOptions = useMemo(
    () => WEEKDAY_ANCHORS.map((date, index) => ({
      value: String(index),
      label: formatWeekday(`${date}T12:00:00Z`, 'UTC'),
    })),
    [formatWeekday],
  );

  const sortedTimes = useMemo(() => [...times].filter(isValidTime).sort(), [times]);

  const buildRule = useCallback((): ScheduleRule | null => {
    switch (kind) {
      case 'fixed_times':
        return sortedTimes.length > 0 ? { kind: 'fixed_times', times: sortedTimes } : null;
      case 'interval': {
        const hours = Number(everyHours);
        if (!Number.isFinite(hours) || hours < 1 || hours > 72 || !isValidTime(anchorTime)) return null;
        const windowSet = isValidTime(activeFrom) && isValidTime(activeUntil);
        return {
          kind: 'interval',
          everyHours: hours,
          anchorTime,
          ...(windowSet ? { activeFrom, activeUntil } : {}),
        };
      }
      case 'days_of_week': {
        const days = weekdays.map(Number).filter((day) => Number.isInteger(day) && day >= 0 && day <= 6).sort();
        if (days.length === 0 || sortedTimes.length === 0) return null;
        return { kind: 'days_of_week', weekdays: days, times: sortedTimes };
      }
      case 'cycle': {
        const on = Number(daysOn);
        const off = Number(daysOff);
        if (!Number.isInteger(on) || on < 1 || !Number.isInteger(off) || off < 0) return null;
        if (sortedTimes.length === 0 || !isValidLocalDate(cycleAnchorDate)) return null;
        return { kind: 'cycle', daysOn: on, daysOff: off, times: sortedTimes, cycleAnchorDate };
      }
      case 'as_needed': {
        const max = maxPerDay.trim() === '' ? undefined : Number(maxPerDay);
        const gap = minHoursBetween.trim() === '' ? undefined : Number(minHoursBetween);
        return {
          kind: 'as_needed',
          ...(max !== undefined && Number.isInteger(max) && max >= 1 ? { maxPerDay: max } : {}),
          ...(gap !== undefined && Number.isFinite(gap) && gap >= 0 ? { minHoursBetween: gap } : {}),
        };
      }
      default:
        return null;
    }
  }, [activeFrom, activeUntil, anchorTime, cycleAnchorDate, daysOff, daysOn, everyHours, kind, maxPerDay, minHoursBetween, sortedTimes, weekdays]);

  /** The sentence the patient checks the whole screen against. */
  const preview = useMemo((): string => {
    const rule = buildRule();
    if (!rule) return '';
    const list = sortedTimes.join(separator);
    switch (rule.kind) {
      case 'fixed_times':
        return t('schedule.previewFixed', { count: formatNumber(rule.times.length), times: list });
      case 'interval':
        return rule.activeFrom && rule.activeUntil
          ? t('schedule.previewIntervalWindow', {
            hours: formatNumber(rule.everyHours), from: rule.activeFrom, until: rule.activeUntil,
          })
          : t('schedule.previewInterval', { hours: formatNumber(rule.everyHours), time: rule.anchorTime });
      case 'days_of_week':
        return t('schedule.previewWeekly', {
          days: rule.weekdays
            .map((day) => weekdayOptions[day]?.label ?? String(day))
            .join(separator),
          times: list,
        });
      case 'cycle':
        return t('schedule.previewCycle', {
          on: formatNumber(rule.daysOn), off: formatNumber(rule.daysOff), times: list,
        });
      case 'as_needed':
        return rule.maxPerDay !== undefined && rule.minHoursBetween !== undefined
          ? t('schedule.previewAsNeededLimits', {
            max: formatNumber(rule.maxPerDay), hours: formatNumber(rule.minHoursBetween),
          })
          : t('schedule.previewAsNeeded');
      default:
        return '';
    }
  }, [buildRule, formatNumber, separator, sortedTimes, t, weekdayOptions]);

  const describeError = useCallback((err: unknown): string => {
    if (err instanceof NetworkError) return t('notifications.offlineBanner');
    if (err instanceof ApiError) {
      const key = `error.${err.code}` as MessageKey;
      const message = t(key);
      return message === key ? t('error.internal_error') : message;
    }
    return t('error.internal_error');
  }, [t]);

  const save = async (confirmHighRiskChange = false) => {
    if (!medicationId) return;
    const rule = buildRule();
    if (!rule) {
      setValidation(
        kind === 'days_of_week' && weekdays.length === 0
          ? t('schedule.weekdaysRequired')
          : kind === 'interval' || kind === 'as_needed'
            ? t('schedule.invalidTime')
            : t('schedule.timesRequired'),
      );
      return;
    }
    const quantity = Number(doseQuantity.replace(',', '.'));
    if (!Number.isFinite(quantity) || quantity <= 0) {
      setValidation(t('error.validation_failed'));
      return;
    }
    const isCurrent = captureSave();
    if (!isCurrent()) return;
    setValidation(null);
    setError(null);
    setSaving(true);

    const payload = {
      rule,
      doseQuantity: quantity,
      doseUnit,
      startDate: isValidLocalDate(startDate) ? startDate : todayLocalDate(activeProfile?.timezone),
      endDate: endDate && isValidLocalDate(endDate) ? endDate : null,
    };

    try {
      if (isEdit && scheduleId) {
        await api.patch(`/v1/schedules/${scheduleId}`, {
          ...payload,
          ...(confirmHighRiskChange ? { confirmHighRiskChange: true } : {}),
        });
      } else {
        await api.post(`/v1/medications/${medicationId}/schedules`, {
          ...payload,
          timezone: activeProfile?.timezone,
        });
      }
      if (!isCurrent()) return;
      setHighRisk(null);
      if (!user || !activeProfile) return;
      setMedicationDetailRouteIntent({
        userId: user.id,
        patientProfileId: activeProfile.id,
        medicationId,
      });
      router.replace('/medication/detail');
    } catch (err) {
      if (!isCurrent()) return;
      if (err instanceof ApiError && err.code === 'high_risk_confirmation_required') {
        const meta = err.meta as HighRiskPrompt | undefined;
        setHighRisk({ changes: meta?.changes ?? [], before: meta?.before ?? {} });
      } else {
        setError(describeError(err));
      }
    } finally {
      if (isCurrent()) setSaving(false);
    }
  };

  if (loading) return <SafeAreaView style={{ flex: 1 }}><Loading /></SafeAreaView>;

  if (!medicationId) {
    return (
      <SafeAreaView style={{ flex: 1 }}>
        <Screen>
          <Banner tone="danger" title={t('error.not_found')} />
          <Button label={t('common.back')} tone="ghost" onPress={() => router.back()} />
        </Screen>
      </SafeAreaView>
    );
  }

  const usesTimes = kind === 'fixed_times' || kind === 'days_of_week' || kind === 'cycle';

  const changeBefore = (change: string): string => {
    if (change === 'dose_quantity') {
      const value = highRisk?.before.doseQuantity;
      return value === undefined ? t('common.none') : formatNumber(value);
    }
    if (change === 'dose_unit') {
      const value = highRisk?.before.doseUnit;
      return value ? t(`unit.${value}` as MessageKey) : t('common.none');
    }
    if (change === 'schedule_timing') {
      const rule = highRisk?.before.rule;
      if (!rule) return t('common.none');
      if (rule.kind === 'interval') return t('schedule.everyHours', { hours: formatNumber(rule.everyHours) });
      if (rule.kind === 'as_needed') return t('schedule.asNeeded');
      return rule.times.join(separator);
    }
    return '';
  };

  const changeAfter = (change: string): string => {
    if (change === 'dose_quantity') return formatNumber(Number(doseQuantity.replace(',', '.')));
    if (change === 'dose_unit') return t(`unit.${doseUnit}` as MessageKey);
    if (change === 'schedule_timing') return preview;
    return '';
  };

  return (
    <SafeAreaView style={{ flex: 1 }}>
      <Screen>
        <Txt variant="h2" weight="bold" accessibilityRole="header">
          {isEdit ? t('schedule.editTitle') : t('schedule.builderTitle')}
        </Txt>

        {error ? <Banner tone="danger" title={error} /> : null}
        {validation ? <Banner tone="warning" title={validation} /> : null}

        <Card>
          <Picker label={t('schedule.kind')} options={kindOptions} value={kind} onChange={setKind} />
        </Card>

        {usesTimes ? (
          <Card>
            <Txt variant="bodySmall" weight="medium" color={theme.colors.ink700}>{t('schedule.times')}</Txt>
            {times.map((time, index) => (
              <Row key={`time-${index}`} gap={theme.spacing.sm} align="flex-end">
                <View style={{ flex: 1 }}>
                  <Field
                    label={`${t('schedule.times')} ${formatNumber(index + 1)}`}
                    value={time}
                    onChangeText={(value) => setTimes((current) =>
                      current.map((entry, position) => (position === index ? maskTime(value) : entry)))}
                    keyboardType="number-pad"
                    maxLength={5}
                    hint={t('schedule.timeHint', { example: TIME_EXAMPLE })}
                    error={time.length > 0 && !isValidTime(time) ? t('schedule.invalidTime') : null}
                  />
                </View>
                {times.length > 1 ? (
                  <Button
                    label={t('common.remove')}
                    tone="ghost"
                    fullWidth={false}
                    accessibilityHint={t('schedule.removeTime', { time })}
                    onPress={() => setTimes((current) => current.filter((_, position) => position !== index))}
                  />
                ) : null}
              </Row>
            ))}
            <Button
              label={t('schedule.addTime')}
              tone="secondary"
              onPress={() => setTimes((current) => [...current, ''])}
            />
          </Card>
        ) : null}

        {kind === 'interval' ? (
          <Card>
            <Field
              label={t('schedule.everyHoursLabel')}
              value={everyHours}
              onChangeText={setEveryHours}
              keyboardType="number-pad"
              maxLength={2}
            />
            <Field
              label={t('schedule.anchorTime')}
              value={anchorTime}
              onChangeText={(value) => setAnchorTime(maskTime(value))}
              keyboardType="number-pad"
              maxLength={5}
              hint={t('schedule.timeHint', { example: TIME_EXAMPLE })}
              error={anchorTime.length > 0 && !isValidTime(anchorTime) ? t('schedule.invalidTime') : null}
            />
            <Divider />
            <Txt variant="bodySmall" weight="medium" color={theme.colors.ink700}>{t('schedule.activeWindow')}</Txt>
            <Row gap={theme.spacing.md} align="flex-start">
              <View style={{ flex: 1 }}>
                <Field
                  label={t('schedule.activeFrom')}
                  value={activeFrom}
                  onChangeText={(value) => setActiveFrom(maskTime(value))}
                  keyboardType="number-pad"
                  maxLength={5}
                />
              </View>
              <View style={{ flex: 1 }}>
                <Field
                  label={t('schedule.activeUntil')}
                  value={activeUntil}
                  onChangeText={(value) => setActiveUntil(maskTime(value))}
                  keyboardType="number-pad"
                  maxLength={5}
                />
              </View>
            </Row>
          </Card>
        ) : null}

        {kind === 'days_of_week' ? (
          <Card>
            <MultiPicker
              label={t('schedule.weekdays')}
              options={weekdayOptions}
              values={weekdays}
              onToggle={(value) => setWeekdays((current) =>
                current.includes(value) ? current.filter((day) => day !== value) : [...current, value])}
              error={weekdays.length === 0 ? t('schedule.weekdaysRequired') : null}
            />
          </Card>
        ) : null}

        {kind === 'cycle' ? (
          <Card>
            <Row gap={theme.spacing.md} align="flex-start">
              <View style={{ flex: 1 }}>
                <Field label={t('schedule.daysOn')} value={daysOn} onChangeText={setDaysOn} keyboardType="number-pad" maxLength={3} />
              </View>
              <View style={{ flex: 1 }}>
                <Field label={t('schedule.daysOff')} value={daysOff} onChangeText={setDaysOff} keyboardType="number-pad" maxLength={3} />
              </View>
            </Row>
            <DateField label={t('schedule.cycleAnchor')} value={cycleAnchorDate} onChange={setCycleAnchorDate} />
          </Card>
        ) : null}

        {kind === 'as_needed' ? (
          <Card>
            <Field
              label={t('schedule.maxPerDay')}
              value={maxPerDay}
              onChangeText={setMaxPerDay}
              keyboardType="number-pad"
              maxLength={2}
              hint={t('common.optional')}
            />
            <Field
              label={t('schedule.minHoursBetween')}
              value={minHoursBetween}
              onChangeText={setMinHoursBetween}
              keyboardType="number-pad"
              maxLength={2}
              hint={t('common.optional')}
            />
          </Card>
        ) : null}

        <SectionTitle>{t('medication.dose')}</SectionTitle>
        <Card>
          <Field
            label={t('schedule.doseQuantity')}
            value={doseQuantity}
            onChangeText={setDoseQuantity}
            keyboardType="decimal-pad"
          />
          <Picker label={t('schedule.doseUnit')} options={unitOptions} value={doseUnit} onChange={setDoseUnit} />
        </Card>

        <Card>
          <DateField label={t('schedule.startDate')} value={startDate} onChange={setStartDate} />
          <DateField label={t('schedule.endDate')} value={endDate} onChange={setEndDate} optional />
        </Card>

        <SectionTitle>{t('schedule.preview')}</SectionTitle>
        <Card>
          <Txt variant="bodyLarge" weight="medium">{preview || t('schedule.timesRequired')}</Txt>
          {preview ? (
            <Txt variant="bodySmall" color={theme.colors.ink500}>
              {t('schedule.dosePerTime', {
                qty: formatNumber(Number(doseQuantity.replace(',', '.')) || 0),
                unit: t(`unit.${doseUnit}` as MessageKey),
              })}
            </Txt>
          ) : null}
        </Card>

        <Button
          label={t('common.save')}
          size="large"
          loading={saving}
          onPress={() => void save()}
          testID="save-schedule"
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
                    {t('medication.changeFromTo', { from: changeBefore(change), to: changeAfter(change) })}
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
                    onPress={() => void save(true)}
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
