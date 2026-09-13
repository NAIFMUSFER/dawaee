-- 0076_push_endpoint_exact_session.sql
-- Receipt-aware push endpoint lookup must preserve the exact-session binding
-- introduced in 0061. A fresh login on the same device must not reactivate a
-- push token that is still bound to an expired or revoked session.

CREATE OR REPLACE FUNCTION app.list_live_push_endpoints(
  p_user_id uuid,
  p_limit integer DEFAULT 5
)
RETURNS TABLE(push_token_id uuid, token text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT pt.id, pt.token
    FROM push_tokens pt
    JOIN auth_sessions s
      ON s.id = pt.session_id
     AND s.user_id = pt.user_id
     AND s.device_id = pt.device_id
   WHERE pt.user_id = p_user_id
     AND pt.active
     AND s.revoked_at IS NULL
     AND s.expires_at > now()
   ORDER BY pt.last_seen_at DESC, pt.id DESC
   LIMIT LEAST(GREATEST(COALESCE(p_limit, 5), 1), 20)
$$;

REVOKE ALL ON FUNCTION app.list_live_push_endpoints(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.list_live_push_endpoints(uuid, integer) TO dawaee_worker;

COMMENT ON FUNCTION app.list_live_push_endpoints(uuid, integer) IS
  'Worker-only receipt-aware endpoint lookup; a token is live only while its exact bound auth session is live.';
