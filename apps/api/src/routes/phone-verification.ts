import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError, ERROR_CODES, phoneInput } from '@dawaee/shared';
import { withUser, withUserReadOnly } from '../lib/db.js';
import { authenticate, currentUser } from '../middleware/context.js';
import { enforceAuthBudget } from '../auth/rate-budget.js';
import {
  FirebasePhoneProofInvalid, FirebasePhoneProofUnavailable, verifyFirebasePhoneIdToken,
} from '../auth/firebase-phone-proof.js';
import { verifyPassword } from '../lib/password.js';
import { normalizePhone } from '../lib/crypto.js';
import { recordAudit } from '../services/audit-service.js';

const proofSchema = z.object({ idToken: z.string().min(100).max(16_384) });

export function registerPhoneVerificationRoutes(app: FastifyInstance): void {
  app.post('/v1/auth/phone', { preHandler: authenticate, config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } }, async (req) => {
    const body = z.object({ phone: phoneInput, currentPassword: z.string().min(1).max(200) }).strict().parse(req.body);
    const { userId } = currentUser(req);
    await enforceAuthBudget({ ip: { scope: 'phone-link:ip', value: req.ip }, identifier: { scope: 'phone-link:account', value: userId } });
    const phone = normalizePhone(body.phone);
    if (!phone) throw AppError.badRequest(ERROR_CODES.VALIDATION_FAILED, 'Invalid phone number');
    return withUser(userId, async tx => {
      const { rows } = await tx.query<{ hash: string | null }>('SELECT app.password_hash_for_user($1) AS hash', [userId]);
      const hash = rows[0]?.hash;
      if (!hash || !await verifyPassword(body.currentPassword, hash)) throw new AppError(ERROR_CODES.INVALID_CREDENTIALS, 401, 'Incorrect current password');
      const result = await tx.query<{ linked: boolean }>('SELECT app.attach_account_phone($1,$2,$3) AS linked', [userId, phone, hash]);
      if (!result.rows[0]?.linked) throw new AppError(ERROR_CODES.CONFLICT, 409, 'Unable to link this phone to this account');
      await recordAudit(tx, { actorUserId: userId, patientProfileId: null, action: 'auth.phone_linked', entityType: 'user', entityId: userId, requestId: req.id, ipHash: req.ipHash });
      return { linked: true };
    });
  });

  app.get('/v1/auth/phone-verification', { preHandler: authenticate }, async (req) => {
    const { userId } = currentUser(req);
    return withUserReadOnly(userId, async (tx) => {
      const { rows } = await tx.query<{ phone: string | null; verified: boolean }>(
        'SELECT phone_e164 AS phone, app.has_verified_phone(id) AS verified FROM users WHERE id = $1',
        [userId],
      );
      return rows[0] ?? { phone: null, verified: false };
    });
  });

  app.post('/v1/auth/phone-verification', {
    preHandler: authenticate,
    config: { rateLimit: { max: 10, timeWindow: '10 minutes' } },
  }, async (req) => {
    const { userId } = currentUser(req);
    const body = proofSchema.parse(req.body);
    await enforceAuthBudget({
      ip: { scope: 'phone-proof:ip', value: req.ip },
      identifier: { scope: 'phone-proof:account', value: userId },
    });
    let proof;
    try {
      proof = await verifyFirebasePhoneIdToken(body.idToken);
    } catch (error) {
      if (error instanceof FirebasePhoneProofUnavailable) {
        throw new AppError(ERROR_CODES.PROVIDER_UNAVAILABLE, 503, 'Phone verification is temporarily unavailable');
      }
      if (error instanceof FirebasePhoneProofInvalid) {
        throw new AppError(ERROR_CODES.PHONE_VERIFICATION_REQUIRED, 403, 'Verify your account phone again');
      }
      throw error;
    }
    return withUser(userId, async (tx) => {
      const { rows } = await tx.query<{ verified: boolean }>(
        'SELECT app.record_verified_phone($1,$2,$3) AS verified',
        [userId, proof.phoneE164, new Date(proof.authenticatedAt * 1000)],
      );
      if (!rows[0]?.verified) {
        throw new AppError(ERROR_CODES.PHONE_VERIFICATION_REQUIRED, 403, 'Verify the phone registered to this account');
      }
      await recordAudit(tx, {
        actorUserId: userId, patientProfileId: null, action: 'auth.phone_verified',
        entityType: 'user', entityId: userId, requestId: req.id, ipHash: req.ipHash,
        newValue: { provider: 'firebase' },
      });
      return { verified: true };
    });
  });
}
