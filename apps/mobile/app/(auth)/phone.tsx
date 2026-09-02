import React, { useState } from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Banner, Button, Field, Screen, Txt } from '@/components/ui';
import { useI18n } from '@/i18n';
import { useTheme } from '@/hooks/useTheme';
import { api, ApiError, NetworkError } from '@/api/client';

/**
 * Phone entry.
 *
 * Accepts the local Saudi format people actually type (05…) as well as +966,
 * and lets the server do the normalising — the client never silently rewrites
 * what the user entered.
 */
export default function PhoneScreen() {
  const { t } = useI18n();
  const theme = useTheme();
  const [phone, setPhone] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.anonymous.post<{ sent: boolean; expiresAt: string; debugCode?: string }>(
        '/v1/auth/otp/request', { phone: phone.trim(), locale: 'ar' },
      );
      router.push({ pathname: '/(auth)/otp', params: { phone: phone.trim(), debugCode: res.debugCode ?? '' } });
    } catch (err) {
      if (err instanceof NetworkError) setError(t('notifications.offlineBanner'));
      else if (err instanceof ApiError) setError(err.message);
      else setError(t('error.internal_error'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SafeAreaView style={{ flex: 1 }}>
      <Screen>
        <View style={{ gap: theme.spacing.sm, paddingTop: theme.spacing.xl }}>
          <Txt variant="h1" weight="bold" accessibilityRole="header">{t('auth.phoneTitle')}</Txt>
          <Txt variant="body" color={theme.colors.ink500}>{t('safety.notMedicalAdvice')}</Txt>
        </View>

        <Field
          label={t('auth.phoneTitle')}
          value={phone}
          onChangeText={setPhone}
          placeholder="05XXXXXXXX"
          keyboardType="phone-pad"
          hint="+966"
          error={error}
          autoFocus
          maxLength={20}
        />

        <Button label={t('common.next')} onPress={() => void submit()} loading={busy} disabled={phone.trim().length < 7} size="large" />

        <Banner tone="info" title={t('settings.privacy')} body={t('safety.noDoseAdvice')} />
      </Screen>
    </SafeAreaView>
  );
}
