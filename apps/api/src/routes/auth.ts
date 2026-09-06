import type { FastifyInstance } from 'fastify';
import {
  AppError, ERROR_CODES, passwordLoginSchema, registerPushTokenSchema, registerSchema,
  refreshSchema, setPasswordSchema, verifyOtpSchema, t,
} from '@dawaee/shared';
import { withTransaction, withUser } from '../lib/db.js';
import { maskPhone, normalizePhone } from '../lib/crypto.js';
import { assertOtpVerified, checkOtp } from '../auth/otp-service.js';
import { assertRotated, createSession, revokeSession, rotateSessionAttempt } from '../auth/session-service.js';
import {
  assertLogin, attemptPasswordLogin, hashNewPassword, passwordLoginEnabled,
} from '../auth/password-service.js';
import { verifyPassword } from '../lib/password.js';
import { accessTokenTtlSeconds, signAccessToken } from '../auth/tokens.js';
import { authenticate, currentUser } from '../middleware/context.js';
import { recordAudit } from '../services/audit-service.js';
import { clearBudget, enforceAuthBudget } from './../auth/rate-budget.js';

export function registerAuthRoutes(app: FastifyInstance): void {
  /**
   * Request an OTP.
   *
   * Refused, and deliberately not deleted.
   *
   * There is no channel left to deliver a code over: reaching a Saudi phone by
   * SMS needs an alphanumeric Sender ID registered against a commercial
   * registration, and by WhatsApp needs a Meta-verified business with an
   * approved AUTHENTICATION template. Both were removed rather than left as
   * configuration nobody can switch on.
   *
   * It refuses instead of issuing a code because issuing one is worse than
   * saying no: the caller would get a 200, wait for a message that can never
   * arrive, and conclude their phone or the app is broken. The verify route
   * below still works, so an existing challenge is not stranded, and the whole
   * path comes back by adding a provider once a registration exists.
   */
  app.post('/v1/auth/otp/request', {
    config: { rateLimit: { max: 8, timeWindow: '10 minutes' } },
  }, async () => {
    throw new AppError(
      ERROR_CODES.PROVIDER_UNAVAILABLE, 503,
      'Sign-in codes are unavailable. Use your password to sign in.',
    );
  });

  /** Verify an OTP; creates the account on first successful verification. */
  app.post('/v1/auth/otp/verify', {
    config: { rateLimit: { max: 12, timeWindow: '10 minutes' } },
  }, async (req) => {
    const body = verifyOtpSchema.parse(req.body);
    const phone = normalizePhone(body.phone);
    if (!phone) throw AppError.badRequest(ERROR_CODES.VALIDATION_FAILED, 'Invalid phone number');

    await enforceAuthBudget({
      ip: { scope: 'otp-verify:ip', value: req.ip },
      identifier: { scope: 'otp-verify:identifier', value: phone },
    });

    // Verification COMMITS on its own before any error is raised: a wrong
    // guess must durably increment the attempt counter, and a code that was
    // consumed must stay consumed even though the request goes on to fail.
    const otp = await withTransaction((tx) => checkOtp(tx, phone, body.code));
    assertOtpVerified(otp);

    const result = await withTransaction(async (tx) => {
      // Account resolution runs before an identity exists, so it goes through
      // the auth-plane function rather than raw INSERTs that RLS would refuse.
      let account;
      try {
        ({ rows: account } = await tx.query<{
          user_id: string; is_admin: boolean; is_new_user: boolean; self_profile_id: string | null;
        }>('SELECT * FROM app.find_or_create_user_by_phone($1, $2, $3)', [phone, maskPhone(phone), 'ar']));
      } catch (err) {
        /**
         * A disabled account looks exactly like a wrong code.
         *
         * `find_or_create_user_by_phone` raises `insufficient_privilege` for a
         * disabled account, which the error handler was rendering as 404
         * "Resource not found" — a different answer from the 200 an unknown
         * number gets, and therefore a working "this number is registered, and
         * it has been suspended" oracle for anyone holding a valid code. It was
         * also simply the wrong status for an authentication refusal.
         *
         * Disablement is a compromise or abuse response. Confirming it tells an
         * attacker their target has been flagged, which is precisely the moment
         * they should learn nothing. The code has already been consumed by the
         * committed transaction above, so this costs the attacker their guess.
         */
        if ((err as { code?: string }).code === '42501') {
          throw new AppError(ERROR_CODES.OTP_INVALID, 401, 'Incorrect verification code');
        }
        throw err;
      }

      const { user_id: userId, is_admin: isAdmin, is_new_user: isNewUser } = account[0]!;

      /**
       * Signing in by code clears a password lockout. This is a policy choice,
       * stated rather than inherited.
       *
       * A one-time code proves possession of the phone the account is
       * registered to, which is a stronger claim than knowing its password —
       * so it is not a bypass of the lockout, it outranks it. Leaving the lock
       * in place would also leave a patient who just proved who they are unable
       * to use their own password for another fifteen minutes, with nothing on
       * screen explaining why.
       *
       * Disablement is NOT cleared here, and must not be: that is an operator
       * decision, and the refusal above happens before this line is reached.
       */
      await tx.query('SELECT app.clear_login_failures($1)', [userId]);

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


  // ------------------------------------------------------------- password

  /**
   * Create an account with a password.
   *
   * Reachable by phone, by email, or by both. SMS and WhatsApp both turned out
   * to need a commercial registration before they can carry a login code, and
   * a password needs nobody's approval.
   */
  app.post('/v1/auth/register', {
    config: { rateLimit: { max: 6, timeWindow: '10 minutes' } },
  }, async (req) => {
    if (!passwordLoginEnabled()) {
      throw new AppError(ERROR_CODES.FORBIDDEN, 403, 'Password sign-in is disabled.');
    }
    const body = registerSchema.parse(req.body);

    const phone = body.phone ? normalizePhone(body.phone) : null;
    if (body.phone && !phone) {
      throw AppError.badRequest(ERROR_CODES.VALIDATION_FAILED, 'Invalid phone number');
    }
    // Already trimmed and lower-cased by `emailInput`; one spelling, decided once.
    const email = body.email ?? null;

    // Shared with every other replica and surviving a cold start, unlike the
    // in-process limiter this sits behind. Keyed by identifier as well as by
    // address so a distributed attempt against one number is still bounded.
    await enforceAuthBudget({
      ip: { scope: 'register:ip', value: req.ip },
      identifier: { scope: 'register:identifier', value: phone ?? email! },
    });

    const passwordHash = await hashNewPassword(body.password, body.locale, phone ?? email ?? undefined);

    const result = await withTransaction(async (tx) => {
      const { rows } = await tx.query<{ user_id: string; created: boolean; self_profile_id: string | null }>(
        'SELECT * FROM app.register_with_password($1,$2,$3,$4,$5)',
        [phone, email, body.displayName.trim(), passwordHash, body.locale],
      );
      const row = rows[0]!;
      if (!row.created) return { taken: true as const };

      // A new account without its own patient profile is unusable: every
      // screen needs one, and the app would sit on a loading spinner rather
      // than report anything. Refuse the registration instead of handing back
      // a session to a half-built account.
      if (!row.self_profile_id) {
        throw new AppError(ERROR_CODES.INTERNAL, 500, 'Account setup did not complete.');
      }

      const session = await createSession(tx, row.user_id, {
        deviceId: body.deviceId,
        deviceName: body.deviceName ?? null,
        userAgent: req.headers['user-agent'] ?? null,
        ipHash: req.ipHash,
      });
      await recordAudit(tx, {
        actorUserId: row.user_id,
        patientProfileId: null,
        action: 'auth.register',
        entityType: 'user',
        entityId: row.user_id,
        requestId: req.id,
        ipHash: req.ipHash,
        newValue: { method: 'password', deviceId: body.deviceId },
      });
      return { taken: false as const, userId: row.user_id, session };
    });

    if (result.taken) {
      // Registration is the one place this cannot be hidden — the account
      // genuinely cannot be created twice. Sign-in stays uniform.
      throw new AppError(ERROR_CODES.IDENTIFIER_TAKEN, 409, t(body.locale, 'auth.identifierTaken'));
    }

    return {
      accessToken: await signAccessToken(result.userId, result.session.sessionId, false),
      refreshToken: result.session.refreshToken,
      expiresIn: accessTokenTtlSeconds(),
      refreshExpiresAt: result.session.refreshExpiresAt.toISOString(),
      isNewUser: true,
    };
  });

  /** Sign in with phone-or-email and a password. */
  app.post('/v1/auth/login', {
    config: { rateLimit: { max: 12, timeWindow: '10 minutes' } },
  }, async (req) => {
    if (!passwordLoginEnabled()) {
      throw new AppError(ERROR_CODES.FORBIDDEN, 403, 'Password sign-in is disabled.');
    }
    const body = passwordLoginSchema.parse(req.body);
    const locale = req.headers['accept-language']?.startsWith('en') ? 'en' : 'ar';

    // A typed identifier may be a local-format phone, an E.164 phone, or an
    // email. Normalize the phone shape and let the lookup try both.
    const typed = body.identifier.trim();
    const asPhone = normalizePhone(typed);
    const identifier = asPhone ?? typed.toLowerCase();

    await enforceAuthBudget({
      ip: { scope: 'login:ip', value: req.ip },
      identifier: { scope: 'login:identifier', value: identifier },
    });

    // The attempt (and its failure counter) commits before anything is refused.
    const attempt = await withTransaction((tx) => attemptPasswordLogin(tx, identifier, body.password));
    assertLogin(attempt, locale);

    const session = await withTransaction(async (tx) => {
      const created = await createSession(tx, attempt.userId, {
        deviceId: body.deviceId,
        deviceName: body.deviceName ?? null,
        userAgent: req.headers['user-agent'] ?? null,
        ipHash: req.ipHash,
      });
      await recordAudit(tx, {
        actorUserId: attempt.userId,
        patientProfileId: null,
        action: 'auth.login',
        entityType: 'user',
        entityId: attempt.userId,
        requestId: req.id,
        ipHash: req.ipHash,
        newValue: { method: 'password', deviceId: body.deviceId },
      });
      return created;
    });

    // Signed in: a couple of mistyped passwords should not follow the person
    // around for the rest of the window.
    await clearBudget('login:identifier', identifier);

    const { rows } = await withUser(attempt.userId, (tx) =>
      tx.query<{ is_admin: boolean }>('SELECT is_admin FROM users WHERE id = $1', [attempt.userId]));

    return {
      accessToken: await signAccessToken(attempt.userId, session.sessionId, rows[0]?.is_admin ?? false),
      refreshToken: session.refreshToken,
      expiresIn: accessTokenTtlSeconds(),
      refreshExpiresAt: session.refreshExpiresAt.toISOString(),
      isNewUser: false,
    };
  });

  /**
   * Set or change a password.
   *
   * An account that has one must prove it. An account that has none — created
   * back when the only way in was a one-time code — can set one from an
   * authenticated session, which is proof enough.
   */
  app.post('/v1/auth/password', {
    preHandler: authenticate,
    config: { rateLimit: { max: 6, timeWindow: '10 minutes' } },
  }, async (req) => {
    const body = setPasswordSchema.parse(req.body);
    const { userId } = currentUser(req);
    const locale = req.headers['accept-language']?.startsWith('en') ? 'en' : 'ar';

    /**
     * The existing hash, looked up BY USER ID.
     *
     * This used to call `app.find_user_for_password_login(userId)`, and that
     * function matches on `phone_e164` or `lower(email)` — never on an id. A
     * UUID matches neither, so it returned no row, `existing` was always null,
     * and the current-password check below was skipped for every account that
     * has ever used this endpoint. Anyone holding a valid access token could
     * set a new password without knowing the old one; combined with the fact
     * that a password change does not end other sessions, a single stolen
     * access token was a permanent account takeover — the attacker sets a
     * password and the owner's own stops working.
     *
     * It goes through a function rather than a plain SELECT because
     * `user_credentials` is deliberately unreachable from the API role — RLS
     * with zero policies and no grant — so hashes are reachable only through
     * the SECURITY DEFINER auth plane. `app.password_hash_for_user` returns the
     * hash and nothing else.
     */
    const existing = await withTransaction(async (tx) => {
      const { rows } = await tx.query<{ password_hash: string | null }>(
        'SELECT app.password_hash_for_user($1) AS password_hash',
        [userId],
      );
      return rows[0]?.password_hash ?? null;
    });

    // An account with no password yet (OTP-only) is setting one for the first
    // time and has nothing to prove. An account that HAS one must present it.
    if (existing) {
      const ok = body.currentPassword ? await verifyPassword(body.currentPassword, existing) : false;
      if (!ok) {
        throw new AppError(ERROR_CODES.INVALID_CREDENTIALS, 401, t(locale, 'auth.currentPasswordWrong'));
      }
    }

    const hash = await hashNewPassword(body.newPassword, locale);
    const { sessionId } = currentUser(req);
    // `withUser`, not `withTransaction`: the session revocation below is a
    // plain UPDATE on auth_sessions, and that table's policy scopes rows to
    // `app.current_user_id()`. Without the identity set, RLS silently matches
    // nothing and the revocation is a no-op that reports success — which is
    // exactly the failure mode this whole finding is about.
    await withUser(userId, async (tx) => {
      await tx.query('SELECT app.set_password($1,$2)', [userId, hash]);

      /**
       * Every OTHER session ends here.
       *
       * Changing a password is what someone does when they believe another
       * person has their account. Leaving the other sessions alive means the
       * action they took to eject an intruder does not eject them — the
       * intruder's refresh token keeps working and the owner gets no signal.
       * The session making the change is deliberately kept, so the person is
       * not signed out of the device they are holding.
       */
      await tx.query(
        `UPDATE auth_sessions SET revoked_at = now()
          WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL`,
        [userId, sessionId],
      );
      await recordAudit(tx, {
        actorUserId: userId,
        patientProfileId: null,
        action: existing ? 'auth.password_changed' : 'auth.password_set',
        entityType: 'user',
        entityId: userId,
        requestId: req.id,
        ipHash: req.ipHash,
      });
    });

    // Changing a password does not end other sessions here; that is a separate
    // deliberate action so a patient mid-dose is never logged out unexpectedly.
    return { updated: true };
  });

  app.post('/v1/auth/refresh', {
    config: { rateLimit: { max: 60, timeWindow: '10 minutes' } },
  }, async (req) => {
    const body = refreshSchema.parse(req.body);
    // Committed before the outcome is judged, so a detected token reuse
    // durably revokes the device even though the request ends in a 401.
    // Address only: a refresh token is a capability, so there is no identifier
    // to key on that an attacker does not already hold.
    await enforceAuthBudget({ ip: { scope: 'refresh:ip', value: req.ip } });

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
