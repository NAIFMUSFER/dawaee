-- =============================================================================
-- Dawaee — 0033: let a profile owner suppress queued caregiver notifications
-- when revoking that caregiver's access.
--
-- Evidence: production DELETE /v1/caregivers/:relationshipId reached the API
-- but rolled back with HTTP 400 when the route attempted to mark queued
-- notification_deliveries as skipped. RLS had SELECT for the owner and UPDATE
-- for the worker, but no owner UPDATE policy.
--
-- This policy is intentionally narrow: the request role may only update rows
-- belonging to a profile it owns, and the resulting state must be `skipped`.
-- It does not grant caregivers any notification-delivery write path.
-- =============================================================================

DROP POLICY IF EXISTS notif_owner_update ON notification_deliveries;

CREATE POLICY notif_owner_update
  ON notification_deliveries
  FOR UPDATE
  TO dawaee_app
  USING (app.owns_profile(patient_profile_id))
  WITH CHECK (
    app.owns_profile(patient_profile_id)
    AND status = 'skipped'::delivery_status
  );
