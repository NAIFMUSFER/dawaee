-- A newly authenticated Google account has no user-known password. Allow that
-- account to attach a phone only after the API has verified the Firebase SMS
-- proof. The session owner and an existing Google identity are both required.
CREATE FUNCTION app.attach_google_account_phone(p_user uuid, p_phone text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
BEGIN
  IF p_user IS DISTINCT FROM app.current_user_id()
    OR p_phone !~ '^\+[1-9][0-9]{7,14}$'
    OR NOT EXISTS (SELECT 1 FROM google_auth_identities g WHERE g.user_id = p_user)
  THEN RETURN false; END IF;

  PERFORM 1 FROM users u
    WHERE u.id = p_user AND u.disabled_at IS NULL
      AND (u.phone_e164 IS NULL OR u.phone_e164 = p_phone)
    FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;

  UPDATE users SET phone_e164 = p_phone WHERE id = p_user;
  RETURN true;
EXCEPTION WHEN unique_violation THEN RETURN false;
END $$;

REVOKE ALL ON FUNCTION app.attach_google_account_phone(uuid,text) FROM PUBLIC, dawaee_worker;
GRANT EXECUTE ON FUNCTION app.attach_google_account_phone(uuid,text) TO dawaee_app;
