import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, resetConfigCache } from '../src/config.js';
import { openRecoveryToken, recoveryVerificationKey, sealRecoveryToken } from '../src/auth/recovery-tokens.js';
import { signAccessToken, verifyAccessToken } from '../src/auth/tokens.js';

const service = `VA${'3'.repeat(32)}`;
const verification = () => ({ phone: '+966500000001', verificationSid: `VE${'4'.repeat(32)}`, serviceSid: service, startedAt: Math.floor(Date.now() / 1000) });
beforeEach(() => {
  resetConfigCache();
  loadConfig({ DATABASE_URL: 'postgres://test.invalid/synthetic', JWT_SECRET: 'synthetic'.repeat(8), TWILIO_VERIFY_SERVICE_SID: service });
});
afterEach(() => { resetConfigCache(); vi.useRealTimers(); });
describe('encrypted purpose-bound recovery tokens', () => {
  it('hides the phone, rejects tampering and prevents a challenge becoming a password proof', async () => {
    const original = verification(), token = await sealRecoveryToken(original, 'challenge');
    expect(token).not.toContain(original.phone);
    expect(await openRecoveryToken(token, 'challenge')).toEqual(original);
    await expect(openRecoveryToken(token, 'proof')).rejects.toThrow();
    const parts = token.split('.'); parts[3] = `${parts[3]![0] === 'a' ? 'b' : 'a'}${parts[3]!.slice(1)}`;
    await expect(openRecoveryToken(parts.join('.'), 'challenge')).rejects.toThrow();
  });
  it('is not interchangeable with a login access token', async () => {
    const token = await sealRecoveryToken(verification(), 'proof');
    await expect(verifyAccessToken(token)).rejects.toThrow();
    await expect(openRecoveryToken(await signAccessToken('synthetic-user', 'synthetic-session'), 'proof')).rejects.toThrow();
  });
  it('expires from the original creation time even when a proof is minted later', async () => {
    vi.useFakeTimers(); const original = verification();
    vi.advanceTimersByTime(240_000);
    const token = await sealRecoveryToken(original, 'proof');
    expect(await openRecoveryToken(token, 'proof')).toEqual(original);
    vi.advanceTimersByTime(61_000);
    await expect(openRecoveryToken(token, 'proof')).rejects.toThrow();
  });
  it('gives repeated proofs/resends the same SQL consumption key, isolated by account and provider service', async () => {
    const original = verification();
    const first = await openRecoveryToken(await sealRecoveryToken(original, 'proof'), 'proof');
    const second = await openRecoveryToken(await sealRecoveryToken(original, 'proof'), 'proof');
    expect(recoveryVerificationKey(first)).toBe(recoveryVerificationKey(second));
    expect(recoveryVerificationKey(first)).toBe(recoveryVerificationKey({ ...first, startedAt: first.startedAt + 1 }));
    expect(recoveryVerificationKey(first)).not.toBe(recoveryVerificationKey({ ...first, phone: '+966500000002' }));
    expect(recoveryVerificationKey(first)).not.toBe(recoveryVerificationKey({ ...first, serviceSid: `VA${'5'.repeat(32)}` }));
  });
  it('refuses a token from a previous service configuration', async () => {
    const token = await sealRecoveryToken(verification(), 'proof');
    resetConfigCache(); loadConfig({ DATABASE_URL: 'postgres://test.invalid/synthetic', JWT_SECRET: 'synthetic'.repeat(8), TWILIO_VERIFY_SERVICE_SID: `VA${'5'.repeat(32)}` });
    await expect(openRecoveryToken(token, 'proof')).rejects.toThrow();
  });
});
