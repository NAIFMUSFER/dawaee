-- =============================================================================
-- Dawaee — 0065: serialize logout-all with refresh rotation
-- =============================================================================
--
-- PROVEN DEFECT
--   PR #20 / logout-all-refresh-race.test.ts
--
-- POST /v1/auth/logout-all revokes every currently-visible session with one
-- UPDATE. A refresh transaction can already have rotated a predecessor into an
-- uncommitted descendant while logout-all takes its statement snapshot. The
-- UPDATE then waits on the predecessor row, resumes from that older snapshot,
-- and reports success without ever seeing the newly-committed descendant.
--
-- Migration 0054 established a transaction-scoped per-user advisory auth lock
-- for refresh rotation and password changes. Migration 0063 reuses the same
-- lock for account disable/re-enable. Logout-all must acquire that lock in a
-- separate SQL statement BEFORE its revocation UPDATE, so the UPDATE receives
-- a fresh READ COMMITTED snapshot after any in-flight refresh has committed.
--
-- This helper deliberately derives the user from the transaction-local RLS
-- identity rather than accepting a caller-selected account id. It only locks;
-- the existing RLS-protected UPDATE remains the authorization boundary.
-- =============================================================================

CREATE OR REPLACE FUNCTION app.lock_current_auth_account()
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog, public, app
AS $$
DECLARE
  uid_text text;
BEGIN
  uid_text := current_setting('app.user_id', true);
  IF uid_text IS NULL OR uid_text = '' THEN
    RAISE EXCEPTION 'authenticated user context required'
      USING ERRCODE = '42501';
  END IF;

  -- Keep this salt identical to app.rotate_session(), app.set_password(), and
  -- users_serialize_disabled_at_transition. A collision can only serialize two
  -- unrelated accounts; it cannot transfer authorization state.
  PERFORM pg_advisory_xact_lock(hashtextextended(uid_text, 20260912));
END
$$;

REVOKE ALL ON FUNCTION app.lock_current_auth_account() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.lock_current_auth_account() TO dawaee_app;

COMMENT ON FUNCTION app.lock_current_auth_account() IS
  'Acquires the current authenticated user auth-serialization advisory lock for the surrounding transaction; used before logout-all account-wide session revocation.';
