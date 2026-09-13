-- =============================================================================
-- Dawaee — 0049: caregiver digest permission revocation.
--
-- Evidence: daily/weekly caregiver summaries contain adherence counts and are
-- derived from medication schedules. The producer now requires
-- receive_notifications + view_adherence + view_schedule, matching the
-- /v1/adherence permission dependencies. A summary already in the outbox,
-- however, could survive later removal of either data permission because 0043
-- only suppresses deliveries when receive_notifications itself is removed.
--
-- This migration closes both upgrade and race windows:
--   1. retire any already-queued/in-flight digest that current permissions no
--      longer authorize (including rows created by a pre-fix worker), and
--   2. invalidate queued/sending digest leases whenever either required data
--      permission is removed in the future.
-- The worker also re-checks the same contract immediately before provider send
-- so a legacy invalid row cannot bypass the database guard.
-- =============================================================================

UPDATE notification_deliveries d
   SET status = 'skipped',
       lease_until = NULL,
       lease_token = NULL
  FROM caregiver_relationships cr
 WHERE d.relationship_id = cr.id
   AND d.kind IN ('daily_summary', 'weekly_summary')
   AND d.status IN ('queued', 'sending')
   AND NOT (
     cr.status = 'active'
     AND cr.permissions @> ARRAY['receive_notifications','view_adherence','view_schedule']::text[]
   );

CREATE OR REPLACE FUNCTION app.suppress_caregiver_digests_on_data_permission_removal()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF OLD.permissions @> ARRAY['receive_notifications','view_adherence','view_schedule']::text[]
     AND NOT (
       NEW.permissions @> ARRAY['receive_notifications','view_adherence','view_schedule']::text[]
     ) THEN
    UPDATE notification_deliveries
       SET status = 'skipped',
           lease_until = NULL,
           lease_token = NULL
     WHERE relationship_id = NEW.id
       AND kind IN ('daily_summary', 'weekly_summary')
       AND status IN ('queued', 'sending');
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS caregiver_digest_permission_revocation_suppresses_deliveries
  ON caregiver_relationships;

CREATE TRIGGER caregiver_digest_permission_revocation_suppresses_deliveries
AFTER UPDATE OF permissions ON caregiver_relationships
FOR EACH ROW
WHEN (OLD.permissions IS DISTINCT FROM NEW.permissions)
EXECUTE FUNCTION app.suppress_caregiver_digests_on_data_permission_removal();
