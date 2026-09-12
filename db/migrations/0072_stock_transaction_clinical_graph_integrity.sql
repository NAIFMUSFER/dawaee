-- =============================================================================
-- 0072 — Stock transaction clinical graph integrity
--
-- stock_transactions stores medication_id and patient_profile_id beside optional
-- dose_occurrence_id and dose_event_id. The existing stock profile guard and RLS
-- validate the claimed medication/profile, but the two optional references are
-- independent foreign keys. An otherwise-authorized write can therefore attach
-- Alice's stock movement to Bob's dose or append-only event. That corrupts the
-- clinical ledger and can make later undo logic consume the wrong movement.
--
-- Bind the complete graph at the database boundary. Existing rows are checked
-- first; any mismatch aborts the migration instead of rewriting history.
-- =============================================================================

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public.stock_transactions st
      JOIN public.dose_occurrences d ON d.id = st.dose_occurrence_id
     WHERE st.dose_occurrence_id IS NOT NULL
       AND (st.medication_id <> d.medication_id
            OR st.patient_profile_id <> d.patient_profile_id)
  ) THEN
    RAISE EXCEPTION
      'existing stock transaction/dose graph mismatch; reconcile data before migration';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.stock_transactions st
      JOIN public.dose_events e ON e.id = st.dose_event_id
     WHERE st.dose_event_id IS NOT NULL
       AND (st.dose_occurrence_id IS DISTINCT FROM e.dose_occurrence_id
            OR st.patient_profile_id <> e.patient_profile_id)
  ) THEN
    RAISE EXCEPTION
      'existing stock transaction/event graph mismatch; reconcile data before migration';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION app.assert_stock_transaction_clinical_graph()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app
AS $$
DECLARE
  dose_medication uuid;
  dose_profile uuid;
  event_dose uuid;
  event_profile uuid;
BEGIN
  IF NEW.dose_occurrence_id IS NOT NULL THEN
    SELECT d.medication_id, d.patient_profile_id
      INTO dose_medication, dose_profile
      FROM public.dose_occurrences d
     WHERE d.id = NEW.dose_occurrence_id;

    -- Missing references remain the responsibility of the existing foreign key.
    IF FOUND AND (
      dose_medication <> NEW.medication_id
      OR dose_profile <> NEW.patient_profile_id
    ) THEN
      RAISE EXCEPTION
        'stock transaction dose does not belong to medication/profile'
        USING ERRCODE = '23514', CONSTRAINT = 'stock_transaction_dose_graph_match';
    END IF;
  END IF;

  IF NEW.dose_event_id IS NOT NULL THEN
    SELECT e.dose_occurrence_id, e.patient_profile_id
      INTO event_dose, event_profile
      FROM public.dose_events e
     WHERE e.id = NEW.dose_event_id;

    IF FOUND AND (
      NEW.dose_occurrence_id IS DISTINCT FROM event_dose
      OR NEW.patient_profile_id <> event_profile
    ) THEN
      RAISE EXCEPTION
        'stock transaction event does not belong to dose/profile'
        USING ERRCODE = '23514', CONSTRAINT = 'stock_transaction_event_graph_match';
    END IF;
  END IF;

  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION app.assert_stock_transaction_clinical_graph() FROM PUBLIC;

DROP TRIGGER IF EXISTS zz_stock_transaction_clinical_graph_guard
  ON public.stock_transactions;
CREATE TRIGGER zz_stock_transaction_clinical_graph_guard
BEFORE INSERT OR UPDATE OF medication_id, patient_profile_id, dose_occurrence_id, dose_event_id
ON public.stock_transactions
FOR EACH ROW EXECUTE FUNCTION app.assert_stock_transaction_clinical_graph();
