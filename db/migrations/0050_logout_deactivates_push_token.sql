-- =============================================================================
-- Dawaee — 0050: explicit logout retires that installation's remote push token
-- =============================================================================
--
-- The mobile client already attempts to unregister its push token before it
-- calls /v1/auth/logout, but both HTTP requests are deliberately best-effort.
-- If the token-removal request is lost while logout reaches the server, the
-- session is revoked but push_tokens.active stays true. The worker dispatches
-- push notifications from active tokens independently of session liveness, so
-- a signed-out/shared device can keep receiving the previous user's reminders.
--
-- Bind the cleanup to the authoritative session row instead of trusting a
-- second client-supplied device id. This is intentionally scoped to the
-- explicit revoke_session function: refresh rotation also revokes an old
-- session while keeping a successor alive on the same device, and must NOT
-- deactivate that installation's push endpoint.

CREATE OR REPLACE FUNCTION app.revoke_session(p_session_id uuid)
RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
  WITH revoked AS (
    UPDATE auth_sessions
       SET revoked_at = now()
     WHERE id = p_session_id
       AND revoked_at IS NULL
     RETURNING user_id, device_id
  )
  UPDATE push_tokens p
     SET active = false
    FROM revoked r
   WHERE p.user_id = r.user_id
     AND p.device_id = r.device_id
$$;

REVOKE EXECUTE ON FUNCTION app.revoke_session(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.revoke_session(uuid) TO dawaee_app;
