import Constants from 'expo-constants';
import { api } from '@/api/client';
import { redirectInviteSystemPath } from '@/navigation/native-invite';

// Expo Router invokes this for both launch URLs and its live Linking 'url'
// listener, before route matching. getInitialURL alone cannot read a warm tap.
export function redirectSystemPath({ path }: { path: string; initial: boolean }): string | null {
  const configured = Constants.expoConfig?.scheme ?? 'dawaee';
  const schemes = Array.isArray(configured) ? configured : [configured];
  return redirectInviteSystemPath(path, api.baseUrl, schemes);
}
