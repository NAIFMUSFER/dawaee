-- =============================================================================
-- Dawaee — 0067: session deletion must retire its exact push endpoint
-- =============================================================================
--
-- PROVEN DEFECT
--   push-session-retention-regression.test.ts
--
-- Migration 0061 binds an active push endpoint to one exact auth session and
-- deliberately rejects client device_id as session authority. auth_sessions has
-- an ON DELETE SET NULL foreign key from push_tokens.session_id. If retention
-- deletes an expired bound session while an unrelated live session uses the same
-- client-supplied device_id, the SET NULL update reaches the binding guard while
-- the token is still active. The legacy compatibility fallback can then resolve
-- that unrelated session and silently transfer the endpoint to it.
--
-- Retire the exact endpoint before any auth-session DELETE. This runs before the
-- FK action, so the row is already inactive and unbound; the binding guard then
-- has no authority to infer a replacement from a device label. This also makes
-- every future session-deletion path fail closed, not only retention cleanup.
-- =============================================================================

CREATE OR REPLACE FUNCTION app.deactivate_push_before_session_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app
AS $$
BEGIN
  UPDATE push_tokens
     SET active = false,
         session_id = NULL
   WHERE session_id = OLD.id
     AND active;

  RETURN OLD;
END
$$;

REVOKE ALL ON FUNCTION app.deactivate_push_before_session_delete() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.deactivate_push_before_session_delete() FROM dawaee_app;
REVOKE ALL ON FUNCTION app.deactivate_push_before_session_delete() FROM dawaee_worker;

DROP TRIGGER IF EXISTS retire_push_before_auth_session_delete ON auth_sessions;
CREATE TRIGGER retire_push_before_auth_session_delete
BEFORE DELETE ON auth_sessions
FOR EACH ROW
EXECUTE FUNCTION app.deactivate_push_before_session_delete();

COMMENT ON FUNCTION app.deactivate_push_before_session_delete() IS
  'Fails closed before auth-session deletion by retiring only push endpoints bound to that exact server session; never rebinds through client device_id.';
