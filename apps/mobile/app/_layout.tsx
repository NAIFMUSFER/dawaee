import React, { useEffect } from 'react';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { View } from 'react-native';
import { AppProvider, useApp } from '@/state/app-store';
import { I18nProvider } from '@/i18n';
import { Loading, PreviewBanner } from '@/components/ui';
import { PALETTE } from '@dawaee/shared';
import { configureCategories, configureChannels, startNotificationActionListener, syncPushRegistration } from '@/notifications';
import { DEMO_MODE } from '@/api/client';
import { AppLockGate } from '@/security/AppLockGate';

/**
 * Root layout.
 *
 * Order matters: the app state resolves first (it holds the locale), then the
 * i18n provider wraps everything so the very first frame is already in the
 * right language and direction — no flash of English in an Arabic app.
 */
function Shell() {
  const { ready, preferences, signedIn, deviceId, syncNow: refreshAfterAction } = useApp();

  useEffect(() => {
    void configureChannels();
    void configureCategories(preferences.locale);
  }, [preferences.locale]);

  /**
   * Tell the server which device to reach.
   *
   * This is the step that was missing entirely: a token was obtainable but
   * never sent, so `push_tokens` stayed empty and every escalation ended at
   * the dispatcher with `no_active_device` — the reminder chain stopping one
   * move short of an actual phone. Runs on every signed-in start because the
   * OS can reissue a token at any time, and a stale one is a missed dose that
   * nothing reports.
   *
   * Failure is deliberately quiet here: web and simulators cannot receive
   * push at all, and a refused permission is the patient's choice. The
   * settings screen is where that state is reported, not a toast at launch.
   */
  useEffect(() => {
    if (!signedIn || !deviceId) return;
    void syncPushRegistration(deviceId).catch(() => undefined);
  }, [signedIn, deviceId]);

  /**
   * Act on the reminder's own buttons.
   *
   * Registering the category only tells the OS to draw "Taken / Remind me
   * later / Skip"; something has to listen for the tap. Nothing did, so a
   * patient confirming from the lock screen recorded nothing, the dose was
   * marked missed, and their family was alerted — the gesture meant to prevent
   * a false alarm was producing one.
   *
   * Mounted once for the whole app rather than on the Today screen, because
   * two of the three buttons deliberately do not open the app: the handler has
   * to exist even when no screen is showing.
   */
  useEffect(() => {
    if (!signedIn) return;
    let stop: (() => void) | undefined;
    let cancelled = false;
    void startNotificationActionListener(() => { void refreshAfterAction(); })
      .then((s) => { if (cancelled) s(); else stop = s; })
      .catch(() => undefined);
    return () => { cancelled = true; stop?.(); };
  }, [signedIn, refreshAfterAction]);

  // The provider wraps the loading state too. Components as basic as the
  // spinner reach for the theme, and the theme is direction-aware — rendering
  // anything outside the provider throws.
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
        // The lock wraps the router, not individual screens. `appLockEnabled`
        // was previously written and displayed by the settings screen and
        // enforced nowhere — anyone holding the unlocked phone could read the
        // full medication history of a patient who had been told it was
        // protected. Placed here, every route renders underneath it, including
        // ones opened by a deep link or a notification tap that never pass
        // through a screen that could have done the checking.
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
