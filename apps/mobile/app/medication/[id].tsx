import React, { useEffect } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Loading } from '@/components/ui';
import { setMedicationDetailRouteIntent } from '@/navigation/private-navigation';
import { useApp } from '@/state/app-store';

/**
 * Compatibility shim for an already-issued dynamic medication URL.
 *
 * The first request may already have reached the hosting platform, so current
 * navigation never creates this route. Once account/profile ownership is
 * available, preserve the selection in memory and replace the browser entry
 * with the fixed detail path.
 */
export default function LegacyMedicationDetailScreen() {
  const params = useLocalSearchParams<{ id?: string }>();
  const { user, activeProfile } = useApp();
  const medicationId = Array.isArray(params.id) ? params.id[0] : params.id;

  useEffect(() => {
    if (!medicationId) {
      router.replace('/medication/detail');
      return;
    }
    if (!user || !activeProfile) return;
    setMedicationDetailRouteIntent({
      userId: user.id,
      patientProfileId: activeProfile.id,
      medicationId,
    });
    router.replace('/medication/detail');
  }, [activeProfile, medicationId, user]);

  return <SafeAreaView style={{ flex: 1 }}><Loading /></SafeAreaView>;
}
