-- =============================================================================
-- 0073 — Consent / patient-profile ownership integrity
--
-- `consents.user_id` and `consents.patient_profile_id` are independent foreign
-- keys. The runtime RLS policy proves only that user_id is the signed-in user;
-- it does not prove that a non-null patient_profile_id belongs to that user.
-- The API currently checks ownership before writing a scoped consent, but an
-- application regression or another permitted SQL path must not be able to
-- persist a consent statement against another patient's profile.
--
-- Product ownership treats both owner_user_id and linked_user_id as `owner`.
-- Account-wide consent remains represented by patient_profile_id IS NULL.
-- Existing rows are checked first and the migration fails closed rather than
-- silently rewriting consent history.
-- =============================================================================

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public.consents c
      JOIN public.patient_profiles pp ON pp.id = c.patient_profile_id
     WHERE c.patient_profile_id IS NOT NULL
       AND c.user_id IS DISTINCT FROM pp.owner_user_id
       AND c.user_id IS DISTINCT FROM pp.linked_user_id
  ) THEN
    RAISE EXCEPTION
      'existing consent/profile ownership mismatch; reconcile data before migration';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION app.assert_consent_profile_owner()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app
AS $$
DECLARE
  profile_owner uuid;
  profile_linked uuid;
BEGIN
  -- NULL is the established account-wide consent scope.
  IF NEW.patient_profile_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT pp.owner_user_id, pp.linked_user_id
    INTO profile_owner, profile_linked
    FROM public.patient_profiles pp
   WHERE pp.id = NEW.patient_profile_id;

  -- Unknown profile ids remain the responsibility of the existing foreign key.
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  IF NEW.user_id IS DISTINCT FROM profile_owner
     AND NEW.user_id IS DISTINCT FROM profile_linked THEN
    RAISE EXCEPTION
      'consent user does not own patient profile'
      USING ERRCODE = '23514', CONSTRAINT = 'consent_profile_owner_match';
  END IF;

  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION app.assert_consent_profile_owner() FROM PUBLIC;

DROP TRIGGER IF EXISTS consent_profile_owner_guard ON public.consents;
CREATE TRIGGER consent_profile_owner_guard
BEFORE INSERT OR UPDATE OF user_id, patient_profile_id
ON public.consents
FOR EACH ROW EXECUTE FUNCTION app.assert_consent_profile_owner();
