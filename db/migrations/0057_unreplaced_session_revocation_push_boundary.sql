-- =============================================================================
-- Dawaee — 0057: unreplaced session revocation invalidates that device's push
-- =============================================================================
--
-- PROVEN DEFECT (red regression: session-revocation-push-boundary.test.ts)
--
-- `device_id` is supplied by the client when a session is created. A second
-- authenticated session can therefore deliberately use the same device id as
-- the session the account owner is currently holding, then register its own
-- provider push token for that `(user_id, device_id)` row. A subsequent password
-- change revokes every other session, but migration 0051 kept the push row active
-- whenever *any* live session survived on the same device id. In the collision
-- case that survivor is the legitimate current session, while the active token
-- can still be the endpoint written by the now-ejected session.
--
-- The one revocation path where keeping the endpoint is provably safe is refresh
-- rotation: `app.rotate_session` creates the successor first and revokes the old
-- row with `replaced_by = <successor id>` in the same transaction. Ordinary
-- security revocations (password change, explicit revoke, refresh-reuse response)
-- do not carry that replacement proof. Treat those as an endpoint-invalidating
-- boundary even if another session happens to claim the same client-supplied
-- device id. A surviving legitimate client can register its own endpoint again.
--
-- This is intentionally implemented at the session/push invariant rather than
-- only in the password route so future unreplaced server-side revocations cannot
-- reintroduce the same ambiguity.

CREATE OR REPLACE FUNCTION app.deactivate_push_after_device_session_revocation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app
AS $$
BEGIN
  IF OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL THEN
    -- A replaced session is the normal refresh-rotation case. Keep push only
    -- when that replacement (or another live session) really leaves the same
    -- user/device authenticated. For an unreplaced revocation, device_id alone
    -- is not strong enough evidence that the existing provider token belongs to
    -- the surviving session, so retire it unconditionally.
    IF NEW.replaced_by IS NULL OR NOT EXISTS (
      SELECT 1
        FROM auth_sessions s
       WHERE s.user_id = NEW.user_id
         AND s.device_id = NEW.device_id
         AND s.revoked_at IS NULL
         AND s.expires_at > now()
    ) THEN
      UPDATE push_tokens
         SET active = false
       WHERE user_id = NEW.user_id
         AND device_id = NEW.device_id
         AND active;
    END IF;
  END IF;

  RETURN NULL; -- AFTER trigger; ignored by PostgreSQL.
END
$$;

-- Trigger functions are internal invariants, not runtime APIs.
REVOKE EXECUTE ON FUNCTION app.deactivate_push_after_device_session_revocation() FROM PUBLIC;

COMMENT ON FUNCTION app.deactivate_push_after_device_session_revocation() IS
  'Retires push on unreplaced session revocation because client-supplied device ids cannot prove provider-token ownership; preserves normal refresh rotation only when a live same-device successor remains.';
