-- =============================================================================
-- Dawaee — 0059: only a server-proven replacement may preserve push on revoke
-- =============================================================================
--
-- PROVEN DEFECT
--   refresh-reuse-push-device-id-isolation.test.ts
--
-- Migration 0057 closes the password-change collision by marking that specific
-- transaction. Migration 0058 then makes refresh-token theft response revoke
-- only the server-written `replaced_by` lineage instead of every session sharing
-- a client-supplied device id.
--
-- One ambiguity remained between those two boundaries. When refresh reuse
-- revokes the live tip of the compromised lineage, an unrelated live session
-- can still claim the same client-controlled device_id. The 0057 trigger then
-- sees that unrelated session and preserves the shared push_tokens row, even
-- though the provider endpoint in that row may have been written by the lineage
-- that was just revoked. `app.list_live_push_tokens` likewise sees the unrelated
-- live session and would continue delivering medication notifications to that
-- stale endpoint.
--
-- Device id is routing metadata, not proof of endpoint ownership. The only case
-- where preserving the endpoint across a revocation is server-proven is normal
-- refresh rotation: the revoked predecessor itself records `replaced_by`, and a
-- live session remains for that user/device. Every unreplaced revocation retires
-- the endpoint. A legitimate surviving installation can register its endpoint
-- again on its next authenticated sync.
-- =============================================================================

CREATE OR REPLACE FUNCTION app.deactivate_push_after_device_session_revocation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app
AS $$
BEGIN
  IF OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL THEN
    -- Preserve push only for a server-linked refresh replacement. A live row
    -- that merely shares NEW.device_id is insufficient because device_id is
    -- chosen by the client and the shared provider endpoint may belong to the
    -- session being ejected.
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

REVOKE EXECUTE ON FUNCTION app.deactivate_push_after_device_session_revocation() FROM PUBLIC;

COMMENT ON FUNCTION app.deactivate_push_after_device_session_revocation() IS
  'Preserves a device push endpoint only across a server-proven refresh replacement; any unreplaced session revocation retires the ambiguous client-device endpoint.';
