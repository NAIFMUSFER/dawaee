-- Schedule editors may not read clinical history. A boolean guard prevents
-- their RLS-filtered view from making a recorded future dose look untouched.
-- It exposes no note, measurement, event, actor or stock values.
CREATE OR REPLACE FUNCTION app.dose_has_recorded_history(p_dose uuid)
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, app
AS $$
DECLARE
  caller_role text := COALESCE(NULLIF(current_setting('role', true), 'none'), session_user);
  profile_id uuid;
BEGIN
  SELECT d.patient_profile_id INTO profile_id
    FROM public.dose_occurrences d
    JOIN public.medications m
      ON m.id = d.medication_id AND m.patient_profile_id = d.patient_profile_id
    JOIN public.medication_schedules s
      ON s.id = d.schedule_id AND s.medication_id = d.medication_id
      AND s.patient_profile_id = d.patient_profile_id
   WHERE d.id = p_dose;

  -- Fail closed and give the same result for absent and unauthorized ids.
  IF profile_id IS NULL OR NOT (
    caller_role = 'dawaee_worker' OR
    (caller_role = 'dawaee_app' AND app.has_permission(profile_id, 'edit_schedule'))
  ) THEN
    RETURN true;
  END IF;

  RETURN EXISTS (SELECT 1 FROM public.dose_events WHERE dose_occurrence_id = p_dose)
    OR EXISTS (SELECT 1 FROM public.symptom_notes WHERE dose_occurrence_id = p_dose)
    OR EXISTS (SELECT 1 FROM public.health_measurements WHERE dose_occurrence_id = p_dose)
    OR EXISTS (SELECT 1 FROM public.stock_transactions WHERE dose_occurrence_id = p_dose);
END;
$$;

REVOKE ALL ON FUNCTION app.dose_has_recorded_history(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.dose_has_recorded_history(uuid) TO dawaee_app, dawaee_worker;
SELECT app.ensure_definer_policies();
