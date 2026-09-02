-- =============================================================================
-- Dawaee — 0007: emergency card, QR access, append-only audit log
-- =============================================================================

CREATE TABLE emergency_cards (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_profile_id   uuid NOT NULL UNIQUE REFERENCES patient_profiles(id) ON DELETE CASCADE,
  blood_type           text CHECK (blood_type IS NULL OR blood_type ~ '^(A|B|AB|O)[+-]$'),
  -- Verbatim user entry. The system never infers an allergy or a condition.
  allergies            text[] NOT NULL DEFAULT '{}',
  conditions_note      text CHECK (conditions_note IS NULL OR length(conditions_note) <= 1000),
  emergency_contacts   jsonb NOT NULL DEFAULT '[]'::jsonb,

  include_medications  boolean NOT NULL DEFAULT true,
  include_allergies    boolean NOT NULL DEFAULT true,
  include_contacts     boolean NOT NULL DEFAULT true,

  -- QR access is off by default and can be killed instantly by rotating the
  -- token; only the hash is stored so a leaked database row is not a key.
  qr_enabled           boolean NOT NULL DEFAULT false,
  qr_token_hash        text,
  qr_rotated_at        timestamptz,
  qr_view_count        integer NOT NULL DEFAULT 0,
  qr_last_viewed_at    timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT emergency_qr_needs_token CHECK (NOT qr_enabled OR qr_token_hash IS NOT NULL),
  CONSTRAINT emergency_contacts_is_array CHECK (jsonb_typeof(emergency_contacts) = 'array'),
  CONSTRAINT emergency_contacts_bounded CHECK (jsonb_array_length(emergency_contacts) <= 5)
);
CREATE UNIQUE INDEX emergency_qr_token_idx ON emergency_cards (qr_token_hash) WHERE qr_token_hash IS NOT NULL;
CREATE TRIGGER emergency_cards_touch BEFORE UPDATE ON emergency_cards
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- --------------------------------------------------------------- audit log

-- Append-only by construction: no UPDATE or DELETE is permitted, even by the
-- application role, and a trigger blocks it regardless of grants.
CREATE TABLE audit_logs (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at                 timestamptz NOT NULL DEFAULT now(),
  actor_user_id      uuid REFERENCES users(id) ON DELETE SET NULL,
  actor_role         actor_role NOT NULL DEFAULT 'patient',
  patient_profile_id uuid REFERENCES patient_profiles(id) ON DELETE SET NULL,
  action             text NOT NULL,
  entity_type        text NOT NULL,
  entity_id          text,
  previous_value     jsonb,
  new_value          jsonb,
  request_id         text,
  ip_hash            text,
  user_agent         text
);
CREATE INDEX audit_logs_profile_idx ON audit_logs (patient_profile_id, at DESC);
CREATE INDEX audit_logs_actor_idx ON audit_logs (actor_user_id, at DESC);
CREATE INDEX audit_logs_entity_idx ON audit_logs (entity_type, entity_id, at DESC);
CREATE INDEX audit_logs_action_idx ON audit_logs (action, at DESC);

CREATE OR REPLACE FUNCTION app.block_audit_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only; % is not permitted', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END $$;

CREATE TRIGGER audit_logs_no_update BEFORE UPDATE ON audit_logs
  FOR EACH STATEMENT EXECUTE FUNCTION app.block_audit_mutation();
CREATE TRIGGER audit_logs_no_delete BEFORE DELETE ON audit_logs
  FOR EACH STATEMENT EXECUTE FUNCTION app.block_audit_mutation();
CREATE TRIGGER audit_logs_no_truncate BEFORE TRUNCATE ON audit_logs
  FOR EACH STATEMENT EXECUTE FUNCTION app.block_audit_mutation();

-- Timezone-change prompts awaiting a patient decision. Nothing moves until
-- the patient answers.
CREATE TABLE travel_prompts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_profile_id uuid NOT NULL REFERENCES patient_profiles(id) ON DELETE CASCADE,
  detected_timezone  text NOT NULL,
  previous_timezone  text NOT NULL,
  offset_shift_hours numeric(4,2) NOT NULL,
  decision           text CHECK (decision IN ('keep_home_time','follow_local_time','dismiss')),
  decided_at         timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX travel_prompts_open_idx ON travel_prompts (patient_profile_id) WHERE decision IS NULL;

-- Uploaded object metadata. Files live in private object storage; rows here
-- carry only the key and the validation verdict.
CREATE TABLE stored_objects (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  object_key         text NOT NULL UNIQUE,
  owner_user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  patient_profile_id uuid REFERENCES patient_profiles(id) ON DELETE CASCADE,
  purpose            text NOT NULL CHECK (purpose IN ('medication_image','prescription_image','avatar')),
  content_type       text NOT NULL,
  byte_size          integer NOT NULL CHECK (byte_size > 0),
  sha256             text,
  scan_status        text NOT NULL DEFAULT 'pending' CHECK (scan_status IN ('pending','clean','rejected')),
  reject_reason      text,
  uploaded_at        timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX stored_objects_profile_idx ON stored_objects (patient_profile_id, created_at DESC);
CREATE INDEX stored_objects_pending_idx ON stored_objects (created_at) WHERE uploaded_at IS NULL;
