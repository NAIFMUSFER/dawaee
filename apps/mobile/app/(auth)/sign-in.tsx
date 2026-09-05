import React, { useState } from 'react';
import { Pressable, View } from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Button, Field, Screen, Txt } from '@/components/ui';
import { useI18n } from '@/i18n';
import { useTheme } from '@/hooks/useTheme';
import { useApp } from '@/state/app-store';
import { api, ApiError, NetworkError, getDeviceId } from '@/api/client';
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

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const tokens = await api.anonymous.post<AuthTokens>('/v1/auth/login', {
        identifier: identifier.trim(),
        password,
        deviceId: await getDeviceId(),
      });
      await signInWithTokens(tokens);
      // Someone who arrived through a caregiver invitation came here to finish
      // it. The token was already being stashed before this detour and nothing
      // ever read it back, so they landed on Today and the invitation sat in
      // storage forever — the care circle could not be formed at all.
      router.replace(await landingAfterAuth());
    } catch (err) {
      if (err instanceof NetworkError) setError(t('notifications.offlineBanner'));
      else if (err instanceof ApiError) setError(err.message);
      else setError(t('error.internal_error'));
    } finally {
      setBusy(false);
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
          error={error}
        />

        <Pressable
          onPress={() => setReveal((v) => !v)}
          accessibilityRole="button"
          accessibilityLabel={reveal ? t('auth.hidePassword') : t('auth.showPassword')}
          hitSlop={12}
        >
          <Txt variant="caption" color={theme.colors.primary600}>
            {reveal ? t('auth.hidePassword') : t('auth.showPassword')}
          </Txt>
        </Pressable>

        <Button
          label={t('auth.signIn')}
          onPress={() => void submit()}
          loading={busy}
          disabled={!ready}
          size="large"
        />

        <Pressable
          onPress={() => router.push('/(auth)/sign-up')}
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
