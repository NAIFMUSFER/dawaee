-- =============================================================================
-- Dawaee — 0060: logout revokes only the server-proven refresh lineage
-- =============================================================================
--
-- PROVEN DEFECT
--   logout-device-id-isolation.test.ts
--
-- Migration 0044 fixed the logout-versus-refresh race by revoking every live
-- session that shared the target session's `(user_id, device_id)`. That scope
-- assumed device_id was an authenticated device identity. It is not: device_id
-- is supplied by the client at sign-in, so an independent sibling session may
-- deliberately or accidentally carry the same value. Logging out one session
-- could therefore log out that unrelated sibling as well.
--
-- The server already records the relationship that logout actually needs:
-- refresh rotation writes `replaced_by` from predecessor to successor. Revoke
-- the target session and only that server-written replacement lineage.
--
-- Keep the race closed by sharing migration 0054's per-user advisory auth lock.
-- Lock order is important: resolve user without a tuple lock, take the advisory
-- lock, then re-read the target session FOR UPDATE. A concurrent refresh uses
-- the same order, so either logout wins before a successor can be minted or it
-- sees the committed successor and revokes the full lineage deterministically.
-- =============================================================================

CREATE OR REPLACE FUNCTION app.revoke_session(p_session_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app
AS $$
DECLARE
  s auth_sessions%ROWTYPE;
BEGIN
  -- Optimistic identity lookup only; it authorizes nothing. The row is re-read
  -- under lock after account-wide serialization.
  SELECT * INTO s
    FROM auth_sessions
   WHERE id = p_session_id;

  IF s.id IS NULL THEN
    RETURN;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(s.user_id::text, 20260912));

  SELECT * INTO s
    FROM auth_sessions
   WHERE id = p_session_id
   FOR UPDATE;

  IF s.id IS NULL THEN
    RETURN;
  END IF;

  WITH RECURSIVE session_lineage(id) AS (
    SELECT s.id
    UNION
    SELECT parent.replaced_by
      FROM auth_sessions parent
      JOIN session_lineage lineage ON parent.id = lineage.id
     WHERE parent.user_id = s.user_id
       AND parent.replaced_by IS NOT NULL
  )
  UPDATE auth_sessions target
     SET revoked_at = now()
   WHERE target.user_id = s.user_id
     AND target.id IN (SELECT id FROM session_lineage WHERE id IS NOT NULL)
     AND target.revoked_at IS NULL;
END
$$;

REVOKE EXECUTE ON FUNCTION app.revoke_session(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.revoke_session(uuid) TO dawaee_app;

COMMENT ON FUNCTION app.revoke_session(uuid) IS
  'Revokes only the target session and its server-written refresh replacement lineage under the account advisory lock; client-supplied device_id never expands logout scope.';
