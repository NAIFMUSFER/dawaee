import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  Badge, Banner, Button, Card, Divider, Field, Loading, Row, Screen, SafetyNote, SectionTitle, Txt,
} from '@/components/ui';
import { useI18n } from '@/i18n';
import { useTheme } from '@/hooks/useTheme';
import { useApp } from '@/state/app-store';
import { api, ApiError, NetworkError } from '@/api/client';
import type { CaregiverView, TodayResponse } from '@/api/types';
import type { EscalationStage, NotificationChannel } from '@dawaee/shared';

/**
 * Smart escalation.
 *
 * The mental model this screen has to teach in one glance: a missed dose walks
 * outward — the patient first, then a repeat, then the closest caregiver, then
 * the rest — and stops the moment the dose is confirmed. The plain-language
 * timeline is the real interface; the stage list underneath is for the person
 * who wants to move a step by ten minutes.
 *
 * Two rules the UI enforces because the API rejects otherwise, and because a
 * rejection here would be an unfixable dead end for an elderly user:
 *  - `afterMinutes` is strictly increasing across stages;
 *  - the first stage is the patient's own reminder, so it is never removed.
 *    Escalation with no patient stage would silently stop reminding the
 *    patient at all — the worker sends the dose reminder from stage 0.
 */

type StageTarget = EscalationStage['target'];

const PATIENT_CHANNELS: readonly NotificationChannel[] = ['push', 'local'];
const CAREGIVER_CHANNELS: readonly NotificationChannel[] = ['push'];
const TARGETS: readonly StageTarget[] = ['patient', 'primary_caregiver', 'secondary_caregivers', 'all_caregivers'];
const MAX_STAGES = 8;
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

const TARGET_LABEL: Record<StageTarget, 'escalation.targetPatient' | 'escalation.targetPrimary' | 'escalation.targetSecondary' | 'escalation.targetAll'> = {
  patient: 'escalation.targetPatient',
  primary_caregiver: 'escalation.targetPrimary',
  secondary_caregivers: 'escalation.targetSecondary',
  all_caregivers: 'escalation.targetAll',
};

type PresetKey = 'immediately' | 'after15' | 'after30' | 'after60' | 'afterTwoMissed' | 'never';

const PRESET_LABEL: Record<PresetKey, 'escalation.immediately' | 'escalation.after15' | 'escalation.after30' | 'escalation.after60' | 'escalation.afterTwoMissed' | 'escalation.never'> = {
  immediately: 'escalation.immediately',
  after15: 'escalation.after15',
  after30: 'escalation.after30',
  after60: 'escalation.after60',
  afterTwoMissed: 'escalation.afterTwoMissed',
  never: 'escalation.never',
};

const patientStage = (afterMinutes: number): EscalationStage =>
  ({ afterMinutes, target: 'patient', channels: ['push', 'local'] });
const caregiverStage = (afterMinutes: number, target: StageTarget): EscalationStage =>
  ({ afterMinutes, target, channels: ['push'] });

/**
 * Every preset keeps the patient's own reminder at minute 0 and a repeat at
 * minute 10; what changes is when — and whether — the circle widens.
 * "Never" is a ladder with no caregiver stage, not a disabled policy: a
 * disabled policy would take the patient's reminders down with it.
 */
const PRESETS: Record<PresetKey, () => EscalationStage[]> = {
  immediately: () => [patientStage(0), caregiverStage(1, 'primary_caregiver'), caregiverStage(31, 'secondary_caregivers')],
  after15: () => [patientStage(0), patientStage(10), caregiverStage(15, 'primary_caregiver'), caregiverStage(45, 'secondary_caregivers')],
  after30: () => [patientStage(0), patientStage(10), caregiverStage(30, 'primary_caregiver'), caregiverStage(60, 'secondary_caregivers')],
  after60: () => [patientStage(0), patientStage(10), caregiverStage(60, 'primary_caregiver'), caregiverStage(90, 'secondary_caregivers')],
  afterTwoMissed: () => [patientStage(0), patientStage(10), caregiverStage(20, 'primary_caregiver'), caregiverStage(50, 'secondary_caregivers')],
  never: () => [patientStage(0), patientStage(10)],
};

interface PolicyResponse {
  policy: {
    id: string | null;
    medicationId: string | null;
    enabled: boolean;
    stages: EscalationStage[];
    quietHoursStart: string | null;
    quietHoursEnd: string | null;
  };
  isDefault: boolean;
  defaultStages: EscalationStage[];
}

interface CareCircleResponse {
  caregivers: CaregiverView[];
  viewerRole: 'owner' | 'caregiver' | 'none';
}

function sameStages(a: readonly EscalationStage[], b: readonly EscalationStage[]): boolean {
  return a.length === b.length && a.every((stage, i) => {
    const other = b[i];
    return other !== undefined
      && stage.afterMinutes === other.afterMinutes
      && stage.target === other.target
      && stage.channels.length === other.channels.length
      && stage.channels.every((c) => other.channels.includes(c));
  });
}

/** Keeps `afterMinutes` strictly increasing by nudging later stages forward. */
function enforceOrder(stages: EscalationStage[]): { stages: EscalationStage[]; adjusted: boolean } {
  let adjusted = false;
  const out: EscalationStage[] = [];
  for (const stage of stages) {
    const previous = out[out.length - 1];
    if (previous !== undefined && stage.afterMinutes <= previous.afterMinutes) {
      out.push({ ...stage, afterMinutes: previous.afterMinutes + 1 });
      adjusted = true;
    } else {
      out.push({ ...stage });
    }
  }
  return { stages: out, adjusted };
}

function channelsFor(target: StageTarget): readonly NotificationChannel[] {
  return target === 'patient' ? PATIENT_CHANNELS : CAREGIVER_CHANNELS;
}

export default function EscalationScreen() {
  const { t, formatNumber, formatTime } = useI18n();
  const theme = useTheme();
  const { activeProfile, setOffline } = useApp();

  const [stages, setStages] = useState<EscalationStage[]>([]);
  const [quietStart, setQuietStart] = useState('');
  const [quietEnd, setQuietEnd] = useState('');
  const [saved, setSaved] = useState<{ stages: EscalationStage[]; quietStart: string; quietEnd: string } | null>(null);
  const [caregivers, setCaregivers] = useState<CaregiverView[]>([]);
  const [viewerRole, setViewerRole] = useState<CareCircleResponse['viewerRole']>('none');
  const [anchor, setAnchor] = useState<string | null>(null);

  const [advanced, setAdvanced] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const describe = useCallback((err: unknown): string => {
    if (!(err instanceof ApiError)) return t('error.internal_error');
    const key = `error.${err.code}` as 'error.internal_error';
    const text = t(key);
    return text === key ? err.message : text;
  }, [t]);

  const load = useCallback(async () => {
    if (!activeProfile) {
      setLoading(false);
      return;
    }
    try {
      const [policyRes, circleRes, todayRes] = await Promise.all([
        api.get<PolicyResponse>('/v1/escalation-policy', { profileId: activeProfile.id }),
        api.get<CareCircleResponse>('/v1/care-circle', { profileId: activeProfile.id }),
        api.get<TodayResponse>('/v1/today', { profileId: activeProfile.id }).catch(() => null),
      ]);
      const loaded = policyRes.policy.stages.length > 0 ? policyRes.policy.stages : policyRes.defaultStages;
      const start = policyRes.policy.quietHoursStart ?? '';
      const end = policyRes.policy.quietHoursEnd ?? '';
      setStages(loaded);
      setQuietStart(start);
      setQuietEnd(end);
      setSaved({ stages: loaded, quietStart: start, quietEnd: end });
      setCaregivers(circleRes.caregivers);
      setViewerRole(circleRes.viewerRole);
      // A real upcoming dose makes the timeline concrete instead of abstract.
      setAnchor(todayRes?.next?.scheduledAt ?? todayRes?.today[0]?.scheduledAt ?? null);
      setError(null);
      setOffline(false);
    } catch (err) {
      if (err instanceof NetworkError) setOffline(true);
      else setError(describe(err));
    } finally {
      setLoading(false);
    }
  }, [activeProfile, describe, setOffline]);

  useEffect(() => { void load(); }, [load]);

  const isOwner = viewerRole === 'owner';

  const activeCaregivers = useMemo(
    () => caregivers
      .filter((c) => c.status === 'active' && c.permissions.includes('receive_notifications'))
      .sort((a, b) => a.escalationPriority - b.escalationPriority),
    [caregivers],
  );

  const namesFor = useCallback((target: StageTarget): string => {
    if (target === 'patient') return activeProfile?.displayName ?? t('escalation.targetPatient');
    if (activeCaregivers.length === 0) return t('escalation.previewNoCaregiver');
    const top = activeCaregivers[0];
    if (top === undefined) return t('escalation.previewNoCaregiver');
    const selected =
      target === 'primary_caregiver' ? activeCaregivers.filter((c) => c.escalationPriority === top.escalationPriority)
        : target === 'secondary_caregivers' ? activeCaregivers.filter((c) => c.escalationPriority > top.escalationPriority)
          : activeCaregivers;
    const names = selected.map((c) => c.name).filter((n): n is string => Boolean(n));
    return names.length > 0 ? names.join('، ') : t('escalation.previewNoCaregiver');
  }, [activeCaregivers, activeProfile?.displayName, t]);

  /** The clock the preview counts from: a real next dose, or a plain evening slot. */
  const anchorIso = useMemo(() => {
    if (anchor) return anchor;
    const evening = new Date();
    evening.setHours(20, 0, 0, 0);
    return evening.toISOString();
  }, [anchor]);

  const preview = useMemo(() => {
    const base = Date.parse(anchorIso);
    let patientStagesSeen = 0;
    return stages.map((stage) => {
      const time = formatTime(new Date(base + stage.afterMinutes * 60_000).toISOString(), activeProfile?.timezone);
      const name = namesFor(stage.target);
      if (stage.target === 'patient') {
        patientStagesSeen += 1;
        return patientStagesSeen === 1
          ? t('escalation.previewRemind', { time, name })
          : t('escalation.previewRemindAgain', { time, name });
      }
      const channel = stage.channels[0];
      return t('escalation.previewNotify', {
        time,
        channel: channel ? t(`channel.${channel}` as 'channel.push') : t('channel.push'),
        name,
      });
    });
  }, [activeProfile?.timezone, anchorIso, formatTime, namesFor, stages, t]);

  const matchedPreset = useMemo<PresetKey | null>(() => {
    const keys = Object.keys(PRESETS) as PresetKey[];
    return keys.find((key) => sameStages(stages, PRESETS[key]())) ?? null;
  }, [stages]);

  const applyStages = useCallback((next: EscalationStage[]) => {
    const { stages: ordered, adjusted } = enforceOrder(next);
    setStages(ordered);
    setNotice(adjusted ? t('escalation.orderFixed') : null);
  }, [t]);

  /**
   * Minute edits are left exactly as typed — clamping mid-keystroke turns
   * "15" into "11" and fights the user — so the order rule is surfaced as a
   * blocking validation instead, and the save is held back until it holds.
   */
  const outOfOrder = useMemo(
    () => stages.some((stage, i) => {
      const previous = stages[i - 1];
      return previous !== undefined && stage.afterMinutes <= previous.afterMinutes;
    }),
    [stages],
  );

  const dirty = useMemo(() => {
    if (!saved) return false;
    return !sameStages(stages, saved.stages) || quietStart !== saved.quietStart || quietEnd !== saved.quietEnd;
  }, [quietEnd, quietStart, saved, stages]);

  const save = useCallback(async () => {
    if (!activeProfile) return;
    if (stages.length === 0) {
      setError(t('escalation.stagesRequired'));
      return;
    }
    if (stages.some((s) => s.channels.length === 0)) {
      setError(t('escalation.channelsRequired'));
      return;
    }
    if (outOfOrder) {
      setError(t('escalation.orderRule'));
      return;
    }
    for (const value of [quietStart, quietEnd]) {
      if (value.trim() && !TIME_PATTERN.test(value.trim())) {
        setError(t('notify.invalidTime'));
        return;
      }
    }

    setBusy(true);
    setError(null);
    try {
      // `enabled` stays true: the patient's own reminder is stage 0 of this
      // very ladder, so "never alert the family" is expressed as a ladder with
      // no caregiver stage, never as a disabled policy.
      await api.put('/v1/escalation-policy', {
        enabled: true,
        stages,
        quietHoursStart: quietStart.trim() || null,
        quietHoursEnd: quietEnd.trim() || null,
      }, { profileId: activeProfile.id });
      setSaved({ stages, quietStart, quietEnd });
      setNotice(t('escalation.saved'));
    } catch (err) {
      if (err instanceof NetworkError) setOffline(true);
      else setError(describe(err));
    } finally {
      setBusy(false);
    }
  }, [activeProfile, describe, outOfOrder, quietEnd, quietStart, setOffline, stages, t]);

  if (loading) return <SafeAreaView style={{ flex: 1 }}><Loading label={t('common.loading')} /></SafeAreaView>;

  if (!activeProfile) {
    return (
      <SafeAreaView style={{ flex: 1 }}>
        <Screen>
          <Txt variant="h2" weight="bold" accessibilityRole="header">{t('escalation.title')}</Txt>
          <Banner tone="warning" title={t('caregiver.noPatients')} />
          <Button label={t('common.back')} tone="secondary" onPress={() => router.back()} />
        </Screen>
      </SafeAreaView>
    );
  }

  const updateStage = (index: number, patch: Partial<EscalationStage>) => {
    applyStages(stages.map((stage, i) => (i === index ? { ...stage, ...patch } : stage)));
  };

  const setMinutes = (index: number, raw: string) => {
    const parsed = Number.parseInt(raw.replace(/\D/g, ''), 10);
    const afterMinutes = Number.isNaN(parsed) ? 0 : Math.min(1440, parsed);
    setNotice(null);
    setStages((current) => current.map((stage, i) => (i === index ? { ...stage, afterMinutes } : stage)));
  };

  const toggleChannel = (index: number, channel: NotificationChannel) => {
    const stage = stages[index];
    if (!stage) return;
    const channels = stage.channels.includes(channel)
      ? stage.channels.filter((c) => c !== channel)
      : [...stage.channels, channel];
    updateStage(index, { channels });
  };

  const changeTarget = (index: number, target: StageTarget) => {
    const stage = stages[index];
    if (!stage) return;
    const allowed = channelsFor(target);
    const channels = stage.channels.filter((c) => allowed.includes(c));
    updateStage(index, { target, channels: channels.length > 0 ? channels : [...allowed].slice(0, 2) });
  };

  const addStage = () => {
    if (stages.length >= MAX_STAGES) return;
    const last = stages[stages.length - 1];
    applyStages([...stages, caregiverStage((last?.afterMinutes ?? 0) + 15, 'primary_caregiver')]);
  };

  const removeStage = (index: number) => {
    applyStages(stages.filter((_, i) => i !== index));
  };

  /**
   * Reordering swaps what a step *does*, leaving the minutes where they are.
   * Moving the payload instead of the timestamp makes it impossible to produce
   * an out-of-order ladder, which the API would reject outright.
   */
  const swapWithNeighbour = (index: number, direction: -1 | 1) => {
    const other = index + direction;
    const a = stages[index];
    const b = stages[other];
    if (!a || !b) return;
    applyStages(stages.map((stage, i) => {
      if (i === index) return { ...stage, target: b.target, channels: [...b.channels] };
      if (i === other) return { ...stage, target: a.target, channels: [...a.channels] };
      return stage;
    }));
  };

  return (
    <SafeAreaView style={{ flex: 1 }}>
      <Screen>
        <Row style={{ justifyContent: 'space-between' }}>
          <Txt variant="h2" weight="bold" accessibilityRole="header">{t('escalation.title')}</Txt>
          <Button label={t('common.back')} tone="ghost" fullWidth={false} onPress={() => router.back()} />
        </Row>

        {error ? <Banner tone="danger" title={error} /> : null}
        {notice ? <Banner tone="success" title={notice} /> : null}
        {!isOwner ? <Banner tone="info" title={t('family.permissionsSetByPatient')} /> : null}

        <SectionTitle>{t('escalation.quickChoices')}</SectionTitle>
        <View style={{ gap: theme.spacing.sm }}>
          {(Object.keys(PRESETS) as PresetKey[]).map((key) => (
            <Button
              key={key}
              label={`${matchedPreset === key ? '✓ ' : ''}${t(PRESET_LABEL[key])}`}
              tone={matchedPreset === key ? 'primary' : 'secondary'}
              disabled={!isOwner}
              onPress={() => applyStages(PRESETS[key]())}
            />
          ))}
          {matchedPreset === null ? (
            <Badge label={t('preset.custom')} fg={theme.colors.info700} bg={theme.colors.info100} />
          ) : null}
        </View>

        <SectionTitle>{t('escalation.preview')}</SectionTitle>
        <Card>
          <Txt variant="caption" color={theme.colors.ink500}>
            {t('escalation.previewBasedOn', { time: formatTime(anchorIso, activeProfile.timezone) })}
          </Txt>
          {preview.length === 0 ? (
            <Txt variant="bodySmall" color={theme.colors.ink500}>{t('escalation.stagesRequired')}</Txt>
          ) : (
            preview.map((line, index) => (
              <Row key={`${line}-${index}`} gap={theme.spacing.sm} align="flex-start">
                <Txt variant="body" color={theme.colors.primary600}>{index === 0 ? '•' : '↓'}</Txt>
                <View style={{ flex: 1 }}>
                  <Txt variant="body">{line}</Txt>
                </View>
              </Row>
            ))
          )}
        </Card>

        <Button
          label={t('escalation.advanced')}
          tone="ghost"
          onPress={() => setAdvanced((a) => !a)}
          accessibilityHint={t('escalation.orderRule')}
        />

        {advanced ? (
          <View style={{ gap: theme.spacing.md }}>
            {outOfOrder
              ? <Banner tone="danger" title={t('escalation.orderRule')} />
              : <Txt variant="caption" color={theme.colors.ink500}>{t('escalation.orderRule')}</Txt>}
            {stages.map((stage, index) => (
              <Card key={`stage-${index}`}>
                <Row style={{ justifyContent: 'space-between' }}>
                  <Txt variant="bodyLarge" weight="bold">
                    {t('escalation.stageNumber', { number: formatNumber(index + 1) })}
                  </Txt>
                  <Row gap={theme.spacing.xs}>
                    <Button
                      label="↑"
                      tone="ghost"
                      fullWidth={false}
                      disabled={!isOwner || index === 0}
                      accessibilityHint={t('escalation.moveEarlier', { number: formatNumber(index + 1) })}
                      onPress={() => swapWithNeighbour(index, -1)}
                    />
                    <Button
                      label="↓"
                      tone="ghost"
                      fullWidth={false}
                      disabled={!isOwner || index === stages.length - 1}
                      accessibilityHint={t('escalation.moveLater', { number: formatNumber(index + 1) })}
                      onPress={() => swapWithNeighbour(index, 1)}
                    />
                    <Button
                      label="✕"
                      tone="ghost"
                      fullWidth={false}
                      disabled={!isOwner || stages.length <= 1 || index === 0}
                      accessibilityHint={t('escalation.removeStage', { number: formatNumber(index + 1) })}
                      onPress={() => removeStage(index)}
                    />
                  </Row>
                </Row>

                <Field
                  label={t('escalation.afterMinutes')}
                  value={String(stage.afterMinutes)}
                  onChangeText={(v) => setMinutes(index, v)}
                  keyboardType="number-pad"
                  maxLength={4}
                  error={index > 0 && stage.afterMinutes <= (stages[index - 1]?.afterMinutes ?? -1)
                    ? t('escalation.orderRule')
                    : null}
                />

                <Txt variant="caption" weight="bold" color={theme.colors.ink700}>{t('escalation.target')}</Txt>
                <View style={{ gap: theme.spacing.xs }}>
                  {TARGETS.map((target) => (
                    <Button
                      key={target}
                      label={`${stage.target === target ? '✓ ' : ''}${t(TARGET_LABEL[target])}`}
                      tone={stage.target === target ? 'primary' : 'secondary'}
                      disabled={!isOwner}
                      onPress={() => changeTarget(index, target)}
                    />
                  ))}
                </View>

                <Txt variant="caption" weight="bold" color={theme.colors.ink700}>{t('escalation.channels')}</Txt>
                <Row wrap gap={theme.spacing.sm}>
                  {channelsFor(stage.target).map((channel) => (
                    <Button
                      key={channel}
                      label={`${stage.channels.includes(channel) ? '☑' : '☐'}  ${t(`channel.${channel}` as 'channel.push')}`}
                      tone={stage.channels.includes(channel) ? 'secondary' : 'ghost'}
                      fullWidth={false}
                      disabled={!isOwner}
                      onPress={() => toggleChannel(index, channel)}
                    />
                  ))}
                </Row>
                {stage.channels.length === 0 ? (
                  <Txt variant="caption" color={theme.colors.danger700}>{t('escalation.channelsRequired')}</Txt>
                ) : null}
              </Card>
            ))}

            <Button
              label={t('escalation.addStage')}
              tone="secondary"
              disabled={!isOwner || stages.length >= MAX_STAGES}
              onPress={addStage}
            />
            <Txt variant="caption" color={theme.colors.ink500}>
              {t('escalation.maxStages', { count: formatNumber(MAX_STAGES) })}
            </Txt>
          </View>
        ) : null}

        <SectionTitle>{t('notify.quietHours')}</SectionTitle>
        <Card>
          <Row gap={theme.spacing.md} align="flex-start">
            <View style={{ flex: 1 }}>
              <Field
                label={t('notify.quietFrom')}
                value={quietStart}
                onChangeText={setQuietStart}
                keyboardType="number-pad"
                maxLength={5}
              />
            </View>
            <View style={{ flex: 1 }}>
              <Field
                label={t('notify.quietTo')}
                value={quietEnd}
                onChangeText={setQuietEnd}
                keyboardType="number-pad"
                maxLength={5}
              />
            </View>
          </Row>
          <Txt variant="caption" color={theme.colors.ink500}>{t('notify.timeHint')}</Txt>
          <Divider />
          <Txt variant="bodySmall" color={theme.colors.ink700}>{t('escalation.quietHoursNote')}</Txt>
        </Card>

        {isOwner ? (
          <Button
            label={t('common.save')}
            size="large"
            loading={busy}
            disabled={!dirty || outOfOrder}
            onPress={() => void save()}
            testID="save-escalation"
          />
        ) : null}

        <SafetyNote textKey="safety.notMedicalAdvice" />
      </Screen>
    </SafeAreaView>
  );
}
