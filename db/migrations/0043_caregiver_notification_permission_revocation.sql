-- =============================================================================
-- Dawaee — 0043: make receive_notifications revocation authoritative over
-- already-enqueued caregiver deliveries.
--
-- Red-team evidence (apps/api/test/caregiver-delivery-revocation-race.test.ts):
-- a delivery queued while the relationship had receive_notifications remained
-- queued after the patient removed that permission, so the worker could still
-- claim and send it.
--
-- The invariant belongs at the data boundary, not only in one HTTP route:
-- whenever an owner-authorised relationship update removes
-- receive_notifications, every linked queued/sending delivery is atomically
-- suppressed in the same transaction. 0033's deliberately narrow owner UPDATE
-- policy permits only the resulting skipped state, so this trigger does not
-- widen notification-delivery write access.
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
