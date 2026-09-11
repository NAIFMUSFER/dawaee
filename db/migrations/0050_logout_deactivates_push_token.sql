-- =============================================================================
-- Dawaee — 0050: explicit logout retires that installation's remote push token
-- =============================================================================
--
-- The mobile client already attempts to unregister its push token before it
-- calls /v1/auth/logout, but both HTTP requests are deliberately best-effort.
-- If the token-removal request is lost while logout reaches the server, the
-- session can be revoked while push_tokens.active stays true. The worker sends
-- push notifications from active tokens independently of session liveness, so
-- a signed-out/shared device can keep receiving the previous user's reminders.
--
-- Bind cleanup to the authoritative session row instead of trusting a second
-- client-supplied device id.
--
-- IMPORTANT: migration 0044 made revoke_session race-safe by locking the target
-- session, then revoking every live descendant for the same user + device. Keep
-- that exact protection here. A concurrent refresh may already have rotated
-- S1 -> S2 by the time logout acquires the lock; revoking only S1 would return
-- the pre-0044 bug where S2 survives an explicit logout.

CREATE OR REPLACE FUNCTION app.revoke_session(p_session_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app
AS $$
DECLARE
  s auth_sessions%ROWTYPE;
BEGIN
  SELECT * INTO s
    FROM auth_sessions
   WHERE id = p_session_id
   FOR UPDATE;

  IF s.id IS NULL THEN
    RETURN;
  END IF;

  -- Same user/device scope established by migration 0044. This catches a
  -- refresh descendant that committed before logout obtained the row lock.
  UPDATE auth_sessions
     SET revoked_at = now()
   WHERE user_id = s.user_id
     AND device_id = s.device_id
     AND revoked_at IS NULL;

  -- Remote notification eligibility follows the explicit device logout. Do
  -- not rely on the mobile client's separate best-effort deregistration call.
  UPDATE push_tokens
     SET active = false
   WHERE user_id = s.user_id
     AND device_id = s.device_id
     AND active;
END
$$;

REVOKE EXECUTE ON FUNCTION app.revoke_session(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.revoke_session(uuid) TO dawaee_app;

COMMENT ON FUNCTION app.revoke_session(uuid) IS
  'Locks the target session, revokes every live session for its user/device so a refresh descendant cannot survive logout, and deactivates that installation push token.';
