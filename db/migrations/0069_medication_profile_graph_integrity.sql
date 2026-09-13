-- =============================================================================
-- 0069 — Medication patient-profile graph integrity
--
-- Child tables such as schedules and stock records already validate that their
-- medication belongs to the same patient profile when those child rows are
-- written. That protection can be invalidated later if the parent medication is
-- moved to another patient profile, because PostgreSQL does not re-run child
-- triggers when the parent row changes.
--
-- escalation_policies also stores patient_profile_id and medication_id as
-- independent foreign keys. RLS only establishes that the caller may access a
-- profile; for an owner with multiple profiles it does not establish that the
-- selected medication belongs to that same profile.
--
-- Make both invariants structural at the database boundary. There is no
-- supported product flow for transferring a medication between patient
-- profiles; archive/recreate is the safe operation because medication history,
-- schedules, stock and dose records are profile-scoped.
-- =============================================================================

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public.escalation_policies ep
      JOIN public.medications m ON m.id = ep.medication_id
     WHERE ep.medication_id IS NOT NULL
       AND ep.patient_profile_id <> m.patient_profile_id
  ) THEN
    RAISE EXCEPTION
      'existing escalation policy/medication profile mismatch; reconcile data before migration';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION app.assert_medication_patient_profile_immutable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app
AS $$
BEGIN
  IF NEW.patient_profile_id IS DISTINCT FROM OLD.patient_profile_id THEN
    RAISE EXCEPTION
      'medication patient profile cannot be changed after creation'
      USING ERRCODE = '23514', CONSTRAINT = 'medication_patient_profile_immutable';
  END IF;

  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION app.assert_medication_patient_profile_immutable() FROM PUBLIC;

DROP TRIGGER IF EXISTS medication_patient_profile_immutable_guard
  ON public.medications;
CREATE TRIGGER medication_patient_profile_immutable_guard
-- AFTER is deliberate. For dawaee_app, PostgreSQL must evaluate the existing
-- RLS WITH CHECK boundary first, so a cross-profile re-parent attempt remains
-- an authorization denial (42501). The AFTER trigger is the independent graph-
-- integrity backstop for privileged/owner writes that can bypass RLS; raising
-- here still aborts and rolls back the UPDATE atomically.
AFTER UPDATE OF patient_profile_id
ON public.medications
FOR EACH ROW EXECUTE FUNCTION app.assert_medication_patient_profile_immutable();

CREATE OR REPLACE FUNCTION app.assert_escalation_policy_medication_profile_match()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app
AS $$
DECLARE
  medication_profile uuid;
BEGIN
  -- A NULL medication_id is a profile-wide policy and has no medication edge to
  -- validate. Preserve that existing product behaviour.
  IF NEW.medication_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT m.patient_profile_id
    INTO medication_profile
    FROM public.medications m
   WHERE m.id = NEW.medication_id;

  -- Leave unknown medication ids to the existing foreign key. This trigger owns
  -- only the cross-profile invariant.
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  IF medication_profile <> NEW.patient_profile_id THEN
    RAISE EXCEPTION
      'escalation policy medication does not belong to patient profile'
      USING ERRCODE = '23514', CONSTRAINT = 'escalation_policy_medication_profile_match';
  END IF;

  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION app.assert_escalation_policy_medication_profile_match() FROM PUBLIC;

DROP TRIGGER IF EXISTS escalation_policy_medication_profile_guard
  ON public.escalation_policies;
CREATE TRIGGER escalation_policy_medication_profile_guard
BEFORE INSERT OR UPDATE OF patient_profile_id, medication_id
ON public.escalation_policies
FOR EACH ROW EXECUTE FUNCTION app.assert_escalation_policy_medication_profile_match();
