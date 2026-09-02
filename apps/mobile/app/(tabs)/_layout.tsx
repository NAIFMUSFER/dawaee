import React from 'react';
import { Tabs } from 'expo-router';
import { Text } from 'react-native';
import { useI18n } from '@/i18n';
import { useTheme } from '@/hooks/useTheme';

/**
 * Bottom navigation.
 *
 * Only five destinations, and in elderly mode the labels grow with the type
 * ramp. The brief's "fewer options per page" is enforced structurally: deeper
 * functions live one level in, not in the tab bar.
 */
export default function TabsLayout() {
  const { t } = useI18n();
  const theme = useTheme();

  const icon = (glyph: string) => ({ color, focused }: { color: string; focused: boolean }) => (
    <Text style={{ fontSize: theme.elderlyMode ? 28 : 22, color, opacity: focused ? 1 : 0.75 }}>{glyph}</Text>
  );

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: theme.colors.primary700,
        tabBarInactiveTintColor: theme.colors.ink500,
        tabBarStyle: {
          height: theme.touch + 30,
          paddingTop: 6,
          paddingBottom: 10,
          backgroundColor: theme.colors.surface,
          borderTopColor: theme.colors.ink100,
        },
        // The label is NOT scaled by elderly mode: five tabs cannot hold five
        // larger Arabic words without truncating, and a clipped label is worse
        // than a small one. The emphasis goes into the icon and the target
        // height instead, both of which do grow.
        tabBarLabelStyle: { fontSize: 12, fontWeight: '600' },
        tabBarLabelPosition: 'below-icon',
        tabBarAllowFontScaling: false,
      }}
    >
      <Tabs.Screen name="today" options={{ title: t('nav.today'), tabBarIcon: icon('☀️') }} />
      <Tabs.Screen name="medications" options={{ title: t('nav.medications'), tabBarIcon: icon('💊') }} />
      <Tabs.Screen name="history" options={{ title: t('nav.history'), tabBarIcon: icon('📅') }} />
      <Tabs.Screen name="family" options={{ title: t('nav.family'), tabBarIcon: icon('👨‍👩‍👦') }} />
      <Tabs.Screen name="settings" options={{ title: t('nav.settings'), tabBarIcon: icon('⚙️') }} />
    </Tabs>
  );
}
