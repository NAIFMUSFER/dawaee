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
-- token can rotate the newly-visible descendant again between passes. Both
-- security operations instead take the same transaction-scoped advisory lock,
-- derived from the user id, before password/session mutation. A 64-bit advisory
-- key collision can only cause harmless extra serialization; it cannot merge
-- authorization state or grant access.
--
-- An earlier version used SELECT ... FOR UPDATE on users as the shared lock.
-- CI then proved a deadlock with audit_logs.actor_user_id's FK lock while a
-- concurrent refresh waited on auth_sessions. The advisory lock deliberately
-- lives outside table/FK lock graphs and is released automatically at commit or
-- rollback.
-- =============================================================================

CREATE OR REPLACE FUNCTION app.set_password(p_user_id uuid, p_password_hash text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
BEGIN
  -- Account-wide auth serialization point. Keep it for the whole surrounding
  -- transaction so no refresh can mint a descendant between the password write
  -- and the route's revocation of every other session.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::text, 20260912));

  PERFORM 1 FROM users u WHERE u.id = p_user_id;
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
  'Sets a password while holding a transaction-scoped per-user advisory auth '
  'lock, preventing concurrent refresh descendants from escaping the '
  'password-change session revocation boundary.';

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
  -- Resolve the account without a tuple lock so the shared advisory lock is
  -- always acquired before the session-row lock. The token is re-read under a
  -- row lock after advisory serialization, so this optimistic lookup cannot
  -- authorize or rotate stale state.
  SELECT * INTO s
    FROM auth_sessions
   WHERE refresh_token_hash = p_presented_hash;

  IF s.id IS NULL THEN
    RETURN QUERY SELECT 'invalid'::text, NULL::uuid, NULL::boolean, NULL::uuid, NULL::timestamptz;
    RETURN;
  END IF;

  -- Same transaction-scoped account lock as app.set_password(). No users-row
  -- tuple lock is taken here, avoiding cycles with audit-log foreign keys and
  -- other operations that legitimately reference the user row.
  PERFORM pg_advisory_xact_lock(hashtextextended(s.user_id::text, 20260912));

  -- Re-read after waiting for serialization: another refresh or password
  -- change may have committed while we waited. Existing superseded/reuse
  -- policy must judge this committed current state.
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
  'Rotates a refresh token under a transaction-scoped per-user advisory lock, '
  'then the token row lock. Exactly one concurrent caller wins; password '
  'changes share the advisory lock so no refresh descendant can cross the '
  'password-change revocation boundary. Superseded/reuse behavior remains '
  'migration-0023 compatible.';
