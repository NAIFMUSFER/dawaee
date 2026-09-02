-- =============================================================================
-- Dawaee — 0013: let "view adherence" actually work on its own
--
-- A caregiver granted only `view_adherence` could read dose rows but not the
-- schedules they join to, so the adherence query returned nothing at all — the
-- narrowest, most privacy-preserving grant in the product was the one that did
-- not work. Caught by the integration test asserting a son with adherence-only
-- access sees his father's numbers.
--
-- Schedules carry timing thresholds, not medical identity, so reading them
-- under `view_adherence` discloses nothing the adherence figure does not
-- already imply. Medication NAMES stay behind `view_medications`, and the API
-- omits the per-medication breakdown for callers without it.
-- =============================================================================

DROP POLICY IF EXISTS sched_read ON medication_schedules;
CREATE POLICY sched_read ON medication_schedules FOR SELECT TO dawaee_app
  USING (
    app.has_permission(patient_profile_id, 'view_schedule')
    OR app.has_permission(patient_profile_id, 'view_adherence')
    OR app.has_permission(patient_profile_id, 'view_history')
  );
