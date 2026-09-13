-- =============================================================================
-- Dawaee — 0051: revoked devices stop receiving remote push
-- =============================================================================
--
-- Session revocation is used as a security boundary in several places, not only
-- explicit logout. A password change deliberately ejects every other session,
-- and refresh-token reuse revokes the affected device. Before this migration,
-- those server-side revocations could leave push_tokens.active = true, so the
-- worker could continue delivering medication notifications to a device the
-- server had just declared no longer authenticated.
--
-- Keep push eligibility coupled to the DEVICE, not to an individual session:
-- refresh rotation revokes its predecessor only after creating a live successor
-- on the same user/device. In that normal case the token must stay active.

CREATE OR REPLACE FUNCTION app.deactivate_push_after_device_session_revocation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app
AS $$
BEGIN
  -- Run only on the live -> revoked edge. The trigger WHEN clause enforces the
  -- same condition, and keeping it here makes the function safe if it is ever
  -- invoked by another trigger definition.
  IF OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL THEN
    -- If any unrevoked, unexpired session survives for this same user/device,
    -- the installation is still authenticated. This is what preserves push
    -- during refresh rotation and also avoids silencing a current session when
    -- another login on the same physical device is retired.
    IF NOT EXISTS (
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

REVOKE EXECUTE ON FUNCTION app.deactivate_push_after_device_session_revocation() FROM PUBLIC;

DROP TRIGGER IF EXISTS auth_sessions_deactivate_push_after_revocation ON auth_sessions;
CREATE TRIGGER auth_sessions_deactivate_push_after_revocation
AFTER UPDATE OF revoked_at ON auth_sessions
FOR EACH ROW
WHEN (OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL)
EXECUTE FUNCTION app.deactivate_push_after_device_session_revocation();

COMMENT ON TRIGGER auth_sessions_deactivate_push_after_revocation ON auth_sessions IS
  'When a user/device loses its last live session because of revocation, deactivate that device push token; refresh rotation stays active because its successor session already exists.';
