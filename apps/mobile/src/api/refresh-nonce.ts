/** A capability, never an installation identifier or Math.random fallback. */
export async function createRefreshNonce(): Promise<string> {
  const { getRandomBytesAsync } = await import('expo-crypto');
  const bytes = await getRandomBytesAsync(32);
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}
