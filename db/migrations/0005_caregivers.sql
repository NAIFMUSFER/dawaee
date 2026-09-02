-- =============================================================================
-- Dawaee — 0005: Family Care Circle, permissions, escalation policies
-- =============================================================================

CREATE TABLE caregiver_relationships (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_profile_id    uuid NOT NULL REFERENCES patient_profiles(id) ON DELETE CASCADE,
  caregiver_user_id     uuid REFERENCES users(id) ON DELETE CASCADE,
  invited_phone_e164    text,
  invited_name          text,
  role                  caregiver_role NOT NULL DEFAULT 'caregiver',
  status                caregiver_relationship_status NOT NULL DEFAULT 'pending',
  permissions           text[] NOT NULL DEFAULT '{}',
  escalation_priority   smallint NOT NULL DEFAULT 10 CHECK (escalation_priority BETWEEN 1 AND 20),

  invitation_token_hash text,
  invitation_expires_at timestamptz,
  invitation_channel    text CHECK (invitation_channel IN ('sms','whatsapp','link','qr')),

  invited_by_user_id    uuid NOT NULL REFERENCES users(id),
  accepted_at           timestamptz,
  declined_at           timestamptz,
  revoked_at            timestamptz,
  revoked_by_user_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT caregiver_permissions_valid CHECK (app.valid_permissions(permissions)),
  -- An active relationship must be bound to a real account; a pending one
  -- must still carry the phone number the invitation was sent to.
  CONSTRAINT caregiver_active_has_user CHECK (status <> 'active' OR caregiver_user_id IS NOT NULL),
  CONSTRAINT caregiver_pending_has_target CHECK (
    status <> 'pending' OR (invited_phone_e164 IS NOT NULL AND invitation_token_hash IS NOT NULL
      AND invitation_expires_at IS NOT NULL)),
  CONSTRAINT caregiver_not_self CHECK (caregiver_user_id IS NULL OR true)
);
-- A caregiver holds at most one live relationship per patient.
CREATE UNIQUE INDEX caregiver_rel_unique_active_idx
  ON caregiver_relationships (patient_profile_id, caregiver_user_id)
  WHERE status = 'active' AND caregiver_user_id IS NOT NULL;
CREATE UNIQUE INDEX caregiver_rel_token_idx ON caregiver_relationships (invitation_token_hash)
  WHERE invitation_token_hash IS NOT NULL;
CREATE INDEX caregiver_rel_profile_idx ON caregiver_relationships (patient_profile_id, status);
CREATE INDEX caregiver_rel_user_idx ON caregiver_relationships (caregiver_user_id, status)
  WHERE caregiver_user_id IS NOT NULL;
CREATE INDEX caregiver_rel_escalation_idx
  ON caregiver_relationships (patient_profile_id, escalation_priority) WHERE status = 'active';
CREATE TRIGGER caregiver_rel_touch BEFORE UPDATE ON caregiver_relationships
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- The patient can never be their own caregiver, which would create a
-- privilege loop around the owner-only checks.
CREATE OR REPLACE FUNCTION app.assert_caregiver_not_patient() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE owner_id uuid; linked_id uuid;
BEGIN
  IF NEW.caregiver_user_id IS NULL THEN RETURN NEW; END IF;
  SELECT owner_user_id, linked_user_id INTO owner_id, linked_id
    FROM patient_profiles WHERE id = NEW.patient_profile_id;
  IF NEW.caregiver_user_id IN (owner_id, linked_id) THEN
    RAISE EXCEPTION 'a profile owner cannot also be its caregiver';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER caregiver_rel_not_self BEFORE INSERT OR UPDATE ON caregiver_relationships
  FOR EACH ROW EXECUTE FUNCTION app.assert_caregiver_not_patient();

CREATE TABLE caregiver_notification_rules (
  id                           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  relationship_id              uuid NOT NULL REFERENCES caregiver_relationships(id) ON DELETE CASCADE,
  patient_profile_id           uuid NOT NULL REFERENCES patient_profiles(id) ON DELETE CASCADE,
  channel                      notification_channel NOT NULL,
  mode                         caregiver_notify_mode NOT NULL DEFAULT 'missed_only',
  consecutive_missed_threshold smallint NOT NULL DEFAULT 2 CHECK (consecutive_missed_threshold BETWEEN 1 AND 10),
  summary_time                 time,
  quiet_hours_start            time,
  quiet_hours_end              time,
  enabled                      boolean NOT NULL DEFAULT true,
  updated_at                   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX caregiver_rules_unique_idx ON caregiver_notification_rules (relationship_id, channel);
CREATE INDEX caregiver_rules_digest_idx ON caregiver_notification_rules (mode, summary_time)
  WHERE enabled AND mode IN ('daily_summary','weekly_summary');
CREATE TRIGGER caregiver_rules_touch BEFORE UPDATE ON caregiver_notification_rules
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

CREATE TABLE escalation_policies (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_profile_id uuid NOT NULL REFERENCES patient_profiles(id) ON DELETE CASCADE,
  -- NULL means "the default for every medication on this profile".
  medication_id      uuid REFERENCES medications(id) ON DELETE CASCADE,
  enabled            boolean NOT NULL DEFAULT true,
  stages             jsonb NOT NULL DEFAULT '[]'::jsonb,
  quiet_hours_start  time,
  quiet_hours_end    time,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT escalation_stages_is_array CHECK (jsonb_typeof(stages) = 'array'),
  CONSTRAINT escalation_stages_bounded CHECK (jsonb_array_length(stages) <= 8)
);
CREATE UNIQUE INDEX escalation_policy_default_idx ON escalation_policies (patient_profile_id)
  WHERE medication_id IS NULL;
CREATE UNIQUE INDEX escalation_policy_med_idx ON escalation_policies (patient_profile_id, medication_id)
  WHERE medication_id IS NOT NULL;
CREATE TRIGGER escalation_policies_touch BEFORE UPDATE ON escalation_policies
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
