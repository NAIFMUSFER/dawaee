import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Switch, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  Badge, Banner, Button, Card, Divider, EmptyState, Field, Loading, Row, Screen, SectionTitle, Txt,
} from '@/components/ui';
import { useI18n } from '@/i18n';
import { useTheme } from '@/hooks/useTheme';
import { useApp } from '@/state/app-store';
import { profileScopeKey, useRequestScope } from '@/hooks/useRequestScope';
import { api, ApiError, NetworkError } from '@/api/client';
import type { CaregiverView } from '@/api/types';
import {
  CAREGIVER_NOTIFY_MODES, CAREGIVER_PERMISSIONS, toggleCaregiverPermission,
  type CaregiverNotifyMode, type CaregiverPermission,
} from '@dawaee/shared';

/**
 * One caregiver's access.
 *
 * Everything here is written by the PATIENT. A caregiver opening this screen
 * sees the same facts read-only — the API refuses a caregiver widening their
 * own grant, and offering the control anyway would only teach them to try.
 */

const CHANGE_PERMISSIONS: readonly CaregiverPermission[] = [
  'edit_schedule', 'add_medication', 'edit_medication', 'update_stock', 'confirm_dose', 'manage_caregivers',
];
const VIEW_PERMISSIONS = CAREGIVER_PERMISSIONS.filter((p) => !CHANGE_PERMISSIONS.includes(p));

/** The two channels a caregiver can be reached on outside the app. */
// Push is the only channel that can carry a caregiver alert. WhatsApp and SMS
// both need a Saudi commercial registration before a single message is sent,
// so neither is offered as a rule a caregiver can configure and then wait on.
const RULE_CHANNELS = ['push'] as const;
type RuleChannel = (typeof RULE_CHANNELS)[number];

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const MIN_PRIORITY = 1;
const MAX_PRIORITY = 20;

interface CareCircleResponse {
  caregivers: CaregiverView[];
  viewerRole: 'owner' | 'caregiver' | 'none';
}

interface RuleState {
  mode: CaregiverNotifyMode;
  consecutiveMissedThreshold: number;
  summaryTime: string;
  quietHoursStart: string;
  quietHoursEnd: string;
  enabled: boolean;
}

const EMPTY_RULE: RuleState = {
  mode: 'missed_only',
  consecutiveMissedThreshold: 2,
  summaryTime: '',
  quietHoursStart: '',
  quietHoursEnd: '',
  enabled: true,
};

function asMode(value: string): CaregiverNotifyMode {
  return (CAREGIVER_NOTIFY_MODES as readonly string[]).includes(value)
    ? (value as CaregiverNotifyMode)
    : 'missed_only';
}

function ruleFrom(caregiver: CaregiverView, channel: RuleChannel): RuleState {
  const found = caregiver.notificationRules.find((r) => r.channel === channel);
  if (!found) return EMPTY_RULE;
  return {
    mode: asMode(found.mode),
    consecutiveMissedThreshold: found.consecutiveMissedThreshold,
    summaryTime: found.summaryTime ?? '',
    quietHoursStart: found.quietHoursStart ?? '',
    quietHoursEnd: found.quietHoursEnd ?? '',
    enabled: found.enabled,
  };
}

function timeOrNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export default function CaregiverDetailScreen() {
  const { user, activeProfile } = useApp();
  return <CaregiverDetailProfileScreen key={profileScopeKey(user?.id, activeProfile)} />;
}

function CaregiverDetailProfileScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { t, formatNumber } = useI18n();
  const theme = useTheme();
  const { activeProfile, setOffline } = useApp();

  const [caregiver, setCaregiver] = useState<CaregiverView | null>(null);
  const [viewerRole, setViewerRole] = useState<CareCircleResponse['viewerRole']>('none');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [permissions, setPermissions] = useState<CaregiverPermission[]>([]);
  const [priority, setPriority] = useState(MIN_PRIORITY);
  const [rules, setRules] = useState<Record<RuleChannel, RuleState>>({ push: EMPTY_RULE });
  const [savingPermissions, setSavingPermissions] = useState(false);
  const [savingChannel, setSavingChannel] = useState<RuleChannel | null>(null);
  const { begin: beginLoad, capture: captureMutation } = useRequestScope();
  /** Set when the server answered 428: the rule waiting for a consent grant. */

  const describe = useCallback((err: unknown): string => {
    if (!(err instanceof ApiError)) return t('error.internal_error');
    const key = `error.${err.code}` as 'error.internal_error';
    const text = t(key);
    return text === key ? err.message : text;
  }, [t]);

  const load = useCallback(async () => {
    const isCurrent = beginLoad();
    if (!isCurrent()) return;
    if (!activeProfile) {
      setLoading(false);
      return;
    }
    try {
      const res = await api.get<CareCircleResponse>('/v1/care-circle', { profileId: activeProfile.id });
      if (!isCurrent()) return;
      const found = res.caregivers.find((c) => c.id === id) ?? null;
      setViewerRole(res.viewerRole);
      setCaregiver(found);
      if (found) {
        setPermissions(found.permissions);
        setPriority(found.escalationPriority);
        setRules({ push: ruleFrom(found, 'push') });
      }
      setError(null);
      setOffline(false);
    } catch (err) {
      if (!isCurrent()) return;
      if (err instanceof NetworkError) setOffline(true);
      else setError(describe(err));
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [activeProfile, beginLoad, describe, id, setOffline]);

  useEffect(() => { void load(); }, [load]);

  const isOwner = viewerRole === 'owner';
  const name = caregiver?.name ?? caregiver?.phone ?? t('common.none');

  const savePermissions = useCallback(async () => {
    if (!caregiver) return;
    setSavingPermissions(true);
    setError(null);
    try {
      await api.patch('/v1/caregivers/permissions', {
        relationshipId: caregiver.id,
        permissions,
        escalationPriority: priority,
      });
      setNotice(t('caregiver.permissionsSaved'));
      await load();
    } catch (err) {
      if (err instanceof NetworkError) setOffline(true);
      else setError(describe(err));
    } finally {
      setSavingPermissions(false);
    }
  }, [caregiver, describe, load, permissions, priority, setOffline, t]);

  const saveRule = useCallback(async (channel: RuleChannel, rule: RuleState): Promise<void> => {
    if (!caregiver) return;
    if (rule.summaryTime.trim() && !TIME_PATTERN.test(rule.summaryTime.trim())) {
      setError(t('notify.invalidTime'));
      return;
    }
    for (const value of [rule.quietHoursStart, rule.quietHoursEnd]) {
      if (value.trim() && !TIME_PATTERN.test(value.trim())) {
        setError(t('notify.invalidTime'));
        return;
      }
    }

    setSavingChannel(channel);
    setError(null);
    try {
      await api.put('/v1/caregivers/notification-rules', {
        relationshipId: caregiver.id,
        channel,
        mode: rule.mode,
        consecutiveMissedThreshold: rule.consecutiveMissedThreshold,
        summaryTime: timeOrNull(rule.summaryTime),
        quietHoursStart: timeOrNull(rule.quietHoursStart),
        quietHoursEnd: timeOrNull(rule.quietHoursEnd),
        enabled: rule.enabled,
      });
      setNotice(t('notify.saved'));
      await load();
    } catch (err) {
      if (err instanceof NetworkError) setOffline(true);
      else setError(describe(err));
    } finally {
      setSavingChannel(null);
    }
  }, [caregiver, describe, load, setOffline, t]);

  const revoke = useCallback(() => {
    if (!caregiver) return;
    Alert.alert(t('family.revokeAccess'), t('family.revokeConfirm', { name }), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('family.revokeAccess'),
        style: 'destructive',
        onPress: () => {
          void (async () => {
            const isCurrent = captureMutation();
            if (!isCurrent()) return;
            try {
              await api.post('/v1/caregivers/revoke', { relationshipId: caregiver.id });
              if (!isCurrent()) return;
              router.replace('/(tabs)/family');
            } catch (err) {
              if (!isCurrent()) return;
              if (err instanceof NetworkError) setOffline(true);
              else setError(describe(err));
            }
          })();
        },
      },
    ]);
  }, [captureMutation, caregiver, describe, name, setOffline, t]);

  const dirtyPermissions = useMemo(() => {
    if (!caregiver) return false;
    const same =
      permissions.length === caregiver.permissions.length &&
      permissions.every((p) => caregiver.permissions.includes(p));
    return !same || priority !== caregiver.escalationPriority;
  }, [caregiver, permissions, priority]);

  if (loading) return <SafeAreaView style={{ flex: 1 }}><Loading label={t('common.loading')} /></SafeAreaView>;

  if (!caregiver) {
    return (
      <SafeAreaView style={{ flex: 1 }}>
        <Screen>
          <EmptyState
            title={t('caregiver.notFound')}
            body={error ?? undefined}
            action={<Button label={t('common.back')} fullWidth={false} onPress={() => router.back()} />}
          />
        </Screen>
      </SafeAreaView>
    );
  }

  const togglePermission = (permission: CaregiverPermission) => {
    // The switches describe a usable grant, not independent database flags.
    // Adding a capability turns on what it must read; turning a dependency off
    // also turns off capabilities that would otherwise be rejected by the API.
    setPermissions((current) => toggleCaregiverPermission(current, permission));
  };

  const setRule = (channel: RuleChannel, patch: Partial<RuleState>) => {
    setRules((current) => ({ ...current, [channel]: { ...current[channel], ...patch } }));
  };

  return (
    <SafeAreaView style={{ flex: 1 }}>
      <Screen>
        <Row style={{ justifyContent: 'space-between' }}>
          <View style={{ flex: 1, gap: 2 }}>
            <Txt variant="h2" weight="bold" accessibilityRole="header" numberOfLines={1}>{name}</Txt>
            <Txt variant="bodySmall" color={theme.colors.ink500}>
              {t(`relationship.${caregiver.role}` as 'relationship.other')}
            </Txt>
          </View>
          <Button label={t('common.back')} tone="ghost" fullWidth={false} onPress={() => router.back()} />
        </Row>

        {error ? <Banner tone="danger" title={error} /> : null}
        {notice ? <Banner tone="success" title={notice} /> : null}
        {caregiver.status === 'pending' ? <Banner tone="info" title={t('caregiver.pendingNote')} /> : null}
        {!isOwner ? <Banner tone="info" title={t('family.permissionsSetByPatient')} /> : null}

        <SectionTitle>{t('family.permissions')}</SectionTitle>
        <Card>
          <Txt variant="caption" weight="bold" color={theme.colors.ink700}>{t('family.canSee')}</Txt>
          {VIEW_PERMISSIONS.map((p) => (
            <PermissionRow
              key={p}
              label={t(`permission.${p}`)}
              on={permissions.includes(p)}
              disabled={!isOwner}
              onToggle={() => togglePermission(p)}
            />
          ))}
          <Divider />
          <Txt variant="caption" weight="bold" color={theme.colors.ink700}>{t('family.canChange')}</Txt>
          {CHANGE_PERMISSIONS.map((p) => (
            <PermissionRow
              key={p}
              label={t(`permission.${p}`)}
              on={permissions.includes(p)}
              disabled={!isOwner}
              onToggle={() => togglePermission(p)}
            />
          ))}
        </Card>

        <SectionTitle>{t('family.alertOrder')}</SectionTitle>
        <Card>
          <Txt variant="bodySmall" color={theme.colors.ink500}>{t('invite.priority')}</Txt>
          <Row style={{ justifyContent: 'space-between' }} gap={theme.spacing.md}>
            <Button
              label="−"
              tone="secondary"
              fullWidth={false}
              disabled={!isOwner || priority <= MIN_PRIORITY}
              accessibilityHint={t('escalation.moveEarlier', { number: formatNumber(priority) })}
              onPress={() => setPriority((p) => Math.max(MIN_PRIORITY, p - 1))}
            />
            <Txt variant="h3" weight="bold">
              {t('family.alertOrderValue', { priority: formatNumber(priority) })}
            </Txt>
            <Button
              label="+"
              tone="secondary"
              fullWidth={false}
              disabled={!isOwner || priority >= MAX_PRIORITY}
              accessibilityHint={t('escalation.moveLater', { number: formatNumber(priority) })}
              onPress={() => setPriority((p) => Math.min(MAX_PRIORITY, p + 1))}
            />
          </Row>
          {priority === MIN_PRIORITY ? (
            <Badge label={t('family.primaryCaregiver')} fg={theme.colors.primary700} bg={theme.colors.primary100} />
          ) : null}
        </Card>

        {isOwner ? (
          <Button
            label={t('common.save')}
            loading={savingPermissions}
            disabled={!dirtyPermissions}
            onPress={() => void savePermissions()}
            testID="save-permissions"
          />
        ) : null}

        <SectionTitle>{t('notify.title')}</SectionTitle>
        {RULE_CHANNELS.map((channel) => (
          <ChannelRuleCard
            key={channel}
            channel={channel}
            rule={rules[channel]}
            editable={isOwner}
            saving={savingChannel === channel}
            onChange={(patch) => setRule(channel, patch)}
            onSave={() => void saveRule(channel, rules[channel])}
          />
        ))}

        {isOwner ? (
          <Button label={t('family.revokeAccess')} tone="danger" onPress={revoke} />
        ) : null}
      </Screen>
    </SafeAreaView>
  );
}

function PermissionRow({
  label, on, disabled, onToggle,
}: { label: string; on: boolean; disabled: boolean; onToggle: () => void }) {
  const theme = useTheme();
  return (
    <Row style={{ justifyContent: 'space-between', minHeight: theme.touch }} gap={theme.spacing.md}>
      <View style={{ flex: 1 }}>
        <Txt variant="body" color={disabled ? theme.colors.ink500 : theme.colors.ink900}>{label}</Txt>
      </View>
      <Switch
        value={on}
        onValueChange={onToggle}
        disabled={disabled}
        accessibilityRole="switch"
        accessibilityLabel={label}
        trackColor={{ false: theme.colors.ink200, true: theme.colors.primary200 }}
        thumbColor={on ? theme.colors.primary700 : theme.colors.surface}
      />
    </Row>
  );
}

function ChannelRuleCard({
  channel, rule, editable, saving, onChange, onSave,
}: {
  channel: RuleChannel;
  rule: RuleState;
  editable: boolean;
  saving: boolean;
  onChange: (patch: Partial<RuleState>) => void;
  onSave: () => void;
}) {
  const { t, formatNumber } = useI18n();
  const theme = useTheme();

  const showsThreshold = rule.mode === 'consecutive_missed';
  const showsSummaryTime = rule.mode === 'daily_summary' || rule.mode === 'weekly_summary';

  return (
    <Card>
      <Row style={{ justifyContent: 'space-between' }} gap={theme.spacing.md}>
        <View style={{ flex: 1 }}>
          <Txt variant="bodyLarge" weight="bold">{t(`channel.${channel}`)}</Txt>
        </View>
        <Switch
          value={rule.enabled}
          onValueChange={(enabled) => onChange({ enabled })}
          disabled={!editable}
          accessibilityRole="switch"
          accessibilityLabel={t('notify.channelEnabled')}
          trackColor={{ false: theme.colors.ink200, true: theme.colors.primary200 }}
          thumbColor={rule.enabled ? theme.colors.primary700 : theme.colors.surface}
        />
      </Row>

      <Txt variant="caption" weight="bold" color={theme.colors.ink700}>{t('notify.mode')}</Txt>
      <View style={{ gap: theme.spacing.xs }}>
        {CAREGIVER_NOTIFY_MODES.map((mode) => (
          <Button
            key={mode}
            label={`${rule.mode === mode ? '✓ ' : ''}${t(`notify.${mode}`)}`}
            tone={rule.mode === mode ? 'primary' : 'secondary'}
            disabled={!editable}
            onPress={() => onChange({ mode })}
          />
        ))}
      </View>

      {showsThreshold ? (
        <Row style={{ justifyContent: 'space-between' }} gap={theme.spacing.md}>
          <View style={{ flex: 1 }}>
            <Txt variant="bodySmall">{t('notify.threshold')}</Txt>
          </View>
          <Row gap={theme.spacing.sm}>
            <Button
              label="−"
              tone="secondary"
              fullWidth={false}
              disabled={!editable || rule.consecutiveMissedThreshold <= 1}
              accessibilityHint={t('notify.threshold')}
              onPress={() => onChange({ consecutiveMissedThreshold: Math.max(1, rule.consecutiveMissedThreshold - 1) })}
            />
            <Txt variant="h3" weight="bold">{formatNumber(rule.consecutiveMissedThreshold)}</Txt>
            <Button
              label="+"
              tone="secondary"
              fullWidth={false}
              disabled={!editable || rule.consecutiveMissedThreshold >= 10}
              accessibilityHint={t('notify.threshold')}
              onPress={() => onChange({ consecutiveMissedThreshold: Math.min(10, rule.consecutiveMissedThreshold + 1) })}
            />
          </Row>
        </Row>
      ) : null}

      {showsSummaryTime ? (
        <Field
          label={t('notify.summaryTime')}
          value={rule.summaryTime}
          onChangeText={(v) => onChange({ summaryTime: v })}
          keyboardType="number-pad"
          hint={t('notify.timeHint')}
          maxLength={5}
        />
      ) : null}

      <Divider />
      <Txt variant="caption" weight="bold" color={theme.colors.ink700}>{t('notify.quietHours')}</Txt>
      <Row gap={theme.spacing.md} align="flex-start">
        <View style={{ flex: 1 }}>
          <Field
            label={t('notify.quietFrom')}
            value={rule.quietHoursStart}
            onChangeText={(v) => onChange({ quietHoursStart: v })}
            keyboardType="number-pad"
            maxLength={5}
          />
        </View>
        <View style={{ flex: 1 }}>
          <Field
            label={t('notify.quietTo')}
            value={rule.quietHoursEnd}
            onChangeText={(v) => onChange({ quietHoursEnd: v })}
            keyboardType="number-pad"
            maxLength={5}
          />
        </View>
      </Row>
      <Txt variant="caption" color={theme.colors.ink500}>{t('notify.timeHint')}</Txt>
      <Txt variant="caption" color={theme.colors.ink500}>{t('escalation.quietHoursNote')}</Txt>

      {editable ? <Button label={t('common.save')} tone="secondary" loading={saving} onPress={onSave} /> : null}
    </Card>
  );
}