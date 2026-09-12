-- =============================================================================
-- Dawaee — 0054: serialize password change with refresh-token rotation
--
-- Proven race (PR/issue #18): POST /v1/auth/password changes the password and
-- then revokes every other live auth_sessions row in the same transaction.
-- app.rotate_session() previously locked only the presented session row.
--
-- Under READ COMMITTED, the password-change UPDATE can take its statement
-- snapshot, block on a predecessor row held by an in-flight refresh, and then
-- resume after that refresh commits a newly-created descendant session. The
-- UPDATE keeps its original snapshot, so the descendant is invisible and can
-- survive even though the HTTP password-change response promises the other
-- sessions were ejected.
--
-- Do not paper over this with a second UPDATE: an attacker holding the refresh
-- token can rotate the newly-visible descendant again between passes. Instead
-- use the users row as the per-account transaction lock shared by BOTH security
-- operations. Password change obtains it inside app.set_password() and keeps it
-- until its surrounding transaction commits. Refresh resolves the token to a
-- user without locking, takes that same user lock, then re-reads and locks the
-- session row before making any decision. That lock order is deliberately
-- user -> session on refresh, matching password change's user -> sessions order
-- and avoiding a session -> user deadlock cycle.
-- =============================================================================

CREATE OR REPLACE FUNCTION app.set_password(p_user_id uuid, p_password_hash text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
BEGIN
  -- Account-wide auth serialization point. This row lock is held until the
  -- caller's transaction ends, so no refresh rotation for this user can mint a
  -- descendant between the password write and revocation of other sessions.
  PERFORM 1 FROM users u WHERE u.id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'user not found' USING ERRCODE = 'no_data_found';
  END IF;

  INSERT INTO user_credentials (user_id, password_hash)
  VALUES (p_user_id, p_password_hash)
  ON CONFLICT (user_id) DO UPDATE
     SET password_hash = excluded.password_hash,
         password_updated_at = now(),
         failed_login_count = 0,
         locked_until = NULL;
END $$;

COMMENT ON FUNCTION app.set_password(uuid,text) IS
  'Sets a password while holding the per-user auth serialization lock until '
  'transaction end, preventing concurrent refresh descendants from escaping '
  'the password-change session revocation boundary.';

CREATE OR REPLACE FUNCTION app.rotate_session(
  p_presented_hash text,
  p_new_hash text,
  p_ip_hash text,
  p_ttl_days int
) RETURNS TABLE (outcome text, user_id uuid, is_admin boolean, session_id uuid, expires_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
#variable_conflict use_column
DECLARE
  s auth_sessions%ROWTYPE;
  admin boolean;
  new_id uuid;
  new_expiry timestamptz;
  disabled timestamptz;
  grace constant interval := interval '30 seconds';
BEGIN
  -- First resolve the account WITHOUT taking the session row lock. Taking the
  -- session lock first and the user lock second would deadlock with password
  -- change, which deliberately takes the user lock before revoking sessions.
  SELECT * INTO s
    FROM auth_sessions
   WHERE refresh_token_hash = p_presented_hash;

  IF s.id IS NULL THEN
    RETURN QUERY SELECT 'invalid'::text, NULL::uuid, NULL::boolean, NULL::uuid, NULL::timestamptz;
    RETURN;
  END IF;

  -- The same account-wide lock held by app.set_password(). All refreshes for a
  -- user serialize here, and a password-change transaction keeps this blocked
  -- until its password write + other-session revocation are committed.
  PERFORM 1 FROM users u WHERE u.id = s.user_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'invalid'::text, NULL::uuid, NULL::boolean, NULL::uuid, NULL::timestamptz;
    RETURN;
  END IF;

  -- Re-read after waiting for the account lock: another refresh may have
  -- rotated this predecessor before we obtained the lock. The existing
  -- superseded/reuse policy must judge the committed current state, not the
  -- optimistic lookup above.
  SELECT * INTO s
    FROM auth_sessions
   WHERE refresh_token_hash = p_presented_hash
   FOR UPDATE;

  IF s.id IS NULL THEN
    RETURN QUERY SELECT 'invalid'::text, NULL::uuid, NULL::boolean, NULL::uuid, NULL::timestamptz;
    RETURN;
  END IF;

  -- A disabled account cannot refresh, whatever the token's state. Keep the
  -- externally indistinguishable 'invalid' outcome from migration 0023.
  SELECT u.disabled_at INTO disabled FROM users u WHERE u.id = s.user_id;
  IF disabled IS NOT NULL THEN
    RETURN QUERY SELECT 'invalid'::text, NULL::uuid, NULL::boolean, NULL::uuid, NULL::timestamptz;
    RETURN;
  END IF;

  IF s.revoked_at IS NOT NULL THEN
    -- Immediate predecessor race: mint nothing and revoke nothing during the
    -- existing 30-second grace window.
    IF s.replaced_by IS NOT NULL AND s.revoked_at > now() - grace THEN
      RETURN QUERY SELECT 'superseded'::text, NULL::uuid, NULL::boolean, NULL::uuid, NULL::timestamptz;
      RETURN;
    END IF;

    -- Any other reuse remains theft: revoke every still-live session on that
    -- device, exactly as migration 0023 specified.
    UPDATE auth_sessions SET revoked_at = now()
     WHERE user_id = s.user_id AND device_id = s.device_id AND revoked_at IS NULL;
    RETURN QUERY SELECT 'reuse_detected'::text, s.user_id, NULL::boolean, NULL::uuid, NULL::timestamptz;
    RETURN;
  END IF;

  IF s.expires_at <= now() THEN
    RETURN QUERY SELECT 'expired'::text, s.user_id, NULL::boolean, NULL::uuid, NULL::timestamptz;
    RETURN;
  END IF;

  SELECT u.is_admin INTO admin FROM users u WHERE u.id = s.user_id;

  INSERT INTO auth_sessions
    (user_id, refresh_token_hash, device_id, device_name, ip_hash, expires_at)
  VALUES
    (s.user_id, p_new_hash, s.device_id, s.device_name, p_ip_hash, now() + make_interval(days => p_ttl_days))
  RETURNING id, auth_sessions.expires_at INTO new_id, new_expiry;

  UPDATE auth_sessions
     SET revoked_at = now(), replaced_by = new_id, last_used_at = now()
   WHERE id = s.id;

  RETURN QUERY SELECT 'rotated'::text, s.user_id, admin, new_id, new_expiry;
END $$;

COMMENT ON FUNCTION app.rotate_session(text,text,text,int) IS
  'Rotates a refresh token under a per-user auth lock followed by the token row '
  'lock. Exactly one concurrent caller wins; password changes share the user '
  'lock so a refresh descendant cannot cross the password-change revocation '
  'boundary. Superseded/reuse behavior remains migration-0023 compatible.';
