-- =============================================================================
-- Dawaee — 0058: refresh-token reuse revokes only the proven replacement lineage
-- =============================================================================
--
-- PROVEN DEFECT
--   password-change-revoked-refresh-device-id-isolation.test.ts
--
-- `auth_sessions.device_id` is supplied by the client at sign-in. The reuse
-- response inherited from migration 0023 treated that identifier as a security
-- principal: presenting any revoked refresh token caused every live session
-- with the same `(user_id, device_id)` to be revoked.
--
-- A compromised session can choose the legitimate installation's device id.
-- After the owner changes the password, that compromised session is correctly
-- revoked; however, replaying its already-revoked refresh token then matched the
-- owner's surviving session by the spoofed device id and revoked it too. The old
-- token consequently remained a persistent logout capability after password
-- recovery.
--
-- `replaced_by` is the authoritative server-written relationship created by a
-- successful refresh rotation. On reuse of a genuinely rotated predecessor,
-- revoke only its still-live replacement lineage. An already-revoked session
-- with no replacement has no server-proven descendant to revoke and therefore
-- mutates no other session. This preserves theft response without trusting a
-- client-controlled installation label.
--
-- Keep the account advisory lock introduced by migration 0054. It serializes
-- this lineage walk with password changes and concurrent refresh rotations.
-- =============================================================================

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

  PERFORM pg_advisory_xact_lock(hashtextextended(s.user_id::text, 20260912));

  -- Re-read after waiting for account-wide serialization.
  SELECT * INTO s
    FROM auth_sessions
   WHERE refresh_token_hash = p_presented_hash
   FOR UPDATE;

  IF s.id IS NULL THEN
    RETURN QUERY SELECT 'invalid'::text, NULL::uuid, NULL::boolean, NULL::uuid, NULL::timestamptz;
    RETURN;
  END IF;

  SELECT u.disabled_at INTO disabled FROM users u WHERE u.id = s.user_id;
  IF disabled IS NOT NULL THEN
    RETURN QUERY SELECT 'invalid'::text, NULL::uuid, NULL::boolean, NULL::uuid, NULL::timestamptz;
    RETURN;
  END IF;

  IF s.revoked_at IS NOT NULL THEN
    -- Benign immediate predecessor race: preserve migration 0054's grace
    -- behavior so two requests from the same client do not eject the winner.
    IF s.replaced_by IS NOT NULL AND s.revoked_at > now() - grace THEN
      RETURN QUERY SELECT 'superseded'::text, NULL::uuid, NULL::boolean, NULL::uuid, NULL::timestamptz;
      RETURN;
    END IF;

    -- Outside the grace window, reuse still signals theft. Revoke only sessions
    -- linked by server-written `replaced_by`; device_id is client controlled and
    -- cannot authorize mutation of an independent session.
    IF s.replaced_by IS NOT NULL THEN
      WITH RECURSIVE replacement_lineage(id) AS (
        SELECT s.replaced_by
        UNION
        SELECT child.replaced_by
          FROM auth_sessions child
          JOIN replacement_lineage lineage ON child.id = lineage.id
         WHERE child.user_id = s.user_id
           AND child.replaced_by IS NOT NULL
      )
      UPDATE auth_sessions target
         SET revoked_at = now()
       WHERE target.user_id = s.user_id
         AND target.id IN (SELECT id FROM replacement_lineage WHERE id IS NOT NULL)
         AND target.revoked_at IS NULL;
    END IF;

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
  'Rotates refresh tokens under the account advisory lock. Reuse revokes only the server-linked replacement lineage; client-supplied device_id never authorizes revocation of an independent session.';
