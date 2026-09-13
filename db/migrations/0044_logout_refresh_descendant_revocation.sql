-- Close the server-side logout/refresh race without broadening revocation beyond
-- the scope already used by refresh-token reuse detection: one user + device.
--
-- Race being closed:
--   1. /logout authenticates access token for session S1.
--   2. A concurrent /refresh locks and rotates S1 -> S2, then commits.
--   3. /logout reaches app.revoke_session(S1).
--
-- The previous function updated only S1. At step 3 S1 was already revoked, so
-- logout returned success while S2 remained live. A patient could therefore
-- explicitly sign out yet leave a usable refresh/access descendant behind.
--
-- The row lock makes both interleavings safe:
-- - logout locks S1 first: refresh waits, then sees a revoked predecessor and
--   cannot mint a live descendant;
-- - refresh locks S1 first: logout waits, then revokes every currently-live
--   session for S1's same user/device, including the committed descendant.
--
-- This does NOT sign out other devices. user_id + device_id is the same scope
-- app.rotate_session already uses for suspected refresh-token reuse.

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

  UPDATE auth_sessions
     SET revoked_at = now()
   WHERE user_id = s.user_id
     AND device_id = s.device_id
     AND revoked_at IS NULL;
END
$$;

COMMENT ON FUNCTION app.revoke_session(uuid) IS
  'Revokes every live session for the target session user/device under a lock on the target row, so a refresh descendant cannot survive a concurrent logout.';
