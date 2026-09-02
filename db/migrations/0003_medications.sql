-- =============================================================================
-- Dawaee — 0003: medications, stock, refills, prescriptions, schedules
-- =============================================================================

CREATE TABLE prescriptions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_profile_id uuid NOT NULL REFERENCES patient_profiles(id) ON DELETE CASCADE,
  reference          text,
  prescriber_name    text,
  facility           text,
  issued_date        date,
  expiry_date        date,
  image_key          text,
  ocr_raw            jsonb,
  ocr_status         ocr_status NOT NULL DEFAULT 'none',
  created_by         uuid NOT NULL REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT prescriptions_dates CHECK (expiry_date IS NULL OR issued_date IS NULL OR expiry_date >= issued_date)
);
CREATE INDEX prescriptions_profile_idx ON prescriptions (patient_profile_id, created_at DESC);
CREATE INDEX prescriptions_renewal_idx ON prescriptions (expiry_date) WHERE expiry_date IS NOT NULL;
CREATE TRIGGER prescriptions_touch BEFORE UPDATE ON prescriptions
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

CREATE TABLE medications (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_profile_id  uuid NOT NULL REFERENCES patient_profiles(id) ON DELETE CASCADE,
  name                text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 160),
  brand_name          text,
  generic_name        text,
  form                medication_form NOT NULL,
  strength_value      numeric(12,4) CHECK (strength_value IS NULL OR strength_value > 0),
  strength_unit       strength_unit,
  manufacturer        text,
  barcode             text,
  image_key           text,
  instructions        text,
  doctor_instructions text,
  food_instruction    food_instruction NOT NULL DEFAULT 'no_preference',
  notes               text,
  status              medication_status NOT NULL DEFAULT 'active',
  start_date          date NOT NULL,
  end_date            date,
  expiry_date         date,
  prescription_id     uuid REFERENCES prescriptions(id) ON DELETE SET NULL,
  -- Provenance: OCR output is never trusted until a human confirms it.
  identity_source     identity_source NOT NULL DEFAULT 'user',
  created_by          uuid NOT NULL REFERENCES users(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  archived_at         timestamptz,
  CONSTRAINT medications_date_order CHECK (end_date IS NULL OR end_date >= start_date),
  CONSTRAINT medications_strength_pair CHECK (
    (strength_value IS NULL AND strength_unit IS NULL) OR
    (strength_value IS NOT NULL AND strength_unit IS NOT NULL))
);
CREATE INDEX medications_profile_idx ON medications (patient_profile_id, status);
CREATE INDEX medications_active_idx ON medications (patient_profile_id) WHERE status = 'active';
CREATE INDEX medications_name_trgm_idx ON medications USING gin (name gin_trgm_ops);
CREATE INDEX medications_barcode_idx ON medications (patient_profile_id, barcode) WHERE barcode IS NOT NULL;
CREATE INDEX medications_expiry_idx ON medications (expiry_date)
  WHERE expiry_date IS NOT NULL AND status IN ('active','paused');
CREATE TRIGGER medications_touch BEFORE UPDATE ON medications
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

CREATE TABLE medication_stock (
  medication_id            uuid PRIMARY KEY REFERENCES medications(id) ON DELETE CASCADE,
  patient_profile_id       uuid NOT NULL REFERENCES patient_profiles(id) ON DELETE CASCADE,
  unit                     dose_unit NOT NULL,
  initial_quantity         numeric(12,4) CHECK (initial_quantity IS NULL OR initial_quantity >= 0),
  remaining_quantity       numeric(12,4) CHECK (remaining_quantity IS NULL OR remaining_quantity >= 0),
  low_stock_threshold_days smallint CHECK (low_stock_threshold_days IS NULL OR low_stock_threshold_days BETWEEN 1 AND 60),
  tracking_enabled         boolean NOT NULL DEFAULT true,
  last_refill_at           timestamptz,
  -- Suppresses repeat low-stock nagging; cleared on refill.
  low_stock_notified_at    timestamptz,
  updated_at               timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX medication_stock_profile_idx ON medication_stock (patient_profile_id);
CREATE TRIGGER medication_stock_touch BEFORE UPDATE ON medication_stock
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- Every quantity movement, so a disputed balance can always be reconstructed.
CREATE TABLE stock_transactions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  medication_id       uuid NOT NULL REFERENCES medications(id) ON DELETE CASCADE,
  patient_profile_id  uuid NOT NULL REFERENCES patient_profiles(id) ON DELETE CASCADE,
  delta               numeric(12,4) NOT NULL,
  reason              stock_reason NOT NULL,
  dose_occurrence_id  uuid,
  balance_after       numeric(12,4),
  note                text,
  actor_user_id       uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX stock_tx_med_idx ON stock_transactions (medication_id, created_at DESC);
-- One consumption row per dose: replaying an offline confirmation cannot
-- decrement the same box twice.
CREATE UNIQUE INDEX stock_tx_dose_idx ON stock_transactions (dose_occurrence_id, reason)
  WHERE dose_occurrence_id IS NOT NULL;

CREATE TABLE refill_events (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  medication_id      uuid NOT NULL REFERENCES medications(id) ON DELETE CASCADE,
  patient_profile_id uuid NOT NULL REFERENCES patient_profiles(id) ON DELETE CASCADE,
  quantity_added     numeric(12,4) NOT NULL CHECK (quantity_added > 0),
  unit               dose_unit NOT NULL,
  pharmacy           text,
  cost               numeric(12,2) CHECK (cost IS NULL OR cost >= 0),
  note               text,
  refilled_at        timestamptz NOT NULL DEFAULT now(),
  created_by         uuid NOT NULL REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX refill_events_med_idx ON refill_events (medication_id, refilled_at DESC);

-- ------------------------------------------------------------- schedules

CREATE TABLE medication_schedules (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  medication_id        uuid NOT NULL REFERENCES medications(id) ON DELETE CASCADE,
  patient_profile_id   uuid NOT NULL REFERENCES patient_profiles(id) ON DELETE CASCADE,
  rule_kind            schedule_rule_kind NOT NULL,
  rule                 jsonb NOT NULL,
  dose_quantity        numeric(10,4) NOT NULL CHECK (dose_quantity > 0),
  dose_unit            dose_unit NOT NULL,
  timezone             text NOT NULL DEFAULT 'Asia/Riyadh',
  start_date           date NOT NULL,
  end_date             date,
  missed_after_minutes smallint NOT NULL DEFAULT 120 CHECK (missed_after_minutes BETWEEN 5 AND 1440),
  late_after_minutes   smallint NOT NULL DEFAULT 15 CHECK (late_after_minutes BETWEEN 1 AND 720),
  active               boolean NOT NULL DEFAULT true,
  -- Horizon already materialized into dose_occurrences.
  materialized_through timestamptz,
  created_by           uuid NOT NULL REFERENCES users(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT schedules_date_order CHECK (end_date IS NULL OR end_date >= start_date),
  CONSTRAINT schedules_threshold_order CHECK (missed_after_minutes > late_after_minutes),
  CONSTRAINT schedules_rule_kind_matches CHECK (rule->>'kind' = rule_kind::text)
);
CREATE INDEX schedules_medication_idx ON medication_schedules (medication_id);
CREATE INDEX schedules_profile_active_idx ON medication_schedules (patient_profile_id) WHERE active;
-- Drives the materializer: which schedules need more occurrences generated.
CREATE INDEX schedules_materialize_idx ON medication_schedules (materialized_through)
  WHERE active AND rule_kind <> 'as_needed';
CREATE TRIGGER schedules_touch BEFORE UPDATE ON medication_schedules
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- The profile on child rows must match the parent medication's profile. This is
-- the structural guarantee that medical data cannot leak between profiles.
CREATE OR REPLACE FUNCTION app.assert_profile_matches_medication() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE med_profile uuid;
BEGIN
  SELECT patient_profile_id INTO med_profile FROM medications WHERE id = NEW.medication_id;
  IF med_profile IS NULL THEN
    RAISE EXCEPTION 'medication % not found', NEW.medication_id;
  END IF;
  IF NEW.patient_profile_id <> med_profile THEN
    RAISE EXCEPTION 'profile mismatch: row claims % but medication belongs to %',
      NEW.patient_profile_id, med_profile;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER stock_profile_guard BEFORE INSERT OR UPDATE ON medication_stock
  FOR EACH ROW EXECUTE FUNCTION app.assert_profile_matches_medication();
CREATE TRIGGER stock_tx_profile_guard BEFORE INSERT OR UPDATE ON stock_transactions
  FOR EACH ROW EXECUTE FUNCTION app.assert_profile_matches_medication();
CREATE TRIGGER refill_profile_guard BEFORE INSERT OR UPDATE ON refill_events
  FOR EACH ROW EXECUTE FUNCTION app.assert_profile_matches_medication();
CREATE TRIGGER schedules_profile_guard BEFORE INSERT OR UPDATE ON medication_schedules
  FOR EACH ROW EXECUTE FUNCTION app.assert_profile_matches_medication();
