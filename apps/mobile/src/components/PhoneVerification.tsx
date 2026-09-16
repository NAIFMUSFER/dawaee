import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Banner, Button, Card, Field, Loading, Txt } from '@/components/ui';
import { useI18n } from '@/i18n';
import { api } from '@/api/client';
import { useRequestScope } from '@/hooks/useRequestScope';
import { phoneVerificationSupported, startPhoneProof, type PhoneChallenge } from '@/security/phone-proof';
import { useApp } from '@/state/app-store';

export function PhoneVerification({ onVerified }: { onVerified?: () => void }) {
  const { t } = useI18n();
  const { user } = useApp();
  const { begin, capture } = useRequestScope(user?.id ?? '');
  const [phone, setPhone] = useState<string | null>(null);
  const [verified, setVerified] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const challenge = useRef<PhoneChallenge | null>(null);
  const busyRef = useRef(false);
  const completed = useRef(false);

  const load = useCallback(async () => {
    const current = begin();
    setLoading(true); setError(null);
    try {
      const result = await api.get<{ phone: string | null; verified: boolean }>('/v1/auth/phone-verification');
      if (!current()) return;
      setPhone(result.phone); setVerified(result.verified);
    } catch { if (current()) setError(t('phoneVerification.loadError')); }
    finally { if (current()) setLoading(false); }
  }, [begin, t]);
  useEffect(() => { void load(); return () => { challenge.current?.cancel(); }; }, [load]);

  const send = async () => {
    if (busyRef.current || !phone || !phoneVerificationSupported) return;
    busyRef.current = true; setBusy(true); setError(null); setCode('');
    const current = capture();
    challenge.current?.cancel();
    completed.current = false;
    try {
      const next = await startPhoneProof(phone, async (idToken) => {
        if (!current()) return;
        try {
          await api.post('/v1/auth/phone-verification', { idToken });
          if (!current()) return;
          completed.current = true; setVerified(true); setSent(false); setCode('');
          onVerified?.();
        } catch {
          if (current()) { setSent(false); setError(t('phoneVerification.failed')); }
        }
      }, () => {
        if (current()) { setSent(false); setError(t('phoneVerification.failed')); }
      });
      if (!current() || completed.current) { next.cancel(); return; }
      challenge.current = next; setSent(true);
    } catch { if (current()) setError(t('phoneVerification.failed')); }
    finally { busyRef.current = false; if (current()) setBusy(false); }
  };

  const confirm = async () => {
    if (busyRef.current || !challenge.current || !/^\d{6}$/.test(code.trim())) return;
    busyRef.current = true; setBusy(true); setError(null);
    const current = capture();
    try { await challenge.current.confirm(code.trim()); }
    catch { if (current()) setError(t('phoneVerification.codeError')); }
    finally { busyRef.current = false; if (current()) setBusy(false); }
  };

  if (loading) return <Loading />;
  if (verified) return <Card>
    <Banner tone="success" title={t('phoneVerification.verified')} />
    {onVerified ? <Button label={t('common.continue')} onPress={onVerified} /> : null}
  </Card>;
  return <Card>
    <Txt variant="h2" weight="bold">{t('phoneVerification.title')}</Txt>
    <Txt>{t('phoneVerification.body')}</Txt>
    {phone ? <Txt>{phone}</Txt> : null}
    {error ? <Banner tone="warning" title={error} /> : null}
    {!phone ? <>
      <Txt>{t('phoneVerification.noPhone')}</Txt>
      <Button label={t('common.retry')} onPress={() => void load()} />
    </> : !phoneVerificationSupported ? <Txt>{t('phoneVerification.androidRequired')}</Txt> : sent ? <>
      <Field label={t('phoneVerification.code')} value={code} onChangeText={setCode}
        keyboardType="number-pad" textContentType="oneTimeCode" maxLength={6} autoComplete="sms-otp" />
      <Button label={t('phoneVerification.confirm')} onPress={() => void confirm()} loading={busy} disabled={code.trim().length !== 6} />
      <Button label={t('phoneVerification.restart')} tone="ghost" disabled={busy} onPress={() => {
        challenge.current?.cancel(); challenge.current = null; setSent(false); setCode(''); setError(null);
      }} />
    </> : <>
      <Txt variant="caption">{t('phoneVerification.consent')}</Txt>
      <Button label={t('phoneVerification.send')} onPress={() => void send()} loading={busy} />
    </>}
  </Card>;
}

export default PhoneVerification;
