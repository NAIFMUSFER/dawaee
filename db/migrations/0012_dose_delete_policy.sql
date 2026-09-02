-- =============================================================================
-- Dawaee — 0012: allow a schedule edit to clear its own future doses
--
-- 0008 gave dose_occurrences SELECT/INSERT/UPDATE policies but no DELETE one.
-- Row-level security is default-deny, so `rematerializeSchedule` silently
-- removed nothing and a schedule edit left the old doses behind — the patient
-- would have kept getting reminders on the previous times. Caught by the
-- integration test asserting that changing a schedule removes future doses.
--
-- The policy is intentionally narrow. It permits deleting a dose only for
-- someone who may edit the schedule, and the application never deletes a dose
-- that has been notified, confirmed or acted on: history is not editable.
-- =============================================================================

CREATE POLICY doses_delete ON dose_occurrences FOR DELETE TO dawaee_app
  USING (app.has_permission(patient_profile_id, 'edit_schedule'));

-- Same gap on the event trail: cascade deletes are fine, but a direct DELETE
-- must never be possible, so this stays revoked rather than getting a policy.
COMMENT ON TABLE dose_events IS
  'Append-only dose history. DELETE is revoked from dawaee_app; rows disappear only when their dose or profile is deleted.';
