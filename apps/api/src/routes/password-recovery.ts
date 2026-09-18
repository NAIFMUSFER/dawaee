import type { FastifyInstance } from 'fastify';
import { createHash, createHmac } from 'node:crypto';
import { z } from 'zod';
import { AppError, ERROR_CODES, normalizeDigits, t } from '@dawaee/shared';
import { withTransaction } from '../lib/db.js';
import { loadConfig } from '../config.js';
import { hashNewPassword, passwordLoginEnabled } from '../auth/password-service.js';
import { enforceAuthBudget } from '../auth/rate-budget.js';
import { FirebasePhoneProofInvalid, FirebasePhoneProofUnavailable, verifyFirebasePhoneIdToken } from '../auth/firebase-phone-proof.js';
import { recordAudit } from '../services/audit-service.js';
import { deriveRecoveryRequestKey } from '../lib/password.js';
import { buildRecoveryVerify, RecoveryVerifyError, type RecoveryVerifyProvider } from '../providers/recovery-verify.js';
import { openRecoveryToken, recoveryVerificationKey, sealRecoveryToken } from '../auth/recovery-tokens.js';

const tokenSchema = z.string().min(100).max(16_384);
const resetSchema = z.union([
  z.object({ idToken: tokenSchema, newPassword: z.string().min(1).max(200) }).strict(),
  z.object({ recoveryToken: tokenSchema, newPassword: z.string().min(1).max(200) }).strict(),
]);
const startSchema = z.object({ phone: z.string().regex(/^\+9665\d{8}$/) }).strict();
const checkSchema = z.object({ challengeToken: tokenSchema,
  code: z.string().transform((value) => normalizeDigits(value).trim()).pipe(z.string().regex(/^\d{6}$/)),
}).strict();

export function registerPasswordRecoveryRoutes(app: FastifyInstance, provider: RecoveryVerifyProvider = buildRecoveryVerify(loadConfig())): void {
  const requireTwilio = (locale: 'ar' | 'en') => {
    if (!passwordLoginEnabled() || loadConfig().PASSWORD_RECOVERY_PROVIDER !== 'twilio' || !provider.ready) {
      throw new AppError(ERROR_CODES.PROVIDER_UNAVAILABLE, 503, t(locale, 'recovery.unavailable'));
    }
  };
  const providerError = (error: unknown, locale: 'ar' | 'en'): never => {
    if (error instanceof RecoveryVerifyError && error.reason === 'rate_limited') {
      throw new AppError(ERROR_CODES.RATE_LIMITED, 429, t(locale, 'error.rate_limited'));
    }
    if (error instanceof RecoveryVerifyError && error.reason === 'invalid') {
      throw new AppError(ERROR_CODES.OTP_EXPIRED, 403, t(locale, 'phoneVerification.expired'));
    }
    throw new AppError(ERROR_CODES.PROVIDER_UNAVAILABLE, 503, t(locale, 'recovery.unavailable'));
  };
  app.get('/v1/auth/password/recovery-options', async (_req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const selected = loadConfig().PASSWORD_RECOVERY_PROVIDER;
    return { provider: selected, available: passwordLoginEnabled() && (selected === 'firebase' || provider.ready) };
  });
  app.post('/v1/auth/password/recovery/start', {
    config: { rateLimit: { max: 10, timeWindow: '10 minutes' } },
  }, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const locale = req.headers['accept-language']?.startsWith('en') ? 'en' : 'ar';
    requireTwilio(locale);
    const { phone } = startSchema.parse(req.body);
    // No account lookup: known and unknown numbers take the same path. Every
    // paid send is bounded durably before contacting Twilio, across replicas.
    await enforceAuthBudget({ ip: { scope: 'recovery-send:ip', value: req.ip },
      identifier: { scope: 'recovery-send:phone', value: phone } });
    await enforceAuthBudget({ identifier: { scope: 'recovery-send:hour', value: phone } });
    await enforceAuthBudget({ identifier: { scope: 'recovery-send:global', value: 'password-recovery' } });
    let verification;
    try { verification = await provider.start(phone, locale); }
    catch (error) { return providerError(error, locale); }
    return { challengeToken: await sealRecoveryToken(verification, 'challenge'), retryAfterSeconds: 60 };
  });
  app.post('/v1/auth/password/recovery/check', {
    config: { rateLimit: { max: 10, timeWindow: '10 minutes' } },
  }, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const locale = req.headers['accept-language']?.startsWith('en') ? 'en' : 'ar';
    requireTwilio(locale);
    const body = checkSchema.parse(req.body);
    await enforceAuthBudget({ ip: { scope: 'recovery:ip', value: req.ip } });
    let verification;
    try { verification = await openRecoveryToken(body.challengeToken, 'challenge'); }
    catch { throw new AppError(ERROR_CODES.OTP_EXPIRED, 403, t(locale, 'phoneVerification.expired')); }
    await enforceAuthBudget({ identifier: { scope: 'recovery:phone', value: verification.phone } });
    await enforceAuthBudget({ identifier: { scope: 'recovery-check:verification', value: verification.verificationSid } });
    let approved;
    try { approved = await provider.check(verification, body.code); }
    catch (error) { return providerError(error, locale); }
    if (!approved) throw new AppError(ERROR_CODES.OTP_INVALID, 403, t(locale, 'phoneVerification.codeError'));
    // A challenge is never accepted as a proof. No client phone/account ID is
    // accepted here: both are bound by the authenticated encrypted envelope.
    return { recoveryToken: await sealRecoveryToken(verification, 'proof') };
  });
  app.post('/v1/auth/password/recover', {
    config: { rateLimit: { max: 10, timeWindow: '10 minutes' } },
  }, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const locale = req.headers['accept-language']?.startsWith('en') ? 'en' : 'ar';
    if (!passwordLoginEnabled()) throw new AppError(ERROR_CODES.FORBIDDEN, 403, t(locale, 'recovery.unavailable'));
    const body = resetSchema.parse(req.body);
    await enforceAuthBudget({ ip: { scope: 'recovery:ip', value: req.ip } });
    let proof: { phoneE164: string; authenticatedAt: number };
    let proofKey: string;
    if ('recoveryToken' in body) {
      requireTwilio(locale);
      try {
        const verification = await openRecoveryToken(body.recoveryToken, 'proof');
        proof = { phoneE164: verification.phone, authenticatedAt: verification.startedAt };
        proofKey = recoveryVerificationKey(verification);
      } catch { throw new AppError(ERROR_CODES.INVALID_CREDENTIALS, 403, t(locale, 'recovery.failed')); }
    } else {
      // Keep the existing Firebase proof contract for installed app versions.
      try {
        const firebase = await verifyFirebasePhoneIdToken(body.idToken, { maxAuthAgeSeconds: 300 });
        proof = firebase;
        proofKey = createHash('sha256').update(JSON.stringify([firebase.phoneE164, firebase.firebaseUid, firebase.authenticatedAt])).digest('hex');
      } catch (error) {
        if (error instanceof FirebasePhoneProofUnavailable) throw new AppError(ERROR_CODES.PROVIDER_UNAVAILABLE, 503, t(locale, 'recovery.unavailable'));
        if (error instanceof FirebasePhoneProofInvalid) throw new AppError(ERROR_CODES.INVALID_CREDENTIALS, 403, t(locale, 'recovery.failed'));
        throw error;
      }
    }
    await enforceAuthBudget({ identifier: { scope: 'recovery:phone', value: proof.phoneE164 } });
    const passwordHash = await hashNewPassword(body.newPassword, locale, proof.phoneE164);
    // Apply password-strength derivation before the keyed retry fingerprint.
    const requestKey = await deriveRecoveryRequestKey(body.newPassword, proofKey);
    const requestHash = createHmac('sha256', loadConfig().JWT_SECRET)
      .update('password-recovery:v1').update(requestKey).digest('hex');
    const updated = await withTransaction(async (tx) => {
      const { rows } = await tx.query<{ user_id: string | null }>(
        'SELECT app.recover_password($1,$2,$3,$4,$5) AS user_id',
        [proof.phoneE164, new Date(proof.authenticatedAt * 1000), proofKey, requestHash, passwordHash],
      );
      const userId = rows[0]?.user_id;
      if (!userId) return false;
      await recordAudit(tx, { actorUserId: userId, patientProfileId: null,
        action: 'auth.password_recovered', entityType: 'user', entityId: userId,
        requestId: req.id, ipHash: req.ipHash });
      return true;
    });
    // Unknown, disabled, stale and reused proofs share one response. Never
    // create a user or return their ID / phone / tokens from password recovery.
    if (!updated) throw new AppError(ERROR_CODES.INVALID_CREDENTIALS, 403, t(locale, 'recovery.failed'));
    return { updated: true };
  });
}
