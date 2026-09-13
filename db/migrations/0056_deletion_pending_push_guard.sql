-- =============================================================================
-- Dawaee — 0056: a deletion-pending account cannot reactivate remote push
-- =============================================================================
--
-- PROVEN DEFECT (red regression: deletion-request-push-boundary.test.ts)
--
-- `/v1/me/deletion-request` deliberately keeps the authenticated session alive
-- during the fourteen-day grace period, but deactivates every push token so the
-- account stops receiving server reminders immediately. The mobile shell also
-- re-registers its Expo token whenever an authenticated installation starts.
-- A process restart during that grace period therefore reached
-- `/v1/devices/push-token` with the still-valid session and the ordinary upsert
-- flipped the same token back to active=true, undoing the deletion boundary.
--
-- Put the invariant at the table boundary instead of only in one HTTP handler:
-- no current or future writer may activate a push endpoint for an account whose
-- deletion marker is present. Lock the user row before allowing activation so a
-- concurrent deletion request and registration have a deterministic final
-- state: registration first => deletion subsequently silences it; deletion
-- first => registration is refused after observing the committed marker.

CREATE OR REPLACE FUNCTION app.guard_deletion_pending_push_activation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app
AS $$
DECLARE
  v_deletion_requested_at timestamptz;
BEGIN
  IF NOT NEW.active THEN
    RETURN NEW;
  END IF;

  SELECT u.deletion_requested_at
    INTO v_deletion_requested_at
    FROM users u
   WHERE u.id = NEW.user_id
   FOR UPDATE;

  -- Let the existing foreign key remain the authority for a nonexistent user.
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  IF v_deletion_requested_at IS NOT NULL THEN
    RAISE EXCEPTION 'push registration is disabled while account deletion is pending'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END
$$;

-- Trigger functions are an internal invariant, not a callable runtime API.
REVOKE ALL ON FUNCTION app.guard_deletion_pending_push_activation() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.guard_deletion_pending_push_activation() FROM dawaee_app;
REVOKE ALL ON FUNCTION app.guard_deletion_pending_push_activation() FROM dawaee_worker;

CREATE TRIGGER push_tokens_deletion_pending_guard
BEFORE INSERT OR UPDATE OF active, user_id ON push_tokens
FOR EACH ROW
WHEN (NEW.active)
EXECUTE FUNCTION app.guard_deletion_pending_push_activation();

COMMENT ON FUNCTION app.guard_deletion_pending_push_activation() IS
  'Trigger-only invariant: serializes with account deletion and refuses active push endpoints while deletion_requested_at is set.';
