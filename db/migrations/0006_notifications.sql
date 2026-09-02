-- =============================================================================
-- Dawaee — 0006: notification deliveries, outbox, provider failures
-- =============================================================================

CREATE TABLE notification_deliveries (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_profile_id   uuid NOT NULL REFERENCES patient_profiles(id) ON DELETE CASCADE,
  recipient_user_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  recipient_phone_e164 text,
  relationship_id      uuid REFERENCES caregiver_relationships(id) ON DELETE SET NULL,

  kind                 notification_kind NOT NULL,
  channel              notification_channel NOT NULL,
  dose_occurrence_id   uuid REFERENCES dose_occurrences(id) ON DELETE CASCADE,
  medication_id        uuid REFERENCES medications(id) ON DELETE CASCADE,
  escalation_stage     smallint,

  status               delivery_status NOT NULL DEFAULT 'queued',
  provider             text,
  provider_message_id  text,
  error_code           text,
  error_detail         text,
  attempts             smallint NOT NULL DEFAULT 0,
  max_attempts         smallint NOT NULL DEFAULT 3,

  -- Localized payload is rendered at enqueue time so a locale change later
  -- never rewrites what was actually sent.
  locale               text NOT NULL DEFAULT 'ar',
  title                text,
  body                 text,
  payload              jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- The single strongest guarantee against double-messaging a family member.
  dedupe_key           text NOT NULL,
  scheduled_for        timestamptz NOT NULL DEFAULT now(),
  next_attempt_at      timestamptz NOT NULL DEFAULT now(),
  sent_at              timestamptz,
  delivered_at         timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX notification_dedupe_idx ON notification_deliveries (dedupe_key);
-- The dispatcher's claim query.
CREATE INDEX notification_queue_idx ON notification_deliveries (next_attempt_at)
  WHERE status IN ('queued','sending');
CREATE INDEX notification_profile_idx ON notification_deliveries (patient_profile_id, created_at DESC);
CREATE INDEX notification_dose_idx ON notification_deliveries (dose_occurrence_id)
  WHERE dose_occurrence_id IS NOT NULL;
CREATE INDEX notification_failures_idx ON notification_deliveries (channel, created_at DESC)
  WHERE status = 'failed';
CREATE TRIGGER notification_deliveries_touch BEFORE UPDATE ON notification_deliveries
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- Provider webhooks (WhatsApp delivery receipts, push receipts) land here
-- before being folded into notification_deliveries, so a replayed webhook is
-- harmless and a malformed one never corrupts delivery state.
CREATE TABLE provider_webhook_events (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider       text NOT NULL,
  external_id    text,
  event_type     text,
  payload        jsonb NOT NULL,
  signature_ok   boolean NOT NULL DEFAULT false,
  processed_at   timestamptz,
  received_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX provider_webhook_dedupe_idx ON provider_webhook_events (provider, external_id)
  WHERE external_id IS NOT NULL;
CREATE INDEX provider_webhook_unprocessed_idx ON provider_webhook_events (received_at)
  WHERE processed_at IS NULL;

-- Background job bookkeeping so the admin panel can answer "did the reminder
-- run?" without reading medical rows.
CREATE TABLE job_runs (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_name      text NOT NULL,
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  succeeded     boolean,
  items_processed integer NOT NULL DEFAULT 0,
  error_message text,
  metadata      jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX job_runs_name_idx ON job_runs (job_name, started_at DESC);

-- Advisory-lock helper so two worker instances never process the same tick.
CREATE OR REPLACE FUNCTION app.try_job_lock(job text) RETURNS boolean
LANGUAGE sql AS $$
  SELECT pg_try_advisory_xact_lock(hashtext($1)::bigint)
$$;
