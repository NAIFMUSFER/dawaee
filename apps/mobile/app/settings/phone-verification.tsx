import React from 'react';
import { Screen } from '@/components/ui';
import { PhoneVerification } from '@/components/PhoneVerification';
import { useApp } from '@/state/app-store';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Button } from '@/components/ui';
import { useI18n } from '@/i18n';

export default function PhoneVerificationScreen() {
  const { user, refreshProfiles } = useApp();
  const { t } = useI18n();
  return <SafeAreaView style={{ flex: 1 }}><Screen>
    <Button label={t('common.back')} tone="ghost" onPress={() => router.replace('/(tabs)/settings')} />
    <PhoneVerification key={user?.id} onVerified={() => { void refreshProfiles().catch(() => undefined); }} />
  </Screen></SafeAreaView>;
}
