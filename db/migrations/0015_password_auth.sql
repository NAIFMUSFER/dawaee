-- =============================================================================
-- Dawaee — 0015: password sign-in
--
-- WhatsApp and SMS both turned out to be gated behind a Saudi commercial
-- registration — SMS needs a Sender ID registered against one, and Meta
-- requires business verification before it will approve an AUTHENTICATION
-- template. Neither can be switched on by writing code. A password does not
-- depend on anyone's approval, so it becomes the way in.
--
-- The one-time-code path is deliberately left intact underneath. When the
-- business is verified, OTP becomes available again — as a second factor
-- rather than a replacement, which is where it belongs anyway.
-- =============================================================================

-- An account may now be reached by phone OR email. The old constraint demanded
-- a phone on every row, which would have made email sign-in impossible.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_identifier_present;
ALTER TABLE users ADD CONSTRAINT users_identifier_present
  CHECK (phone_e164 IS NOT NULL OR email IS NOT NULL);

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS password_hash        text,
  ADD COLUMN IF NOT EXISTS password_updated_at  timestamptz,
  ADD COLUMN IF NOT EXISTS failed_login_count   smallint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS locked_until         timestamptz;

-- Email is matched case-insensitively at login, so it must be unique that way
-- too — otherwise 'A@x.com' and 'a@x.com' become two accounts that both answer
-- to the same typed address.
DROP INDEX IF EXISTS users_email_lower_idx;
CREATE UNIQUE INDEX users_email_lower_idx ON users (lower(email)) WHERE email IS NOT NULL;

-- ------------------------------------------------------------- lookup
--
-- Returns the row needed to verify a password. Runs in the auth plane because
-- no identity exists yet, and takes the identifier as typed: the caller must
-- not have to decide whether it is a phone or an email.
CREATE OR REPLACE FUNCTION app.find_user_for_password_login(p_identifier text)
RETURNS TABLE (
  user_id uuid, password_hash text, locked_until timestamptz,
  failed_login_count smallint, disabled boolean
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
  SELECT u.id, u.password_hash, u.locked_until, u.failed_login_count,
         (u.disabled_at IS NOT NULL)
    FROM users u
   WHERE u.phone_e164 = p_identifier
      OR lower(u.email) = lower(p_identifier)
   LIMIT 1
$$;

-- ------------------------------------------------------- failure counting
--
-- Lockout is written on its own, so the caller can COMMIT it before refusing
-- the request. A counter rolled back by the very exception that reports the
-- failure is not a counter — it is an unlimited guessing budget.
CREATE OR REPLACE FUNCTION app.record_login_failure(
  p_user_id uuid, p_max_attempts int, p_lock_minutes int
) RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
DECLARE
  n smallint;
  lock_at timestamptz := NULL;
BEGIN
  UPDATE users
     SET failed_login_count = failed_login_count + 1,
         locked_until = CASE
           WHEN failed_login_count + 1 >= p_max_attempts
           THEN now() + make_interval(mins => p_lock_minutes)
           ELSE locked_until
         END
   WHERE id = p_user_id
   RETURNING failed_login_count, locked_until INTO n, lock_at;

  RETURN lock_at;
END $$;

CREATE OR REPLACE FUNCTION app.clear_login_failures(p_user_id uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
  UPDATE users SET failed_login_count = 0, locked_until = NULL WHERE id = p_user_id
$$;

-- ------------------------------------------------------------ registration
--
-- Refuses an identifier that already exists rather than quietly attaching a
-- password to somebody else's account.
CREATE OR REPLACE FUNCTION app.register_with_password(
  p_phone text, p_email text, p_display_name text, p_password_hash text, p_locale text
) RETURNS TABLE (user_id uuid, created boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
#variable_conflict use_column
DECLARE
  existing uuid;
  new_id uuid;
BEGIN
  SELECT u.id INTO existing FROM users u
   WHERE (p_phone IS NOT NULL AND u.phone_e164 = p_phone)
      OR (p_email IS NOT NULL AND lower(u.email) = lower(p_email))
   LIMIT 1;

  IF existing IS NOT NULL THEN
    RETURN QUERY SELECT existing, false;
    RETURN;
  END IF;

  INSERT INTO users (phone_e164, email, display_name, locale, password_hash, password_updated_at)
  VALUES (p_phone, p_email, p_display_name, coalesce(p_locale, 'ar'), p_password_hash, now())
  RETURNING id INTO new_id;

  RETURN QUERY SELECT new_id, true;
END $$;

CREATE OR REPLACE FUNCTION app.set_password(p_user_id uuid, p_password_hash text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
  UPDATE users
     SET password_hash = p_password_hash,
         password_updated_at = now(),
         failed_login_count = 0,
         locked_until = NULL
   WHERE id = p_user_id
$$;

REVOKE EXECUTE ON FUNCTION
  app.find_user_for_password_login(text),
  app.record_login_failure(uuid, int, int),
  app.clear_login_failures(uuid),
  app.register_with_password(text, text, text, text, text),
  app.set_password(uuid, text)
FROM PUBLIC;

GRANT EXECUTE ON FUNCTION
  app.find_user_for_password_login(text),
  app.record_login_failure(uuid, int, int),
  app.clear_login_failures(uuid),
  app.register_with_password(text, text, text, text, text),
  app.set_password(uuid, text)
TO dawaee_app;

-- The password hash must never be readable through an ordinary request. The
-- app role reaches it only through the SECURITY DEFINER function above, which
-- returns it for one comparison and nothing else.
REVOKE SELECT (password_hash) ON users FROM dawaee_app, dawaee_worker;
