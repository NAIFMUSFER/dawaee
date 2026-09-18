import type { FastifyInstance } from 'fastify';
import { createHash, createHmac } from 'node:crypto';
import { z } from 'zod';
import { AppError, ERROR_CODES, t } from '@dawaee/shared';
import { withTransaction } from '../lib/db.js';
import { loadConfig } from '../config.js';
import { hashNewPassword, passwordLoginEnabled } from '../auth/password-service.js';
import { enforceAuthBudget } from '../auth/rate-budget.js';
import { FirebasePhoneProofInvalid, FirebasePhoneProofUnavailable, verifyFirebasePhoneIdToken } from '../auth/firebase-phone-proof.js';
import { recordAudit } from '../services/audit-service.js';
import { deriveRecoveryRequestKey } from '../lib/password.js';

const resetSchema = z.object({ idToken: z.string().min(100).max(16_384), newPassword: z.string().min(1).max(200) }).strict();

export function registerPasswordRecoveryRoutes(app: FastifyInstance): void {
  app.post('/v1/auth/password/recover', {
    config: { rateLimit: { max: 10, timeWindow: '10 minutes' } },
  }, async (req) => {
    const locale = req.headers['accept-language']?.startsWith('en') ? 'en' : 'ar';
    if (!passwordLoginEnabled()) throw new AppError(ERROR_CODES.FORBIDDEN, 403, t(locale, 'recovery.unavailable'));
    const body = resetSchema.parse(req.body);
    await enforceAuthBudget({ ip: { scope: 'recovery:ip', value: req.ip } });
    let proof;
    try { proof = await verifyFirebasePhoneIdToken(body.idToken, { maxAuthAgeSeconds: 300 }); }
    catch (error) {
      if (error instanceof FirebasePhoneProofUnavailable) throw new AppError(ERROR_CODES.PROVIDER_UNAVAILABLE, 503, t(locale, 'recovery.unavailable'));
      if (error instanceof FirebasePhoneProofInvalid) throw new AppError(ERROR_CODES.INVALID_CREDENTIALS, 403, t(locale, 'recovery.failed'));
      throw error;
    }
    await enforceAuthBudget({ identifier: { scope: 'recovery:phone', value: proof.phoneE164 } });
    const passwordHash = await hashNewPassword(body.newPassword, locale, proof.phoneE164);
    const proofKey = createHash('sha256').update(JSON.stringify([proof.phoneE164, proof.firebaseUid, proof.authenticatedAt])).digest('hex');
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
