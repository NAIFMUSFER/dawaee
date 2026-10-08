import { Platform } from 'react-native';
import * as AppleAuthentication from 'expo-apple-authentication';
import { digestStringAsync, CryptoDigestAlgorithm } from 'expo-crypto';
import { createRefreshNonce } from '@/api/refresh-nonce';

export async function appleAuthorization(): Promise<{ authorizationCode: string; rawNonce: string; displayName?: string } | null> {
  if (Platform.OS !== 'ios') throw new Error('Apple sign-in requires the iOS app');
  const rawNonce = await createRefreshNonce();
  const state = await createRefreshNonce();
  try {
    // Expo forwards nonce unchanged to ASAuthorizationAppleIDRequest.
    const credential = await AppleAuthentication.signInAsync({ state,
      nonce: await digestStringAsync(CryptoDigestAlgorithm.SHA256, rawNonce),
      requestedScopes: [AppleAuthentication.AppleAuthenticationScope.FULL_NAME, AppleAuthentication.AppleAuthenticationScope.EMAIL] });
    if (credential.state !== state || !credential.authorizationCode) throw new Error('Invalid Apple response');
    const displayName = credential.fullName ? AppleAuthentication.formatFullName(credential.fullName).trim().slice(0, 120) : '';
    return { authorizationCode: credential.authorizationCode, rawNonce, ...(displayName ? { displayName } : {}) };
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ERR_REQUEST_CANCELED') return null;
    throw error;
  }
}
