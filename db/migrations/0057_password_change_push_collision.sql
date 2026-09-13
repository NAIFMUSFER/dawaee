-- =============================================================================
-- Dawaee — 0057: password-change revocation wins over device-id collisions
-- =============================================================================
--
-- Migration 0051 intentionally keeps a push token active when a revoked session
-- has another live session on the same user/device. That is correct for refresh
-- rotation: the newly-created successor is the same authenticated installation.
--
-- A password change is different. It is an account-recovery boundary that
-- deliberately ejects every OTHER session. Two independently-authenticated
-- sessions can nevertheless present the same client-controlled device_id. If
-- the ejected session registered the push endpoint and the current session uses
-- that same device_id, the generic 0051 trigger sees the current session and
-- leaves the endpoint active. The ejected installation can then continue
-- receiving medication notifications after its session was revoked.
--
-- Mark transactions that actually change password credentials, then make the
-- session-revocation trigger treat that security boundary specially: any device
-- represented by an ejected session loses its push endpoint, even if another
-- live session claims the same device_id. Normal refresh rotation does not touch
-- user_credentials and therefore retains the 0051 successor-preserving rule.
-- =============================================================================

CREATE OR REPLACE FUNCTION app.mark_password_change_push_revocation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, app
AS $$
BEGIN
  -- Transaction-local by design. POST /v1/auth/password updates credentials and
  -- revokes the other sessions in one transaction, so the marker cannot leak to
  -- another request on a pooled connection after COMMIT/ROLLBACK.
  PERFORM set_config('app.password_change_push_revocation', '1', true);
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS user_credentials_mark_password_change_push_revocation ON user_credentials;
CREATE TRIGGER user_credentials_mark_password_change_push_revocation
AFTER INSERT OR UPDATE OF password_hash ON user_credentials
FOR EACH ROW
EXECUTE FUNCTION app.mark_password_change_push_revocation();

COMMENT ON TRIGGER user_credentials_mark_password_change_push_revocation ON user_credentials IS
  'Marks the current transaction as a password-credential change so later session revocations retire push endpoints even when another session claims the same device_id.';

CREATE OR REPLACE FUNCTION app.deactivate_push_after_device_session_revocation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app
AS $$
DECLARE
  password_change boolean :=
    COALESCE(current_setting('app.password_change_push_revocation', true), '') = '1';
BEGIN
  -- Run only on the live -> revoked edge. The trigger WHEN clause enforces the
  -- same condition, and keeping it here makes the function safe if it is ever
  -- invoked by another trigger definition.
  IF OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL THEN
    -- Password change is an explicit account-recovery boundary. A surviving
    -- same-device session cannot prove that the endpoint registered by the
    -- ejected session belongs to the survivor, because device_id is supplied by
    -- the client. Retire it and let the surviving installation re-register.
    --
    -- Outside password change, preserve migration 0051 behavior: refresh
    -- rotation creates a live successor on the same user/device and must not
    -- silence that installation.
    IF password_change OR NOT EXISTS (
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

COMMENT ON FUNCTION app.deactivate_push_after_device_session_revocation() IS
  'Deactivates push when a device loses authentication; password-change ejections always retire the affected device endpoint, while ordinary refresh rotation preserves a live successor.';
