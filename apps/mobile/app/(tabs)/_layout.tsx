import React from 'react';
import { Tabs } from 'expo-router';
import { useI18n } from '@/i18n';
import { useTheme } from '@/hooks/useTheme';
import { TabIcon, type TabIconName } from '@/components/TabIcon';

/**
 * Bottom navigation.
 *
 * Uses deterministic SVG icons instead of emoji so the same symbols render on
 * iOS, Android and web. Emoji varied by platform and could appear as missing or
 * differently-sized glyphs in Safari, which made a navigation target look
 * broken even when the route itself was healthy.
 */
export default function TabsLayout() {
  const { t } = useI18n();
  const theme = useTheme();

  const icon = (name: TabIconName) => ({ color, focused }: { color: string; focused: boolean }) => (
    <TabIcon
      name={name}
      color={color}
      focused={focused}
      size={theme.elderlyMode ? 29 : 24}
    />
  );

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: theme.colors.primary700,
        tabBarInactiveTintColor: theme.colors.ink500,
        tabBarHideOnKeyboard: true,
        tabBarStyle: {
          height: theme.touch + 30,
          paddingTop: 7,
          paddingBottom: 10,
          backgroundColor: theme.colors.surface,
          borderTopColor: theme.colors.ink100,
        },
        tabBarItemStyle: {
          minWidth: 0,
          paddingHorizontal: 2,
        },
        // Keep all five Arabic labels readable on narrow iPhones without
        // allowing OS font scaling to clip one label and shift the others.
        tabBarLabelStyle: { fontSize: 12, fontWeight: '600', lineHeight: 16 },
        tabBarLabelPosition: 'below-icon',
        tabBarAllowFontScaling: false,
      }}
    >
      <Tabs.Screen name="today" options={{ title: t('nav.today'), tabBarIcon: icon('today') }} />
      <Tabs.Screen name="medications" options={{ title: t('nav.medications'), tabBarIcon: icon('medications') }} />
      <Tabs.Screen name="history" options={{ title: t('nav.history'), tabBarIcon: icon('history') }} />
      <Tabs.Screen name="family" options={{ title: t('nav.family'), tabBarIcon: icon('family') }} />
      <Tabs.Screen name="settings" options={{ title: t('nav.settings'), tabBarIcon: icon('settings') }} />
    </Tabs>
  );
}
