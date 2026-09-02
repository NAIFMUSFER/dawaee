import React, { useCallback, useMemo, useState } from 'react';
import { Clipboard, Switch, View } from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  Badge, Banner, Button, Card, Divider, Field, Row, Screen, SectionTitle, Txt,
} from '@/components/ui';
import { useI18n } from '@/i18n';
import { useTheme } from '@/hooks/useTheme';
import { useApp } from '@/state/app-store';
import { api, ApiError, NetworkError } from '@/api/client';
import {
  CAREGIVER_PERMISSIONS, CAREGIVER_ROLES, CAREGIVER_ROLE_PRESETS,
  type CaregiverPermission, type CaregiverRole,
} from '@dawaee/shared';

/**
 * Inviting a caregiver.
 *
 * The patient chooses a preset because nobody wants to reason about thirteen
 * checkboxes, but the checkboxes stay one tap away because "my nurse, but she
 * cannot delete anything" is a real request.
 *
 * The link is always shown at the end: SMS and WhatsApp delivery can fail
 * quietly, and a patient sitting next to their daughter would rather just hand
 * her the link.
 */

const PRESET_KEYS = ['observer', 'family', 'nurse', 'emergency_only'] as const;
type PresetKey = (typeof PRESET_KEYS)[number];

const CHANNELS = ['sms', 'whatsapp', 'link', 'qr'] as const;
type InviteChannel = (typeof CHANNELS)[number];

const PRIORITIES: ReadonlyArray<{ value: number; labelKey: 'invite.priorityFirst' | 'invite.priorityBackup' | 'invite.priorityLast' }> = [
  { value: 1, labelKey: 'invite.priorityFirst' },
  { value: 5, labelKey: 'invite.priorityBackup' },
  { value: 10, labelKey: 'invite.priorityLast' },
];

const CHANGE_PERMISSIONS: readonly CaregiverPermission[] = [
  'edit_schedule', 'add_medication', 'edit_medication', 'update_stock', 'confirm_dose', 'manage_caregivers',
];
const VIEW_PERMISSIONS = CAREGIVER_PERMISSIONS.filter((p) => !CHANGE_PERMISSIONS.includes(p));

const INVITE_EXPIRY_HOURS = 72;
const CONSENT_VERSION = '1.0';

interface MeResponse {
  consents: Array<{ type: string; granted: boolean }>;
}

interface InviteResponse {
  relationshipId: string;
  expiresAt: string;
  invitationLink: string;
  delivery: { channel: string; ok: boolean; error?: string };
}

function presetPermissions(key: PresetKey): CaregiverPermission[] {
  return [...(CAREGIVER_ROLE_PRESETS[key] ?? [])];
}

function samePermissions(a: readonly CaregiverPermission[], b: readonly CaregiverPermission[]): boolean {
  return a.length === b.length && a.every((p) => b.includes(p));
}

export default function InviteCaregiverScreen() {
  const { t, formatNumber } = useI18n();
  const theme = useTheme();
  const { activeProfile, setOffline } = useApp();

  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [role, setRole] = useState<CaregiverRole>('son');
  const [permissions, setPermissions] = useState<CaregiverPermission[]>(presetPermissions('family'));
  const [customising, setCustomising] = useState(false);
  const [priority, setPriority] = useState(1);
  const [channel, setChannel] = useState<InviteChannel>('sms');

  const [needsWhatsappConsent, setNeedsWhatsappConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<{ name?: string; phone?: string }>({});
  const [result, setResult] = useState<InviteResponse | null>(null);
  const [copied, setCopied] = useState(false);

  const describe = useCallback((err: unknown): string => {
    if (!(err instanceof ApiError)) return t('error.internal_error');
    const key = `error.${err.code}` as 'error.internal_error';
    const text = t(key);
    return text === key ? err.message : text;
  }, [t]);

  const matchedPreset = useMemo<PresetKey | null>(
    () => PRESET_KEYS.find((k) => samePermissions(permissions, presetPermissions(k))) ?? null,
    [permissions],
  );

  const choosePreset = (key: PresetKey) => setPermissions(presetPermissions(key));

  const togglePermission = (permission: CaregiverPermission) => {
    setPermissions((current) =>
      current.includes(permission) ? current.filter((p) => p !== permission) : [...current, permission],
    );
  };

  /**
   * WhatsApp delivery is gated on a recorded consent. Checking before the
   * invite means the patient reads what they are agreeing to, rather than
   * meeting a 428 after filling in the form.
   */
  const ensureWhatsappConsent = useCallback(async (): Promise<boolean> => {
    const me = await api.get<MeResponse>('/v1/me');
    const granted = me.consents.some((c) => c.type === 'whatsapp_notifications' && c.granted);
    if (!granted) setNeedsWhatsappConsent(true);
    return granted;
  }, []);

  const grantWhatsappConsent = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await api.put('/v1/me/consents', {
        type: 'whatsapp_notifications', granted: true, version: CONSENT_VERSION,
      });
      setNeedsWhatsappConsent(false);
    } catch (err) {
      if (err instanceof NetworkError) setOffline(true);
      else setError(describe(err));
    } finally {
      setBusy(false);
    }
  }, [describe, setOffline]);

  const submit = useCallback(async () => {
    if (!activeProfile) return;

    const errors: { name?: string; phone?: string } = {};
    if (name.trim().length === 0) errors.name = t('invite.nameRequired');
    // The server normalises Saudi local format; the client only rejects what
    // could not be a phone number at all.
    if (phone.replace(/\D/g, '').length < 9) errors.phone = t('invite.phoneRequired');
    setFieldError(errors);
    if (errors.name || errors.phone) return;

    if (permissions.length === 0) {
      setError(t('invite.permissionsRequired'));
      return;
    }

    setBusy(true);
    setError(null);
    try {
      if (channel === 'whatsapp' && !(await ensureWhatsappConsent())) {
        setBusy(false);
        return;
      }
      const res = await api.post<InviteResponse>('/v1/caregivers/invite', {
        patientProfileId: activeProfile.id,
        invitedName: name.trim(),
        invitedPhone: phone.trim(),
        role,
        permissions,
        escalationPriority: priority,
        channel,
        expiresInHours: INVITE_EXPIRY_HOURS,
      });
      setResult(res);
    } catch (err) {
      if (err instanceof NetworkError) setOffline(true);
      else if (err instanceof ApiError && err.code === 'consent_required') setNeedsWhatsappConsent(true);
      else setError(describe(err));
    } finally {
      setBusy(false);
    }
  }, [activeProfile, channel, describe, ensureWhatsappConsent, name, permissions, phone, priority, role, setOffline, t]);

  const copyLink = useCallback((link: string) => {
    Clipboard.setString(link);
    setCopied(true);
  }, []);

  if (!activeProfile) {
    return (
      <SafeAreaView style={{ flex: 1 }}>
        <Screen>
          <Txt variant="h2" weight="bold" accessibilityRole="header">{t('invite.title')}</Txt>
          <Banner tone="warning" title={t('caregiver.noPatients')} />
          <Button label={t('common.back')} tone="secondary" onPress={() => router.back()} />
        </Screen>
      </SafeAreaView>
    );
  }

  if (result) {
    return (
      <SafeAreaView style={{ flex: 1 }}>
        <Screen>
          <Txt variant="h1" weight="bold" accessibilityRole="header">{t('invite.created')}</Txt>
          <Txt variant="body" color={theme.colors.ink700}>
            {t('invite.createdBody', { name: name.trim(), hours: formatNumber(INVITE_EXPIRY_HOURS) })}
          </Txt>

          {!result.delivery.ok ? <Banner tone="warning" title={t('invite.deliveryFailed')} /> : null}

          <Card>
            <Txt variant="caption" color={theme.colors.ink500}>{t('invite.copyLink')}</Txt>
            <Txt variant="bodySmall" style={{ writingDirection: 'ltr' }}>{result.invitationLink}</Txt>
            <Button
              label={copied ? t('invite.linkCopied') : t('invite.copyLink')}
              tone={copied ? 'success' : 'primary'}
              onPress={() => copyLink(result.invitationLink)}
            />
          </Card>

          <Button label={t('invite.backToFamily')} tone="secondary" onPress={() => router.replace('/(tabs)/family')} />
          <Button
            label={t('invite.inviteAnother')}
            tone="ghost"
            onPress={() => {
              setResult(null);
              setCopied(false);
              setName('');
              setPhone('');
            }}
          />
        </Screen>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1 }}>
      <Screen>
        <Row style={{ justifyContent: 'space-between' }}>
          <Txt variant="h2" weight="bold" accessibilityRole="header">{t('invite.title')}</Txt>
          <Button label={t('common.back')} tone="ghost" fullWidth={false} onPress={() => router.back()} />
        </Row>

        {error ? <Banner tone="danger" title={error} /> : null}

        {needsWhatsappConsent ? (
          <Card>
            <Txt variant="h3" weight="bold">{t('whatsapp.consentTitle')}</Txt>
            <Txt variant="body" color={theme.colors.ink700}>{t('whatsapp.consent')}</Txt>
            <Txt variant="caption" color={theme.colors.ink500}>{t('whatsapp.consentRequired')}</Txt>
            <Button label={t('whatsapp.agree')} loading={busy} onPress={() => void grantWhatsappConsent()} />
            <Button
              label={t('common.notNow')}
              tone="ghost"
              onPress={() => { setNeedsWhatsappConsent(false); setChannel('sms'); }}
            />
          </Card>
        ) : null}

        <Field
          label={t('invite.name')}
          value={name}
          onChangeText={(v) => { setName(v); setFieldError((e) => ({ ...e, name: undefined })); }}
          error={fieldError.name ?? null}
        />
        <Field
          label={t('invite.phone')}
          value={phone}
          onChangeText={(v) => { setPhone(v); setFieldError((e) => ({ ...e, phone: undefined })); }}
          keyboardType="phone-pad"
          hint={t('invite.phoneHint')}
          error={fieldError.phone ?? null}
          maxLength={20}
        />

        <SectionTitle>{t('invite.relationship')}</SectionTitle>
        <Row wrap gap={theme.spacing.sm}>
          {CAREGIVER_ROLES.map((r) => (
            <Button
              key={r}
              label={`${role === r ? '✓ ' : ''}${t(`relationship.${r}`)}`}
              tone={role === r ? 'primary' : 'secondary'}
              fullWidth={false}
              onPress={() => setRole(r)}
            />
          ))}
        </Row>

        <SectionTitle>{t('invite.accessLevel')}</SectionTitle>
        <View style={{ gap: theme.spacing.sm }}>
          {PRESET_KEYS.map((key) => {
            const selected = matchedPreset === key;
            return (
              <Card
                key={key}
                onPress={() => choosePreset(key)}
                accessibilityLabel={`${t(`preset.${key}`)}. ${t(`preset.${key}Hint`)}`}
                style={selected ? { borderColor: theme.colors.primary600, borderWidth: 2 } : undefined}
              >
                <Row style={{ justifyContent: 'space-between' }}>
                  <Txt variant="bodyLarge" weight="bold">{t(`preset.${key}`)}</Txt>
                  {selected ? <Badge label={t('common.done')} fg={theme.colors.primary700} bg={theme.colors.primary100} /> : null}
                </Row>
                <Txt variant="bodySmall" color={theme.colors.ink500}>{t(`preset.${key}Hint`)}</Txt>
              </Card>
            );
          })}
          {matchedPreset === null ? (
            <Badge label={t('preset.custom')} fg={theme.colors.info700} bg={theme.colors.info100} />
          ) : null}
        </View>

        <Button
          label={t('invite.customise')}
          tone="ghost"
          onPress={() => setCustomising((c) => !c)}
          accessibilityHint={t('family.permissions')}
        />

        {customising ? (
          <Card>
            <Txt variant="caption" weight="bold" color={theme.colors.ink700}>{t('family.canSee')}</Txt>
            {VIEW_PERMISSIONS.map((p) => (
              <PermissionToggle
                key={p}
                label={t(`permission.${p}`)}
                on={permissions.includes(p)}
                onToggle={() => togglePermission(p)}
              />
            ))}
            <Divider />
            <Txt variant="caption" weight="bold" color={theme.colors.ink700}>{t('family.canChange')}</Txt>
            {CHANGE_PERMISSIONS.map((p) => (
              <PermissionToggle
                key={p}
                label={t(`permission.${p}`)}
                on={permissions.includes(p)}
                onToggle={() => togglePermission(p)}
              />
            ))}
          </Card>
        ) : null}

        <SectionTitle>{t('invite.priority')}</SectionTitle>
        <View style={{ gap: theme.spacing.sm }}>
          {PRIORITIES.map((p) => (
            <Button
              key={p.value}
              label={`${priority === p.value ? '✓ ' : ''}${t(p.labelKey)}`}
              tone={priority === p.value ? 'primary' : 'secondary'}
              onPress={() => setPriority(p.value)}
            />
          ))}
        </View>

        <SectionTitle>{t('invite.channel')}</SectionTitle>
        <Row wrap gap={theme.spacing.sm}>
          {CHANNELS.map((c) => (
            <Button
              key={c}
              label={`${channel === c ? '✓ ' : ''}${t(`channel.${c}`)}`}
              tone={channel === c ? 'primary' : 'secondary'}
              fullWidth={false}
              onPress={() => setChannel(c)}
            />
          ))}
        </Row>

        <Button
          label={t('invite.send')}
          size="large"
          loading={busy}
          disabled={needsWhatsappConsent}
          onPress={() => void submit()}
          testID="invite-send"
        />
      </Screen>
    </SafeAreaView>
  );
}

function PermissionToggle({ label, on, onToggle }: { label: string; on: boolean; onToggle: () => void }) {
  const theme = useTheme();
  return (
    <Row style={{ justifyContent: 'space-between', minHeight: theme.touch }} gap={theme.spacing.md}>
      <View style={{ flex: 1 }}>
        <Txt variant="body">{label}</Txt>
      </View>
      <Switch
        value={on}
        onValueChange={onToggle}
        accessibilityRole="switch"
        accessibilityLabel={label}
        trackColor={{ false: theme.colors.ink200, true: theme.colors.primary200 }}
        thumbColor={on ? theme.colors.primary700 : theme.colors.surface}
      />
    </Row>
  );
}
