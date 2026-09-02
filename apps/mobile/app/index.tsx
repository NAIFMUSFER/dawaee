import React from 'react';
import { Redirect } from 'expo-router';
import { useApp } from '@/state/app-store';

/** Splash / entry: sends the user to sign-in or straight to Today. */
export default function Index() {
  const { signedIn, profiles } = useApp();
  if (!signedIn) return <Redirect href="/(auth)/language" />;
  if (profiles.length === 0) return <Redirect href="/(auth)/onboarding" />;
  return <Redirect href="/(tabs)/today" />;
}
