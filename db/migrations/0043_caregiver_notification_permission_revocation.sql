-- =============================================================================
-- Dawaee — 0043: pending release hardening after production schema 0033.
--
-- A) Caregiver notification revocation
-- Red-team evidence (apps/api/test/caregiver-delivery-revocation-race.test.ts):
-- a delivery queued while the relationship had receive_notifications remained
-- queued after the patient removed that permission, so the worker could still
-- claim and send it. Whenever the patient removes that permission, linked
-- queued/sending deliveries are suppressed and their leases invalidated.
--
-- B) API operational-table least privilege
-- Red-team + production evidence (app-operational-privilege-boundary.test.ts):
-- dawaee_app inherited SELECT/INSERT/UPDATE/DELETE from migration 0008 on the
-- three public operational tables that intentionally have no RLS:
-- schema_migrations, job_runs and provider_webhook_events. Current HTTP routes
-- read those tables only. Keep SELECT and remove mutation authority so an API
-- compromise cannot forge migration/worker state or delete webhook evidence.
--
-- Production remains on schema 0033, so this migration has not been deployed;
-- both evidence-backed release hardenings can be rehearsed together without
-- changing an already-recorded production checksum.
-- =============================================================================

CREATE OR REPLACE FUNCTION app.suppress_caregiver_deliveries_on_notification_permission_removal()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF OLD.permissions @> ARRAY['receive_notifications']::text[]
     AND NOT (NEW.permissions @> ARRAY['receive_notifications']::text[]) THEN
    UPDATE notification_deliveries
       SET status = 'skipped',
           lease_until = NULL,
           lease_token = NULL
     WHERE relationship_id = NEW.id
       AND status IN ('queued', 'sending');
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS caregiver_notification_permission_revocation_suppresses_deliveries
  ON caregiver_relationships;

CREATE TRIGGER caregiver_notification_permission_revocation_suppresses_deliveries
AFTER UPDATE OF permissions ON caregiver_relationships
FOR EACH ROW
WHEN (OLD.permissions IS DISTINCT FROM NEW.permissions)
EXECUTE FUNCTION app.suppress_caregiver_deliveries_on_notification_permission_removal();

REVOKE INSERT, UPDATE, DELETE ON TABLE
  schema_migrations,
  job_runs,
  provider_webhook_events
FROM dawaee_app;

GRANT SELECT ON TABLE
  schema_migrations,
  job_runs,
  provider_webhook_events
TO dawaee_app;
