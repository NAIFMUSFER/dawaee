/** Browser/Android never load Apple's iOS native module. */
export async function appleAuthorization(): Promise<{ authorizationCode: string; rawNonce: string; displayName?: string } | null> {
  throw new Error('Apple sign-in requires the iOS app');
}
