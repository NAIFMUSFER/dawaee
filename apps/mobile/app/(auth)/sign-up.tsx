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

import { phoneInput } from '@dawaee/shared';

const MIN_PASSWORD = 10;

interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

/** New accounts use an email that must be verified before onboarding ends. */
export default function SignUpScreen() {
  const { t } = useI18n();
  const theme = useTheme();
  const { signInWithTokens, preferences } = useApp();

  const [name, setName] = useState('');
  const [identifier, setIdentifier] = useState('');
  const [phone, setPhone] = useState('');
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
    let submitted = false;
    setBusy(true);
    setError(null);
    const typed = identifier.trim();
    try {
      await waitForAuthServer(controller.signal);
      if (!current()) return;
      const deviceId = await getDeviceId();
      if (!current()) return;
      submitted = true;
      const tokens = await api.anonymous.post<AuthTokens>('/v1/auth/register', {
        email: typed.toLowerCase(),
        phone: phone.trim(),
        displayName: name.trim(),
        password,
        // The language chosen on the first screen, not a hardcoded default:
        // it is the account's locale from the first notification onward.
        locale: preferences.locale,
        deviceId,
      });
      if (!current()) return;
      await signInWithTokens(tokens);
      if (!current()) return;
      // Add and verify recovery email before leaving onboarding. Pending caregiver
      // invitations remain stored and can be continued from email settings.
      router.replace('/settings/email-verification');
    } catch (err) {
      if (!current()) return;
      if (err instanceof NetworkError || (err instanceof ApiError && err.status >= 500)) {
        setError(t(submitted ? 'auth.registrationUnconfirmed' : 'auth.connectionFailed'));
      }
      else if (err instanceof ApiError) setError(err.message);
      else setError(t('error.internal_error'));
    } finally {
      if (current()) { action.current = null; setBusy(false); }
    }
  };

  const ready =
    name.trim().length > 0 && phoneInput.safeParse(phone).success && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(identifier.trim()) && password.length >= MIN_PASSWORD;

  return (
    <SafeAreaView style={{ flex: 1 }}>
      <Screen>
        <View style={{ gap: theme.spacing.sm, paddingTop: theme.spacing.xl }}>
          <Txt variant="h1" weight="bold" accessibilityRole="header">{t('auth.signUpTitle')}</Txt>
          <Txt variant="body" color={theme.colors.ink500}>{t('safety.notMedicalAdvice')}</Txt>
        </View>

        <Field
          label={t('auth.displayName')}
          value={name}
          onChangeText={setName}
          maxLength={120}
          editable={!busy}
          autoFocus
        />

        <Field label={t('invite.phone')} value={phone} onChangeText={setPhone}
          autoComplete="tel" keyboardType="phone-pad" maxLength={20}
          editable={!busy}
          hint={t('auth.linkedPhoneHint')} />

        <Field
          label={t('emailAccount.email')}
          value={identifier}
          onChangeText={setIdentifier}
          autoComplete="email"
          keyboardType="email-address"
          autoCapitalize="none"
          autoCorrect={false}
          maxLength={320}
          editable={!busy}
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
          hint={t('auth.passwordHint', { min: String(MIN_PASSWORD) })}
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
          label={t('auth.signUp')}
          onPress={() => void submit()}
          loading={busy}
          disabled={!ready}
          size="large"
        />

        <Pressable
          onPress={() => router.replace('/(auth)/sign-in')}
          disabled={busy}
          accessibilityRole="button"
          hitSlop={12}
          style={{ paddingVertical: theme.spacing.sm }}
        >
          <Txt variant="body" color={theme.colors.primary600}>{t('auth.haveAccount')}</Txt>
        </Pressable>
      </Screen>
    </SafeAreaView>
  );
}
