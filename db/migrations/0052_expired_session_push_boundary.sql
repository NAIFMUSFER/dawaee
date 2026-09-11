-- =============================================================================
-- Dawaee — 0052: time-based session expiry also removes remote push eligibility
-- =============================================================================
--
-- Migration 0051 couples explicit session revocation to push-token activity, but
-- a session can also stop being valid purely because expires_at passes. That
-- clock edge does not execute an UPDATE trigger, so push_tokens.active alone is
-- not a sufficient authorization boundary for remote medication notifications.
--
-- Keep the worker least-privileged: it still receives no SELECT privilege on
-- auth_sessions. Instead expose only the provider routing tokens whose device
-- currently has at least one live, unrevoked session for the same account.

CREATE OR REPLACE FUNCTION app.list_live_push_tokens(
  p_user_id uuid,
  p_limit int
)
RETURNS TABLE(token text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'list_live_push_tokens: user id is required';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 20 THEN
    RAISE EXCEPTION 'list_live_push_tokens: limit must be between 1 and 20';
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
END $$;

REVOKE EXECUTE ON FUNCTION app.list_live_push_tokens(uuid, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.list_live_push_tokens(uuid, int) TO dawaee_worker;

COMMENT ON FUNCTION app.list_live_push_tokens(uuid, int) IS
  'Worker-only bounded remote-push routing tokens for devices that still have a live session for the same account; exposes no auth-session rows or hashes.';
