import React from 'react';
import { Redirect } from 'expo-router';
import { useApp } from '@/state/app-store';
import { DEMO_MODE } from '@/api/client';

/** Splash / entry: sends the user to sign-in or straight to Today. */
export default function Index() {
  const { signedIn, profiles } = useApp();
  // The preview has no sign-in to complete, so it opens on the screen that
  // actually shows the product.
  if (DEMO_MODE) return <Redirect href="/(tabs)/today" />;
  if (!signedIn) return <Redirect href="/(auth)/language" />;
  if (profiles.length === 0) return <Redirect href="/(auth)/onboarding" />;
  return <Redirect href="/(tabs)/today" />;
}
