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
  const { signInWithTokens } = useApp();

  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [reveal, setReveal] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const action = useRef<AbortController | null>(null);
  useEffect(() => () => { action.current?.abort(); action.current = null; }, []);

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
      const landing = await landingAfterAuth();
      if (current()) router.replace(landing);
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

  return (
    <SafeAreaView style={{ flex: 1 }}>
      <Screen>
        <View style={{ gap: theme.spacing.sm, paddingTop: theme.spacing.xl }}>
          <Txt variant="h1" weight="bold" accessibilityRole="header">{t('auth.signInTitle')}</Txt>
          <Txt variant="body" color={theme.colors.ink500}>{t('safety.notMedicalAdvice')}</Txt>
        </View>

        <Field
          label={t('auth.identifier')}
          value={identifier}
          onChangeText={setIdentifier}
          placeholder={t('auth.identifierHint')}
          keyboardType="email-address"
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
