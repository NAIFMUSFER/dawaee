-- =============================================================================
-- Dawaee — 0011: the authentication plane
--
-- Account creation, session lookup and session rotation all happen BEFORE an
-- identity is established, so they cannot satisfy the RLS policies in 0008 —
-- those policies are written against `app.user_id`, which is not set yet.
--
-- Rather than loosening the policies (which would weaken every authenticated
-- request), the auth plane gets its own narrow, audited SECURITY DEFINER
-- surface. Each function does exactly one thing, takes only the inputs it
-- needs, and returns only what the caller must know.
-- =============================================================================

/**
 * Resolve a phone number to an account, creating it on first sign-in.
 *
 * A new account is born complete: preferences row, and a "this is me" patient
 * profile so the first medication has somewhere to live without an extra
 * onboarding step.
 */
CREATE OR REPLACE FUNCTION app.find_or_create_user_by_phone(
  p_phone text,
  p_display_name text,
  p_locale text DEFAULT 'ar'
) RETURNS TABLE (user_id uuid, is_admin boolean, is_new_user boolean, self_profile_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
#variable_conflict use_column
DECLARE
  -- Deliberately NOT named `found`: plpgsql's built-in FOUND flag is
  -- case-insensitive, and a variable by that name silently shadows it.
  u users%ROWTYPE;
  new_profile uuid;
BEGIN
  SELECT * INTO u FROM users WHERE phone_e164 = p_phone;

  IF u.id IS NOT NULL THEN
    IF u.disabled_at IS NOT NULL THEN
      RAISE EXCEPTION 'account is disabled' USING ERRCODE = 'insufficient_privilege';
    END IF;
    SELECT id INTO new_profile FROM patient_profiles
     WHERE owner_user_id = u.id AND is_self AND archived_at IS NULL LIMIT 1;
    RETURN QUERY SELECT u.id, u.is_admin, false, new_profile;
    RETURN;
  END IF;

  INSERT INTO users (phone_e164, display_name, locale)
  VALUES (p_phone, p_display_name, p_locale)
  RETURNING * INTO u;

  INSERT INTO user_preferences (user_id, locale) VALUES (u.id, p_locale);

  INSERT INTO patient_profiles (owner_user_id, linked_user_id, display_name, is_self)
  VALUES (u.id, u.id, p_display_name, true)
  RETURNING id INTO new_profile;

  RETURN QUERY SELECT u.id, u.is_admin, true, new_profile;
END $$;

/** Create a refresh session. Only the token hash is ever stored. */
CREATE OR REPLACE FUNCTION app.create_session(
  p_user_id uuid,
  p_refresh_hash text,
  p_device_id text,
  p_device_name text,
  p_user_agent text,
  p_ip_hash text,
  p_ttl_days int
) RETURNS TABLE (session_id uuid, expires_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
#variable_conflict use_column
DECLARE new_id uuid; new_expiry timestamptz;
BEGIN
  INSERT INTO auth_sessions
    (user_id, refresh_token_hash, device_id, device_name, user_agent, ip_hash, expires_at)
  VALUES
    (p_user_id, p_refresh_hash, p_device_id, p_device_name, p_user_agent, p_ip_hash,
     now() + make_interval(days => p_ttl_days))
  RETURNING id, auth_sessions.expires_at INTO new_id, new_expiry;
  RETURN QUERY SELECT new_id, new_expiry;
END $$;

/**
 * Rotating refresh.
 *
 * Presenting a token that was already rotated is treated as theft: every
 * session on that device is revoked, so the legitimate owner is signed out and
 * has to re-authenticate rather than silently sharing an account with an
 * attacker.
 */
CREATE OR REPLACE FUNCTION app.rotate_session(
  p_presented_hash text,
  p_new_hash text,
  p_ip_hash text,
  p_ttl_days int
) RETURNS TABLE (outcome text, user_id uuid, is_admin boolean, session_id uuid, expires_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
#variable_conflict use_column
DECLARE
  s auth_sessions%ROWTYPE;
  admin boolean;
  new_id uuid;
  new_expiry timestamptz;
BEGIN
  SELECT * INTO s FROM auth_sessions WHERE refresh_token_hash = p_presented_hash FOR UPDATE;
  IF s.id IS NULL THEN
    RETURN QUERY SELECT 'invalid'::text, NULL::uuid, NULL::boolean, NULL::uuid, NULL::timestamptz; RETURN;
  END IF;

  IF s.revoked_at IS NOT NULL THEN
    UPDATE auth_sessions SET revoked_at = now()
     WHERE user_id = s.user_id AND device_id = s.device_id AND revoked_at IS NULL;
    RETURN QUERY SELECT 'reuse_detected'::text, s.user_id, NULL::boolean, NULL::uuid, NULL::timestamptz; RETURN;
  END IF;

  IF s.expires_at <= now() THEN
    RETURN QUERY SELECT 'expired'::text, s.user_id, NULL::boolean, NULL::uuid, NULL::timestamptz; RETURN;
  END IF;

  SELECT u.is_admin INTO admin FROM users u WHERE u.id = s.user_id;

  INSERT INTO auth_sessions
    (user_id, refresh_token_hash, device_id, device_name, ip_hash, expires_at)
  VALUES
    (s.user_id, p_new_hash, s.device_id, s.device_name, p_ip_hash, now() + make_interval(days => p_ttl_days))
  RETURNING id, auth_sessions.expires_at INTO new_id, new_expiry;

  UPDATE auth_sessions SET revoked_at = now(), replaced_by = new_id, last_used_at = now() WHERE id = s.id;

  RETURN QUERY SELECT 'rotated'::text, s.user_id, admin, new_id, new_expiry;
END $$;

/**
 * Checked on every authenticated request so a session revoked on another
 * device stops working immediately, not when its JWT happens to expire.
 */
CREATE OR REPLACE FUNCTION app.session_is_live(p_session_id uuid)
RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
  SELECT EXISTS (
    SELECT 1 FROM auth_sessions
     WHERE id = p_session_id AND revoked_at IS NULL AND expires_at > now()
  )
$$;

CREATE OR REPLACE FUNCTION app.revoke_session(p_session_id uuid)
RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
  UPDATE auth_sessions SET revoked_at = now() WHERE id = p_session_id AND revoked_at IS NULL
$$;

REVOKE EXECUTE ON FUNCTION
  app.find_or_create_user_by_phone(text,text,text),
  app.create_session(uuid,text,text,text,text,text,int),
  app.rotate_session(text,text,text,int),
  app.session_is_live(uuid),
  app.revoke_session(uuid)
FROM PUBLIC;

GRANT EXECUTE ON FUNCTION
  app.find_or_create_user_by_phone(text,text,text),
  app.create_session(uuid,text,text,text,text,text,int),
  app.rotate_session(text,text,text,int),
  app.session_is_live(uuid),
  app.revoke_session(uuid)
TO dawaee_app;

-- Audit rows are written by the auth plane before app.user_id exists, so the
-- insert policy must not depend on it. Reads stay locked to the patient.
DROP POLICY IF EXISTS audit_insert ON audit_logs;
CREATE POLICY audit_insert ON audit_logs FOR INSERT TO dawaee_app WITH CHECK (true);
