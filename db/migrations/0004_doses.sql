-- =============================================================================
-- Dawaee — 0004: dose occurrences, events, notes, measurements
-- =============================================================================

CREATE TABLE dose_occurrences (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id          uuid NOT NULL REFERENCES medication_schedules(id) ON DELETE CASCADE,
  medication_id        uuid NOT NULL REFERENCES medications(id) ON DELETE CASCADE,
  patient_profile_id   uuid NOT NULL REFERENCES patient_profiles(id) ON DELETE CASCADE,

  -- The single authoritative instant. Everything else is presentation.
  scheduled_at         timestamptz NOT NULL,
  scheduled_local_date date NOT NULL,
  scheduled_local_time time NOT NULL,
  scheduled_timezone   text NOT NULL,

  dose_quantity        numeric(10,4) NOT NULL CHECK (dose_quantity > 0),
  dose_unit            dose_unit NOT NULL,

  status               dose_status NOT NULL DEFAULT 'upcoming',
  notified_at          timestamptz,
  snoozed_until        timestamptz,
  snooze_count         smallint NOT NULL DEFAULT 0 CHECK (snooze_count BETWEEN 0 AND 20),
  confirmed_at         timestamptz,
  confirmed_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  confirmation_method  confirmation_method,
  confirmation_device_id text,

  escalation_stage        smallint NOT NULL DEFAULT 0,
  escalation_completed_at timestamptz,

  -- Idempotency key from the offline queue on the device.
  client_event_id      text,

  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),

  -- A recorded dose must carry its confirmation metadata.
  CONSTRAINT doses_confirmation_complete CHECK (
    (status NOT IN ('taken','taken_late')) OR
    (confirmed_at IS NOT NULL AND confirmation_method IS NOT NULL))
);

-- Regenerating a schedule must never duplicate a dose. This index is what
-- makes the materializer safe to run every minute.
CREATE UNIQUE INDEX dose_occurrences_unique_idx ON dose_occurrences (schedule_id, scheduled_at);
-- Offline replay of the same action is a no-op, not a second dose.
CREATE UNIQUE INDEX dose_occurrences_client_event_idx ON dose_occurrences (client_event_id)
  WHERE client_event_id IS NOT NULL;

CREATE INDEX dose_occurrences_today_idx
  ON dose_occurrences (patient_profile_id, scheduled_at DESC);
CREATE INDEX dose_occurrences_local_date_idx
  ON dose_occurrences (patient_profile_id, scheduled_local_date);
-- The reminder worker's hot path: open doses whose time has come.
CREATE INDEX dose_occurrences_pending_idx ON dose_occurrences (scheduled_at)
  WHERE status IN ('upcoming','due','pending_confirmation','snoozed');
CREATE INDEX dose_occurrences_medication_idx ON dose_occurrences (medication_id, scheduled_at DESC);

CREATE TRIGGER dose_occurrences_touch BEFORE UPDATE ON dose_occurrences
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER dose_occurrences_profile_guard BEFORE INSERT OR UPDATE ON dose_occurrences
  FOR EACH ROW EXECUTE FUNCTION app.assert_profile_matches_medication();

ALTER TABLE stock_transactions
  ADD CONSTRAINT stock_tx_dose_fk FOREIGN KEY (dose_occurrence_id)
  REFERENCES dose_occurrences(id) ON DELETE SET NULL;

-- Append-only trail of everything that happened to a dose.
CREATE TABLE dose_events (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  dose_occurrence_id uuid NOT NULL REFERENCES dose_occurrences(id) ON DELETE CASCADE,
  patient_profile_id uuid NOT NULL REFERENCES patient_profiles(id) ON DELETE CASCADE,
  type               dose_event_type NOT NULL,
  at                 timestamptz NOT NULL DEFAULT now(),
  actor_user_id      uuid REFERENCES users(id) ON DELETE SET NULL,
  method             confirmation_method,
  device_id          text,
  metadata           jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX dose_events_dose_idx ON dose_events (dose_occurrence_id, at);
CREATE INDEX dose_events_profile_idx ON dose_events (patient_profile_id, at DESC);

CREATE TABLE symptom_notes (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_profile_id uuid NOT NULL REFERENCES patient_profiles(id) ON DELETE CASCADE,
  dose_occurrence_id uuid REFERENCES dose_occurrences(id) ON DELETE SET NULL,
  -- Stored exactly as the patient entered it. The system never interprets,
  -- classifies or acts on these values.
  tags               text[] NOT NULL DEFAULT '{}',
  text               text CHECK (text IS NULL OR length(text) <= 1000),
  recorded_at        timestamptz NOT NULL DEFAULT now(),
  created_by         uuid NOT NULL REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX symptom_notes_profile_idx ON symptom_notes (patient_profile_id, recorded_at DESC);

CREATE TABLE health_measurements (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_profile_id uuid NOT NULL REFERENCES patient_profiles(id) ON DELETE CASCADE,
  type               measurement_type NOT NULL,
  value_primary      numeric(10,3) NOT NULL,
  value_secondary    numeric(10,3),
  unit               text NOT NULL,
  measured_at        timestamptz NOT NULL DEFAULT now(),
  dose_occurrence_id uuid REFERENCES dose_occurrences(id) ON DELETE SET NULL,
  note               text,
  created_by         uuid NOT NULL REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX health_measurements_profile_idx ON health_measurements (patient_profile_id, type, measured_at DESC);
