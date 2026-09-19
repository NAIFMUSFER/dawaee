import React, { useCallback, useEffect, useRef, useState } from 'react';
import { router } from 'expo-router';
import { AppState } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Banner, Button, Field, Screen, Txt } from '@/components/ui';
import { useI18n } from '@/i18n';
import { useApp } from '@/state/app-store';
import { api, ApiError, NetworkError } from '@/api/client';
import { landingAfterAuth } from '@/storage/pending-invite';
import { useRequestScope } from '@/hooks/useRequestScope';

export default function EmailVerificationScreen() {
  const { user } = useApp();
  return <EmailForm key={user?.id ?? 'signed-out'} />;
}
function EmailForm() {
  const { t } = useI18n();
  const { user, syncNow, signOut } = useApp();
  const required = user?.emailVerified === false || user?.emailVerificationRequired === true;
  const { capture } = useRequestScope();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [status, setStatus] = useState<{ email: string | null; verified: boolean; available: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [cooldown, setCooldown] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const locked = useRef(false);
  const edited = useRef(false);
  const lastSend = useRef(0);
  const load = useCallback(async () => {
    const current = capture();
    try {
      const result = await api.get<{ email: string | null; verified: boolean; available: boolean }>('/v1/auth/email');
      if (!current()) return;
      setStatus(result);
      if (!edited.current) setEmail(result.email ?? '');
      if (result.verified) void syncNow();
    } catch { if (current()) setError(t('emailAccount.unavailable')); }
  }, [capture, syncNow, t]);
  useEffect(() => {
    void load();
    const listener = AppState.addEventListener('change', state => { if (state === 'active') void load(); });
    return () => listener.remove();
  }, [load]);
  useEffect(() => {
    if (!cooldown) return;
    const timer = setTimeout(() => setCooldown(false), 60_000);
    return () => clearTimeout(timer);
  }, [cooldown]);
  const send = async () => {
    if (locked.current || !user || !status?.available || !password || Date.now() - lastSend.current < 60_000) return;
    locked.current = true; setBusy(true); setError(null); setSent(false);
    lastSend.current = Date.now(); setCooldown(true);
    const current = capture();
    try {
      const result = await api.post<{ accepted: boolean }>('/v1/auth/email/request', { email: email.trim().toLowerCase(), currentPassword: password });
      if (!current()) return;
      if (result.accepted !== true) throw new Error('Invalid response');
      setPassword(''); setSent(true);
    } catch (err) {
      if (current()) setError(t(err instanceof NetworkError ? 'auth.connectionFailed' : err instanceof ApiError && err.code === 'invalid_credentials' ? 'auth.currentPasswordWrong' : err instanceof ApiError && err.code === 'rate_limited' ? 'error.rate_limited' : 'emailAccount.failed'));
    } finally { locked.current = false; if (current()) setBusy(false); }
  };
  return <SafeAreaView style={{ flex: 1 }}><Screen>
    <Txt variant="h1" weight="bold" accessibilityRole="header">{t('emailAccount.title')}</Txt>
    <Txt>{t('emailAccount.verifyBody')}</Txt>
    {required ? <Txt>{t('emailAccount.required')}</Txt> : null}
    {error ? <Banner tone="warning" title={error} /> : null}
    {status?.verified ? <Banner tone="success" title={`${t('emailAccount.verified')}: ${status.email}`} /> : null}
    {status && !status.available ? <Banner tone="warning" title={t('emailAccount.unavailable')} /> : null}
    <Field label={t('emailAccount.email')} value={email} onChangeText={value => { edited.current = true; setEmail(value); setSent(false); }}
      keyboardType="email-address" autoComplete="email" autoCapitalize="none" autoCorrect={false} editable={!busy} maxLength={320} />
    <Field label={t('emailAccount.currentPassword')} value={password} onChangeText={setPassword} secureTextEntry
      autoComplete="current-password" autoCapitalize="none" autoCorrect={false} editable={!busy} maxLength={200} />
    {sent ? <Banner tone="info" title={t('emailAccount.verifyRequested')} /> : null}
    {cooldown ? <Txt>{t('recovery.cooldown')}</Txt> : null}
    <Button label={t('emailAccount.sendVerify')} loading={busy} disabled={!status?.available || !password || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) || cooldown} onPress={() => void send()} />
    <Button label={t('emailAccount.refresh')} tone="secondary" disabled={busy} onPress={() => void load()} />
    {!required ? <Button label={t('common.back')} tone="ghost" disabled={busy} onPress={() => { void landingAfterAuth().then(path => router.replace(path)); }} /> : null}
    {required ? <Button label={t('settings.signOut')} tone="ghost" disabled={busy} onPress={() => { void signOut(); }} /> : null}
  </Screen></SafeAreaView>;
}
