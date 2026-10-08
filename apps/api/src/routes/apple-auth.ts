import type { FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { AppError, ERROR_CODES, appleAuthorizationProofSchema } from '@dawaee/shared';
import { appleAuthAvailable, AppleProviderUnavailable, exchangeAppleCode } from '../auth/apple-token.js';
import { withTransaction, withUser } from '../lib/db.js';
import { hashPassword } from '../lib/password.js';
import { enforceAuthBudget } from '../auth/rate-budget.js';
import { createSession } from '../auth/session-service.js';
import { signAccessToken, accessTokenTtlSeconds } from '../auth/tokens.js';
import { recordAudit } from '../services/audit-service.js';

const schema = appleAuthorizationProofSchema.extend({ locale: z.enum(['ar', 'en']),
  displayName: z.string().trim().min(1).max(120).optional(),
  deviceId: z.string().regex(/^[A-Za-z0-9._~-]{1,128}$/) }).strict();

export function registerAppleAuthRoutes(app: FastifyInstance): void {
  app.get('/v1/auth/apple/options', async (_req, reply) => {
    reply.header('Cache-Control', 'no-store'); return { available: appleAuthAvailable() };
  });
  app.post('/v1/auth/apple', { config: { rateLimit: { max: 12, timeWindow: '10 minutes' } } }, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!appleAuthAvailable()) throw new AppError(ERROR_CODES.PROVIDER_UNAVAILABLE, 503, 'Apple sign-in unavailable');
    const body = schema.parse(req.body);
    await enforceAuthBudget({ ip: { scope: 'login:ip', value: req.ip } });
    let identity;
    try { identity = await exchangeAppleCode(body.authorizationCode, body.rawNonce); }
    catch (error) {
      if (error instanceof AppleProviderUnavailable) throw new AppError(ERROR_CODES.PROVIDER_UNAVAILABLE, 503, 'Apple sign-in temporarily unavailable');
      throw new AppError(ERROR_CODES.INVALID_CREDENTIALS, 401, body.locale === 'ar' ? 'تعذر تأكيد حساب Apple. حاول مرة أخرى.' : 'Unable to verify Apple account. Try again.');
    }
    await enforceAuthBudget({ identifier: { scope: 'login:identifier', value: identity.subject } });
    const passwordHash = await hashPassword(randomBytes(48).toString('base64url'));
    const result = await withTransaction(async tx => {
      const { rows } = await tx.query<{ user_id: string | null; created: boolean }>(
        'SELECT * FROM app.resolve_apple_account($1,$2,$3,$4,$5)',
        [identity.subject, identity.email, body.displayName ?? 'TADAWEE', passwordHash, body.locale]);
      const account = rows[0];
      if (!account?.user_id) return null;
      const session = await createSession(tx, account.user_id, { deviceId: body.deviceId, deviceName: null,
        userAgent: req.headers['user-agent'] ?? null, ipHash: req.ipHash });
      await recordAudit(tx, { actorUserId: account.user_id, patientProfileId: null, action: 'auth.login',
        entityType: 'user', entityId: account.user_id, requestId: req.id, ipHash: req.ipHash, newValue: { method: 'apple' } });
      return { userId: account.user_id, created: account.created, session };
    });
    if (!result) throw new AppError(ERROR_CODES.INVALID_CREDENTIALS, 401,
      body.locale === 'ar' ? 'تعذر الدخول بحساب Apple. استخدم طريقة الدخول السابقة لحسابك.' : 'Unable to sign in with Apple. Use your existing sign-in method.');
    const { rows } = await withUser(result.userId, tx => tx.query<{ is_admin: boolean }>('SELECT is_admin FROM users WHERE id=$1', [result.userId]));
    return { accessToken: await signAccessToken(result.userId, result.session.sessionId, rows[0]?.is_admin ?? false),
      refreshToken: result.session.refreshToken, expiresIn: accessTokenTtlSeconds(), isNewUser: result.created };
  });
}
