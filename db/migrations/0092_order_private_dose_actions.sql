-- Confirming a dose does not grant access to its event history. Resolve only
-- replay/order eligibility inside the owner context, never event details.
CREATE OR REPLACE FUNCTION app.dose_action_order(
  p_dose uuid, p_client_event text, p_action_at timestamptz DEFAULT NULL
)
RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, app
AS $$
DECLARE
  caller_role text := COALESCE(NULLIF(current_setting('role', true), 'none'), session_user);
  actor_id uuid := app.current_user_id();
  profile_id uuid;
BEGIN
  IF caller_role <> 'dawaee_app' OR actor_id IS NULL
    OR p_client_event IS NULL OR length(p_client_event) NOT BETWEEN 8 AND 128 THEN
    RETURN 'denied';
  END IF;

  SELECT d.patient_profile_id INTO profile_id
    FROM public.dose_occurrences d
    JOIN public.medications m
      ON m.id = d.medication_id AND m.patient_profile_id = d.patient_profile_id
    JOIN public.medication_schedules s
      ON s.id = d.schedule_id AND s.medication_id = d.medication_id
      AND s.patient_profile_id = d.patient_profile_id
   WHERE d.id = p_dose;
  IF profile_id IS NULL OR NOT app.has_permission(profile_id, 'confirm_dose') THEN
    RETURN 'denied';
  END IF;

  IF EXISTS (SELECT 1 FROM public.dose_events e
    WHERE e.dose_occurrence_id = p_dose AND e.patient_profile_id = profile_id
      AND e.client_event_id = p_client_event AND e.actor_user_id = actor_id) THEN
    RETURN 'replay';
  END IF;
  -- Another actor's id is not this caller's intent and must never be reused.
  IF EXISTS (SELECT 1 FROM public.dose_events e
    WHERE e.dose_occurrence_id = p_dose AND e.patient_profile_id = profile_id
      AND e.client_event_id = p_client_event) THEN
    RETURN 'denied';
  END IF;
  IF p_action_at IS NOT NULL AND EXISTS (SELECT 1 FROM public.dose_events e
    WHERE e.dose_occurrence_id = p_dose AND e.patient_profile_id = profile_id
      AND e.type IN ('taken','skipped','snoozed','undone') AND e.at > p_action_at) THEN
    RETURN 'stale';
  END IF;
  RETURN 'new';
END;
$$;

REVOKE ALL ON FUNCTION app.dose_action_order(uuid, text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.dose_action_order(uuid, text, timestamptz) TO dawaee_app;
SELECT app.ensure_definer_policies();
