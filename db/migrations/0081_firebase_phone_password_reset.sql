-- =============================================================================
-- Dawaee — 0081: password reset after externally verified phone possession
-- =============================================================================
-- The HTTP layer verifies a fresh Firebase Phone Auth ID token before calling
-- this function. Firebase tokens are never persisted.
-- =============================================================================

CREATE OR REPLACE FUNCTION app.reset_password_by_verified_phone(
  p_phone_e164 text,
  p_password_hash text
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app
AS $$
DECLARE
  uid uuid;
BEGIN
  SELECT u.id INTO uid
    FROM users u
   WHERE u.phone_e164 = p_phone_e164
     AND u.disabled_at IS NULL;

  IF uid IS NULL THEN
    RETURN NULL;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(uid::text, 20260912));

  PERFORM 1 FROM users u
   WHERE u.id = uid
     AND u.phone_e164 = p_phone_e164
     AND u.disabled_at IS NULL;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  INSERT INTO user_credentials (user_id, password_hash)
  VALUES (uid, p_password_hash)
  ON CONFLICT (user_id) DO UPDATE
     SET password_hash = excluded.password_hash,
         password_updated_at = now(),
         failed_login_count = 0,
         locked_until = NULL;

  UPDATE auth_sessions
     SET revoked_at = COALESCE(revoked_at, now())
   WHERE user_id = uid
     AND revoked_at IS NULL;

  RETURN uid;
END
$$;

REVOKE ALL ON FUNCTION app.reset_password_by_verified_phone(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reset_password_by_verified_phone(text,text) TO dawaee_app;

COMMENT ON FUNCTION app.reset_password_by_verified_phone(text,text) IS
  'Resets a password after the API has verified recent possession of the account phone; serializes with refresh rotation and revokes all live sessions.';
