-- =============================================================================
-- 0068 — Caregiver notification-rule profile integrity
--
-- caregiver_notification_rules redundantly stores both relationship_id and
-- patient_profile_id. The API currently copies the profile id from the selected
-- relationship, but 0008's RLS threat model explicitly assumes an application
-- bug can issue a query with the wrong profile id and requires the database to
-- refuse it. RLS alone cannot do that when one account owns both profiles: the
-- wrong profile is still owner-authorized.
--
-- The worker selects notification rules by patient_profile_id and then matches
-- them to caregiver relationships. A cross-profile row therefore silently
-- detaches the rule from the relationship's real patient and can suppress
-- caregiver notifications. Make the relationship/profile graph structural.
-- =============================================================================

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public.caregiver_notification_rules r
      JOIN public.caregiver_relationships cr ON cr.id = r.relationship_id
     WHERE r.patient_profile_id <> cr.patient_profile_id
  ) THEN
    RAISE EXCEPTION
      'existing caregiver notification rule/profile mismatch; reconcile data before migration';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION app.assert_caregiver_rule_profile_match()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app
AS $$
DECLARE
  relationship_profile uuid;
BEGIN
  SELECT cr.patient_profile_id
    INTO relationship_profile
    FROM public.caregiver_relationships cr
   WHERE cr.id = NEW.relationship_id;

  -- Preserve the foreign key's normal behaviour when the relationship id does
  -- not exist. This trigger owns only the cross-profile invariant.
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  IF relationship_profile <> NEW.patient_profile_id THEN
    RAISE EXCEPTION
      'caregiver notification rule does not belong to relationship patient profile'
      USING ERRCODE = '23514', CONSTRAINT = 'caregiver_rule_profile_match';
  END IF;

  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION app.assert_caregiver_rule_profile_match() FROM PUBLIC;

DROP TRIGGER IF EXISTS caregiver_rule_profile_guard
  ON public.caregiver_notification_rules;
CREATE TRIGGER caregiver_rule_profile_guard
BEFORE INSERT OR UPDATE OF relationship_id, patient_profile_id
ON public.caregiver_notification_rules
FOR EACH ROW EXECUTE FUNCTION app.assert_caregiver_rule_profile_match();
