import React, { useEffect, useRef, useState } from 'react';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { normalizeDigits } from '@dawaee/shared';
import { Banner, Button, Field, Screen, Txt } from '@/components/ui';
import { useI18n } from '@/i18n';
import { api, ApiError, NetworkError } from '@/api/client';
import { useRequestScope } from '@/hooks/useRequestScope';
import { phoneVerificationSupported, startPhoneProof, type PhoneChallenge } from '@/security/phone-proof';
import { phoneProofErrorKey } from '@/security/phone-proof-errors';

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
  const [channel, setChannel] = useState<'firebase' | 'twilio' | 'unavailable' | null>(null);
  const [optionsAttempt, setOptionsAttempt] = useState(0);
  const locked = useRef(false);
  const proof = useRef<{ idToken: string } | { recoveryToken: string } | null>(null);
  const challenge = useRef<PhoneChallenge | null>(null);
  const smsChallenge = useRef<string | null>(null);
  const lastSend = useRef(0);
  useEffect(() => () => { challenge.current?.cancel(); smsChallenge.current = null; proof.current = null; }, []);
  useEffect(() => {
    let active = true;
    setChannel(null);
    api.anonymous.get<{ provider: string; available: boolean }>('/v1/auth/password/recovery-options')
      .then((options) => {
        if (!active) return;
        setChannel(options.available === true && (options.provider === 'firebase' || options.provider === 'twilio')
          ? options.provider : 'unavailable');
      }).catch((err) => {
        if (!active) return;
        // An older API has no discovery endpoint. Outages/malformed responses
        // must not silently switch a configured provider or claim SMS readiness.
        setChannel(err instanceof ApiError && err.status === 404 ? 'firebase' : 'unavailable');
      });
    return () => { active = false; };
  }, [optionsAttempt]);
  useEffect(() => {
    if (!cooldown) return;
    const timer = setTimeout(() => setCooldown(false), 60_000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  const restart = () => {
    if (locked.current) return;
    begin(); challenge.current?.cancel(); challenge.current = null; smsChallenge.current = null; proof.current = null;
    setCode(''); setPassword(''); setConfirmation(''); setError(null); setStep('phone');
  };
  const send = async () => {
    if (locked.current || !channel || channel === 'unavailable' || (channel === 'firebase' && !phoneVerificationSupported)
      || Date.now() - lastSend.current < 60_000) return;
    const canonical = recoveryPhone(phone);
    if (!canonical) { setError(t('recovery.phoneInvalid')); return; }
    if (channel === 'twilio' && !/^\+9665\d{8}$/.test(canonical)) { setError(t('recovery.saudiPhone')); return; }
    locked.current = true; setBusy(true); setError(null);
    const current = begin();
    challenge.current?.cancel(); challenge.current = null; smsChallenge.current = null; proof.current = null; setCode('');
    try {
      if (channel === 'twilio') {
        // Apply cooldown even after a timeout: Twilio may already have accepted
        // the send. Do not automatically resend or switch to Firebase.
        lastSend.current = Date.now(); setCooldown(true);
        const next = await api.anonymous.post<{ challengeToken: string }>('/v1/auth/password/recovery/start', { phone: canonical });
        if (!current()) return;
        if (typeof next.challengeToken !== 'string' || next.challengeToken.length < 100) throw new Error('Invalid recovery response');
        smsChallenge.current = next.challengeToken; setStep('code');
        return;
      }
      const next = await startPhoneProof(canonical, async (idToken) => {
        if (!current()) return;
        proof.current = { idToken }; setCode(''); setStep('password'); setError(null);
      }, (err) => { if (current()) setError(t(phoneProofErrorKey(err))); });
      if (!current()) { next.cancel(); return; }
      lastSend.current = Date.now(); setCooldown(true);
      if (proof.current) { next.cancel(); return; }
      challenge.current = next; setStep('code');
    } catch (err) { if (current()) setError(channel === 'twilio' ? recoveryError(err) : t(phoneProofErrorKey(err))); }
    finally { locked.current = false; if (current()) setBusy(false); }
  };
  const confirmCode = async () => {
    const normalized = normalizeDigits(code).trim();
    if (locked.current || (!challenge.current && !smsChallenge.current) || !/^\d{6}$/.test(normalized)) return;
    locked.current = true; setBusy(true); setError(null);
    const current = capture();
    try {
      if (channel === 'twilio' && smsChallenge.current) {
        const result = await api.anonymous.post<{ recoveryToken: string }>('/v1/auth/password/recovery/check', {
          challengeToken: smsChallenge.current, code: normalized,
        });
        if (!current()) return;
        if (typeof result.recoveryToken !== 'string' || result.recoveryToken.length < 100) throw new Error('Invalid recovery response');
        proof.current = { recoveryToken: result.recoveryToken }; smsChallenge.current = null;
        setCode(''); setStep('password');
      } else { await challenge.current?.confirm(normalized); }
    } catch (err) { if (current()) setError(channel === 'twilio' ? recoveryError(err) : t(phoneProofErrorKey(err))); }
    finally { locked.current = false; if (current()) setBusy(false); }
  };
  const save = async () => {
    if (locked.current || !proof.current) return;
    if (password !== confirmation) { setError(t('recovery.mismatch')); return; }
    locked.current = true; setBusy(true); setError(null);
    const current = capture();
    try {
      const result = await api.anonymous.post<{ updated: boolean }>('/v1/auth/password/recover', {
        ...proof.current, newPassword: password,
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
  const recoveryError = (err: unknown) => {
    if (err instanceof NetworkError) return t('notifications.offlineBanner');
    if (err instanceof ApiError && err.code === 'rate_limited') return t('error.rate_limited');
    if (err instanceof ApiError && err.code === 'otp_invalid') return t('phoneVerification.codeError');
    if (err instanceof ApiError && err.code === 'otp_expired') return t('phoneVerification.expired');
    return t('recovery.unavailable');
  };
  return <SafeAreaView style={{ flex: 1 }}><Screen>
    <Txt variant="h1" weight="bold" accessibilityRole="header">{t('recovery.title')}</Txt>
    {error ? <Banner tone="warning" title={error} /> : null}
    {step === 'done' ? <Banner tone="success" title={t('recovery.success')} /> : <>
      <Txt>{t('recovery.body')}</Txt>
      {channel === null ? <Txt>{t('common.loading')}</Txt> : channel === 'unavailable' ? <>
        <Banner tone="warning" title={t('recovery.unavailable')} />
        <Button label={t('common.retry')} onPress={() => setOptionsAttempt((value) => value + 1)} />
      </> : channel === 'firebase' && !phoneVerificationSupported ? <Banner tone="warning" title={t('recovery.platform')} /> : step === 'phone' ? <>
        <Field label={t('recovery.phone')} value={phone} onChangeText={setPhone} keyboardType="phone-pad"
          autoComplete="tel" editable={!busy} maxLength={24} />
        <Txt variant="caption">{t(channel === 'twilio' ? 'recovery.twilioConsent' : 'phoneVerification.consent')}</Txt>
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
        <Txt>{t(channel === 'twilio' ? 'recovery.smsExpiry' : 'recovery.expiry')}</Txt>
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
