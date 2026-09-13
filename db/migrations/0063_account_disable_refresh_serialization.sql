-- =============================================================================
-- Dawaee — 0063: serialize account disablement with refresh rotation
-- =============================================================================
--
-- PROVEN DEFECT
--   PR #21 / account-disable-refresh-race.test.ts
--
-- Migration 0024 permanently revokes sessions on the NULL -> non-NULL
-- disabled_at edge. A concurrent refresh can, however, hold an uncommitted
-- descendant while the operator's UPDATE has already started. Without a shared
-- serialization point, the disable-trigger revocation can continue from a
-- snapshot that predates that descendant, allowing it to become usable again
-- after a later re-enable.
--
-- Migration 0054 established the account-wide advisory auth lock used by
-- app.rotate_session() and password changes. Acquire that same lock BEFORE the
-- disabled_at transition. If refresh already owns it, disable waits until the
-- descendant commits, then migration 0024's AFTER trigger revokes the now-
-- committed session. If disable owns it first, no refresh can mint a descendant
-- across the disable boundary.
--
-- The lock is transaction-scoped and keyed by user id. Re-enable takes the same
-- lock as well; that is intentional so a credential cannot race the boundary in
-- either direction. The AFTER trigger remains responsible for permanent
-- revocation only on NULL -> non-NULL.
-- =============================================================================

CREATE OR REPLACE FUNCTION app.serialize_disabled_at_transition()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app
AS $$
BEGIN
  IF OLD.disabled_at IS DISTINCT FROM NEW.disabled_at THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(NEW.id::text, 20260912));
  END IF;
  RETURN NEW;
END
$$;

REVOKE EXECUTE ON FUNCTION app.serialize_disabled_at_transition() FROM PUBLIC;

DROP TRIGGER IF EXISTS users_serialize_disabled_at_transition ON users;
CREATE TRIGGER users_serialize_disabled_at_transition
BEFORE UPDATE OF disabled_at ON users
FOR EACH ROW
WHEN (OLD.disabled_at IS DISTINCT FROM NEW.disabled_at)
EXECUTE FUNCTION app.serialize_disabled_at_transition();

COMMENT ON TRIGGER users_serialize_disabled_at_transition ON users IS
  'Serializes account disable/re-enable with refresh rotation using the same per-user advisory auth lock, so no refresh descendant can cross the disable boundary.';
