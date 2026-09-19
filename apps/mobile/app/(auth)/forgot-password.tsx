import React, { useEffect, useRef, useState } from 'react';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Banner, Button, Field, Screen, Txt } from '@/components/ui';
import { useI18n } from '@/i18n';
import { api, ApiError, NetworkError } from '@/api/client';
import { useRequestScope } from '@/hooks/useRequestScope';

export default function ForgotPasswordScreen() {
  const { t } = useI18n();
  const { capture } = useRequestScope();
  const [email, setEmail] = useState('');
  const [available, setAvailable] = useState<boolean | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [cooldown, setCooldown] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const locked = useRef(false);
  const lastSend = useRef(0);
  useEffect(() => {
    let active = true; setAvailable(null);
    api.anonymous.get<{ provider: string; available: boolean }>('/v1/auth/password/recovery-options')
      .then(value => { if (active) setAvailable(value.provider === 'email' && value.available === true); })
      .catch(() => { if (active) setAvailable(false); });
    return () => { active = false; };
  }, [attempt]);
  useEffect(() => {
    if (!cooldown) return;
    const timer = setTimeout(() => setCooldown(false), 60_000);
    return () => clearTimeout(timer);
  }, [cooldown]);
  const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const send = async () => {
    if (locked.current || !available || !valid || Date.now() - lastSend.current < 60_000) return;
    locked.current = true; setBusy(true); setError(null); setSent(false);
    lastSend.current = Date.now(); setCooldown(true);
    const current = capture();
    try {
      const result = await api.anonymous.post<{ accepted: boolean }>('/v1/auth/password/recovery/request', { email: email.trim().toLowerCase() });
      if (!current()) return;
      if (result.accepted !== true) throw new Error('Invalid response');
      setSent(true);
    } catch (err) {
      if (current()) setError(t(err instanceof NetworkError ? 'auth.connectionFailed' : err instanceof ApiError && err.code === 'rate_limited' ? 'error.rate_limited' : 'emailAccount.unavailable'));
    } finally { locked.current = false; if (current()) setBusy(false); }
  };
  return <SafeAreaView style={{ flex: 1 }}><Screen>
    <Txt variant="h1" weight="bold" accessibilityRole="header">{t('recovery.title')}</Txt>
    <Txt>{t('emailAccount.recoveryBody')}</Txt>
    {error ? <Banner tone="warning" title={error} /> : null}
    {available === null ? <Txt>{t('common.loading')}</Txt> : available === false ? <>
      <Banner tone="warning" title={t('emailAccount.unavailable')} />
      <Button label={t('common.retry')} onPress={() => setAttempt(v => v + 1)} />
    </> : <>
      <Field label={t('emailAccount.email')} value={email} onChangeText={v => { setEmail(v); setSent(false); }}
        keyboardType="email-address" autoComplete="email" autoCapitalize="none" autoCorrect={false} editable={!busy} maxLength={320} />
      {sent ? <Banner tone="info" title={t('emailAccount.requested')} /> : null}
      {cooldown ? <Txt>{t('recovery.cooldown')}</Txt> : null}
      <Button label={t('emailAccount.sendReset')} loading={busy} disabled={!valid || cooldown} onPress={() => void send()} />
    </>}
    <Txt variant="caption">{t('emailAccount.noVerifiedEmail')}</Txt>
    <Button label={t('recovery.back')} tone="secondary" disabled={busy} onPress={() => router.replace('/(auth)/sign-in')} />
  </Screen></SafeAreaView>;
}
