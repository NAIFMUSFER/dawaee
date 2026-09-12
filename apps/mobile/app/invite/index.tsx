import React, { useEffect } from 'react';
import { Linking, Platform } from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Loading } from '@/components/ui';
import { stashPendingInvite } from '@/storage/pending-invite';

/**
 * Read the caregiver invitation bearer from a URL fragment and erase it from
 * browser history before navigating anywhere else. Fragments are not sent in
 * the HTTP request to the app origin/edge, unlike the legacy `/invite/<token>`
 * path. Native builds keep the token in SecureStore for the auth detour; web
 * keeps it process-memory-only by pending-invite policy.
 */
async function consumeInviteCapability(): Promise<string | null> {
  let fragment = '';
  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    fragment = window.location.hash.slice(1);
    if (fragment && typeof window.history?.replaceState === 'function') {
      window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
    }
  } else {
    const initial = await Linking.getInitialURL();
    fragment = initial?.split('#')[1] ?? '';
  }

  let token = fragment;
  try { token = decodeURIComponent(fragment); } catch { return null; }
  // New invitations use a hash-route (`#/invite/<token>`) so API integration
  // helpers and deep-link routers can identify the intent while the bearer
  // remains entirely after `#`. Keep accepting the earlier raw `#<token>`
  // fragment too, because already-issued links must continue to work.
  if (token.startsWith('/invite/')) token = token.slice('/invite/'.length);
  // randomToken(32) is currently 43 base64url characters. Keep a narrow
  // forward-compatible bound without accepting delimiters or arbitrary text.
  return /^[A-Za-z0-9_-]{32,128}$/.test(token) ? token : null;
}

export default function InviteCapabilityEntry() {
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const token = await consumeInviteCapability();
      if (token) await stashPendingInvite(token);
      if (!cancelled) router.replace('/caregiver/accept');
    })();
    return () => { cancelled = true; };
  }, []);

  return (
    <SafeAreaView style={{ flex: 1 }}>
      <Loading />
    </SafeAreaView>
  );
}
