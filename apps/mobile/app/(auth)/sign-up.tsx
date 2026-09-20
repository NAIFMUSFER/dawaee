import React, { useEffect, useRef, useState } from 'react';
import { Pressable, View } from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Banner, Button, Field, Screen, Txt } from '@/components/ui';
import { useI18n } from '@/i18n';
import { useTheme } from '@/hooks/useTheme';
import { useApp } from '@/state/app-store';
import { api, ApiError, NetworkError } from '@/api/client';
import { waitForAuthServer } from '@/api/auth-connection';

/** The mailbox holder creates the account from the one-time email link. */
export default function SignUpScreen() {
  const { t } = useI18n();
  const theme = useTheme();
  const { preferences } = useApp();

  const [identifier, setIdentifier] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [requested, setRequested] = useState(false);
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
      submitted = true;
      await api.anonymous.post('/v1/auth/register', {
        email: typed.toLowerCase(),
        locale: preferences.locale,
      });
      if (!current()) return;
      setRequested(true);
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

  const ready = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(identifier.trim());

  return (
    <SafeAreaView style={{ flex: 1 }}>
      <Screen>
        <View style={{ gap: theme.spacing.sm, paddingTop: theme.spacing.xl }}>
          <Txt variant="h1" weight="bold" accessibilityRole="header">{t('auth.signUpTitle')}</Txt>
          <Txt variant="body" color={theme.colors.ink500}>{t('safety.notMedicalAdvice')}</Txt>
        </View>

        <Field
          label={t('emailAccount.email')}
          value={identifier}
          onChangeText={setIdentifier}
          autoComplete="email"
          keyboardType="email-address"
          autoCapitalize="none"
          autoCorrect={false}
          maxLength={320}
          editable={!busy && !requested}
          autoFocus
        />

        {error ? <Banner tone="warning" title={error} /> : null}
        {requested ? <>
          <Banner tone="info" title={t('auth.registrationRequested')} />
          <Button label={t('recovery.title')} tone="secondary"
            onPress={() => router.replace('/(auth)/forgot-password')} />
        </> : null}
        {busy ? <Txt variant="caption" accessibilityRole="alert">{t('auth.connectingServer')}</Txt> : null}
        <Button
          label={t('auth.signUp')}
          onPress={() => void submit()}
          loading={busy}
          disabled={!ready || requested}
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
