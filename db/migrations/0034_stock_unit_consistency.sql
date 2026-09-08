-- =============================================================================
-- Dawaee — 0034: stock quantities must use the same unit as dose consumption
-- =============================================================================
--
-- A stock balance is just a number plus a unit. Dose confirmation subtracts the
-- scheduled dose quantity from that balance; forecasting sums the same dose
-- quantities. If a schedule says `500 mg` while stock says `30 tablets`, the
-- arithmetic is dimensionally invalid: confirming one dose would subtract 500
-- from a count of tablets and clamp the box to zero.
--
-- Production was checked before this migration was authored: there are no
-- schedule/stock or refill/stock unit mismatches today. This migration therefore
-- closes the write path without rewriting any patient data.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM medication_schedules s
      JOIN medication_stock st ON st.medication_id = s.medication_id
     WHERE s.dose_unit <> st.unit
  ) THEN
    RAISE EXCEPTION 'existing medication schedule/stock unit mismatch; reconcile data before migration';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM refill_events r
      JOIN medication_stock st ON st.medication_id = r.medication_id
     WHERE r.unit <> st.unit
  ) THEN
    RAISE EXCEPTION 'existing refill/stock unit mismatch; reconcile data before migration';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION app.assert_stock_unit_consistency() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app
AS $$
DECLARE
  expected_unit dose_unit;
BEGIN
  IF TG_TABLE_NAME = 'medication_schedules' THEN
    SELECT st.unit INTO expected_unit
      FROM medication_stock st
     WHERE st.medication_id = NEW.medication_id;

    IF expected_unit IS NOT NULL AND NEW.dose_unit <> expected_unit THEN
      RAISE EXCEPTION 'schedule dose unit % does not match stock unit %', NEW.dose_unit, expected_unit
        USING ERRCODE = '23514', CONSTRAINT = 'medication_stock_unit_consistency';
    END IF;

  ELSIF TG_TABLE_NAME = 'medication_stock' THEN
    IF EXISTS (
      SELECT 1
        FROM medication_schedules s
       WHERE s.medication_id = NEW.medication_id
         AND s.dose_unit <> NEW.unit
    ) THEN
      RAISE EXCEPTION 'stock unit % does not match an existing schedule dose unit', NEW.unit
        USING ERRCODE = '23514', CONSTRAINT = 'medication_stock_unit_consistency';
    END IF;

  ELSIF TG_TABLE_NAME = 'refill_events' THEN
    SELECT st.unit INTO expected_unit
      FROM medication_stock st
     WHERE st.medication_id = NEW.medication_id;

    IF expected_unit IS NOT NULL AND NEW.unit <> expected_unit THEN
      RAISE EXCEPTION 'refill unit % does not match stock unit %', NEW.unit, expected_unit
        USING ERRCODE = '23514', CONSTRAINT = 'medication_stock_unit_consistency';
    END IF;
  END IF;

  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION app.assert_stock_unit_consistency() FROM PUBLIC;

DROP TRIGGER IF EXISTS medication_schedule_stock_unit_guard ON medication_schedules;
CREATE TRIGGER medication_schedule_stock_unit_guard
  BEFORE INSERT OR UPDATE OF medication_id, dose_unit ON medication_schedules
  FOR EACH ROW EXECUTE FUNCTION app.assert_stock_unit_consistency();

DROP TRIGGER IF EXISTS medication_stock_schedule_unit_guard ON medication_stock;
CREATE TRIGGER medication_stock_schedule_unit_guard
  BEFORE INSERT OR UPDATE OF medication_id, unit ON medication_stock
  FOR EACH ROW EXECUTE FUNCTION app.assert_stock_unit_consistency();

DROP TRIGGER IF EXISTS refill_stock_unit_guard ON refill_events;
CREATE TRIGGER refill_stock_unit_guard
  BEFORE INSERT OR UPDATE OF medication_id, unit ON refill_events
  FOR EACH ROW EXECUTE FUNCTION app.assert_stock_unit_consistency();
