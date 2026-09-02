import React, { useEffect } from 'react';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { View } from 'react-native';
import { AppProvider, useApp } from '@/state/app-store';
import { I18nProvider } from '@/i18n';
import { Loading } from '@/components/ui';
import { PALETTE } from '@dawaee/shared';
import { configureCategories, configureChannels } from '@/notifications';

/**
 * Root layout.
 *
 * Order matters: the app state resolves first (it holds the locale), then the
 * i18n provider wraps everything so the very first frame is already in the
 * right language and direction — no flash of English in an Arabic app.
 */
function Shell() {
  const { ready, preferences } = useApp();

  useEffect(() => {
    void configureChannels();
    void configureCategories(preferences.locale);
  }, [preferences.locale]);

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
      {ready ? (
        <Stack
          screenOptions={{
            headerShown: false,
            contentStyle: { backgroundColor: PALETTE.background },
            animation: 'slide_from_right',
          }}
        />
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
