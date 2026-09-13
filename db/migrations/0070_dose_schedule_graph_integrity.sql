-- =============================================================================
-- 0070 — Dose occurrence / schedule graph integrity
--
-- dose_occurrences stores schedule_id, medication_id and patient_profile_id as
-- independent foreign keys. The original profile guard proves only that the
-- medication belongs to patient_profile_id; it does not prove that schedule_id
-- belongs to that same medication/profile. The INSERT RLS policy likewise keys
-- only on patient_profile_id. A runtime write can therefore combine an allowed
-- medication/profile with an unrelated schedule id, including a schedule from
-- another patient if that stable id is known.
--
-- The reverse edge can drift too: medication_schedules can currently be moved
-- to a different medication/profile after dose rows already reference it. The
-- existing child triggers are not re-run when the parent schedule changes.
--
-- There is no supported product operation that reparents a schedule. Enforce
-- both directions at the database boundary and fail closed on pre-existing
-- inconsistencies instead of silently rewriting clinical history.
-- =============================================================================

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public.dose_occurrences d
      JOIN public.medication_schedules s ON s.id = d.schedule_id
     WHERE d.medication_id <> s.medication_id
        OR d.patient_profile_id <> s.patient_profile_id
  ) THEN
    RAISE EXCEPTION
      'existing dose/schedule medication-profile mismatch; reconcile data before migration';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION app.assert_dose_schedule_graph_match()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app
AS $$
DECLARE
  schedule_medication uuid;
  schedule_profile uuid;
BEGIN
  SELECT s.medication_id, s.patient_profile_id
    INTO schedule_medication, schedule_profile
    FROM public.medication_schedules s
   WHERE s.id = NEW.schedule_id;

  -- Preserve the foreign key's normal error for an unknown schedule. This
  -- trigger owns only the cross-edge invariant.
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  IF schedule_medication <> NEW.medication_id
     OR schedule_profile <> NEW.patient_profile_id THEN
    RAISE EXCEPTION
      'dose occurrence does not belong to schedule medication/profile'
      USING ERRCODE = '23514', CONSTRAINT = 'dose_schedule_graph_match';
  END IF;

  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION app.assert_dose_schedule_graph_match() FROM PUBLIC;

-- Prefix with zz_ so the original medication/profile guard runs first. That
-- preserves its established error semantics while this trigger adds the
-- independent schedule edge check afterwards.
DROP TRIGGER IF EXISTS zz_dose_schedule_graph_guard
  ON public.dose_occurrences;
CREATE TRIGGER zz_dose_schedule_graph_guard
BEFORE INSERT OR UPDATE OF schedule_id, medication_id, patient_profile_id
ON public.dose_occurrences
FOR EACH ROW EXECUTE FUNCTION app.assert_dose_schedule_graph_match();

CREATE OR REPLACE FUNCTION app.assert_schedule_parent_immutable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app
AS $$
BEGIN
  IF NEW.medication_id IS DISTINCT FROM OLD.medication_id
     OR NEW.patient_profile_id IS DISTINCT FROM OLD.patient_profile_id THEN
    RAISE EXCEPTION
      'schedule medication/profile cannot be changed after creation'
      USING ERRCODE = '23514', CONSTRAINT = 'schedule_parent_immutable';
  END IF;

  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION app.assert_schedule_parent_immutable() FROM PUBLIC;

DROP TRIGGER IF EXISTS schedule_parent_immutable_guard
  ON public.medication_schedules;
CREATE TRIGGER schedule_parent_immutable_guard
-- AFTER is deliberate: RLS and the existing schedule profile guard retain their
-- current authorization/error semantics; raising here still rolls the UPDATE
-- back atomically for privileged or same-owner cross-profile writes.
AFTER UPDATE OF medication_id, patient_profile_id
ON public.medication_schedules
FOR EACH ROW EXECUTE FUNCTION app.assert_schedule_parent_immutable();
