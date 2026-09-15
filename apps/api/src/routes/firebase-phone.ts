import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError, ERROR_CODES, setPasswordSchema } from '@dawaee/shared';
import { withTransaction } from '../lib/db.js';
import { hashPassword } from '../lib/password.js';
import {
  FirebasePhoneProofInvalid,
  FirebasePhoneProofUnavailable,
  verifyFirebasePhoneIdToken,
} from '../auth/firebase-phone-proof.js';

const resetPasswordSchema = z.object({
  idToken: z.string().min(100).max(16_384),
  newPassword: setPasswordSchema.shape.newPassword,
});

export function registerFirebasePhoneRoutes(app: FastifyInstance): void {
  app.post('/v1/auth/firebase-phone/reset-password', {
    config: { rateLimit: { max: 10, timeWindow: '1 hour' } },
  }, async (req) => {
    const body = resetPasswordSchema.parse(req.body);
    let proof;
    try {
      proof = await verifyFirebasePhoneIdToken(body.idToken);
    } catch (error) {
      if (error instanceof FirebasePhoneProofUnavailable) {
        throw new AppError(
          ERROR_CODES.PROVIDER_UNAVAILABLE, 503,
          'Phone verification is temporarily unavailable. Please try again.',
        );
      }
      if (error instanceof FirebasePhoneProofInvalid) {
        throw AppError.unauthenticated('Phone verification is invalid or expired');
      }
      throw error;
    }

    const passwordHash = await hashPassword(body.newPassword);
    const userId = await withTransaction(async (tx) => {
      const { rows } = await tx.query<{ user_id: string | null }>(
        'SELECT app.reset_password_by_verified_phone($1,$2) AS user_id',
        [proof.phoneE164, passwordHash],
      );
      return rows[0]?.user_id ?? null;
    });
    if (!userId) {
      throw AppError.notFound('No Dawaee account is registered to this verified phone number');
    }
    return { ok: true };
  });
}
