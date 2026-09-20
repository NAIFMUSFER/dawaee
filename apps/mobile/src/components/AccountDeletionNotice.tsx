import React, { useRef, useState, useSyncExternalStore } from 'react';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useApp } from '@/state/app-store';
import { useI18n } from '@/i18n';
import { api } from '@/api/client';
import { useRequestScope } from '@/hooks/useRequestScope';
import { PrivacyModal } from '@/security/PrivacyModal';
import { getDeletionReceipt, setDeletionReceipt, subscribeDeletionReceipt } from '@/privacy/deletion-receipt';
import { Banner, Button, Screen, Txt } from './ui';

export function DeletionReceiptNotice() {
  const scheduledFor = useSyncExternalStore(subscribeDeletionReceipt, getDeletionReceipt, getDeletionReceipt);
  const { t, formatDate, formatTime } = useI18n();
  return <PrivacyModal visible={Boolean(scheduledFor)} onRequestClose={() => setDeletionReceipt(null)}>
    {scheduledFor ? <SafeAreaView style={{ flex: 1 }}><Screen>
      <Txt variant="h1" weight="bold">{t('privacy.deleteRequested')}</Txt>
      <Txt>{t('privacy.deleteScheduled', { date: formatDate(scheduledFor), time: formatTime(scheduledFor) })}</Txt>
      <Txt>{t('privacy.deleteSignedOut')}</Txt>
      <Txt>{t('privacy.deleteRecovery')}</Txt>
      <Button label={t('common.ok')} onPress={() => setDeletionReceipt(null)} />
    </Screen></SafeAreaView> : null}
  </PrivacyModal>;
}

/** Fresh sign-in during grace shows recovery instead of the clinical screens. */
export function PendingDeletionScreen() {
  const { user } = useApp();
  return <PendingDeletion key={user?.id} />;
}
function PendingDeletion() {
  const { user, refreshProfiles, signOut } = useApp();
  const { t, formatDate, formatTime } = useI18n();
  const { capture } = useRequestScope(user?.id ?? 'none');
  const submitting = useRef(false);
  const [busy, setBusy] = useState(false);
  const [restored, setRestored] = useState(false);
  const [error, setError] = useState(false);
  const date = user?.deletionScheduledFor;
  const cancel = async () => {
    if (submitting.current) return;
    const current = capture(); submitting.current = true; setBusy(true); setError(false);
    try {
      if (!restored) {
        await api.post('/v1/me/deletion-cancel', { confirm: true });
        if (!current()) return;
        setRestored(true);
      }
      await refreshProfiles();
    } catch { if (current()) setError(true); }
    finally { if (current()) { submitting.current = false; setBusy(false); } }
  };
  return <SafeAreaView style={{ flex: 1 }}><Screen>
    <Txt variant="h1" weight="bold">{t(restored ? 'privacy.deleteCancelled' : 'privacy.deleteRequested')}</Txt>
    {date && !restored ? <Txt>{t('privacy.deleteScheduled', { date: formatDate(date), time: formatTime(date) })}</Txt> : null}
    <Txt>{t('privacy.deleteRecovery')}</Txt>
    {error ? <Banner tone="warning" title={t('privacy.deleteRecoveryFailed')} /> : null}
    {(restored || (date && Date.parse(date) > Date.now())) ? <Button label={t(restored ? 'common.retry' : 'privacy.deleteCancel')}
      loading={busy} onPress={() => void cancel()} /> : null}
    <Button label={t('settings.signOut')} tone="secondary" disabled={busy} onPress={() => void signOut()} />
  </Screen></SafeAreaView>;
}
