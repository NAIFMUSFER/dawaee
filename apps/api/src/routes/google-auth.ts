import type { FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { AppError, ERROR_CODES } from '@dawaee/shared';
import { googleAudiences, verifyGoogleToken } from '../auth/google-token.js';
import { withTransaction, withUser } from '../lib/db.js';
import { hashPassword } from '../lib/password.js';
import { enforceAuthBudget } from '../auth/rate-budget.js';
import { createSession } from '../auth/session-service.js';
import { signAccessToken, accessTokenTtlSeconds } from '../auth/tokens.js';
import { recordAudit } from '../services/audit-service.js';
const schema = z.object({ idToken: z.string().min(100).max(10000), locale: z.enum(['ar','en']),
  deviceId: z.string().regex(/^[A-Za-z0-9._~-]{1,128}$/) }).strict();
export function registerGoogleAuthRoutes(app: FastifyInstance): void {
  app.get('/v1/auth/google/options', async (_req, reply) => { reply.header('Cache-Control','no-store'); return { available: googleAudiences().length > 0 }; });
  app.post('/v1/auth/google', { config: { rateLimit: { max: 12, timeWindow: '10 minutes' } } }, async (req, reply) => {
    reply.header('Cache-Control','no-store');
    if (!googleAudiences().length) throw new AppError(ERROR_CODES.PROVIDER_UNAVAILABLE,503,'Google sign-in unavailable');
    const body = schema.parse(req.body);
    await enforceAuthBudget({ ip: { scope: 'login:ip', value: req.ip } });
    let identity;
    try { identity = await verifyGoogleToken(body.idToken); }
    catch { throw new AppError(ERROR_CODES.INVALID_CREDENTIALS,401,body.locale === 'ar' ? 'تعذر تأكيد حساب قوقل. استخدم بريدك وكلمة المرور.' : 'Unable to verify Google account. Use email and password.'); }
    await enforceAuthBudget({ identifier: { scope: 'login:identifier', value: identity.subject } });
    // A random undisclosed credential avoids a shared/default password. Existing
    // account credentials are never replaced by the resolver.
    const passwordHash = await hashPassword(randomBytes(48).toString('base64url'));
    const result = await withTransaction(async tx => {
      const { rows } = await tx.query<{ user_id: string | null; created: boolean }>('SELECT * FROM app.resolve_google_account($1,$2,$3,$4,$5)',
        [identity.subject, identity.email, identity.displayName, passwordHash, body.locale]);
      const account = rows[0];
      if (!account?.user_id) return null;
      const session = await createSession(tx,account.user_id,{ deviceId: body.deviceId, deviceName: null, userAgent: req.headers['user-agent'] ?? null, ipHash: req.ipHash });
      await recordAudit(tx,{actorUserId:account.user_id,patientProfileId:null,action:'auth.login',entityType:'user',entityId:account.user_id,requestId:req.id,ipHash:req.ipHash,newValue:{method:'google'}});
      return {userId:account.user_id,created:account.created,session};
    });
    if (!result) throw new AppError(ERROR_CODES.INVALID_CREDENTIALS,401,'Sign in with your existing account before linking Google');
    const { rows } = await withUser(result.userId,tx=>tx.query<{is_admin:boolean}>('SELECT is_admin FROM users WHERE id=$1',[result.userId]));
    return {accessToken:await signAccessToken(result.userId,result.session.sessionId,rows[0]?.is_admin ?? false),refreshToken:result.session.refreshToken,expiresIn:accessTokenTtlSeconds(),isNewUser:result.created};
  });
}
