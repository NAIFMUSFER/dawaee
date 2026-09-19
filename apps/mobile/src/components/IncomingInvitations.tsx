import React, { useCallback, useState } from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';
import { api } from '@/api/client';
import { useApp } from '@/state/app-store';
import { useI18n } from '@/i18n';
import { useScreenRefresh } from '@/hooks/useScreenRefresh';
import { useRequestScope } from '@/hooks/useRequestScope';
import { Banner, Button, Card, SectionTitle, Txt } from './ui';

type Invitation = { id: string; patientName: string; role: string; expiresAt: string };
/** Invitations remain discoverable after email verification in a new tab.
 * The server returns only invitations to this account's verified mailbox. */
export function IncomingInvitations() {
  const { user, refreshProfiles, setActiveProfile } = useApp();
  const { t } = useI18n();
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [acceptedProfileId, setAcceptedProfileId] = useState<string | null>(null);
  const { begin, capture } = useRequestScope(user?.id ?? 'none');
  const load = useCallback(async () => {
    const current = begin();
    try {
      const res = await api.get<{ invitations: Invitation[] }>('/v1/caregivers/incoming');
      if (current()) setInvitations(res.invitations);
    } catch { /* Keep a known invitation visible until the next refresh. */ }
  }, [begin]);
  useScreenRefresh(load, user?.id ?? 'none');
  const accept = async (invitation: Invitation) => {
    if (busy) return;
    const current = capture();
    setBusy(invitation.id); setError(false);
    try {
      const res = await api.post<{ profileId: string }>('/v1/caregivers/incoming/accept', { relationshipId: invitation.id });
      if (!current()) return;
      setAcceptedProfileId(res.profileId);
      await refreshProfiles();
      if (!current()) return;
      setActiveProfile(res.profileId);
      router.push('/caregiver/dashboard');
    } catch { if (current()) setError(true); }
    finally { if (current()) setBusy(null); }
  };
  const reopen = async () => {
    if (!acceptedProfileId || busy) return;
    const current = capture(); setBusy('refresh');
    try { await refreshProfiles(); if (current()) { setActiveProfile(acceptedProfileId); router.push('/caregiver/dashboard'); } }
    catch { if (current()) setError(true); }
    finally { if (current()) setBusy(null); }
  };
  if (!invitations.length && !error && !acceptedProfileId) return null;
  return <View>
    <SectionTitle>{t('invite.incoming')}</SectionTitle>
    {acceptedProfileId ? <Banner tone="success" title={t('accept.refreshRequired')}
      action={<Button label={t('common.continue')} loading={busy === 'refresh'} onPress={() => void reopen()} />} />
      : error ? <Banner tone="danger" title={t('error.internal_error')} /> : null}
    {invitations.map(invitation => <Card key={invitation.id}>
      <Txt>{invitation.patientName}</Txt>
      <Button label={t('invite.accept', { name: invitation.patientName })} loading={busy === invitation.id}
        disabled={busy !== null} onPress={() => void accept(invitation)} />
    </Card>)}
  </View>;
}
