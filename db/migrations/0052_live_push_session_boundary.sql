-- =============================================================================
-- Dawaee — 0052: remote push requires a live session on the same device
-- =============================================================================
--
-- A push token can remain active when its last auth session expires by time
-- rather than moving through revoked_at. The worker currently reads push_tokens
-- directly, so push_tokens.active alone must not be treated as an authentication
-- signal.
--
-- Keep auth_sessions hidden from the worker. A SECURITY DEFINER predicate reads
-- only whether a live same-user/same-device session exists; the worker receives
-- only that boolean through RLS and never gains SELECT on session rows, refresh
-- token hashes, device names or IP metadata.

CREATE OR REPLACE FUNCTION app.push_token_device_has_live_session(
  p_user_id uuid,
  p_device_id text
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, app
AS $$
  SELECT p_user_id IS NOT NULL
     AND p_device_id IS NOT NULL
     AND EXISTS (
       SELECT 1
         FROM auth_sessions s
        WHERE s.user_id = p_user_id
          AND s.device_id = p_device_id
          AND s.revoked_at IS NULL
          AND s.expires_at > now()
     )
$$;

REVOKE EXECUTE ON FUNCTION app.push_token_device_has_live_session(uuid, text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION app.push_token_device_has_live_session(uuid, text) TO dawaee_worker;

-- Replace only the worker SELECT policy. The app's own push_tokens policy and
-- the worker UPDATE policy remain unchanged. PostgreSQL combines SELECT
-- visibility with UPDATE row visibility, so provider-driven deactivation still
-- works for tokens selected for a currently authenticated device while expired
-- installations are no longer routable by the worker.
DROP POLICY IF EXISTS push_tokens_worker_read ON push_tokens;
CREATE POLICY push_tokens_worker_read ON push_tokens
  FOR SELECT TO dawaee_worker
  USING (app.push_token_device_has_live_session(user_id, device_id));

COMMENT ON FUNCTION app.push_token_device_has_live_session(uuid, text) IS
  'RLS predicate: a worker may route a push token only while the same user/device has an unrevoked, unexpired auth session.';
