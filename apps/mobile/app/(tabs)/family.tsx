import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Linking, RefreshControl, ScrollView, View } from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Badge, Banner, Button, Card, Divider, EmptyState, Loading, Row, SectionTitle, Txt } from '@/components/ui';
import { useI18n } from '@/i18n';
import { useTheme } from '@/hooks/useTheme';
import { useApp } from '@/state/app-store';
import { api, ApiError, NetworkError } from '@/api/client';
import type { CaregiverView } from '@/api/types';
import type { CaregiverPermission } from '@dawaee/shared';

/**
 * Family Care Circle.
 *
 * The same route serves two very different readers:
 *  - the patient, who grants and revokes access and can see every caregiver;
 *  - a caregiver looking at someone else's profile, who may only see the
 *    access they were given and leave.
 *
 * The server decides which of the two you are (`viewerRole`); the screen never
 * infers it, and it never offers a caregiver a way to widen their own access.
 */

interface CareCircleResponse {
  caregivers: CaregiverView[];
  viewerRole: 'owner' | 'caregiver' | 'none';
  presets: Record<string, readonly CaregiverPermission[]>;
}

const CHANGE_PERMISSIONS: readonly CaregiverPermission[] = [
  'edit_schedule', 'add_medication', 'edit_medication', 'update_stock', 'confirm_dose', 'manage_caregivers',
];

function isChange(permission: CaregiverPermission): boolean {
  return CHANGE_PERMISSIONS.includes(permission);
}

export default function FamilyScreen() {
  const { t, bidi } = useI18n();
  const theme = useTheme();
  const { activeProfile, offline, setOffline } = useApp();

  const [data, setData] = useState<CareCircleResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  // The server's error codes are the primary source; its message is the
  // fallback for a code this build does not yet have a translation for.
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
      const res = await api.get<CareCircleResponse>('/v1/care-circle', { profileId: activeProfile.id });
      setData(res);
      setError(null);
      setOffline(false);
    } catch (err) {
      if (err instanceof NetworkError) setOffline(true);
      else setError(describe(err));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [activeProfile, describe, setOffline]);

  useEffect(() => { void load(); }, [load]);

  const caregivers = data?.caregivers ?? [];
  const isOwner = data?.viewerRole === 'owner';

  const active = useMemo(
    () => caregivers.filter((c) => c.status === 'active').sort((a, b) => a.escalationPriority - b.escalationPriority),
    [caregivers],
  );
  const pending = useMemo(
    () => caregivers.filter((c) => c.status === 'pending' || c.status === 'expired' || c.status === 'declined'),
    [caregivers],
  );

  /** The person the patient would phone first: the highest-priority caregiver we hold a number for. */
  const primaryWithPhone = useMemo(() => active.find((c) => Boolean(c.phone)), [active]);

  const call = useCallback(async (phone: string) => {
    const url = `tel:${phone}`;
    const supported = await Linking.canOpenURL(url).catch(() => false);
    if (supported) await Linking.openURL(url).catch(() => undefined);
  }, []);

  const remove = useCallback((caregiver: CaregiverView, selfRemoval: boolean) => {
    const name = caregiver.name ?? (caregiver.phone ? bidi(caregiver.phone) : null) ?? t('common.none');
    Alert.alert(
      selfRemoval ? t('family.leaveCircle') : t('family.revokeAccess'),
      selfRemoval
        ? t('family.leaveConfirm', { name: activeProfile?.displayName ?? name })
        : t('family.revokeConfirm', { name }),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: selfRemoval ? t('family.leaveCircle') : t('family.revokeAccess'),
          style: 'destructive',
          onPress: () => {
            void (async () => {
              setBusyId(caregiver.id);
              try {
                await api.delete(`/v1/caregivers/${caregiver.id}`);
                await load();
              } catch (err) {
                if (err instanceof NetworkError) setOffline(true);
                else setError(describe(err));
              } finally {
                setBusyId(null);
              }
            })();
          },
        },
      ],
    );
  }, [activeProfile?.displayName, describe, load, setOffline, t]);

  if (loading) {
    return <SafeAreaView style={{ flex: 1 }}><Loading label={t('common.loading')} /></SafeAreaView>;
  }

  if (!activeProfile) {
    return (
      <SafeAreaView style={{ flex: 1 }}>
        <EmptyState title={t('family.title')} body={t('caregiver.noPatients')} />
      </SafeAreaView>
    );
  }

  const you = caregivers.find((c) => c.isYou);

  return (
    <SafeAreaView style={{ flex: 1 }}>
      <ScrollView
        style={{ flex: 1, backgroundColor: theme.colors.background }}
        contentContainerStyle={{ padding: theme.spacing.lg, gap: theme.spacing.md, paddingBottom: theme.spacing.xxxl }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); void load(); }} />}
      >
        <Txt variant="h1" weight="bold" accessibilityRole="header">{t('family.title')}</Txt>

        {offline ? <Banner tone="warning" title={t('notifications.offlineBanner')} /> : null}
        {error ? (
          <Banner
            tone="danger"
            title={t('family.loadError')}
            body={error}
            action={<Button label={t('common.retry')} tone="ghost" fullWidth={false} onPress={() => void load()} />}
          />
        ) : null}

        {isOwner ? (
          <OwnerView
            active={active}
            pending={pending}
            busyId={busyId}
            onRevoke={(c) => remove(c, false)}
            onCall={primaryWithPhone?.phone ? () => void call(primaryWithPhone.phone as string) : null}
            primaryName={primaryWithPhone?.name ?? null}
          />
        ) : (
          <CaregiverSelfView
            you={you ?? null}
            patientName={activeProfile.displayName}
            busy={busyId !== null}
            onLeave={you ? () => remove(you, true) : null}
          />
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function OwnerView({
  active, pending, busyId, onRevoke, onCall, primaryName,
}: {
  active: CaregiverView[];
  pending: CaregiverView[];
  busyId: string | null;
  onRevoke: (caregiver: CaregiverView) => void;
  onCall: (() => void) | null;
  primaryName: string | null;
}) {
  const { t, bidi } = useI18n();
  const theme = useTheme();

  return (
    <>
      {onCall ? (
        <Button
          label={t('caregiver.callCaregiver')}
          size="large"
          onPress={onCall}
          accessibilityHint={primaryName ? t('family.callHint', { name: primaryName }) : undefined}
          testID="call-caregiver"
        />
      ) : null}

      <SectionTitle>{t('family.careCircle')}</SectionTitle>
      {active.length === 0 ? (
        <EmptyState
          title={t('family.empty')}
          body={t('family.emptyBody')}
          action={<Button label={t('family.addCaregiver')} fullWidth={false} onPress={() => router.push('/caregiver/invite')} />}
        />
      ) : (
        <View style={{ gap: theme.spacing.sm }}>
          {active.map((caregiver, index) => (
            <CaregiverCard
              key={caregiver.id}
              caregiver={caregiver}
              isPrimary={index === 0}
              busy={busyId === caregiver.id}
              onRevoke={() => onRevoke(caregiver)}
            />
          ))}
        </View>
      )}

      {pending.length > 0 ? (
        <>
          <SectionTitle>{t('family.pendingInvitations')}</SectionTitle>
          <View style={{ gap: theme.spacing.sm }}>
            {pending.map((caregiver) => (
              <CaregiverCard
                key={caregiver.id}
                caregiver={caregiver}
                isPrimary={false}
                busy={busyId === caregiver.id}
                onRevoke={() => onRevoke(caregiver)}
              />
            ))}
          </View>
        </>
      ) : null}

      <View style={{ gap: theme.spacing.sm, marginTop: theme.spacing.md }}>
        {active.length > 0 || pending.length > 0 ? (
          <Button label={t('family.addCaregiver')} onPress={() => router.push('/caregiver/invite')} />
        ) : null}
        <Button label={t('escalation.title')} tone="secondary" onPress={() => router.push('/caregiver/escalation')} />
      </View>
    </>
  );
}

function CaregiverCard({
  caregiver, isPrimary, busy, onRevoke,
}: { caregiver: CaregiverView; isPrimary: boolean; busy: boolean; onRevoke: () => void }) {
  const { t, formatDate, formatNumber, bidi } = useI18n();
  const theme = useTheme();

  const statusStyle = {
    active: { label: t('family.active'), fg: theme.colors.success700, bg: theme.colors.success100 },
    pending: { label: t('family.invitePending'), fg: theme.colors.warning700, bg: theme.colors.warning100 },
    expired: { label: t('family.expired'), fg: theme.colors.danger700, bg: theme.colors.danger100 },
    declined: { label: t('family.declined'), fg: theme.colors.ink700, bg: theme.colors.ink100 },
    revoked: { label: t('family.revoked'), fg: theme.colors.ink700, bg: theme.colors.ink100 },
  }[caregiver.status];

  const seen = caregiver.permissions.filter((p) => !isChange(p));
  const changed = caregiver.permissions.filter(isChange);
  const name = caregiver.name ?? (caregiver.phone ? bidi(caregiver.phone) : null) ?? t('common.none');

  const summary = (list: CaregiverPermission[]): string => {
    const shown = list.slice(0, 3).map((p) => t(`permission.${p}`));
    const rest = list.length - shown.length;
    return rest > 0
      ? `${shown.join(' · ')} — ${t('family.morePermissions', { count: formatNumber(rest) })}`
      : shown.join(' · ');
  };

  return (
    <Card accessibilityLabel={`${name}، ${t(`relationship.${caregiver.role}` as 'relationship.other')}، ${statusStyle.label}`}>
      <Row style={{ justifyContent: 'space-between' }} gap={theme.spacing.md}>
        <View style={{ flex: 1, gap: 2 }}>
          <Txt variant="bodyLarge" weight="bold" numberOfLines={1}>{name}</Txt>
          <Txt variant="bodySmall" color={theme.colors.ink500}>
            {t(`relationship.${caregiver.role}` as 'relationship.other')}
          </Txt>
        </View>
        <Badge label={statusStyle.label} fg={statusStyle.fg} bg={statusStyle.bg} />
      </Row>

      {isPrimary && caregiver.status === 'active' ? (
        <Badge label={t('family.primaryCaregiver')} fg={theme.colors.primary700} bg={theme.colors.primary100} />
      ) : (
        <Txt variant="caption" color={theme.colors.ink500}>
          {t('family.alertOrderValue', { priority: formatNumber(caregiver.escalationPriority) })}
        </Txt>
      )}

      {caregiver.status === 'pending' && caregiver.invitationExpiresAt ? (
        <Txt variant="bodySmall" color={theme.colors.warning700}>
          {t('family.invitationExpires', {
            date: formatDate(caregiver.invitationExpiresAt, undefined, {
              day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit',
            }),
          })}
        </Txt>
      ) : null}
      {caregiver.status === 'expired' ? (
        <Txt variant="bodySmall" color={theme.colors.danger700}>{t('family.invitationExpiredHint')}</Txt>
      ) : null}

      <Divider />

      {caregiver.permissions.length === 0 ? (
        <Txt variant="bodySmall" color={theme.colors.ink500}>{t('family.seesNothing')}</Txt>
      ) : (
        <View style={{ gap: theme.spacing.xs }}>
          {seen.length > 0 ? (
            <View style={{ gap: 2 }}>
              <Txt variant="caption" weight="bold" color={theme.colors.ink700}>{t('family.canSee')}</Txt>
              <Txt variant="bodySmall" color={theme.colors.ink500}>{summary(seen)}</Txt>
            </View>
          ) : null}
          {changed.length > 0 ? (
            <View style={{ gap: 2 }}>
              <Txt variant="caption" weight="bold" color={theme.colors.ink700}>{t('family.canChange')}</Txt>
              <Txt variant="bodySmall" color={theme.colors.ink500}>{summary(changed)}</Txt>
            </View>
          ) : null}
        </View>
      )}

      <Row gap={theme.spacing.sm} style={{ marginTop: theme.spacing.xs }}>
        <View style={{ flex: 1 }}>
          <Button
            label={t('family.manageCaregiver')}
            tone="secondary"
            onPress={() => router.push(`/caregiver/${caregiver.id}`)}
          />
        </View>
        {!theme.elderlyMode ? (
          <View style={{ flex: 1 }}>
            <Button label={t('family.revokeAccess')} tone="ghost" loading={busy} onPress={onRevoke} />
          </View>
        ) : null}
      </Row>
    </Card>
  );
}

/** What a caregiver sees when they open the care circle of the patient they follow. */
function CaregiverSelfView({
  you, patientName, busy, onLeave,
}: { you: CaregiverView | null; patientName: string; busy: boolean; onLeave: (() => void) | null }) {
  const { t, bidi } = useI18n();
  const theme = useTheme();

  if (!you) {
    return <EmptyState title={t('family.yourAccess')} body={t('caregiver.notShared', { name: patientName })} />;
  }

  const seen = you.permissions.filter((p) => !isChange(p));
  const changed = you.permissions.filter(isChange);

  return (
    <>
      <SectionTitle>{t('family.yourAccess')}</SectionTitle>
      <Card>
        <Txt variant="bodyLarge" weight="bold">{t('family.youFollow', { name: patientName })}</Txt>
        <Txt variant="bodySmall" color={theme.colors.ink500}>{t('family.permissionsSetByPatient')}</Txt>
        <Divider />
        {you.permissions.length === 0 ? (
          <Txt variant="bodySmall" color={theme.colors.ink500}>{t('family.seesNothing')}</Txt>
        ) : (
          <View style={{ gap: theme.spacing.md }}>
            {seen.length > 0 ? (
              <View style={{ gap: theme.spacing.xs }}>
                <Txt variant="caption" weight="bold" color={theme.colors.ink700}>{t('family.canSee')}</Txt>
                {seen.map((p) => (
                  <Txt key={p} variant="bodySmall" color={theme.colors.ink700}>{`• ${t(`permission.${p}`)}`}</Txt>
                ))}
              </View>
            ) : null}
            {changed.length > 0 ? (
              <View style={{ gap: theme.spacing.xs }}>
                <Txt variant="caption" weight="bold" color={theme.colors.ink700}>{t('family.canChange')}</Txt>
                {changed.map((p) => (
                  <Txt key={p} variant="bodySmall" color={theme.colors.ink700}>{`• ${t(`permission.${p}`)}`}</Txt>
                ))}
              </View>
            ) : null}
          </View>
        )}
      </Card>

      <Button label={t('caregiver.dashboard')} onPress={() => router.push('/caregiver/dashboard')} />
      {onLeave ? (
        <Button label={t('family.leaveCircle')} tone="danger" loading={busy} onPress={onLeave} />
      ) : null}
    </>
  );
}
