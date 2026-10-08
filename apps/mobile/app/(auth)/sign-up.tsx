import React, { useEffect, useRef, useState } from 'react';
import { Keyboard } from 'react-native';
import { router } from 'expo-router';
import { Banner, Button, Field, Txt } from '@/components/ui';
import { AuthScreen } from '@/components/AuthScreen';
import { GoogleAuthButton } from '@/components/GoogleAuthButton';
import { AppleAuthButton } from '@/components/AppleAuthButton';
import { useI18n } from '@/i18n';
import { useApp } from '@/state/app-store';
import { api, ApiError, NetworkError, getDeviceId } from '@/api/client';
import { waitForAuthServer } from '@/api/auth-connection';
import { landingAfterAuth } from '@/storage/pending-invite';
import { phoneVerificationSupported } from '@/security/phone-proof';
import { phoneForProof } from '@/security/phone-number';
import { PhoneVerification } from '@/components/PhoneVerification';
import { clearRegistrationPhone, saveRegistrationPhone } from '@/storage/registration-phone';

export default function SignUpScreen() {
  const { t } = useI18n();
  const { preferences, signInWithTokens, user, signedIn } = useApp();
  const account = useRef(user?.id);
  account.current = user?.id;
  const mounted = useRef(true);
  const [phoneStep, setPhoneStep] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [challenge, setChallenge] = useState<string | null>(null);
  const [retryAt, setRetryAt] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const action = useRef<AbortController | null>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; action.current?.abort(); action.current = null; }; }, []);
  useEffect(() => { if (phoneStep && (!signedIn || user?.id !== phoneStep)) { setPhoneStep(null); setPassword(''); } }, [phoneStep, signedIn, user?.id]);
  useEffect(() => { if (!challenge) return; const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [challenge]);
  const ready = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) && displayName.trim().length > 0
    && password.length >= 10 && (!phoneVerificationSupported || Boolean(phoneForProof(phone)));
  const run = async (complete: boolean) => {
    if (action.current || busy) return;
    const controller = new AbortController(); action.current = controller;
    const current = () => action.current === controller && !controller.signal.aborted;
    setBusy(true); setError(null); Keyboard.dismiss();
    try {
      await waitForAuthServer(controller.signal);
      if (!current()) return;
      const typed = email.trim().toLowerCase();
      if (complete) {
        const deviceId = await getDeviceId();
        if (!current()) return;
        const tokens = await api.anonymous.post<{ accessToken: string; refreshToken: string; userId: string }>('/v1/auth/registration-code/complete',
          { email: typed, locale: preferences.locale, challenge, code, displayName: displayName.trim(), password, deviceId });
        if (!current()) return;
        if (phoneVerificationSupported) await saveRegistrationPhone(typed, phoneForProof(phone)!);
        if (!current()) return;
        await signInWithTokens(tokens);
        if (!current()) return;
        if (phoneVerificationSupported) { setPhoneStep(tokens.userId); setCode(''); return; }
        const landing = await landingAfterAuth();
        if (current()) { setPassword(''); setCode(''); router.replace(landing); }
      } else {
        const result = await api.anonymous.post<{ challenge: string; retryAfterSeconds: number }>('/v1/auth/registration-code/request', { email: typed, locale: preferences.locale });
        if (!current()) return;
        setChallenge(result.challenge); setCode(''); setRetryAt(Date.now() + result.retryAfterSeconds * 1000); setNow(Date.now());
      }
    } catch (err) {
      if (!current()) return;
      setError(err instanceof NetworkError ? t('auth.connectionFailed') : err instanceof ApiError ? err.message : t('error.internal_error'));
    } finally { if (current()) { action.current = null; setBusy(false); } }
  };
  const finishPhone = async () => {
    if (!phoneStep || account.current !== phoneStep) return;
    const owner = phoneStep;
    await clearRegistrationPhone(email.trim().toLowerCase()).catch(() => undefined);
    const landing = await landingAfterAuth();
    if (mounted.current && account.current === owner) { setPassword(''); setPhoneStep(null); router.replace(landing); }
  };
  if (phoneStep && signedIn && user?.id === phoneStep) return <AuthScreen>
    <Txt variant="h1" weight="bold">{t('auth.completeRegistrationPhone')}</Txt>
    <PhoneVerification key={phoneStep} initialPhone={phoneForProof(phone)!} initialPassword={password} onVerified={() => void finishPhone()} />
  </AuthScreen>;
  return <AuthScreen>
    <Txt variant="h1" weight="bold">{t('auth.signUpTitle')}</Txt>
    {challenge ? <>
      <Banner tone="info" title={t('auth.codeSent')} body={email.trim()} />
      <Field label={t('auth.emailCode')} value={code} onChangeText={v => setCode(v.replace(/[٠-٩]/g, c => String(c.charCodeAt(0)-1632)).replace(/[^0-9]/g, '').slice(0,6))}
        keyboardType="number-pad" autoComplete="one-time-code" maxLength={6} editable={!busy} />
      <Button label={t('auth.completeInApp')} onPress={() => void run(true)} loading={busy} disabled={code.length !== 6} size="large" />
      <Button label={t('auth.resendCode')} tone="secondary" disabled={busy || now < retryAt} onPress={() => void run(false)} />
      <Button label={t('auth.editRegistration')} tone="ghost" disabled={busy} onPress={() => { setChallenge(null); setCode(''); setError(null); }} />
    </> : <>
      <Field label={t('auth.displayName')} value={displayName} onChangeText={setDisplayName} maxLength={120} editable={!busy} />
      <Field label={t('emailAccount.email')} value={email} onChangeText={setEmail} keyboardType="email-address" autoComplete="email" autoCapitalize="none" autoCorrect={false} maxLength={320} editable={!busy} />
      <Field label={t('auth.password')} value={password} onChangeText={setPassword} secureTextEntry autoComplete="new-password" autoCapitalize="none" autoCorrect={false} maxLength={200} hint={t('auth.passwordHint', { min: '10' })} editable={!busy} />
      {phoneVerificationSupported ? <Field label={t('invite.phone')} value={phone} onChangeText={setPhone} keyboardType="phone-pad" autoComplete="tel" maxLength={20} editable={!busy} hint={t('auth.registrationPhoneHint')} /> : null}
      <Button label={t('auth.sendEmailCode')} onPress={() => void run(false)} loading={busy} disabled={!ready} size="large" />
      <GoogleAuthButton disabled={busy} onBusyChange={setBusy} />
      <AppleAuthButton disabled={busy} onBusyChange={setBusy} />
    </>}
    {busy ? <Txt variant="caption" accessibilityRole="alert">{t('auth.connectingServer')}</Txt> : null}
    {error ? <Banner tone="warning" title={error} /> : null}
    <Button label={t('auth.haveAccount')} tone="ghost" disabled={busy} onPress={() => router.replace('/(auth)/sign-in')} />
  </AuthScreen>;
}
