import React, { useEffect, useRef, useState } from 'react';
import { Keyboard, Platform, View } from 'react-native';
import * as AppleAuthentication from 'expo-apple-authentication';
import { router } from 'expo-router';
import { Banner } from './ui';
import { api, ApiError, getDeviceId } from '@/api/client';
import { appleAuthorization } from '@/security/apple-sign-in';
import { useApp } from '@/state/app-store';
import { useI18n } from '@/i18n';
import { landingAfterAuth } from '@/storage/pending-invite';

export function AppleAuthButton({ disabled = false, onBusyChange }: { disabled?: boolean; onBusyChange?: (busy: boolean) => void }) {
  const { t } = useI18n();
  const { preferences, signInWithTokens } = useApp();
  const [available, setAvailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  const running = useRef(false);
  useEffect(() => {
    mounted.current = true;
    if (Platform.OS === 'ios') void Promise.all([AppleAuthentication.isAvailableAsync(),
      api.anonymous.get<{ available: boolean }>('/v1/auth/apple/options')])
      .then(([native, server]) => { if (mounted.current) setAvailable(native && server.available); }).catch(() => undefined);
    return () => { mounted.current = false; };
  }, []);
  const submit = async () => {
    if (running.current || disabled) return;
    running.current = true; onBusyChange?.(true); setBusy(true); setError(null); Keyboard.dismiss();
    try {
      const proof = await appleAuthorization();
      if (!proof || !mounted.current) return;
      const deviceId = await getDeviceId();
      if (!mounted.current) return;
      const tokens = await api.anonymous.post<{ accessToken: string; refreshToken: string }>('/v1/auth/apple',
        { ...proof, deviceId, locale: preferences.locale });
      if (!mounted.current) return;
      await signInWithTokens(tokens);
      // Apple private relay users can enter with name/email only. Phone stays optional in Settings.
      const landing = await landingAfterAuth();
      if (mounted.current) router.replace(landing);
    } catch (err) { if (mounted.current) setError(err instanceof ApiError ? err.message : t('auth.connectionFailed')); }
    finally { running.current = false; if (mounted.current) { setBusy(false); onBusyChange?.(false); } }
  };
  if (!available) return null;
  return <><View pointerEvents={disabled || busy ? 'none' : 'auto'} accessibilityState={{ disabled: disabled || busy, busy }}>
    <AppleAuthentication.AppleAuthenticationButton buttonType={AppleAuthentication.AppleAuthenticationButtonType.CONTINUE}
      buttonStyle={AppleAuthentication.AppleAuthenticationButtonStyle.BLACK} cornerRadius={12}
      style={{ height: 56, width: '100%', opacity: disabled || busy ? 0.5 : 1 }} onPress={() => void submit()} />
  </View>{error ? <Banner tone="warning" title={error} /> : null}</>;
}
