import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Banner, Button, Card, Field, Loading, Txt } from '@/components/ui';
import { useI18n } from '@/i18n';
import { api, ApiError } from '@/api/client';
import { useRequestScope } from '@/hooks/useRequestScope';
import { phoneVerificationSupported, startPhoneProof, type PhoneChallenge } from '@/security/phone-proof';
import { useApp } from '@/state/app-store';
import { normalizeDigits } from '@dawaee/shared';
import { phoneForProof } from '@/security/phone-number';
import { phoneProofErrorKey } from '@/security/phone-proof-errors';

export function PhoneVerification({ onVerified, initialPhone = '', initialPassword = '' }: {
  onVerified?: () => void; initialPhone?: string; initialPassword?: string;
}) {
  const { t } = useI18n();
  const { user, refreshProfiles } = useApp();
  const { begin, capture } = useRequestScope(user?.id ?? '');
  const [newPhone, setNewPhone] = useState(initialPhone);
  const [password, setPassword] = useState(initialPassword);
  const [reusePassword, setReusePassword] = useState(Boolean(initialPassword));
  const [phone, setPhone] = useState<string | null>(null);
  const [verified, setVerified] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const challenge = useRef<PhoneChallenge | null>(null);
  const busyRef = useRef(false);
  const completed = useRef(false);

  const load = useCallback(async () => {
    const current = begin();
    setLoading(true); setError(null); setLoaded(false);
    try {
      const result = await api.get<{ phone: string | null; verified: boolean }>('/v1/auth/phone-verification');
      if (!current()) return;
      setPhone(result.phone); setVerified(result.verified); setLoaded(true);
    } catch { if (current()) setError(t('phoneVerification.loadError')); }
    finally { if (current()) setLoading(false); }
  }, [begin, t]);
  useEffect(() => { void load(); return () => { challenge.current?.cancel(); }; }, [load]);

  const send = async () => {
    const targetPhone = phone ?? phoneForProof(newPhone);
    if (busyRef.current || !targetPhone || !phoneVerificationSupported || (!phone && !password)) return;
    busyRef.current = true; setBusy(true); setError(null); setCode('');
    const current = capture();
    challenge.current?.cancel();
    completed.current = false;
    try {
      const next = await startPhoneProof(targetPhone, async (idToken) => {
        if (!current()) return;
        try {
          if (phone) await api.post('/v1/auth/phone-verification', { idToken });
          else await api.post('/v1/auth/phone', { idToken, currentPassword: password });
          if (!current()) return;
          if (!phone) {
            setPhone(targetPhone); setPassword(''); setNewPhone('');
          }
          completed.current = true; setVerified(true); setSent(false); setCode('');
          // A failed profile refresh cannot undo a verified server-side link.
          await refreshProfiles().catch(() => undefined);
          if (!current()) return;
          onVerified?.();
        } catch (err) {
          if (current()) {
            setSent(false);
            if (err instanceof ApiError && err.code === 'invalid_credentials') {
              setPassword(''); setReusePassword(false);
            }
            setError(t(!phone && err instanceof ApiError && err.code === 'invalid_credentials'
              ? 'auth.currentPasswordWrong' : !phone ? 'phoneVerification.linkFailed' : 'phoneVerification.failed'));
          }
        }
      }, (err) => {
        if (current()) { setSent(false); setError(t(phoneProofErrorKey(err))); }
      });
      if (!current() || completed.current) { next.cancel(); return; }
      challenge.current = next; setSent(true);
    } catch (err) { if (current()) setError(t(phoneProofErrorKey(err))); }
    finally { busyRef.current = false; if (current()) setBusy(false); }
  };

  const confirm = async () => {
    const normalized = normalizeDigits(code).trim();
    if (busyRef.current || !challenge.current || !/^\d{6}$/.test(normalized)) return;
    busyRef.current = true; setBusy(true); setError(null);
    const current = capture();
    try { await challenge.current.confirm(normalized); }
    catch (err) { if (current()) setError(t(phoneProofErrorKey(err))); }
    finally { busyRef.current = false; if (current()) setBusy(false); }
  };

  if (loading) return <Loading />;
  if (loaded && verified) return <Card>
    <Banner tone="success" title={t('phoneVerification.verified')} />
    {onVerified ? <Button label={t('common.continue')} onPress={onVerified} /> : null}
  </Card>;
  return <Card>
    <Txt variant="h2" weight="bold">{t('phoneVerification.title')}</Txt>
    <Txt>{t('phoneVerification.body')}</Txt>
    {phone ? <Txt>{phone}</Txt> : null}
    {error ? <Banner tone="warning" title={error} /> : null}
    {!loaded ? <Button label={t('common.retry')} onPress={() => void load()} /> : !phone && !phoneVerificationSupported ?
      <Txt>{t('phoneVerification.androidRequired')}</Txt> : !phone ? <>
      <Txt>{t('phoneVerification.noPhone')}</Txt>
      <Field label={t('invite.phone')} value={newPhone} onChangeText={setNewPhone} keyboardType="phone-pad" maxLength={20} editable={!busy && !sent} />
      {!reusePassword ? <Field label={t('auth.password')} value={password} onChangeText={setPassword} secureTextEntry autoCapitalize="none" editable={!busy && !sent} /> : null}
      {sent ? <>
        <Field label={t('phoneVerification.code')} value={code} onChangeText={setCode}
          keyboardType="number-pad" textContentType="oneTimeCode" maxLength={6} autoComplete="sms-otp" />
        <Button label={t('phoneVerification.confirm')} onPress={() => void confirm()} loading={busy} disabled={code.trim().length !== 6} />
        <Button label={t('phoneVerification.restart')} tone="ghost" disabled={busy} onPress={() => {
          challenge.current?.cancel(); challenge.current = null; setSent(false); setCode(''); setError(null);
        }} />
      </> : <>
        <Txt variant="caption">{t('phoneVerification.consent')}</Txt>
        <Button label={t('phoneVerification.send')} loading={busy}
          disabled={!phoneForProof(newPhone) || !password} onPress={() => void send()} />
      </>}
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
