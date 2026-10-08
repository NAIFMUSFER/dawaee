import type { FastifyInstance } from 'fastify';
import { randomBytes, randomInt } from 'node:crypto';
import { z } from 'zod';
import { AppError, ERROR_CODES } from '@dawaee/shared';
import { withTransaction, withUser } from '../lib/db.js';
import { registrationToken } from '../auth/registration-code.js';
import { enforceAuthBudget } from '../auth/rate-budget.js';
import { enqueueAccountEmail } from '../auth/email-capacity.js';
import { hashNewPassword, passwordLoginEnabled, attemptPasswordLogin } from '../auth/password-service.js';
import { createSession } from '../auth/session-service.js';
import { signAccessToken, accessTokenTtlSeconds } from '../auth/tokens.js';
import { accountEmailReady, emailTokenHash, sealEmailJob } from '../providers/account-email.js';
import { recordAudit } from '../services/audit-service.js';

const requestSchema = z.object({ email: z.string().trim().toLowerCase().email().max(320), locale: z.enum(['ar', 'en']) }).strict();
const completeSchema = requestSchema.extend({ challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  code: z.string().regex(/^[0-9]{6}$/), displayName: z.string().trim().min(1).max(120),
  password: z.string().min(10).max(200), deviceId: z.string().regex(/^[A-Za-z0-9._~-]{1,128}$/) }).strict();
export function registerRegistrationCodeRoutes(app: FastifyInstance): void {
  app.post('/v1/auth/registration-code/request', { config: { rateLimit: { max: 6, timeWindow: '10 minutes' } } }, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!accountEmailReady() || !passwordLoginEnabled()) throw new AppError(ERROR_CODES.PROVIDER_UNAVAILABLE, 503, 'Account email is unavailable');
    const body = requestSchema.parse(req.body);
    await enforceAuthBudget({ ip: { scope: 'register:ip', value: req.ip }, identifier: { scope: 'register:identifier', value: body.email } });
    await enforceAuthBudget({ ip: { scope: 'email:ip', value: req.ip }, identifier: { scope: 'email:recipient', value: body.email } });
    await enforceAuthBudget({ identifier: { scope: 'email:hour', value: body.email } });
    const challenge = randomBytes(32).toString('base64url');
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const token = registrationToken(body.email, challenge, code);
    const tokenHash = emailTokenHash(token);
    const payload = await sealEmailJob({ ...body, token, purpose: 'register', code });
    await withTransaction(tx => enqueueAccountEmail(tx, tokenHash, () => tx.query('SELECT app.request_email_registration($1,$2,$3,$4)', [body.email, tokenHash, body.locale, payload])));
    return reply.code(202).send({ accepted: true, challenge, retryAfterSeconds: 60 });
  });
  app.post('/v1/auth/registration-code/complete', { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } }, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!passwordLoginEnabled()) throw new AppError(ERROR_CODES.PROVIDER_UNAVAILABLE, 503, 'Password sign-in unavailable');
    const body = completeSchema.parse(req.body);
    await enforceAuthBudget({ ip: { scope: 'otp-verify:ip', value: req.ip }, identifier: { scope: 'registration-code:challenge', value: body.challenge } });
    const passwordHash = await hashNewPassword(body.password, body.locale);
    const tokenHash = emailTokenHash(registrationToken(body.email, body.challenge, body.code));
    const result = await withTransaction(async tx => {
      const { rows } = await tx.query<{ user_id: string | null }>('SELECT app.complete_email_registration($1,$2,$3) AS user_id', [tokenHash, body.displayName, passwordHash]);
      const userId = rows[0]?.user_id;
      if (!userId) return null;
      // An idempotent completed challenge must never bypass a later password
      // reset or account suspension when used again to request a new session.
      const login = await attemptPasswordLogin(tx, body.email, body.password);
      if (login.outcome !== 'ok' || login.userId !== userId) return null;
      const session = await createSession(tx, userId, { deviceId: body.deviceId, deviceName: null, userAgent: req.headers['user-agent'] ?? null, ipHash: req.ipHash });
      await recordAudit(tx, { actorUserId: userId, patientProfileId: null, action: 'auth.register', entityType: 'user', entityId: userId, requestId: req.id, ipHash: req.ipHash });
      return { userId, session };
    });
    if (!result) throw new AppError(ERROR_CODES.INVALID_CREDENTIALS, 403, body.locale === 'ar' ? 'الرمز غير صحيح أو انتهت صلاحيته. إذا كان لديك حساب، سجّل الدخول.' : 'Invalid or expired code. If you have an account, sign in.');
    const { rows } = await withUser(result.userId, tx => tx.query<{ is_admin: boolean }>('SELECT is_admin FROM users WHERE id=$1', [result.userId]));
    return { userId: result.userId, accessToken: await signAccessToken(result.userId, result.session.sessionId, rows[0]?.is_admin ?? false), refreshToken: result.session.refreshToken, expiresIn: accessTokenTtlSeconds() };
  });
}
