import React from 'react';
import { Stack } from 'expo-router';
import { PALETTE } from '@dawaee/shared';
import { useApp } from '@/state/app-store';
import { DEMO_MODE } from '@/api/client';

// Root Stack names, including nested files without their own layout. The route
// inventory regression requires every new non-public route to join this list.
// Capability entries must remain public so they can preserve an invitation
// through sign-in or resolve a deliberately shared emergency card.
export const AUTHENTICATED_ROUTES = [
  '(tabs)',
  'notification',
  'medication/[id]', 'medication/detail', 'medication/add',
  'medication/capture', 'medication/confirm', 'medication/quick-create',
  'medication/edit', 'medication/stock', 'medication/schedule',
  'reports/index', 'reports/adherence', 'reports/clinician',
  'reports/notes', 'reports/weekly',
  'caregiver/[id]', 'caregiver/detail', 'caregiver/dashboard',
  'caregiver/invite', 'caregiver/escalation', 'caregiver/notification',
  'settings/privacy', 'settings/email-verification', 'settings/app-lock',
  'settings/emergency-qr', 'settings/accessibility', 'settings/notifications',
  'settings/phone-verification', 'settings/travel', 'settings/emergency',
] as const;

export default function AppNavigator() {
  const { signedIn } = useApp();
  return (
    <Stack screenOptions={{
      headerShown: false,
      contentStyle: { backgroundColor: PALETTE.background },
      animation: 'slide_from_right',
    }}>
      <Stack.Screen name="index" />
      <Stack.Protected guard={DEMO_MODE || signedIn}>
        {AUTHENTICATED_ROUTES.map(name => <Stack.Screen key={name} name={name} />)}
      </Stack.Protected>
    </Stack>
  );
}
