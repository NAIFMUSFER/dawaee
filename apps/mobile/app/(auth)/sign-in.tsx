import React, { useEffect, useRef, useState } from 'react';
import { Pressable, View } from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Banner, Button, Field, Screen, Txt } from '@/components/ui';
import { useI18n } from '@/i18n';
import { useTheme } from '@/hooks/useTheme';
import { useApp } from '@/state/app-store';
import { api, ApiError, NetworkError, getDeviceId } from '@/api/client';
import { waitForAuthServer } from '@/api/auth-connection';
import { landingAfterAuth } from '@/storage/pending-invite';
import { readRegistrationPhone, clearRegistrationPhone } from '@/storage/registration-phone';
import { PhoneVerification } from '@/components/PhoneVerification';
import { phoneVerificationSupported } from '@/security/phone-proof';

interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

/**
 * Sign in with a password.
 *
 * One field for the identifier rather than a phone/email switch: the person
 * knows what they registered with, and asking them to classify it first is a
 * question the server answers for itself.
 */
export default function SignInScreen() {
  const { t } = useI18n();
  const theme = useTheme();
  const { signInWithTokens, user, signedIn } = useApp();
  const account = useRef(user?.id);
  account.current = user?.id;

  const [identifier, setIdentifier] = useState('');
  const [loginKind, setLoginKind] = useState<'email' | 'phone'>('email');
  const [password, setPassword] = useState('');
  const [reveal, setReveal] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [phoneStep, setPhoneStep] = useState<{ phone: string; email: string; userId: string } | null>(null);
  const action = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => {
    mounted.current = false; action.current?.abort(); action.current = null;
  }; }, []);
  useEffect(() => {
    if (phoneStep && (!signedIn || user?.id !== phoneStep.userId)) {
      setPhoneStep(null); setPassword('');
    }
  }, [phoneStep, signedIn, user?.id]);

  const submit = async () => {
    if (action.current) return;
    const controller = new AbortController();
    action.current = controller;
    const current = () => action.current === controller && !controller.signal.aborted;
    setBusy(true);
    setError(null);
    try {
      await waitForAuthServer(controller.signal);
      if (!current()) return;
      const deviceId = await getDeviceId();
      if (!current()) return;
      const tokens = await api.anonymous.post<AuthTokens>('/v1/auth/login', {
        identifier: identifier.trim(),
        password,
        deviceId,
      });
      if (!current()) return;
      await signInWithTokens(tokens);
      // Someone who arrived through a caregiver invitation came here to finish
      // it. The token was already being stashed before this detour and nothing
      // ever read it back, so they landed on Today and the invitation sat in
      // storage forever — the care circle could not be formed at all.
      if (!current()) return;
      const draft = phoneVerificationSupported ? await readRegistrationPhone(identifier) : null;
      if (!current()) return;
      if (draft && account.current) {
        const owner = account.current;
        // Verify the server account before showing a saved contact on a shared
        // device. Password stays only in this mounted sign-in component.
        const identity = await api.get<{ email: string | null; verified: boolean }>('/v1/auth/email');
        if (!current() || account.current !== owner) return;
        if (identity.verified && identity.email?.toLowerCase() === draft.email) {
          const status = await api.get<{ phone: string | null; verified: boolean }>('/v1/auth/phone-verification');
          if (!current() || account.current !== owner) return;
          if (!status.phone || (status.phone === draft.phone && !status.verified)) {
            setPhoneStep({ phone: draft.phone, email: draft.email, userId: owner });
            return;
          }
          await clearRegistrationPhone(draft.email);
        }
      }
      const landing = await landingAfterAuth();
      if (current()) { setPassword(''); router.replace(landing); }
    } catch (err) {
      if (!current()) return;
      if (err instanceof NetworkError || (err instanceof ApiError && err.status >= 500)) setError(t('auth.connectionFailed'));
      else if (err instanceof ApiError) setError(err.message);
      else setError(t('error.internal_error'));
    } finally {
      if (current()) { action.current = null; setBusy(false); }
    }
  };

  const ready = identifier.trim().length >= 3 && password.length > 0;

  const finishPhone = async () => {
    if (!phoneStep || account.current !== phoneStep.userId) return;
    const owner = phoneStep.userId;
    await clearRegistrationPhone(phoneStep.email).catch(() => undefined);
    const landing = await landingAfterAuth();
    if (mounted.current && account.current === owner) { setPassword(''); setPhoneStep(null); router.replace(landing); }
  };

  if (phoneStep && signedIn && user?.id === phoneStep.userId) return <SafeAreaView style={{ flex: 1 }}><Screen>
    <Txt variant="h1" weight="bold">{t('auth.completeRegistrationPhone')}</Txt>
    <PhoneVerification key={user.id} initialPhone={phoneStep.phone} initialPassword={password}
      onVerified={() => void finishPhone()} />
  </Screen></SafeAreaView>;

  return (
    <SafeAreaView style={{ flex: 1 }}>
      <Screen>
        <View style={{ gap: theme.spacing.sm, paddingTop: theme.spacing.xl }}>
          <Txt variant="h1" weight="bold" accessibilityRole="header">{t('auth.signInTitle')}</Txt>
          <Txt variant="body" color={theme.colors.ink500}>{t('safety.notMedicalAdvice')}</Txt>
        </View>

        <View style={{ flexDirection: 'row', gap: theme.spacing.sm }}>
          <Button label={t('emailAccount.email')} tone={loginKind === 'email' ? 'primary' : 'secondary'}
            fullWidth={false} disabled={busy} onPress={() => setLoginKind('email')} />
          <Button label={t('invite.phone')} tone={loginKind === 'phone' ? 'primary' : 'secondary'}
            fullWidth={false} disabled={busy} onPress={() => setLoginKind('phone')} />
        </View>
        <Field
          label={t('auth.identifier')}
          value={identifier}
          onChangeText={setIdentifier}
          placeholder={t('auth.identifierHint')}
          keyboardType={loginKind === 'phone' ? 'phone-pad' : 'email-address'}
          autoCapitalize="none"
          autoCorrect={false}
          maxLength={320}
          editable={!busy}
          autoComplete="username"
          autoFocus
        />

        <Field
          label={t('auth.password')}
          value={password}
          onChangeText={setPassword}
          secureTextEntry={!reveal}
          autoCapitalize="none"
          autoCorrect={false}
          maxLength={200}
          editable={!busy}
          autoComplete="current-password"
          returnKeyType="go"
          onSubmitEditing={() => { if (ready && !busy) void submit(); }}
        />

        <Pressable
          onPress={() => setReveal((v) => !v)}
          disabled={busy}
          accessibilityRole="button"
          accessibilityLabel={reveal ? t('auth.hidePassword') : t('auth.showPassword')}
          hitSlop={12}
        >
          <Txt variant="caption" color={theme.colors.primary600}>
            {reveal ? t('auth.hidePassword') : t('auth.showPassword')}
          </Txt>
        </Pressable>

        {error ? <Banner tone="warning" title={error} /> : null}
        {busy ? <Txt variant="caption" accessibilityRole="alert">{t('auth.connectingServer')}</Txt> : null}
        <Button
          label={t('auth.signIn')}
          onPress={() => void submit()}
          loading={busy}
          disabled={!ready}
          size="large"
        />

        <Button label={t('recovery.title')} tone="ghost" disabled={busy}
          onPress={() => router.push('/(auth)/forgot-password')} />

        <Pressable
          onPress={() => router.push('/(auth)/sign-up')}
          disabled={busy}
          accessibilityRole="button"
          hitSlop={12}
          style={{ paddingVertical: theme.spacing.sm }}
        >
          <Txt variant="body" color={theme.colors.primary600}>{t('auth.noAccount')}</Txt>
        </Pressable>
      </Screen>
    </SafeAreaView>
  );
}
