-- 0074 — Runtime patient-profile identity reassignment boundary.
--
-- Evidence: profiles_insert checks only owner_user_id; profiles_update checks
-- app.owns_profile(id), whose lookup cannot establish which identity edges the
-- NEW row is granting. linked_user_id is itself an owner-level access edge.
-- A metadata edit must not silently grant access to a different account.
--
-- Registration and verified account erasure already use SECURITY DEFINER
-- functions. Keep those trusted paths (including FK SET NULL) unchanged, and
-- keep existing linked profiles readable/editable. No historical identities
-- are rewritten or removed by this migration.
CREATE OR REPLACE FUNCTION app.guard_patient_profile_identity_reassignment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, app
AS $$
BEGIN
  -- This guard constrains the ordinary API role, not the role executing the
  -- existing definer functions. Do not switch this to session_user: an API
  -- connection also invokes the trusted registration/erasure functions.
  IF current_user = 'dawaee_app' THEN
    IF TG_OP = 'INSERT' THEN
      -- The ordinary owner may create an unlinked dependent or a self-linked
      -- profile. Granting another account an ownership edge needs a separately
      -- authorized linkage flow, not a direct runtime INSERT.
      IF NEW.linked_user_id IS NOT NULL
         AND NEW.linked_user_id IS DISTINCT FROM NEW.owner_user_id THEN
        RAISE EXCEPTION 'patient profile identity reassignment is not permitted'
          USING ERRCODE = '42501', CONSTRAINT = 'patient_profile_identity_reassignment';
      END IF;
    ELSIF NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id
       OR NEW.linked_user_id IS DISTINCT FROM OLD.linked_user_id THEN
      RAISE EXCEPTION 'patient profile identity reassignment is not permitted'
        USING ERRCODE = '42501', CONSTRAINT = 'patient_profile_identity_reassignment';
    END IF;
  END IF;

  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION app.guard_patient_profile_identity_reassignment() FROM PUBLIC;

CREATE TRIGGER patient_profile_identity_reassignment_guard
BEFORE INSERT OR UPDATE OF owner_user_id, linked_user_id
ON public.patient_profiles
FOR EACH ROW EXECUTE FUNCTION app.guard_patient_profile_identity_reassignment();
