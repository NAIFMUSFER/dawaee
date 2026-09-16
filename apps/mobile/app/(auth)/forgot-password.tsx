import React, { useEffect, useRef, useState } from 'react';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { normalizeDigits } from '@dawaee/shared';
import { Banner, Button, Field, Screen, Txt } from '@/components/ui';
import { useI18n } from '@/i18n';
import { api, ApiError, NetworkError } from '@/api/client';
import { useRequestScope } from '@/hooks/useRequestScope';
import { phoneVerificationSupported, startPhoneProof, type PhoneChallenge } from '@/security/phone-proof';

export function recoveryPhone(raw: string): string | null {
  let phone = normalizeDigits(raw).replace(/[\s().-]/g, '');
  if (phone.startsWith('00')) phone = `+${phone.slice(2)}`;
  if (/^05\d{8}$/.test(phone)) phone = `+966${phone.slice(1)}`;
  else if (/^5\d{8}$/.test(phone)) phone = `+966${phone}`;
  else if (/^9665\d{8}$/.test(phone)) phone = `+${phone}`;
  return /^\+[1-9]\d{7,14}$/.test(phone) ? phone : null;
}

export default function ForgotPasswordScreen() {
  const { t } = useI18n();
  const { begin, capture } = useRequestScope();
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [step, setStep] = useState<'phone' | 'code' | 'password' | 'done'>('phone');
  const [busy, setBusy] = useState(false);
  const [cooldown, setCooldown] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const locked = useRef(false);
  const proof = useRef<string | null>(null);
  const challenge = useRef<PhoneChallenge | null>(null);
  const lastSend = useRef(0);
  useEffect(() => () => { challenge.current?.cancel(); proof.current = null; }, []);
  useEffect(() => {
    if (!cooldown) return;
    const timer = setTimeout(() => setCooldown(false), 60_000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  const restart = () => {
    begin(); challenge.current?.cancel(); challenge.current = null; proof.current = null;
    setCode(''); setPassword(''); setConfirmation(''); setError(null); setStep('phone');
  };
  const send = async () => {
    if (locked.current || !phoneVerificationSupported || Date.now() - lastSend.current < 60_000) return;
    const canonical = recoveryPhone(phone);
    if (!canonical) { setError(t('recovery.phoneInvalid')); return; }
    locked.current = true; setBusy(true); setError(null);
    const current = begin();
    challenge.current?.cancel(); proof.current = null; setCode('');
    try {
      const next = await startPhoneProof(canonical, async (idToken) => {
        if (!current()) return;
        proof.current = idToken; setCode(''); setStep('password'); setError(null);
      }, () => { if (current()) setError(t('phoneVerification.codeError')); });
      if (!current()) { next.cancel(); return; }
      lastSend.current = Date.now(); setCooldown(true);
      if (proof.current) { next.cancel(); return; }
      challenge.current = next; setStep('code');
    } catch { if (current()) setError(t('phoneVerification.failed')); }
    finally { locked.current = false; if (current()) setBusy(false); }
  };
  const confirmCode = async () => {
    const normalized = normalizeDigits(code).trim();
    if (locked.current || !challenge.current || !/^\d{6}$/.test(normalized)) return;
    locked.current = true; setBusy(true); setError(null);
    const current = capture();
    try { await challenge.current.confirm(normalized); }
    catch { if (current()) setError(t('phoneVerification.codeError')); }
    finally { locked.current = false; if (current()) setBusy(false); }
  };
  const save = async () => {
    if (locked.current || !proof.current) return;
    if (password !== confirmation) { setError(t('recovery.mismatch')); return; }
    locked.current = true; setBusy(true); setError(null);
    const current = capture();
    try {
      const result = await api.anonymous.post<{ updated: boolean }>('/v1/auth/password/recover', {
        idToken: proof.current, newPassword: password,
      });
      if (!current()) return;
      if (result.updated !== true) { setError(t('recovery.failed')); return; }
      proof.current = null; setPassword(''); setConfirmation(''); setStep('done');
    } catch (err) {
      if (!current()) return;
      if (err instanceof NetworkError) setError(t('notifications.offlineBanner'));
      else if (err instanceof ApiError && err.code === 'weak_password') setError(err.message);
      else if (err instanceof ApiError && err.code === 'rate_limited') setError(t('error.rate_limited'));
      else setError(t('recovery.failed'));
    } finally { locked.current = false; if (current()) setBusy(false); }
  };
  return <SafeAreaView style={{ flex: 1 }}><Screen>
    <Txt variant="h1" weight="bold" accessibilityRole="header">{t('recovery.title')}</Txt>
    {error ? <Banner tone="warning" title={error} /> : null}
    {step === 'done' ? <Banner tone="success" title={t('recovery.success')} /> : <>
      <Txt>{t('recovery.body')}</Txt>
      {!phoneVerificationSupported ? <Banner tone="warning" title={t('recovery.platform')} /> : step === 'phone' ? <>
        <Field label={t('recovery.phone')} value={phone} onChangeText={setPhone} keyboardType="phone-pad"
          autoComplete="tel" editable={!busy} maxLength={24} />
        <Txt variant="caption">{t('phoneVerification.consent')}</Txt>
        {cooldown ? <Txt>{t('recovery.cooldown')}</Txt> : null}
        <Button label={t('phoneVerification.send')} loading={busy} disabled={cooldown || !recoveryPhone(phone)} onPress={() => void send()} />
      </> : step === 'code' ? <>
        <Field label={t('phoneVerification.code')} value={code} onChangeText={setCode} keyboardType="number-pad"
          textContentType="oneTimeCode" autoComplete="sms-otp" maxLength={6} editable={!busy} />
        <Button label={t('phoneVerification.confirm')} loading={busy}
          disabled={!/^\d{6}$/.test(normalizeDigits(code).trim())} onPress={() => void confirmCode()} />
        <Button label={t('phoneVerification.restart')} tone="secondary" disabled={busy || cooldown} onPress={() => void send()} />
        {cooldown ? <Txt>{t('recovery.cooldown')}</Txt> : null}
        <Button label={t('recovery.changePhone')} tone="ghost" disabled={busy} onPress={restart} />
      </> : <>
        <Txt>{t('recovery.expiry')}</Txt>
        <Field label={t('recovery.newPassword')} value={password} onChangeText={setPassword} secureTextEntry
          autoComplete="new-password" autoCapitalize="none" autoCorrect={false} editable={!busy} maxLength={200} />
        <Field label={t('recovery.confirmPassword')} value={confirmation} onChangeText={setConfirmation} secureTextEntry
          autoComplete="new-password" autoCapitalize="none" autoCorrect={false} editable={!busy} maxLength={200} />
        <Button label={t('recovery.save')} loading={busy} disabled={password.length < 10 || !confirmation} onPress={() => void save()} />
        <Button label={t('phoneVerification.restart')} tone="ghost" disabled={busy} onPress={restart} />
      </>}
    </>}
    <Button label={t('recovery.back')} tone="secondary" disabled={busy} onPress={() => router.replace('/(auth)/sign-in')} />
  </Screen></SafeAreaView>;
}
