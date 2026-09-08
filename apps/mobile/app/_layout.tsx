import React, { useEffect } from 'react';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { Alert, Platform, View } from 'react-native';
import { AppProvider, useApp } from '@/state/app-store';
import { I18nProvider } from '@/i18n';
import { Loading, PreviewBanner } from '@/components/ui';
import { PALETTE } from '@dawaee/shared';
import { configureCategories, configureChannels, startNotificationActionListener, syncPushRegistration } from '@/notifications';
import { DEMO_MODE } from '@/api/client';
import { AppLockGate } from '@/security/AppLockGate';

/**
 * React Native Web does not implement the native multi-button Alert contract.
 * Screens use that contract before destructive actions (revoking caregiver
 * access, leaving a care circle, etc.), so on Safari the button looked alive
 * but its confirmation callback never ran. Install one web-only adapter at the
 * application boundary: native keeps the real Alert, while web maps the same
 * cancel/confirm contract to the browser's blocking confirm dialog.
 */
function useWebAlertAdapter() {
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof globalThis.confirm !== 'function') return;

    const nativeAlert = Alert.alert;
    Alert.alert = (title, message, buttons) => {
      const actions = buttons ?? [];
      const confirmAction = actions.find((button) => button.style === 'destructive')
        ?? actions.find((button) => button.style !== 'cancel');
      const prompt = message ? `${title}\n\n${message}` : title;
      if (globalThis.confirm(prompt)) confirmAction?.onPress?.();
    };

    return () => { Alert.alert = nativeAlert; };
  }, []);
}

/**
 * Root layout.
 *
 * Order matters: the app state resolves first (it holds the locale), then the
 * i18n provider wraps everything so the very first frame is already in the
 * right language and direction — no flash of English in an Arabic app.
 */
function Shell() {
  const { ready, preferences, signedIn, deviceId, syncNow: refreshAfterAction } = useApp();
  useWebAlertAdapter();

  useEffect(() => {
    void configureChannels();
    void configureCategories(preferences.locale);
  }, [preferences.locale]);

  /** Tell the server which device to reach. */
  useEffect(() => {
    if (!signedIn || !deviceId) return;
    void syncPushRegistration(deviceId).catch(() => undefined);
  }, [signedIn, deviceId]);

  /** Act on the reminder's own buttons. */
  useEffect(() => {
    if (!signedIn) return;
    let stop: (() => void) | undefined;
    let cancelled = false;
    void startNotificationActionListener(() => { void refreshAfterAction(); })
      .then((s) => { if (cancelled) s(); else stop = s; })
      .catch(() => undefined);
    return () => { cancelled = true; stop?.(); };
  }, [signedIn, refreshAfterAction]);

  return (
    <I18nProvider
      locale={preferences.locale}
      numeralSystem={preferences.numeralSystem}
      calendar={preferences.calendarSystem}
    >
      <StatusBar style="dark" />
      {DEMO_MODE ? (
        <PreviewBanner
          label={preferences.locale === 'en'
            ? 'Interface preview — sample data, no server attached'
            : 'معاينة الواجهة — بيانات تجريبية، بدون خادم'}
        />
      ) : null}
      {ready ? (
        <AppLockGate>
          <Stack
            screenOptions={{
              headerShown: false,
              contentStyle: { backgroundColor: PALETTE.background },
              animation: 'slide_from_right',
            }}
          />
        </AppLockGate>
      ) : (
        <View style={{ flex: 1, backgroundColor: PALETTE.background, justifyContent: 'center' }}>
          <Loading />
        </View>
      )}
    </I18nProvider>
  );
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <AppProvider>
        <Shell />
      </AppProvider>
    </SafeAreaProvider>
  );
}
