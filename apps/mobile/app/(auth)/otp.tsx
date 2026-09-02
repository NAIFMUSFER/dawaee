import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Button, Field, Screen, Txt } from '@/components/ui';
import { useI18n } from '@/i18n';
import { useTheme } from '@/hooks/useTheme';
import { api, ApiError, getDeviceId } from '@/api/client';
import { useApp } from '@/state/app-store';

export default function OtpScreen() {
  const { phone, debugCode } = useLocalSearchParams<{ phone: string; debugCode?: string }>();
  const { t } = useI18n();
  const theme = useTheme();
  const { signInWithTokens } = useApp();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cooldown, setCooldown] = useState(45);

  // Development builds echo the code so the flow can be exercised without SMS.
  useEffect(() => {
    if (debugCode) setCode(debugCode);
  }, [debugCode]);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  const verify = async () => {
    setBusy(true);
    setError(null);
    try {
      const deviceId = await getDeviceId();
      const res = await api.anonymous.post<{ accessToken: string; refreshToken: string; isNewUser: boolean }>(
        '/v1/auth/otp/verify', { phone, code: code.trim(), deviceId },
      );
      await signInWithTokens(res);
      router.replace(res.isNewUser ? '/(auth)/onboarding' : '/(tabs)/today');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('error.internal_error'));
    } finally {
      setBusy(false);
    }
  };

  const resend = async () => {
    setCooldown(45);
    await api.anonymous.post('/v1/auth/otp/request', { phone, locale: 'ar' }).catch(() => undefined);
  };

  return (
    <SafeAreaView style={{ flex: 1 }}>
      <Screen>
        <View style={{ gap: theme.spacing.sm, paddingTop: theme.spacing.xl }}>
          <Txt variant="h1" weight="bold" accessibilityRole="header">{t('auth.otpTitle')}</Txt>
          <Txt variant="body" color={theme.colors.ink500}>{t('auth.otpSent', { phone: String(phone) })}</Txt>
        </View>

        <Field
          label={t('auth.otpTitle')}
          value={code}
          onChangeText={setCode}
          keyboardType="number-pad"
          maxLength={8}
          error={error}
          autoFocus
        />

        <Button label={t('common.confirm')} onPress={() => void verify()} loading={busy} disabled={code.trim().length < 4} size="large" />
        <Button
          label={cooldown > 0 ? `${t('auth.resend')} (${cooldown})` : t('auth.resend')}
          tone="ghost"
          disabled={cooldown > 0}
          onPress={() => void resend()}
        />
      </Screen>
    </SafeAreaView>
  );
}
