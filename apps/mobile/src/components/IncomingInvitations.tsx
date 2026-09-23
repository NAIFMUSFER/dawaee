import React, { useCallback, useRef, useState } from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';
import { api, ApiError } from '@/api/client';
import { useApp } from '@/state/app-store';
import { useI18n } from '@/i18n';
import { useScreenRefresh } from '@/hooks/useScreenRefresh';
import { useRequestScope } from '@/hooks/useRequestScope';
import { Banner, Button, Card, SectionTitle } from './ui';
import { InvitationPermissions, type InvitationPreview } from './InvitationPermissions';

type Invitation = InvitationPreview;
/** Recover invitations after email/phone verification, including a QR opened
 * on another device. The server enforces the exact verified recipient. */
export function IncomingInvitations() {
  const { user } = useApp();
  return <IncomingInvitationList key={user?.id ?? 'none'} />;
}
function IncomingInvitationList() {
  const { user, refreshProfiles, setActiveProfile } = useApp();
  const { t } = useI18n();
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const submitting = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [acceptedProfileId, setAcceptedProfileId] = useState<string | null>(null);
  const { begin, capture } = useRequestScope(user?.id ?? 'none');
  const load = useCallback(async () => {
    const current = begin();
    try {
      const res = await api.get<{ invitations: Invitation[] }>('/v1/caregivers/incoming');
      if (current()) { setInvitations(res.invitations); setLoadError(null); }
    } catch { if (current()) setLoadError(t('invite.incomingLoadFailed')); }
  }, [begin, t]);
  useScreenRefresh(load, user?.id ?? 'none');
  const accept = async (invitation: Invitation) => {
    if (submitting.current || !Array.isArray(invitation.permissions)) return;
    const current = capture();
    if (!current()) return;
    submitting.current = true; setBusy(invitation.id); setError(null);
    try {
      const res = await api.post<{ profileId: string }>('/v1/caregivers/invitations/accept', {
        relationshipId: invitation.id, role: invitation.role, permissions: invitation.permissions,
      });
      if (!current()) return;
      setAcceptedProfileId(res.profileId);
      await refreshProfiles();
      if (!current()) return;
      setActiveProfile(res.profileId);
      router.push('/caregiver/dashboard');
    } catch (err) {
      if (!current()) return;
      if (err instanceof ApiError && err.code === 'invitation_changed') {
        setError(t('accept.changed'));
        // Remove the stale approval immediately; a failed reload cannot leave
        // its button available against a different grant.
        setInvitations(items => items.filter(item => item.id !== invitation.id));
        await load();
      } else setError(t('error.internal_error'));
    }
    finally { if (current()) { submitting.current = false; setBusy(null); } }
  };
  const reopen = async () => {
    if (!acceptedProfileId || busy) return;
    const current = capture(); setBusy('refresh');
    try { await refreshProfiles(); if (current()) { setActiveProfile(acceptedProfileId); router.push('/caregiver/dashboard'); } }
    catch { if (current()) setError(t('error.internal_error')); }
    finally { if (current()) setBusy(null); }
  };
  if (!invitations.length && !error && !loadError && !acceptedProfileId) return null;
  return <View>
    <SectionTitle>{t('invite.incoming')}</SectionTitle>
    {acceptedProfileId ? <Banner tone="success" title={t('accept.refreshRequired')}
      action={<Button label={t('common.continue')} loading={busy === 'refresh'} onPress={() => void reopen()} />} />
      : error || loadError ? <Banner tone="warning" title={error ?? loadError ?? ''} action={<Button label={t('common.retry')} onPress={() => void load()} />} /> : null}
    {acceptedProfileId ? null : invitations.map(invitation => <Card key={invitation.id}>
      <InvitationPermissions invitation={invitation} />
      <Button label={t('invite.accept', { name: invitation.patientName })} loading={busy === invitation.id}
        disabled={busy !== null || !Array.isArray(invitation.permissions)} onPress={() => void accept(invitation)} />
    </Card>)}
  </View>;
}
