-- =============================================================================
-- Dawaee — 0054: serialize password changes with refresh-token rotation
--
-- Red-team evidence (PR #18) forced this ordering on both PostgreSQL 16 and 17:
--
--   1. refresh R1 -> R2 runs inside an open transaction and holds R1's row lock;
--   2. password change starts revoking every other session and blocks on R1;
--   3. the refresh commits R2 only after the password-change UPDATE has already
--      taken its statement snapshot;
--   4. the password change finishes successfully, but R2 survives because it
--      did not exist in that snapshot.
--
-- That violates the password-change contract: changing a password is the action
-- a patient takes to eject an intruder, so no descendant of an already-in-flight
-- refresh on another device may survive the successful response.
--
-- The fix is one per-user serialization lock, implemented with the existing
-- `users` row rather than a hash/advisory lock. Both operations acquire that row
-- BEFORE they mutate session state. This is collision-free, survives process
-- boundaries, and uses PostgreSQL's transaction lifetime as the release point.
--
-- Lock order is deliberately user -> session. `rotate_session` first discovers
-- the user without a row lock, then locks the user row, and only then locks the
-- presented session. `set_password` locks the same user row before changing the
-- hash; the password route's session-revocation UPDATE follows in the same
-- transaction. This avoids the session -> user / user -> session deadlock that
-- would result from adding the lock after rotate_session's existing FOR UPDATE.
-- =============================================================================

CREATE OR REPLACE FUNCTION app.set_password(p_user_id uuid, p_password_hash text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
BEGIN
  -- Security-boundary lock. The caller keeps this row lock until the enclosing
  -- transaction commits, so a refresh for the same account cannot create a
  -- descendant between the password write and the following session revocation.
  PERFORM 1
    FROM users u
   WHERE u.id = p_user_id
   FOR UPDATE;

  INSERT INTO user_credentials (user_id, password_hash)
  VALUES (p_user_id, p_password_hash)
  ON CONFLICT (user_id) DO UPDATE
     SET password_hash = excluded.password_hash,
         password_updated_at = now(),
         failed_login_count = 0,
         locked_until = NULL;
END $$;

REVOKE EXECUTE ON FUNCTION app.set_password(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.set_password(uuid, text) TO dawaee_app;

COMMENT ON FUNCTION app.set_password(uuid, text) IS
  'Sets a password while holding the account user-row lock for the enclosing transaction, '
  'serializing password security changes with refresh-token rotation.';

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
  target_user uuid;
  admin boolean;
  new_id uuid;
  new_expiry timestamptz;
  disabled timestamptz;
  -- Named so the policy is greppable and changing it is a deliberate act.
  grace constant interval := interval '30 seconds';
BEGIN
  -- Discover the account without locking the session yet. The security lock
  -- below must be acquired before the per-session row lock to keep one global
  -- lock order (user -> session) with password changes.
  SELECT a.user_id
    INTO target_user
    FROM auth_sessions a
   WHERE a.refresh_token_hash = p_presented_hash;

  IF target_user IS NULL THEN
    RETURN QUERY SELECT 'invalid'::text, NULL::uuid, NULL::boolean, NULL::uuid, NULL::timestamptz;
    RETURN;
  END IF;

  -- Serialize every refresh for this account with password changes. Holding a
  -- real user row avoids advisory-lock hash collisions and automatically also
  -- serializes with operator writes that lock/update this account row.
  PERFORM 1
    FROM users u
   WHERE u.id = target_user
   FOR UPDATE;

  -- Re-read after taking the account lock. The token may have been rotated or
  -- revoked while this transaction was waiting; this row lock and the state
  -- checks below decide the outcome from the current committed state.
  SELECT *
    INTO s
    FROM auth_sessions
   WHERE refresh_token_hash = p_presented_hash
   FOR UPDATE;

  IF s.id IS NULL THEN
    RETURN QUERY SELECT 'invalid'::text, NULL::uuid, NULL::boolean, NULL::uuid, NULL::timestamptz;
    RETURN;
  END IF;

  -- A disabled account cannot refresh, whatever the token's state. Returned as
  -- 'invalid' rather than a distinct code so disablement remains unobservable.
  SELECT u.disabled_at INTO disabled FROM users u WHERE u.id = s.user_id;
  IF disabled IS NOT NULL THEN
    RETURN QUERY SELECT 'invalid'::text, NULL::uuid, NULL::boolean, NULL::uuid, NULL::timestamptz;
    RETURN;
  END IF;

  IF s.revoked_at IS NOT NULL THEN
    -- The narrow honest-race case: this exact token was superseded moments ago.
    -- Mint nothing and revoke nothing; the winning request already has R2.
    IF s.replaced_by IS NOT NULL AND s.revoked_at > now() - grace THEN
      RETURN QUERY SELECT 'superseded'::text, NULL::uuid, NULL::boolean, NULL::uuid, NULL::timestamptz;
      RETURN;
    END IF;

    -- Any other reuse is treated as theft and revokes the device.
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

REVOKE EXECUTE ON FUNCTION app.rotate_session(text, text, text, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.rotate_session(text, text, text, int) TO dawaee_app;

COMMENT ON FUNCTION app.rotate_session(text,text,text,int) IS
  'Rotates a refresh token under an account row lock followed by the session row lock. '
  'The account lock serializes rotation with password security changes; exactly one '
  'concurrent refresh wins. Immediate-predecessor races retain the 30-second superseded '
  'outcome with no credential minting or device revocation.';
