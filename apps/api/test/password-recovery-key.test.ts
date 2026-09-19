import { describe, expect, it } from 'vitest';
import { deriveRecoveryRequestKey } from '../src/lib/password.js';

describe('password recovery retry key', () => {
  it('preserves retry equality and separates a different password or authentication', async () => {
    const proof = 'a'.repeat(64);
    const first = await deriveRecoveryRequestKey('fixture recovery secret 2026', proof);
    expect(first.length).toBe(32);
    expect(await deriveRecoveryRequestKey('fixture recovery secret 2026', proof)).toEqual(first);
    expect(await deriveRecoveryRequestKey('different fixture recovery secret', proof)).not.toEqual(first);
    expect(await deriveRecoveryRequestKey('fixture recovery secret 2026', 'b'.repeat(64))).not.toEqual(first);
  });
  it('rejects missing or malformed proof-specific salts', async () => {
    await expect(deriveRecoveryRequestKey('fixture recovery secret', '')).rejects.toThrow('Invalid recovery proof key');
    await expect(deriveRecoveryRequestKey('fixture recovery secret', 'z'.repeat(64))).rejects.toThrow('Invalid recovery proof key');
  });
});
