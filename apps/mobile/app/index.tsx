import React from 'react';
import { Redirect } from 'expo-router';
import { useApp } from '@/state/app-store';
import { DEMO_MODE, isSignedIn } from '@/api/client';
import { Button, Screen, Txt } from '@/components/ui';

/** Splash / entry: sends the user to sign-in or straight to Today. */
export default function Index() {
  const { signedIn, profiles, preferences, refreshProfiles } = useApp();
  const [retrying, setRetrying] = React.useState(false);

  // The preview has no sign-in to complete, so it opens on the screen that
  // actually shows the product.
  if (DEMO_MODE) return <Redirect href="/(tabs)/today" />;

  // A retained credential is deliberately not enough to expose cached health
  // data after an HTTP/protocol bootstrap failure. It is also not a new user:
  // sending this state through language/onboarding makes a transient service
  // outage look like logout. Keep the screen PHI-free and retry the same
  // verified-session bootstrap instead.
  if (!signedIn && isSignedIn()) {
    const ar = preferences.locale === 'ar';
    const retry = async () => {
      if (retrying) return;
      setRetrying(true);
      try {
        await refreshProfiles();
      } catch {
        // Stay on the neutral recovery boundary. The API client keeps the
        // retained session for transient HTTP/protocol failures and clears it
        // itself if a retry proves the session is no longer valid.
      } finally {
        setRetrying(false);
      }
    };

    return (
      <Screen scroll={false} style={{ flex: 1, justifyContent: 'center' }}>
        <Txt variant="h2" weight="bold" align="center">
          {ar ? 'تعذر التحقق من الجلسة' : 'Couldn’t verify your session'}
        </Txt>
        <Txt align="center">
          {ar
            ? 'تعذر الاتصال بالخدمة الآن. لم نعرض البيانات الصحية المخزنة حفاظًا على الخصوصية. أعد المحاولة.'
            : 'We couldn’t reach the service. Cached health data remains hidden until your session is verified. Try again.'}
        </Txt>
        <Button
          testID="session-recovery-retry"
          label={ar ? 'إعادة المحاولة' : 'Try again'}
          loading={retrying}
          onPress={() => { void retry(); }}
        />
      </Screen>
    );
  }

  if (!signedIn) return <Redirect href="/(auth)/language" />;
  if (profiles.length === 0) return <Redirect href="/(auth)/onboarding" />;
  return <Redirect href="/(tabs)/today" />;
}
