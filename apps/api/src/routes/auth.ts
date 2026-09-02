import type { FastifyInstance } from 'fastify';
import {
  AppError, ERROR_CODES, registerPushTokenSchema, requestOtpSchema, refreshSchema, verifyOtpSchema, t,
} from '@dawaee/shared';
import { loadConfig } from '../config.js';
import { withTransaction, withUser } from '../lib/db.js';
import { maskPhone, normalizePhone } from '../lib/crypto.js';
import { assertOtpVerified, checkOtp, issueOtp, OTP_RESEND_COOLDOWN_SECONDS } from '../auth/otp-service.js';
import { assertRotated, createSession, revokeSession, rotateSessionAttempt } from '../auth/session-service.js';
import { accessTokenTtlSeconds, signAccessToken } from '../auth/tokens.js';
import { authenticate, currentUser } from '../middleware/context.js';
import { recordAudit } from '../services/audit-service.js';
import type { Providers } from '../providers/index.js';

export function registerAuthRoutes(app: FastifyInstance, providers: Providers): void {
  const cfg = loadConfig();

  /**
   * Request an OTP.
   *
   * Always answers 200 with the same shape whether or not the number is known.
   * Revealing "no account for this number" would turn the endpoint into a way
   * to test whether a person uses the app — which, for a medication app, is
   * itself a health-adjacent disclosure.
   */
  app.post('/v1/auth/otp/request', {
    config: { rateLimit: { max: 8, timeWindow: '10 minutes' } },
  }, async (req) => {
    const body = requestOtpSchema.parse(req.body);
    const phone = normalizePhone(body.phone);
    if (!phone) throw AppError.badRequest(ERROR_CODES.VALIDATION_FAILED, 'Invalid phone number');

    const issued = await withTransaction(async (tx) => issueOtp(tx, phone, req.ipHash));

    const message = t(body.locale, 'auth.otpSent', { phone: maskPhone(phone) });
    const smsBody =
      body.locale === 'ar'
        ? `رمز التحقق لتطبيق دوائي: ${issued.code}\nصالح لمدة ${cfg.OTP_TTL_MINUTES} دقائق.`
        : `Your Dawaee verification code is ${issued.code}. Valid for ${cfg.OTP_TTL_MINUTES} minutes.`;

    const result = await providers.sms.send(phone, smsBody);
    if (!result.ok) {
      req.log.error({ errorCode: result.errorCode, provider: providers.sms.name }, 'OTP delivery failed');
    }

    return {
      sent: true,
      message,
      expiresAt: issued.expiresAt.toISOString(),
      resendAfterSeconds: OTP_RESEND_COOLDOWN_SECONDS,
      // Development only; config refuses this flag in production.
      ...(cfg.OTP_DEBUG_ECHO ? { debugCode: issued.code } : {}),
    };
  });

  /** Verify an OTP; creates the account on first successful verification. */
  app.post('/v1/auth/otp/verify', {
    config: { rateLimit: { max: 12, timeWindow: '10 minutes' } },
  }, async (req) => {
    const body = verifyOtpSchema.parse(req.body);
    const phone = normalizePhone(body.phone);
    if (!phone) throw AppError.badRequest(ERROR_CODES.VALIDATION_FAILED, 'Invalid phone number');

    // Verification COMMITS on its own before any error is raised: a wrong
    // guess must durably increment the attempt counter, and a code that was
    // consumed must stay consumed even though the request goes on to fail.
    const otp = await withTransaction((tx) => checkOtp(tx, phone, body.code));
    assertOtpVerified(otp);

    const result = await withTransaction(async (tx) => {
      // Account resolution runs before an identity exists, so it goes through
      // the auth-plane function rather than raw INSERTs that RLS would refuse.
      const { rows: account } = await tx.query<{
        user_id: string; is_admin: boolean; is_new_user: boolean; self_profile_id: string | null;
      }>('SELECT * FROM app.find_or_create_user_by_phone($1, $2, $3)', [phone, maskPhone(phone), 'ar']);

      const { user_id: userId, is_admin: isAdmin, is_new_user: isNewUser } = account[0]!;

      const session = await createSession(tx, userId, {
        deviceId: body.deviceId,
        deviceName: body.deviceName ?? null,
        userAgent: req.headers['user-agent'] ?? null,
        ipHash: req.ipHash,
      });

      await recordAudit(tx, {
        actorUserId: userId,
        patientProfileId: null,
        action: 'auth.login',
        entityType: 'user',
        entityId: userId,
        requestId: req.id,
        ipHash: req.ipHash,
        newValue: { isNewUser, deviceId: body.deviceId },
      });

      return { userId, isAdmin, isNewUser, session };
    });

    return {
      accessToken: await signAccessToken(result.userId, result.session.sessionId, result.isAdmin),
      refreshToken: result.session.refreshToken,
      expiresIn: accessTokenTtlSeconds(),
      refreshExpiresAt: result.session.refreshExpiresAt.toISOString(),
      isNewUser: result.isNewUser,
    };
  });

  app.post('/v1/auth/refresh', {
    config: { rateLimit: { max: 60, timeWindow: '10 minutes' } },
  }, async (req) => {
    const body = refreshSchema.parse(req.body);
    // Committed before the outcome is judged, so a detected token reuse
    // durably revokes the device even though the request ends in a 401.
    const attempt = await withTransaction((tx) => rotateSessionAttempt(tx, body.refreshToken, req.ipHash));
    const rotated = assertRotated(attempt);
    return {
      accessToken: await signAccessToken(rotated.userId, rotated.sessionId, rotated.isAdmin),
      refreshToken: rotated.refreshToken,
      expiresIn: accessTokenTtlSeconds(),
      refreshExpiresAt: rotated.refreshExpiresAt.toISOString(),
    };
  });

  app.post('/v1/auth/logout', { preHandler: authenticate }, async (req) => {
    const { userId, sessionId } = currentUser(req);
    await withTransaction(async (tx) => {
      await revokeSession(tx, sessionId);
      await recordAudit(tx, {
        actorUserId: userId, patientProfileId: null, action: 'auth.logout',
        entityType: 'session', entityId: sessionId, requestId: req.id, ipHash: req.ipHash,
      });
    });
    return { ok: true };
  });

  /** Sign out everywhere — used when a phone is lost or sold. */
  app.post('/v1/auth/logout-all', { preHandler: authenticate }, async (req) => {
    const { userId } = currentUser(req);
    const revoked = await withUser(userId, async (tx) => {
      const { rowCount } = await tx.query(
        'UPDATE auth_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL',
        [userId],
      );
      await tx.query('UPDATE push_tokens SET active = false WHERE user_id = $1', [userId]);
      return rowCount ?? 0;
    });
    return { ok: true, sessionsRevoked: revoked };
  });

  app.get('/v1/auth/sessions', { preHandler: authenticate }, async (req) => {
    const { userId, sessionId } = currentUser(req);
    const sessions = await withUser(userId, async (tx) => {
      const { rows } = await tx.query(
        `SELECT id, device_id, device_name, created_at, last_used_at, expires_at
           FROM auth_sessions
          WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()
          ORDER BY last_used_at DESC`,
        [userId],
      );
      return rows;
    });
    return {
      sessions: sessions.map((s) => ({
        id: s.id,
        deviceId: s.device_id,
        deviceName: s.device_name,
        current: s.id === sessionId,
        createdAt: s.created_at,
        lastUsedAt: s.last_used_at,
        expiresAt: s.expires_at,
      })),
    };
  });

  /** Push token registration. Re-registering the same device replaces its token. */
  app.post('/v1/devices/push-token', { preHandler: authenticate }, async (req) => {
    const body = registerPushTokenSchema.parse(req.body);
    const { userId } = currentUser(req);
    await withUser(userId, async (tx) => {
      await tx.query(
        `INSERT INTO push_tokens (user_id, token, platform, device_id, app_version, active, last_seen_at)
         VALUES ($1,$2,$3,$4,$5,true, now())
         ON CONFLICT (user_id, device_id) DO UPDATE
           SET token = EXCLUDED.token, platform = EXCLUDED.platform,
               app_version = EXCLUDED.app_version, active = true,
               failure_count = 0, last_seen_at = now()`,
        [userId, body.token, body.platform, body.deviceId, body.appVersion ?? null],
      );
    });
    return { ok: true };
  });

  app.delete('/v1/devices/push-token/:deviceId', { preHandler: authenticate }, async (req) => {
    const { deviceId } = req.params as { deviceId: string };
    const { userId } = currentUser(req);
    await withUser(userId, async (tx) => {
      await tx.query('UPDATE push_tokens SET active = false WHERE user_id = $1 AND device_id = $2', [userId, deviceId]);
    });
    return { ok: true };
  });
}
