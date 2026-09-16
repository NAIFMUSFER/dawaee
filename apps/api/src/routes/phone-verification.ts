import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError, ERROR_CODES } from '@dawaee/shared';
import { withUser, withUserReadOnly } from '../lib/db.js';
import { authenticate, currentUser } from '../middleware/context.js';
import { enforceAuthBudget } from '../auth/rate-budget.js';
import {
  FirebasePhoneProofInvalid, FirebasePhoneProofUnavailable, verifyFirebasePhoneIdToken,
} from '../auth/firebase-phone-proof.js';
import { recordAudit } from '../services/audit-service.js';

const proofSchema = z.object({ idToken: z.string().min(100).max(16_384) });

export function registerPhoneVerificationRoutes(app: FastifyInstance): void {
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
