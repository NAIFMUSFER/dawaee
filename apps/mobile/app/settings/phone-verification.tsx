import React from 'react';
import { Screen } from '@/components/ui';
import { PhoneVerification } from '@/components/PhoneVerification';
import { useApp } from '@/state/app-store';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Button } from '@/components/ui';
import { useI18n } from '@/i18n';
import { useLocalSearchParams } from 'expo-router';
import { landingAfterAuth } from '@/storage/pending-invite';

export default function PhoneVerificationScreen() {
  const { user } = useApp();
  const { t } = useI18n();
  const { source } = useLocalSearchParams<{ source?: string }>();
  const fromGoogle = source === 'google';
  const finish = async () => router.replace(await landingAfterAuth());
  return <SafeAreaView style={{ flex: 1 }}><Screen>
    {!fromGoogle ? <Button label={t('common.back')} tone="ghost" onPress={() => router.replace('/(tabs)/settings')} /> : null}
    <PhoneVerification key={user?.id} googleAccount={fromGoogle}
      onVerified={fromGoogle ? () => void finish() : () => router.replace('/(tabs)/family')} />
  </Screen></SafeAreaView>;
}
