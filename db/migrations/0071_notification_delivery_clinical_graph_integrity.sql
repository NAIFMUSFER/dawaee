-- =============================================================================
-- 0071 — Notification delivery clinical graph integrity
--
-- notification_deliveries stores patient_profile_id, dose_occurrence_id and
-- medication_id as independent foreign keys. The worker is intentionally able
-- to enqueue across every patient, so its INSERT policy cannot provide tenant
-- correlation between those columns. A worker bug could therefore queue Bob's
-- dose/medication data under Alice's patient_profile_id and recipient, and the
-- dispatcher would treat a relationship-less row as an ordinary patient
-- delivery. Bind the clinical edges at the database boundary.
--
-- Existing data is checked first and the migration fails closed rather than
-- silently rewriting durable notification history.
-- =============================================================================

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public.notification_deliveries nd
      JOIN public.dose_occurrences d ON d.id = nd.dose_occurrence_id
     WHERE nd.dose_occurrence_id IS NOT NULL
       AND d.patient_profile_id <> nd.patient_profile_id
  ) THEN
    RAISE EXCEPTION
      'existing notification delivery/dose profile mismatch; reconcile data before migration';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.notification_deliveries nd
      JOIN public.medications m ON m.id = nd.medication_id
     WHERE nd.medication_id IS NOT NULL
       AND m.patient_profile_id <> nd.patient_profile_id
  ) THEN
    RAISE EXCEPTION
      'existing notification delivery/medication profile mismatch; reconcile data before migration';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.notification_deliveries nd
      JOIN public.dose_occurrences d ON d.id = nd.dose_occurrence_id
     WHERE nd.dose_occurrence_id IS NOT NULL
       AND nd.medication_id IS NOT NULL
       AND d.medication_id <> nd.medication_id
  ) THEN
    RAISE EXCEPTION
      'existing notification delivery dose/medication mismatch; reconcile data before migration';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION app.assert_notification_delivery_clinical_graph()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app
AS $$
DECLARE
  dose_profile uuid;
  dose_medication uuid;
  medication_profile uuid;
BEGIN
  IF NEW.dose_occurrence_id IS NOT NULL THEN
    SELECT d.patient_profile_id, d.medication_id
      INTO dose_profile, dose_medication
      FROM public.dose_occurrences d
     WHERE d.id = NEW.dose_occurrence_id;

    -- Unknown ids remain the responsibility of the existing foreign key.
    IF FOUND THEN
      IF dose_profile <> NEW.patient_profile_id THEN
        RAISE EXCEPTION
          'notification delivery dose does not belong to patient profile'
          USING ERRCODE = '23514', CONSTRAINT = 'notification_delivery_dose_profile_match';
      END IF;

      IF NEW.medication_id IS NOT NULL AND dose_medication <> NEW.medication_id THEN
        RAISE EXCEPTION
          'notification delivery medication does not match dose occurrence'
          USING ERRCODE = '23514', CONSTRAINT = 'notification_delivery_dose_medication_match';
      END IF;
    END IF;
  END IF;

  IF NEW.medication_id IS NOT NULL THEN
    SELECT m.patient_profile_id
      INTO medication_profile
      FROM public.medications m
     WHERE m.id = NEW.medication_id;

    IF FOUND AND medication_profile <> NEW.patient_profile_id THEN
      RAISE EXCEPTION
        'notification delivery medication does not belong to patient profile'
        USING ERRCODE = '23514', CONSTRAINT = 'notification_delivery_medication_profile_match';
    END IF;
  END IF;

  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION app.assert_notification_delivery_clinical_graph() FROM PUBLIC;

DROP TRIGGER IF EXISTS notification_delivery_clinical_graph_guard
  ON public.notification_deliveries;
CREATE TRIGGER notification_delivery_clinical_graph_guard
BEFORE INSERT OR UPDATE OF patient_profile_id, dose_occurrence_id, medication_id
ON public.notification_deliveries
FOR EACH ROW EXECUTE FUNCTION app.assert_notification_delivery_clinical_graph();
