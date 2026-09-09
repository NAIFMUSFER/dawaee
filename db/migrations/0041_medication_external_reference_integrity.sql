-- =============================================================================
-- 0041 — Medication external-reference integrity
--
-- `medications.prescription_id` is a normal FK and `image_key` is an opaque
-- string. A foreign key proves that a prescription EXISTS; it does not prove it
-- belongs to the same patient. Likewise an image key could point at an object
-- owned by another profile if the caller learned the key. RLS on the referenced
-- table is not consulted by a FK check.
--
-- The API already carries patient_profile_id on all three rows. Make that
-- provenance invariant structural so an application regression cannot create a
-- cross-patient graph. Existing production was measured before this migration:
-- zero prescription/profile mismatches, zero image/profile mismatches, and zero
-- medication image keys missing metadata, so the guard narrows future writes
-- without rewriting current data.
-- =============================================================================

CREATE OR REPLACE FUNCTION app.assert_medication_external_references()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app
AS $$
DECLARE
  rx_profile uuid;
  object_profile uuid;
  object_purpose text;
BEGIN
  IF NEW.prescription_id IS NOT NULL THEN
    SELECT patient_profile_id INTO rx_profile
      FROM public.prescriptions
     WHERE id = NEW.prescription_id;

    IF rx_profile IS NULL OR rx_profile <> NEW.patient_profile_id THEN
      RAISE EXCEPTION 'prescription does not belong to medication patient profile'
        USING ERRCODE = '23514', CONSTRAINT = 'medication_prescription_profile_match';
    END IF;
  END IF;

  IF NEW.image_key IS NOT NULL THEN
    SELECT patient_profile_id, purpose
      INTO object_profile, object_purpose
      FROM public.stored_objects
     WHERE object_key = NEW.image_key;

    IF object_profile IS NULL
       OR object_profile <> NEW.patient_profile_id
       OR object_purpose <> 'medication_image' THEN
      RAISE EXCEPTION 'image does not belong to medication patient profile or has wrong purpose'
        USING ERRCODE = '23514', CONSTRAINT = 'medication_image_profile_match';
    END IF;
  END IF;

  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION app.assert_medication_external_references() FROM PUBLIC;

DROP TRIGGER IF EXISTS medication_external_reference_guard ON public.medications;
CREATE TRIGGER medication_external_reference_guard
BEFORE INSERT OR UPDATE OF patient_profile_id, prescription_id, image_key
ON public.medications
FOR EACH ROW EXECUTE FUNCTION app.assert_medication_external_references();
