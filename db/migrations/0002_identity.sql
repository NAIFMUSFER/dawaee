-- =============================================================================
-- Dawaee — 0002: accounts, patient profiles, preferences, consent, devices
-- =============================================================================

CREATE TABLE users (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_e164        text UNIQUE,
  email             text UNIQUE
                      CONSTRAINT users_email_format
                      CHECK (email IS NULL OR email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  display_name      text NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 120),
  locale            text NOT NULL DEFAULT 'ar' CHECK (locale IN ('ar','en')),
  timezone          text NOT NULL DEFAULT 'Asia/Riyadh',
  is_admin          boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  disabled_at       timestamptz,
  deletion_requested_at timestamptz,
  CONSTRAINT users_phone_format CHECK (phone_e164 IS NULL OR phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  CONSTRAINT users_identifier_present CHECK (phone_e164 IS NOT NULL)
);
CREATE TRIGGER users_touch BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- One-time passcodes. Only a hash is stored, and attempts are capped so a
-- stolen phone number cannot be brute-forced.
CREATE TABLE auth_otp_challenges (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_e164     text NOT NULL,
  code_hash      text NOT NULL,
  attempts       smallint NOT NULL DEFAULT 0,
  max_attempts   smallint NOT NULL DEFAULT 5,
  consumed_at    timestamptz,
  expires_at     timestamptz NOT NULL,
  created_ip_hash text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_otp_phone_idx ON auth_otp_challenges (phone_e164, created_at DESC);
CREATE INDEX auth_otp_expiry_idx ON auth_otp_challenges (expires_at) WHERE consumed_at IS NULL;

-- Refresh-token sessions. Rotated on every refresh; only the hash is kept.
CREATE TABLE auth_sessions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  refresh_token_hash text NOT NULL UNIQUE,
  device_id          text NOT NULL,
  device_name        text,
  user_agent         text,
  ip_hash            text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  last_used_at       timestamptz NOT NULL DEFAULT now(),
  expires_at         timestamptz NOT NULL,
  revoked_at         timestamptz,
  replaced_by        uuid REFERENCES auth_sessions(id) ON DELETE SET NULL
);
CREATE INDEX auth_sessions_user_idx ON auth_sessions (user_id) WHERE revoked_at IS NULL;

-- -------------------------------------------------------- patient profiles

-- A profile is the medical boundary. One account may own several (self,
-- father, mother) and data NEVER crosses between them.
CREATE TABLE patient_profiles (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  linked_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  display_name    text NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 120),
  birth_year      smallint CHECK (birth_year BETWEEN 1900 AND 2100),
  avatar_key      text,
  timezone        text NOT NULL DEFAULT 'Asia/Riyadh',
  home_timezone   text NOT NULL DEFAULT 'Asia/Riyadh',
  travel_policy   travel_policy NOT NULL DEFAULT 'ask',
  is_self         boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  archived_at     timestamptz
);
CREATE INDEX patient_profiles_owner_idx ON patient_profiles (owner_user_id) WHERE archived_at IS NULL;
CREATE INDEX patient_profiles_linked_idx ON patient_profiles (linked_user_id) WHERE linked_user_id IS NOT NULL;
-- At most one "this is me" profile per account.
CREATE UNIQUE INDEX patient_profiles_one_self_idx ON patient_profiles (owner_user_id)
  WHERE is_self AND archived_at IS NULL;
CREATE TRIGGER patient_profiles_touch BEFORE UPDATE ON patient_profiles
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

CREATE TABLE user_preferences (
  user_id                 uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  locale                  text NOT NULL DEFAULT 'ar' CHECK (locale IN ('ar','en')),
  numeral_system          text NOT NULL DEFAULT 'latn' CHECK (numeral_system IN ('latn','arab')),
  calendar_system         text NOT NULL DEFAULT 'gregory'
                            CHECK (calendar_system IN ('gregory','islamic-umalqura')),
  elderly_mode            boolean NOT NULL DEFAULT false,
  text_scale              numeric(3,2) NOT NULL DEFAULT 1.00 CHECK (text_scale BETWEEN 0.85 AND 2.00),
  high_contrast           boolean NOT NULL DEFAULT false,
  voice_reminders_enabled boolean NOT NULL DEFAULT false,
  voice_confirmation_enabled boolean NOT NULL DEFAULT false,
  app_lock_enabled        boolean NOT NULL DEFAULT false,
  app_lock_areas          text[] NOT NULL DEFAULT '{}',
  quiet_hours_start       time,
  quiet_hours_end         time,
  default_snooze_minutes  smallint NOT NULL DEFAULT 10 CHECK (default_snooze_minutes BETWEEN 1 AND 240),
  low_stock_threshold_days smallint NOT NULL DEFAULT 7 CHECK (low_stock_threshold_days BETWEEN 1 AND 60),
  expiry_warning_days     smallint NOT NULL DEFAULT 30 CHECK (expiry_warning_days BETWEEN 1 AND 180),
  updated_at              timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER user_preferences_touch BEFORE UPDATE ON user_preferences
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- Consent is recorded per (user, profile, type) with full grant/withdraw history
-- kept in audit_logs. The current state lives here.
CREATE TABLE consents (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  patient_profile_id uuid REFERENCES patient_profiles(id) ON DELETE CASCADE,
  type               consent_type NOT NULL,
  granted            boolean NOT NULL,
  version            text NOT NULL DEFAULT '1.0',
  granted_at         timestamptz,
  withdrawn_at       timestamptz,
  ip_hash            text,
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX consents_unique_idx
  ON consents (user_id, COALESCE(patient_profile_id, '00000000-0000-0000-0000-000000000000'::uuid), type);
CREATE TRIGGER consents_touch BEFORE UPDATE ON consents
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

CREATE TABLE push_tokens (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token        text NOT NULL,
  platform     text NOT NULL CHECK (platform IN ('ios','android','web')),
  device_id    text NOT NULL,
  app_version  text,
  active       boolean NOT NULL DEFAULT true,
  failure_count smallint NOT NULL DEFAULT 0,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  created_at   timestamptz NOT NULL DEFAULT now()
);
-- One live token per device; re-registering the same device replaces it.
CREATE UNIQUE INDEX push_tokens_device_idx ON push_tokens (user_id, device_id);
CREATE UNIQUE INDEX push_tokens_token_idx ON push_tokens (token) WHERE active;
CREATE INDEX push_tokens_active_idx ON push_tokens (user_id) WHERE active;
