import type { FastifyInstance } from 'fastify';
import { randomBytes, createHmac } from 'node:crypto';
import { z } from 'zod';
import { AppError, ERROR_CODES, t } from '@dawaee/shared';
import { authenticate, currentUser } from '../middleware/context.js';
import { loadConfig } from '../config.js';
import { withTransaction, withUser } from '../lib/db.js';
import { verifyPassword, deriveRecoveryRequestKey } from '../lib/password.js';
import { hashNewPassword, passwordLoginEnabled } from '../auth/password-service.js';
import { enforceAuthBudget } from '../auth/rate-budget.js';
import { recordAudit } from '../services/audit-service.js';
import { accountEmailReady, drainAccountEmails, emailTokenHash, sealEmailJob } from '../providers/account-email.js';
import { registerAccountEmailPage } from './account-email-page.js';

const email = z.string().trim().toLowerCase().email().max(320);
const requestSchema = z.object({ email }).strict();
const verifySchema = z.object({ email, currentPassword: z.string().min(1).max(200) }).strict();
const token = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const completeSchema = z.discriminatedUnion('purpose', [
  z.object({ token, purpose: z.literal('verify') }).strict(),
  z.object({ token, purpose: z.literal('reset'), newPassword: z.string().min(1).max(200) }).strict(),
]);
export function registerAccountEmailRoutes(app: FastifyInstance): void {
  const unavailable = () => { throw new AppError(ERROR_CODES.PROVIDER_UNAVAILABLE, 503, 'Account email is unavailable'); };
  const requireEmail = () => { if (!accountEmailReady() || !passwordLoginEnabled()) unavailable(); };
  app.get('/v1/auth/password/recovery-options', async (_req, reply) => {
    reply.header('Cache-Control', 'no-store');
    return { provider: 'email', available: accountEmailReady() && passwordLoginEnabled() };
  });
  app.get('/v1/auth/email', { preHandler: authenticate }, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const { userId } = currentUser(req);
    const { rows } = await withUser(userId, tx => tx.query('SELECT email, app.has_verified_email(id) AS verified FROM users WHERE id=$1', [userId]));
    return { email: rows[0]?.email ?? null, verified: rows[0]?.verified === true, available: accountEmailReady() && passwordLoginEnabled() };
  });
  app.post('/v1/auth/email/request', { preHandler: authenticate, config: { rateLimit: { max: 6, timeWindow: '10 minutes' } } }, async (req, reply) => {
    reply.header('Cache-Control', 'no-store'); requireEmail();
    const body = verifySchema.parse(req.body);
    const { userId, sessionId } = currentUser(req);
    await enforceAuthBudget({ ip: { scope: 'email:ip', value: req.ip }, identifier: { scope: 'email:account', value: userId } });
    await enforceAuthBudget({ identifier: { scope: 'email:recipient', value: body.email } });
    await enforceAuthBudget({ identifier: { scope: 'email:hour', value: body.email } });
    await enforceAuthBudget({ identifier: { scope: 'email:global', value: 'account-email' } });
    const { rows } = await withTransaction(tx => tx.query<{ password_hash: string | null }>('SELECT app.password_hash_for_user($1) AS password_hash', [userId]));
    const hash = rows[0]?.password_hash;
    if (!hash || !await verifyPassword(body.currentPassword, hash)) throw new AppError(ERROR_CODES.INVALID_CREDENTIALS, 401, 'Incorrect current password');
    const secret = randomBytes(32).toString('base64url');
    const payload = await sealEmailJob({ email: body.email, token: secret, purpose: 'verify', locale: req.headers['accept-language']?.startsWith('en') ? 'en' : 'ar' });
    const result = await withUser(userId, tx => tx.query<{ accepted: boolean }>('SELECT app.request_email_verification($1,$2,$3,$4,$5,$6) AS accepted', [userId, sessionId, body.email, emailTokenHash(secret), hash, payload]));
    if (!result.rows[0]?.accepted) throw new AppError(ERROR_CODES.CONFLICT, 409, 'Unable to verify this email');
    return reply.code(202).send({ accepted: true, retryAfterSeconds: 60 });
  });
  app.post('/v1/auth/password/recovery/request', { config: { rateLimit: { max: 6, timeWindow: '10 minutes' } } }, async (req, reply) => {
    reply.header('Cache-Control', 'no-store'); requireEmail();
    const body = requestSchema.parse(req.body);
    await enforceAuthBudget({ ip: { scope: 'email:ip', value: req.ip }, identifier: { scope: 'email:recipient', value: body.email } });
    await enforceAuthBudget({ identifier: { scope: 'email:hour', value: body.email } });
    await enforceAuthBudget({ identifier: { scope: 'email:global', value: 'account-email' } });
    const secret = randomBytes(32).toString('base64url');
    const payload = await sealEmailJob({ email: body.email, token: secret, purpose: 'reset', locale: req.headers['accept-language']?.startsWith('en') ? 'en' : 'ar' });
    await withTransaction(tx => tx.query('SELECT app.request_email_recovery($1,$2,$3)', [body.email, emailTokenHash(secret), payload]));
    return reply.code(202).send({ accepted: true, retryAfterSeconds: 60 });
  });
  app.post('/v1/auth/email/complete', { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } }, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!passwordLoginEnabled()) unavailable();
    const body = completeSchema.parse(req.body);
    const locale = req.headers['accept-language']?.startsWith('en') ? 'en' : 'ar';
    await enforceAuthBudget({ ip: { scope: 'recovery:ip', value: req.ip } });
    const tokenHash = emailTokenHash(body.token);
    await enforceAuthBudget({ identifier: { scope: 'email:token', value: tokenHash } });
    const passwordHash = body.purpose === 'reset' ? await hashNewPassword(body.newPassword, locale) : null;
    const requestHash = body.purpose === 'reset' ? createHmac('sha256', loadConfig().JWT_SECRET)
      .update(await deriveRecoveryRequestKey(body.newPassword, tokenHash)).digest('hex') : null;
    const updated = await withTransaction(async tx => {
      const { rows } = await tx.query<{ user_id: string | null }>('SELECT app.complete_email_action($1,$2,$3,$4) AS user_id', [tokenHash, body.purpose, passwordHash, requestHash]);
      const userId = rows[0]?.user_id;
      if (!userId) return false;
      await recordAudit(tx, { actorUserId: userId, patientProfileId: null, action: body.purpose === 'reset' ? 'auth.password_recovered' : 'auth.email_verified', entityType: 'user', entityId: userId, requestId: req.id, ipHash: req.ipHash });
      return true;
    });
    if (!updated) throw new AppError(ERROR_CODES.INVALID_CREDENTIALS, 403, t(locale, 'emailAccount.invalidLink'));
    return { updated: true };
  });
  registerAccountEmailPage(app);
  let timer: ReturnType<typeof setInterval> | undefined;
  let inflight: Promise<unknown> | null = null;
  app.addHook('onReady', async () => {
    if (!accountEmailReady() || loadConfig().NODE_ENV === 'test') return;
    const tick = () => {
      if (inflight) return;
      inflight = drainAccountEmails().catch(() => app.log.warn('Account email delivery temporarily unavailable'))
        .finally(() => { inflight = null; });
    };
    timer = setInterval(tick, 5000); timer.unref(); tick();
  });
  app.addHook('onClose', async () => { if (timer) clearInterval(timer); await inflight; });
}
