import React from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Button, Screen, Txt } from '@/components/ui';
import { useApp } from '@/state/app-store';
import { useTheme } from '@/hooks/useTheme';
import type { Locale } from '@dawaee/shared';

/**
 * Language selection, shown before anything else.
 *
 * Deliberately the first screen: an elderly Arabic speaker should never have
 * to read an English sentence to find the language switch. Both options are
 * written in their own language, at reminder-button size.
 */
export default function LanguageScreen() {
  const { updatePreferences, preferences } = useApp();
  const theme = useTheme();

  const choose = async (locale: Locale) => {
    await updatePreferences({ locale });
    router.push('/(auth)/phone');
  };

  return (
    <SafeAreaView style={{ flex: 1 }}>
      <Screen>
        <View style={{ alignItems: 'center', gap: theme.spacing.sm, paddingVertical: theme.spacing.xxl }}>
          <Txt variant="display" weight="bold" align="center">دوائي</Txt>
          <Txt variant="h3" color={theme.colors.ink500} align="center">Dawaee</Txt>
        </View>

        <View style={{ gap: theme.spacing.md }}>
          <Button label="العربية" size="large" onPress={() => void choose('ar')} tone={preferences.locale === 'ar' ? 'primary' : 'secondary'} />
          <Button label="English" size="large" onPress={() => void choose('en')} tone={preferences.locale === 'en' ? 'primary' : 'secondary'} />
        </View>

        <Txt variant="caption" color={theme.colors.ink500} align="center" style={{ marginTop: theme.spacing.xl }}>
          يمكنك تغيير اللغة لاحقاً من الإعدادات · You can change this later in Settings
        </Txt>
      </Screen>
    </SafeAreaView>
  );
}
