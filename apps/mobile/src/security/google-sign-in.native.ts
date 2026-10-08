import { Platform } from 'react-native';
import Constants from 'expo-constants';
import { GoogleSignin, isSuccessResponse } from '@react-native-google-signin/google-signin';
const extra = Constants.expoConfig?.extra as { googleWebClientId?: string; googleIosClientId?: string } | undefined;
export const googleSignInConfigured = Boolean(extra?.googleWebClientId && (Platform.OS !== 'ios' || extra.googleIosClientId));
let configured = false;
export async function googleSignIn(): Promise<string | null> {
  if (!googleSignInConfigured) throw new Error('Google sign-in unavailable');
  if (!configured) { GoogleSignin.configure({ webClientId: extra!.googleWebClientId, iosClientId: extra!.googleIosClientId }); configured = true; }
  if (Platform.OS === 'android') await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });
  const response = await GoogleSignin.signIn();
  if (!isSuccessResponse(response)) return null;
  if (!response.data.idToken) throw new Error('Google ID token missing');
  return response.data.idToken;
}
