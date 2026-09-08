import React from 'react';
import { View } from 'react-native';
import { Tabs } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useI18n } from '@/i18n';
import { useTheme } from '@/hooks/useTheme';
import { useApp } from '@/state/app-store';
import { ProfileSwitcher } from '@/components/ProfileSwitcher';
import { TabIcon, type TabIconName } from '@/components/TabIcon';

export default function TabsLayout() {
  const { t } = useI18n();
  const theme = useTheme();
  const { profiles } = useApp();
  const hasMultipleProfiles = profiles.length > 1;

  const icon = (name: TabIconName) => ({ color, focused }: { color: string; focused: boolean }) => (
    <TabIcon
      name={name}
      color={color}
      focused={focused}
      size={theme.elderlyMode ? 29 : 24}
    />
  );

  const profileHeader = () => (
    <SafeAreaView edges={['top']} style={{ backgroundColor: theme.colors.surface }}>
      <View style={{ paddingHorizontal: theme.spacing.lg, paddingBottom: theme.spacing.sm }}>
        <ProfileSwitcher compact />
      </View>
    </SafeAreaView>
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
        tabBarLabelStyle: { fontSize: 12, fontWeight: '600', lineHeight: 16 },
        tabBarLabelPosition: 'below-icon',
        tabBarAllowFontScaling: false,
      }}
    >
      <Tabs.Screen name="today" options={{ title: t('nav.today'), tabBarIcon: icon('today') }} />
      <Tabs.Screen name="medications" options={{ title: t('nav.medications'), tabBarIcon: icon('medications') }} />
      <Tabs.Screen
        name="history"
        options={{
          title: t('nav.history'),
          tabBarIcon: icon('history'),
          headerShown: hasMultipleProfiles,
          header: hasMultipleProfiles ? profileHeader : undefined,
        }}
      />
      <Tabs.Screen name="family" options={{ title: t('nav.family'), tabBarIcon: icon('family') }} />
      <Tabs.Screen name="settings" options={{ title: t('nav.settings'), tabBarIcon: icon('settings') }} />
    </Tabs>
  );
}
