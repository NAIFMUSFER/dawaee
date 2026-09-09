import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { View } from 'react-native';
import { claimInviteAttempt, clearPendingInvite, peekPendingInvite, stashPendingInvite } from '@/storage/pending-invite';
import { router, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Banner, Button, Card, Divider, EmptyState, Loading, Screen, Txt } from '@/components/ui';
import { useI18n } from '@/i18n';
import { useTheme } from '@/hooks/useTheme';
import { useApp } from '@/state/app-store';
import { api, ApiError, NetworkError } from '@/api/client';
import type { CaregiverPermission } from '@dawaee/shared';

/**
 * Accepting a care-circle invitation.
 *
 * The link may be opened by someone who has never signed in, so the token is
 * parked in storage before we send them to sign-in and picked back up when
 * they return — losing an invitation to a sign-in detour would leave the
 * patient waiting for an acceptance that silently never happens.
 *
 * Every outcome the server distinguishes is shown as a different screen: an
 * expired link and a already-used link need different next steps from the
 * person holding them.
 */


const CHANGE_PERMISSIONS: readonly CaregiverPermission[] = [
  'edit_schedule', 'add_medication', 'edit_medication', 'update_stock', 'confirm_dose', 'manage_caregivers',
];

interface AcceptResponse {
  accepted: boolean;
  relationshipId: string | null;
  /** The API returns the raw profile row here, so both spellings are tolerated. */
  profile: { id: string; displayName?: string | null; display_name?: string | null } | null;
}

type Outcome =
  | { kind: 'idle' }
  | { kind: 'working' }
  | { kind: 'accepted'; profileId: string | null; patientName: string }
  | { kind: 'expired' }
  | { kind: 'used' }
  | { kind: 'invalid'; message: string | null }
  | { kind: 'offline' };

export default function AcceptInvitationScreen() {
  const params = useLocalSearchParams<{ token?: string }>();
  const { t } = useI18n();
  const theme = useTheme();
  const { signedIn, profiles, refreshProfiles, setOffline } = useApp();

  const [token, setToken] = useState<string | null>(params.token ?? null);
  const [tokenResolved, setTokenResolved] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>({ kind: 'idle' });

  // A token that arrived on the URL survives the sign-in detour; one that did
  // not arrive at all may still be waiting from a previous attempt.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (params.token) {
        await stashPendingInvite(params.token);
        if (!cancelled) { setToken(params.token); setTokenResolved(true); }
        return;
      }
      const stored = await peekPendingInvite();
      if (!cancelled) { setToken(stored); setTokenResolved(true); }
    })();
    return () => { cancelled = true; };
  }, [params.token]);

  const accept = useCallback(async (value: string) => {
    setOutcome({ kind: 'working' });
    try {
      const res = await api.post<AcceptResponse>('/v1/caregivers/accept', { token: value });
      await clearPendingInvite();
      await refreshProfiles().catch(() => undefined);
      setOffline(false);
      setOutcome({
        kind: 'accepted',
        profileId: res.profile?.id ?? null,
        patientName: res.profile?.displayName ?? res.profile?.display_name ?? '',
      });
    } catch (err) {
      if (err instanceof NetworkError) {
        setOffline(true);
        setOutcome({ kind: 'offline' });
        return;
      }
      if (err instanceof ApiError) {
        // Expired, already used, or invalid: each is a permanent result for
        // this stored bearer. Forget it so the next sign-in cannot route the
        // person back to a capability the server has already refused. Network
        // errors stay above this block because they are retryable.
        if (err.status === 410 || err.code === 'invitation_expired') {
          await clearPendingInvite();
          setOutcome({ kind: 'expired' });
          return;
        }
        if (err.status === 409 || err.code === 'invitation_already_used') {
          await clearPendingInvite();
          setOutcome({ kind: 'used' });
          return;
        }
        if (err.code === 'invitation_invalid') {
          await clearPendingInvite();
          const key = `error.${err.code}` as 'error.internal_error';
          const text = t(key);
          setOutcome({ kind: 'invalid', message: text === key ? err.message : text });
          return;
        }
        const key = `error.${err.code}` as 'error.internal_error';
        const text = t(key);
        setOutcome({ kind: 'invalid', message: text === key ? err.message : text });
        return;
      }
      setOutcome({ kind: 'invalid', message: t('error.internal_error') });
    }
  }, [refreshProfiles, setOffline, t]);

  /**
   * Accept at most once per token, ever.
   *
   * `outcome.kind !== 'idle'` is not enough of a guard. Two effect runs in the
   * same commit both read `idle` before either `setOutcome` lands, so the
   * invitation was accepted TWICE — and an invitation is single-use: the first
   * call succeeded and burned the token, the second got "invitation not found",
   * and the screen showed the caregiver "this invitation link is not valid"
   * for an invitation they had just successfully accepted. They would have
   * asked the patient to send another one, which would have done the same
   * thing again.
   *
   * The claim lives outside this component because the guard has to outlive
   * it: this screen is mounted TWICE during the flow — once before the
   * sign-in detour and once after the return — and both instances become
   * eligible the moment `signedIn` flips. A ref would give each its own guard,
   * and both would fire.
   */
  useEffect(() => {
    if (!tokenResolved || !signedIn || !token) return;
    if (!claimInviteAttempt(token)) return;
    void accept(token);
  }, [accept, signedIn, token, tokenResolved]);

  const acceptedProfile = useMemo(
    () => (outcome.kind === 'accepted' && outcome.profileId
      ? profiles.find((p) => p.id === outcome.profileId) ?? null
      : null),
    [outcome, profiles],
  );

  if (!tokenResolved) {
    return <SafeAreaView style={{ flex: 1 }}><Loading label={t('accept.checking')} /></SafeAreaView>;
  }

  if (!token) {
    return (
      <SafeAreaView style={{ flex: 1 }}>
        <Screen>
          <EmptyState
            title={t('accept.invalidTitle')}
            body={t('accept.missingToken')}
            action={<Button label={t('common.close')} fullWidth={false} onPress={() => router.replace('/')} />}
          />
        </Screen>
      </SafeAreaView>
    );
  }

  if (!signedIn) {
    return (
      <SafeAreaView style={{ flex: 1 }}>
        <Screen>
          <Txt variant="h1" weight="bold" accessibilityRole="header">{t('accept.signInTitle')}</Txt>
          <Txt variant="body" color={theme.colors.ink700}>{t('accept.signInBody')}</Txt>
          <Button label={t('accept.signIn')} size="large" onPress={() => router.push('/(auth)/sign-in')} />
        </Screen>
      </SafeAreaView>
    );
  }

  if (outcome.kind === 'idle' || outcome.kind === 'working') {
    return <SafeAreaView style={{ flex: 1 }}><Loading label={t('accept.checking')} /></SafeAreaView>;
  }

  if (outcome.kind === 'offline') {
    return (
      <SafeAreaView style={{ flex: 1 }}>
        <Screen>
          <Txt variant="h2" weight="bold" accessibilityRole="header">{t('accept.title')}</Txt>
          <Banner tone="warning" title={t('notifications.offlineBanner')} />
          <Button label={t('common.retry')} onPress={() => void accept(token)} />
        </Screen>
      </SafeAreaView>
    );
  }

  if (outcome.kind === 'expired' || outcome.kind === 'used' || outcome.kind === 'invalid') {
    const copy = outcome.kind === 'expired'
      ? { title: t('accept.expiredTitle'), body: t('accept.expiredBody') }
      : outcome.kind === 'used'
        ? { title: t('accept.usedTitle'), body: t('accept.usedBody') }
        : { title: t('accept.invalidTitle'), body: outcome.message ?? t('accept.invalidBody') };

    return (
      <SafeAreaView style={{ flex: 1 }}>
        <Screen>
          <EmptyState
            title={copy.title}
            body={copy.body}
            action={<Button label={t('common.close')} fullWidth={false} onPress={() => router.replace('/')} />}
          />
        </Screen>
      </SafeAreaView>
    );
  }

  const permissions = acceptedProfile?.permissions ?? [];
  const seen = permissions.filter((p) => !CHANGE_PERMISSIONS.includes(p));
  const changed = permissions.filter((p) => CHANGE_PERMISSIONS.includes(p));
  const patientName = acceptedProfile?.displayName ?? outcome.patientName;

  return (
    <SafeAreaView style={{ flex: 1 }}>
      <Screen>
        <Txt variant="h1" weight="bold" accessibilityRole="header">
          {t('accept.acceptedTitle', { name: patientName })}
        </Txt>
        <Txt variant="body" color={theme.colors.ink700}>{t('accept.acceptedBody', { name: patientName })}</Txt>

        <Card>
          {permissions.length === 0 ? (
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
                <>
                  <Divider />
                  <View style={{ gap: theme.spacing.xs }}>
                    <Txt variant="caption" weight="bold" color={theme.colors.ink700}>{t('family.canChange')}</Txt>
                    {changed.map((p) => (
                      <Txt key={p} variant="bodySmall" color={theme.colors.ink700}>{`• ${t(`permission.${p}`)}`}</Txt>
                    ))}
                  </View>
                </>
              ) : null}
            </View>
          )}
          <Txt variant="caption" color={theme.colors.ink500}>{t('family.permissionsSetByPatient')}</Txt>
        </Card>

        <Button
          label={t('accept.openDashboard')}
          size="large"
          onPress={() =>
            router.replace(outcome.profileId
              ? `/caregiver/dashboard?profileId=${outcome.profileId}`
              : '/caregiver/dashboard')}
        />
        <Button label={t('common.close')} tone="ghost" onPress={() => router.replace('/')} />
      </Screen>
    </SafeAreaView>
  );
}
