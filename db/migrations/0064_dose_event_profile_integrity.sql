-- =============================================================================
-- 0064 — Dose-event reference/profile integrity
--
-- dose_events duplicates patient_profile_id beside dose_occurrence_id. RLS
-- authorizes INSERT by the claimed patient_profile_id, while the original
-- foreign keys validate those columns independently. Keep the append-only
-- audit trail structurally bound to the patient that owns the referenced dose.
-- =============================================================================

CREATE OR REPLACE FUNCTION app.assert_dose_event_profile()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app
AS $$
DECLARE
  dose_profile uuid;
BEGIN
  SELECT d.patient_profile_id
    INTO dose_profile
    FROM public.dose_occurrences d
   WHERE d.id = NEW.dose_occurrence_id;

  -- Preserve the existing FK's missing-reference behavior. This trigger owns
  -- only the same-profile graph invariant.
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  IF dose_profile <> NEW.patient_profile_id THEN
    RAISE EXCEPTION 'dose event does not belong to patient profile'
      USING ERRCODE = '23514', CONSTRAINT = 'dose_event_profile_match';
  END IF;

  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION app.assert_dose_event_profile() FROM PUBLIC;

DROP TRIGGER IF EXISTS dose_event_profile_guard ON public.dose_events;
CREATE TRIGGER dose_event_profile_guard
BEFORE INSERT OR UPDATE OF patient_profile_id, dose_occurrence_id
ON public.dose_events
FOR EACH ROW EXECUTE FUNCTION app.assert_dose_event_profile();
