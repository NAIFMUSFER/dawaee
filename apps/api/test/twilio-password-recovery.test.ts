import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError, ERROR_CODES } from '@dawaee/shared';
const boundary = vi.hoisted(() => ({ budget: vi.fn(), query: vi.fn(), audit: vi.fn(), firebase: vi.fn() }));
vi.mock('../src/auth/rate-budget.js', () => ({ enforceAuthBudget: boundary.budget }));
vi.mock('../src/services/audit-service.js', () => ({ recordAudit: boundary.audit }));
vi.mock('../src/auth/firebase-phone-proof.js', async (original) => ({
  ...await original<typeof import('../src/auth/firebase-phone-proof.js')>(), verifyFirebasePhoneIdToken: boundary.firebase,
}));
vi.mock('../src/lib/db.js', async (original) => ({
  ...await original<typeof import('../src/lib/db.js')>(),
  withTransaction: async (run: (tx: unknown) => Promise<unknown>) => run({ query: boundary.query }),
}));
import { registerPasswordRecoveryRoutes } from '../src/routes/password-recovery.js';
import { registerErrorHandler } from '../src/middleware/error-handler.js';
import { loadConfig, resetConfigCache } from '../src/config.js';
import { openRecoveryToken, sealRecoveryToken, recoveryVerificationKey } from '../src/auth/recovery-tokens.js';
import { RecoveryVerifyError } from '../src/providers/recovery-verify.js';

const phone = '+966500000001';
const service = `VA${'3'.repeat(32)}`;
const verification = () => ({ phone, serviceSid: service, verificationSid: `VE${'4'.repeat(32)}`, startedAt: Math.floor(Date.now() / 1000) });
let app: FastifyInstance;
let start: ReturnType<typeof vi.fn>, check: ReturnType<typeof vi.fn>;
function setup(ready = true, provider = 'twilio', enabled = 'true') {
  loadConfig({ DATABASE_URL: 'postgres://test.invalid/synthetic', JWT_SECRET: 'synthetic'.repeat(8),
    PASSWORD_LOGIN_ENABLED: enabled, PASSWORD_RECOVERY_PROVIDER: provider, TWILIO_VERIFY_SERVICE_SID: service });
  app = Fastify(); registerErrorHandler(app);
  start = vi.fn(async () => verification()); check = vi.fn(async () => true);
  registerPasswordRecoveryRoutes(app, { ready, start, check });
}
const post = (path: string, payload: object) => app.inject({ method: 'POST', url: `/v1/auth/password/${path}`, payload });
beforeEach(() => {
  vi.resetAllMocks(); resetConfigCache();
  boundary.query.mockResolvedValue({ rows: [{ user_id: 'synthetic-user' }] });
});
afterEach(async () => { await app?.close(); resetConfigCache(); });

describe('Twilio password recovery route boundaries (mock SQL and provider)', () => {
  it.each([[false, 'twilio', 'true'], [true, 'firebase', 'true'], [true, 'twilio', 'false']] as const)(
    'refuses start/check when disabled or not configured: %s %s %s', async (ready, provider, enabled) => {
      setup(ready, provider, enabled);
      const options = await app.inject('/v1/auth/password/recovery-options');
      expect(options.headers['cache-control']).toBe('no-store');
      expect(options.json()).toEqual({ provider, available: enabled === 'true' && (provider === 'firebase' || ready) });
      expect((await post('recovery/start', { phone })).statusCode).toBe(503);
      expect((await post('recovery/check', { challengeToken: 'x'.repeat(100), code: '123456' })).statusCode).toBe(503);
      expect(start).not.toHaveBeenCalled(); expect(check).not.toHaveBeenCalled();
    });
  it('budgets before sending, without looking up an account or returning a phone/OTP', async () => {
    setup(); start.mockImplementation(async () => { expect(boundary.budget).toHaveBeenCalledTimes(3); return verification(); });
    const response = await post('recovery/start', { phone });
    expect(response.statusCode, response.body).toBe(200); expect(response.headers['cache-control']).toBe('no-store');
    expect(start).toHaveBeenCalledWith(phone, 'ar');
    expect(await openRecoveryToken(response.json().challengeToken, 'challenge')).toMatchObject({ phone, serviceSid: service });
    expect(response.body).not.toContain(phone); expect(response.json().retryAfterSeconds).toBe(60);
    expect(boundary.query).not.toHaveBeenCalled(); expect(boundary.firebase).not.toHaveBeenCalled();
    expect(boundary.budget).toHaveBeenCalledWith({ identifier: { scope: 'recovery-send:global', value: 'password-recovery' } });
  });
  it.each(['+12025550123', '0500000001', '+966110000001'])('rejects unsupported/noncanonical %s before sending', async (phone) => {
    setup(); expect((await post('recovery/start', { phone })).statusCode).toBe(400);
    expect(start).not.toHaveBeenCalled(); expect(boundary.budget).not.toHaveBeenCalled();
  });
  it('fails closed on a durable send budget limit', async () => {
    setup(); boundary.budget.mockRejectedValue(new AppError(ERROR_CODES.RATE_LIMITED, 429, 'Limited'));
    expect((await post('recovery/start', { phone })).statusCode).toBe(429); expect(start).not.toHaveBeenCalled();
  });
  it.each([['unavailable', 503], ['rate_limited', 429]] as const)('reports provider %s without claiming a code was sent', async (reason, status) => {
    setup(); start.mockRejectedValue(new RecoveryVerifyError(reason));
    const response = await post('recovery/start', { phone });
    expect(response.statusCode).toBe(status); expect(response.json().challengeToken).toBeUndefined();
  });
  it('requires a bound approved challenge and normalizes Arabic code digits', async () => {
    setup(); const original = verification(); const challengeToken = await sealRecoveryToken(original, 'challenge');
    check.mockResolvedValueOnce(false);
    expect((await post('recovery/check', { challengeToken, code: '123456' })).statusCode).toBe(403);
    expect(boundary.query).not.toHaveBeenCalled();
    const response = await post('recovery/check', { challengeToken, code: '١٢٣٤٥٦' });
    expect(response.statusCode, response.body).toBe(200);
    expect(check).toHaveBeenLastCalledWith(original, '123456');
    expect(await openRecoveryToken(response.json().recoveryToken, 'proof')).toEqual(original);
    expect(boundary.budget).toHaveBeenCalledWith({ identifier: { scope: 'recovery-check:verification', value: original.verificationSid } });
  });
  it('does not call the provider for forged/expired/wrong-purpose challenges or a check budget limit', async () => {
    setup();
    for (const challengeToken of ['x'.repeat(100), await sealRecoveryToken({ ...verification(), startedAt: Math.floor(Date.now() / 1000) - 301 }, 'challenge'), await sealRecoveryToken(verification(), 'proof')]) {
      expect((await post('recovery/check', { challengeToken, code: '123456' })).statusCode).toBe(403);
    }
    boundary.budget.mockRejectedValue(new AppError(ERROR_CODES.RATE_LIMITED, 429, 'Limited'));
    expect((await post('recovery/check', { challengeToken: await sealRecoveryToken(verification(), 'challenge'), code: '123456' })).statusCode).toBe(429);
    expect(check).not.toHaveBeenCalled(); expect(boundary.query).not.toHaveBeenCalled();
  });
  it('passes only the proof-bound identity and stable single-use key to the existing recovery transaction', async () => {
    setup(); const original = verification();
    const recoveryToken = await sealRecoveryToken(original, 'proof');
    const payload = { recoveryToken, newPassword: 'Recovery password 123!' };
    const first = await post('recover', payload); const retry = await post('recover', payload);
    expect(first.statusCode, first.body).toBe(200); expect(retry.json()).toEqual({ updated: true });
    const [sql, args] = boundary.query.mock.calls[0]!;
    expect(sql).toContain('app.recover_password');
    expect(args.slice(0, 3)).toEqual([phone, new Date(original.startedAt * 1000), recoveryVerificationKey(original)]);
    expect(boundary.query.mock.calls[1]![1].slice(0, 4)).toEqual(args.slice(0, 4));
    expect(JSON.stringify(boundary.query.mock.calls)).not.toContain(recoveryToken);
    expect(JSON.stringify(boundary.query.mock.calls)).not.toContain(payload.newPassword);
    expect(boundary.audit).toHaveBeenCalledTimes(2); expect(boundary.firebase).not.toHaveBeenCalled();
  });
  it('rejects client identity overrides, unapproved challenges, expired proofs and weak passwords before SQL', async () => {
    setup(); const original = verification(); const recoveryToken = await sealRecoveryToken(original, 'proof');
    const base = { recoveryToken, newPassword: 'Recovery password 123!' };
    for (const extra of [{ phone: '+966500000002' }, { userId: 'other' }, { idToken: 'x'.repeat(100) }]) {
      expect((await post('recover', { ...base, ...extra })).statusCode).toBe(400);
    }
    expect((await post('recover', { ...base, recoveryToken: await sealRecoveryToken(original, 'challenge') })).statusCode).toBe(403);
    expect((await post('recover', { ...base, recoveryToken: await sealRecoveryToken({ ...original, startedAt: original.startedAt - 301 }, 'proof') })).statusCode).toBe(403);
    expect((await post('recover', { ...base, newPassword: 'short' })).statusCode).toBe(400);
    expect(boundary.query).not.toHaveBeenCalled();
  });
  it('does not report success if the existing recovery transaction refuses the account/proof', async () => {
    setup(); boundary.query.mockResolvedValue({ rows: [{ user_id: null }] });
    expect((await post('recover', { recoveryToken: await sealRecoveryToken(verification(), 'proof'), newPassword: 'Recovery password 123!' })).statusCode).toBe(403);
    expect(boundary.audit).not.toHaveBeenCalled();
  });
  it('preserves the Firebase proof contract for already-installed versions', async () => {
    setup(); boundary.firebase.mockResolvedValue({ phoneE164: phone, firebaseUid: 'synthetic-firebase', authenticatedAt: Math.floor(Date.now() / 1000) });
    const idToken = 'synthetic-firebase-proof-'.repeat(10);
    expect((await post('recover', { idToken, newPassword: 'Recovery password 123!' })).statusCode).toBe(200);
    expect(boundary.firebase).toHaveBeenCalledWith(idToken, { maxAuthAgeSeconds: 300 });
    expect(check).not.toHaveBeenCalled(); expect(start).not.toHaveBeenCalled();
  });
});
