-- =============================================================================
-- 0062 — Note/measurement dose-reference profile integrity
--
-- `symptom_notes` and `health_measurements` carry both patient_profile_id and an
-- optional dose_occurrence_id. The API currently verifies that an attached dose
-- belongs to the same profile before inserting, but the database itself only
-- had a one-column FK to dose_occurrences(id). A future handler regression (or
-- any other dawaee_app query) could therefore create a cross-patient graph.
--
-- 0008 states the RLS threat model explicitly: the database must still refuse a
-- bad query after an application-layer authorization bug. Keep the same rule
-- for these health-history references. This migration does not rewrite or
-- validate historical rows; it narrows future INSERT/UPDATE writes only.
-- =============================================================================

CREATE OR REPLACE FUNCTION app.assert_health_history_dose_profile()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app
AS $$
DECLARE
  dose_profile uuid;
  guard_name text;
BEGIN
  IF NEW.dose_occurrence_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT d.patient_profile_id
    INTO dose_profile
    FROM public.dose_occurrences d
   WHERE d.id = NEW.dose_occurrence_id;

  -- Preserve the existing FK's 23503 behaviour for an id that does not exist.
  -- This guard owns only the cross-profile invariant.
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  IF dose_profile <> NEW.patient_profile_id THEN
    guard_name := CASE TG_TABLE_NAME
      WHEN 'symptom_notes' THEN 'symptom_note_dose_profile_match'
      WHEN 'health_measurements' THEN 'measurement_dose_profile_match'
      ELSE 'health_history_dose_profile_match'
    END;

    RAISE EXCEPTION 'dose occurrence does not belong to health-history patient profile'
      USING ERRCODE = '23514', CONSTRAINT = guard_name;
  END IF;

  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION app.assert_health_history_dose_profile() FROM PUBLIC;

DROP TRIGGER IF EXISTS symptom_note_dose_profile_guard ON public.symptom_notes;
CREATE TRIGGER symptom_note_dose_profile_guard
BEFORE INSERT OR UPDATE OF patient_profile_id, dose_occurrence_id
ON public.symptom_notes
FOR EACH ROW EXECUTE FUNCTION app.assert_health_history_dose_profile();

DROP TRIGGER IF EXISTS measurement_dose_profile_guard ON public.health_measurements;
CREATE TRIGGER measurement_dose_profile_guard
BEFORE INSERT OR UPDATE OF patient_profile_id, dose_occurrence_id
ON public.health_measurements
FOR EACH ROW EXECUTE FUNCTION app.assert_health_history_dose_profile();
