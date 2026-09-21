import { afterEach, describe, expect, it, vi } from 'vitest';

const entropy = vi.hoisted(() => vi.fn());
vi.mock('expo-crypto', () => ({ getRandomBytesAsync: entropy }));
import { createRefreshNonce } from '../src/api/refresh-nonce.js';
afterEach(() => { vi.restoreAllMocks(); entropy.mockReset(); });

describe('refresh retry entropy', () => {
  it('uses all 32 bytes from the platform cryptographic generator', async () => {
    entropy.mockResolvedValue(Uint8Array.from({ length: 32 }, (_, index) => index));
    vi.spyOn(Math, 'random').mockImplementation(() => { throw new Error('insecure fallback'); });
    expect(await createRefreshNonce()).toBe('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f');
    expect(entropy).toHaveBeenCalledTimes(1);
    expect(entropy).toHaveBeenCalledWith(32);
  });
  it('fails closed when native entropy is unavailable', async () => {
    entropy.mockRejectedValue(new Error('native entropy unavailable'));
    const fallback = vi.spyOn(Math, 'random');
    await expect(createRefreshNonce()).rejects.toThrow('native entropy unavailable');
    expect(fallback).not.toHaveBeenCalled();
  });
});
