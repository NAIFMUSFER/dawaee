import React, { useEffect, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Button, EmptyState, Txt } from '@/components/ui';
import { useI18n } from '@/i18n';
import { useApp } from '@/state/app-store';

/**
 * Neutral landing for privacy-minimized caregiver push notifications.
 *
 * The push intentionally does not identify the patient. Do not infer the
 * alerted person from activeProfile or from the first followed profile: those
 * can belong to an unrelated patient. The caregiver explicitly chooses the
 * person before the clinical dashboard is allowed to render any adherence data.
 */
export default function CaregiverNotificationLandingScreen() {
  const { t } = useI18n();
  const { profiles, activeProfile, setActiveProfile } = useApp();
  const [pendingProfileId, setPendingProfileId] = useState<string | null>(null);
  const followed = profiles.filter((profile) => profile.role === 'caregiver');

  useEffect(() => {
    if (!pendingProfileId || activeProfile?.id !== pendingProfileId) return;
    router.replace('/caregiver/dashboard');
  }, [activeProfile?.id, pendingProfileId]);

  if (followed.length === 0) {
    return (
      <SafeAreaView style={{ flex: 1 }}>
        <EmptyState
          title={t('caregiver.dashboard')}
          body={t('caregiver.noPatients')}
          action={<Button label={t('common.back')} fullWidth={false} onPress={() => router.back()} />}
        />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1 }}>
      <ScrollView contentContainerStyle={{ padding: 20, gap: 16 }}>
        <View style={{ gap: 6 }}>
          <Txt variant="h1" weight="bold" accessibilityRole="header">
            {t('caregiver.choosePatient')}
          </Txt>
          <Txt variant="bodySmall">
            {t('caregiver.dashboard')}
          </Txt>
        </View>

        <View style={{ gap: 10 }}>
          {followed.map((profile) => (
            <Button
              key={profile.id}
              label={profile.displayName}
              onPress={() => {
                setPendingProfileId(profile.id);
                setActiveProfile(profile.id);
              }}
            />
          ))}
        </View>

        <Button label={t('common.back')} tone="ghost" fullWidth={false} onPress={() => router.back()} />
      </ScrollView>
    </SafeAreaView>
  );
}
