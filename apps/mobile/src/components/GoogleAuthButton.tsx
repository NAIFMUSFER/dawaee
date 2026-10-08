import React, { useEffect, useRef, useState } from 'react';
import { Keyboard } from 'react-native';
import { router } from 'expo-router';
import { Banner, Button } from './ui';
import { api, ApiError, getDeviceId } from '@/api/client';
import { useApp } from '@/state/app-store';
import { useI18n } from '@/i18n';
import { googleSignIn, googleSignInConfigured } from '@/security/google-sign-in';
import { landingAfterAuth } from '@/storage/pending-invite';
export function GoogleAuthButton({ disabled = false, onBusyChange }: { disabled?: boolean; onBusyChange?: (busy: boolean) => void }) {
  const { t } = useI18n();
  const { preferences, signInWithTokens } = useApp();
  const [available, setAvailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  const running = useRef(false);
  useEffect(() => { mounted.current = true;
    if (googleSignInConfigured) void api.anonymous.get<{available:boolean}>('/v1/auth/google/options').then(result => { if(mounted.current) setAvailable(result.available); }).catch(() => undefined);
    return () => { mounted.current = false; };
  }, []);
  const submit = async () => {
    if (running.current || disabled) return;
    running.current = true; onBusyChange?.(true); setBusy(true); setError(null); Keyboard.dismiss();
    try {
      const idToken = await googleSignIn();
      if (!idToken || !mounted.current) return;
      const deviceId = await getDeviceId();
      if (!mounted.current) return;
      const tokens = await api.anonymous.post<{accessToken:string;refreshToken:string;isNewUser:boolean}>('/v1/auth/google', { idToken, deviceId, locale: preferences.locale });
      if (!mounted.current) return;
      await signInWithTokens(tokens);
      if (tokens.isNewUser) {
        router.replace('/settings/phone-verification?source=google');
      } else {
        const landing = await landingAfterAuth();
        if (mounted.current) router.replace(landing);
      }
    } catch(err) { if(mounted.current) setError(err instanceof ApiError ? err.message : t('auth.connectionFailed')); }
    finally { running.current = false; if(mounted.current) { setBusy(false); onBusyChange?.(false); } }
  };
  if (!available) return null;
  return <><Button label={t('auth.continueGoogle')} tone="secondary" disabled={disabled} loading={busy} onPress={() => void submit()} />
    {error ? <Banner tone="warning" title={error} /> : null}</>;
}
