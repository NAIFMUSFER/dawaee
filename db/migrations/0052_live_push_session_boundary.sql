-- =============================================================================
-- Dawaee — 0052: remote push requires a live session on the same device
-- =============================================================================
--
-- A push token can remain active when its last auth session expires by time
-- rather than moving through revoked_at. The dispatcher must therefore not use
-- push_tokens.active as an authentication signal. Keep auth_sessions hidden
-- from the worker and expose only the minimal routing answer: the token strings
-- for active installations that still have at least one live session for the
-- same user/device.
--
-- SECURITY DEFINER is intentional: migration 0021 denies dawaee_worker direct
-- SELECT on auth_sessions because it contains refresh-token hashes and device/IP
-- metadata. This function returns none of those fields.

CREATE OR REPLACE FUNCTION app.list_live_push_tokens(
  p_user_id uuid,
  p_limit int DEFAULT 5
)
RETURNS TABLE (token text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app
AS $$
BEGIN
  IF p_user_id IS NULL THEN
    RETURN;
  END IF;

  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 20 THEN
    RAISE EXCEPTION 'list_live_push_tokens: p_limit must be between 1 and 20'
      USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  SELECT pt.token
    FROM push_tokens pt
   WHERE pt.user_id = p_user_id
     AND pt.active
     AND EXISTS (
       SELECT 1
         FROM auth_sessions s
        WHERE s.user_id = pt.user_id
          AND s.device_id = pt.device_id
          AND s.revoked_at IS NULL
          AND s.expires_at > now()
     )
   ORDER BY pt.last_seen_at DESC
   LIMIT p_limit;
END
$$;

REVOKE EXECUTE ON FUNCTION app.list_live_push_tokens(uuid, int) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION app.list_live_push_tokens(uuid, int) TO dawaee_worker;

COMMENT ON FUNCTION app.list_live_push_tokens(uuid, int) IS
  'Returns only active push token strings whose user/device still has a live auth session. Worker cannot read auth_sessions directly.';
