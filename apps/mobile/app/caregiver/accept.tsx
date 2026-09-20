import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Banner, Button, EmptyState, Loading, Screen, Txt } from '@/components/ui';
import { useI18n } from '@/i18n';
import { useApp } from '@/state/app-store';
import { api, ApiError, NetworkError } from '@/api/client';
import { PhoneVerification } from '@/components/PhoneVerification';
import { InvitationPermissions, type InvitationPreview } from '@/components/InvitationPermissions';
import { useRequestScope } from '@/hooks/useRequestScope';
import { clearPendingInvite, peekPendingInvite, stashPendingInvite } from '@/storage/pending-invite';

export default function AcceptInvitationScreen() {
  const params = useLocalSearchParams<{ token?: string }>();
  const { user, signedIn } = useApp();
  // Key all asynchronous/UI state to the account and incoming capability.
  return <InvitationFlow key={`${signedIn ? user?.id : 'signed-out'}:${params.token ?? 'stored'}`} incomingToken={params.token} />;
}

function InvitationFlow({ incomingToken }: { incomingToken?: string }) {
  const { t } = useI18n();
  const { user, signedIn, refreshProfiles, setActiveProfile, setOffline } = useApp();
  const { begin, capture } = useRequestScope(`${user?.id}:${incomingToken ?? ''}`);
  const [token, setToken] = useState<string | null>(null);
  const [resolved, setResolved] = useState(false);
  const [preview, setPreview] = useState<InvitationPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const [verification, setVerification] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [accepted, setAccepted] = useState<{ profileId: string; patientName: string } | null>(null);
  const [refreshed, setRefreshed] = useState(false);

  useEffect(() => {
    const current = capture();
    void (async () => {
      if (incomingToken) await stashPendingInvite(incomingToken);
      const value = incomingToken ?? await peekPendingInvite();
      if (current()) { setToken(value); setResolved(true); }
    })();
  }, [capture, incomingToken]);

  const reportError = useCallback(async (err: unknown, current: () => boolean) => {
    if (!current()) return;
    if (err instanceof NetworkError) {
      setOffline(true); setError(t('notifications.offlineBanner')); return;
    }
    if (err instanceof ApiError) {
      if (err.code === 'phone_verification_required') {
        setPreview(null); setVerification(true); return;
      }
      if (err.status === 410 || err.code === 'invitation_expired') {
        setPreview(null); setError(t('accept.expiredBody'));
        await clearPendingInvite(); return;
      }
      if (err.code === 'invitation_invalid') {
        // A wrong-account attempt keeps the capability for account switching.
        setPreview(null); setError(t(Platform.OS === 'web' ? 'accept.webIdentityHelp' : 'accept.invalidBody')); return;
      }
    }
    setError(t('error.internal_error'));
  }, [setOffline, t]);

  const review = useCallback(async () => {
    if (!signedIn || !token) return;
    const current = begin();
    setLoading(true); setVerification(false); setPreview(null);
    try {
      const result = await api.post<InvitationPreview>('/v1/caregivers/invitations/preview', { token });
      if (current()) { setPreview(result); setOffline(false); }
    } catch (err) { await reportError(err, current); }
    finally { if (current()) setLoading(false); }
  }, [begin, reportError, setOffline, signedIn, token]);

  // Opening the link, finishing sign-in and verifying the phone only REVIEW it.
  useEffect(() => { void review(); }, [review]);

  const openAccepted = async (result: { profileId: string; patientName: string }, current: () => boolean) => {
    try {
      await refreshProfiles();
      if (current()) { setActiveProfile(result.profileId); setRefreshed(true); setError(null); }
    } catch { if (current()) setError(t('accept.refreshRequired')); }
  };

  const accept = async () => {
    if (!preview || submitting.current || !Array.isArray(preview.permissions)) return;
    const current = capture();
    if (!current()) return;
    submitting.current = true; setBusy(true); setError(null);
    try {
      const result = await api.post<{ profileId: string }>('/v1/caregivers/invitations/accept', {
        relationshipId: preview.id, role: preview.role, permissions: preview.permissions,
      });
      if (!current()) return;
      const completed = { profileId: result.profileId, patientName: preview.patientName };
      setAccepted(completed);
      await clearPendingInvite();
      if (current()) await openAccepted(completed, current);
    } catch (err) {
      if (!current()) return;
      if (err instanceof ApiError && err.code === 'invitation_changed') {
        setError(t('accept.changed')); await review();
      } else await reportError(err, current);
    } finally { if (current()) { submitting.current = false; setBusy(false); } }
  };

  const close = async () => { await clearPendingInvite(); router.replace('/'); };
  if (!resolved) return <Loading label={t('accept.checking')} />;
  if (!token) return <EmptyState title={t('accept.invalidTitle')} body={t('accept.missingToken')}
    action={<Button label={t('common.close')} onPress={() => router.replace('/')} />} />;
  if (!signedIn) return <SafeAreaView style={{ flex: 1 }}><Screen>
    <Txt variant="h1" weight="bold">{t('accept.signInTitle')}</Txt>
    <Txt>{t(Platform.OS === 'web' ? 'accept.webSignInBody' : 'accept.signInBody')}</Txt>
    <Button label={t('accept.signIn')} onPress={() => router.push('/(auth)/sign-in')} />
    <Button label={t('auth.signUp')} tone="secondary" onPress={() => router.push('/(auth)/sign-up')} />
  </Screen></SafeAreaView>;

  return <SafeAreaView style={{ flex: 1 }}><Screen>
    <Txt variant="h1" weight="bold" accessibilityRole="header">{t(accepted ? 'accept.acceptedTitle' : 'accept.title', { name: accepted?.patientName ?? '' })}</Txt>
    {error ? <Banner tone="warning" title={error} /> : null}
    {accepted ? <>
      <Txt>{t('accept.acceptedBody', { name: accepted.patientName })}</Txt>
      {preview ? <InvitationPermissions invitation={preview} /> : null}
      <Button label={t(refreshed ? 'accept.openDashboard' : 'common.retry')} onPress={() => {
        if (refreshed) { setActiveProfile(accepted.profileId); router.replace('/caregiver/dashboard'); }
        else void openAccepted(accepted, capture());
      }} />
    </> : loading ? <Loading label={t('accept.checking')} />
      : verification ? <PhoneVerification key={user?.id} onVerified={() => void review()} />
        : preview ? <>
          <InvitationPermissions invitation={preview} />
          <Button label={t('invite.accept', { name: preview.patientName })} size="large" loading={busy}
            disabled={busy || !Array.isArray(preview.permissions)} onPress={() => void accept()} />
        </> : <Button label={t('common.retry')} onPress={() => { setError(null); void review(); }} />}
    <Button label={t(accepted ? 'common.close' : 'accept.notNow')} tone="ghost" disabled={busy} onPress={() => void close()} />
  </Screen></SafeAreaView>;
}
