-- New registrations must prove email ownership before clinical access. Existing
-- accounts retain their identity and can link a mailbox with the 0086 flow.
CREATE TABLE account_email_onboarding (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE
);
REVOKE ALL ON account_email_onboarding FROM PUBLIC, dawaee_app, dawaee_worker;
ALTER TABLE account_email_onboarding ENABLE ROW LEVEL SECURITY;
ALTER TABLE account_email_onboarding FORCE ROW LEVEL SECURITY;
SELECT count(*) FROM app.ensure_definer_policies();

CREATE FUNCTION app.register_email_account(
  p_phone text, p_email text, p_display_name text, p_password_hash text, p_locale text
) RETURNS TABLE(user_id uuid, created boolean, self_profile_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
DECLARE registered record;
BEGIN
  IF p_email IS NULL OR btrim(p_email) = '' THEN
    RAISE EXCEPTION 'Email required' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO registered FROM app.register_with_password(
    p_phone, p_email, p_display_name, p_password_hash, p_locale);
  IF registered.created THEN
    INSERT INTO account_email_onboarding(user_id) VALUES(registered.user_id);
  END IF;
  RETURN QUERY SELECT registered.user_id, registered.created, registered.self_profile_id;
END $$;
REVOKE ALL ON FUNCTION app.register_email_account(text,text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.register_email_account(text,text,text,text,text) TO dawaee_app;

CREATE FUNCTION app.email_verification_required(p_user_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
  SELECT p_user_id = app.current_user_id()
    AND EXISTS (SELECT 1 FROM account_email_onboarding WHERE user_id = p_user_id)
    AND NOT app.has_verified_email(p_user_id)
$$;
REVOKE ALL ON FUNCTION app.email_verification_required(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.email_verification_required(uuid) TO dawaee_app;
