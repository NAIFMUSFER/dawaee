import React, { useEffect } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Loading } from '@/components/ui';
import { stashPendingInvite } from '@/storage/pending-invite';

/**
 * Compatibility entry for invitations issued before fragment-only transport.
 *
 * The legacy URL already contains the bearer in `/invite/<token>`, so the first
 * browser request cannot be made private retroactively. What we can prevent is
 * a second exposure: do not forward the bearer as a search/query parameter to
 * the accept screen. Stash it under the existing pending-invite policy and
 * immediately replace the browser/app route with the fixed, token-free accept
 * path. New invitations continue to use `/invite#...` and never hit this file.
 */
export default function LegacyInviteLink() {
  const { token } = useLocalSearchParams<{ token?: string }>();

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (token) await stashPendingInvite(token);
      if (!cancelled) router.replace('/caregiver/accept');
    })();
    return () => { cancelled = true; };
  }, [token]);

  return (
    <SafeAreaView style={{ flex: 1 }}>
      <Loading />
    </SafeAreaView>
  );
}
