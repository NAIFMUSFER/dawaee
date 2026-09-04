-- =============================================================================
-- Dawaee — 0016: put the password hash out of the application role's reach
--
-- 0015 tried to withhold the hash with `REVOKE SELECT (password_hash) ON users`.
-- That line does nothing. 0008 grants SELECT on the whole table to dawaee_app,
-- and in PostgreSQL a column-level revoke cannot subtract from a table-level
-- grant — so the column stayed readable while the migration read as though it
-- were protected. A guarantee that is written down but not enforced is worse
-- than none, because it stops anyone looking again.
--
-- Credentials move to their own table instead. dawaee_app is granted nothing on
-- it at all, so the only way to a hash is the SECURITY DEFINER function that
-- compares it — and that function returns it for one comparison and never to a
-- request. This holds no matter what columns `users` grows later.
-- =============================================================================

CREATE TABLE IF NOT EXISTS user_credentials (
  user_id             uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  password_hash       text NOT NULL,
  password_updated_at timestamptz NOT NULL DEFAULT now(),
  failed_login_count  smallint NOT NULL DEFAULT 0,
  locked_until        timestamptz
);

-- Carry over anything 0015 already wrote.
INSERT INTO user_credentials (user_id, password_hash, password_updated_at, failed_login_count, locked_until)
SELECT id, password_hash, coalesce(password_updated_at, now()), failed_login_count, locked_until
  FROM users WHERE password_hash IS NOT NULL
ON CONFLICT (user_id) DO NOTHING;

ALTER TABLE users
  DROP COLUMN IF EXISTS password_hash,
  DROP COLUMN IF EXISTS password_updated_at,
  DROP COLUMN IF EXISTS failed_login_count,
  DROP COLUMN IF EXISTS locked_until;

-- No grants to the application roles. Not a restricted grant — none.
REVOKE ALL ON user_credentials FROM PUBLIC, dawaee_app, dawaee_worker;

-- Belt and braces: even if a future migration hands out a blanket table grant
-- the way 0008 does, row-level security with no policy for these roles still
-- returns nothing.
ALTER TABLE user_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_credentials FORCE ROW LEVEL SECURITY;

-- ------------------------------------------------ functions, repointed

CREATE OR REPLACE FUNCTION app.find_user_for_password_login(p_identifier text)
RETURNS TABLE (
  user_id uuid, password_hash text, locked_until timestamptz,
  failed_login_count smallint, disabled boolean
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
  SELECT u.id, c.password_hash, c.locked_until,
         coalesce(c.failed_login_count, 0::smallint), (u.disabled_at IS NOT NULL)
    FROM users u
    LEFT JOIN user_credentials c ON c.user_id = u.id
   WHERE u.phone_e164 = p_identifier
      OR lower(u.email) = lower(p_identifier)
   LIMIT 1
$$;

CREATE OR REPLACE FUNCTION app.record_login_failure(
  p_user_id uuid, p_max_attempts int, p_lock_minutes int
) RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
DECLARE
  lock_at timestamptz := NULL;
BEGIN
  UPDATE user_credentials
     SET failed_login_count = failed_login_count + 1,
         locked_until = CASE
           WHEN failed_login_count + 1 >= p_max_attempts
           THEN now() + make_interval(mins => p_lock_minutes)
           ELSE locked_until
         END
   WHERE user_id = p_user_id
   RETURNING locked_until INTO lock_at;
  RETURN lock_at;
END $$;

CREATE OR REPLACE FUNCTION app.clear_login_failures(p_user_id uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
  UPDATE user_credentials
     SET failed_login_count = 0, locked_until = NULL
   WHERE user_id = p_user_id
$$;

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

  INSERT INTO users (phone_e164, email, display_name, locale)
  VALUES (p_phone, p_email, p_display_name, coalesce(p_locale, 'ar'))
  RETURNING id INTO new_id;

  IF p_password_hash IS NOT NULL THEN
    INSERT INTO user_credentials (user_id, password_hash) VALUES (new_id, p_password_hash);
  END IF;

  RETURN QUERY SELECT new_id, true;
END $$;

CREATE OR REPLACE FUNCTION app.set_password(p_user_id uuid, p_password_hash text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
  INSERT INTO user_credentials (user_id, password_hash)
  VALUES (p_user_id, p_password_hash)
  ON CONFLICT (user_id) DO UPDATE
     SET password_hash = excluded.password_hash,
         password_updated_at = now(),
         failed_login_count = 0,
         locked_until = NULL
$$;

GRANT EXECUTE ON FUNCTION
  app.find_user_for_password_login(text),
  app.record_login_failure(uuid, int, int),
  app.clear_login_failures(uuid),
  app.register_with_password(text, text, text, text, text),
  app.set_password(uuid, text)
TO dawaee_app;
