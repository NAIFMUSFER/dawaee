import React from 'react';
import { Screen } from '@/components/ui';
import { PhoneVerification } from '@/components/PhoneVerification';
import { useApp } from '@/state/app-store';

export default function PhoneVerificationScreen() {
  const { user, refreshProfiles } = useApp();
  return <Screen><PhoneVerification key={user?.id} onVerified={() => { void refreshProfiles().catch(() => undefined); }} /></Screen>;
}
