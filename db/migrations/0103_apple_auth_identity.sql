CREATE TABLE apple_auth_identities (
  subject text PRIMARY KEY CHECK (length(subject) BETWEEN 1 AND 255),
  user_id uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON apple_auth_identities FROM PUBLIC, dawaee_app, dawaee_worker;
ALTER TABLE apple_auth_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE apple_auth_identities FORCE ROW LEVEL SECURITY;
SELECT count(*) FROM app.ensure_definer_policies();

-- Only the API, after a one-use Apple code exchange and signed nonce proof.
-- Never auto-link by email, including Apple private relay addresses.
CREATE FUNCTION app.resolve_apple_account(
  p_subject text, p_email text, p_name text, p_password_hash text, p_locale text
) RETURNS TABLE(user_id uuid, created boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
DECLARE target uuid; existing users%ROWTYPE; registered record; normalized text := lower(btrim(p_email));
BEGIN
  IF p_subject IS NULL OR length(p_subject) NOT BETWEEN 1 AND 255 OR p_locale NOT IN ('ar','en') THEN
    RETURN QUERY SELECT NULL::uuid,false; RETURN;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_subject, 20261008));
  SELECT a.user_id INTO target FROM apple_auth_identities a WHERE a.subject=p_subject;
  IF target IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(target::text, 20260912));
    SELECT * INTO existing FROM users WHERE id=target FOR UPDATE;
    IF existing.id IS NULL OR existing.disabled_at IS NOT NULL
      OR existing.deletion_requested_at <= now()-interval '14 days' THEN
      RETURN QUERY SELECT NULL::uuid,false; RETURN;
    END IF;
    -- A fresh Apple sign-in can reach the existing deletion recovery screen.
    RETURN QUERY SELECT target,false; RETURN;
  END IF;
  IF normalized IS NULL OR normalized = '' THEN RETURN QUERY SELECT NULL::uuid,false; RETURN; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(normalized, 20260920));
  IF EXISTS (SELECT 1 FROM users WHERE lower(email)=normalized) THEN
    RETURN QUERY SELECT NULL::uuid,false; RETURN;
  END IF;
  SELECT * INTO registered FROM app.register_email_account(NULL,normalized,p_name,p_password_hash,p_locale);
  IF NOT registered.created THEN RETURN QUERY SELECT NULL::uuid,false; RETURN; END IF;
  INSERT INTO user_email_verifications(user_id,email) VALUES(registered.user_id,normalized);
  DELETE FROM account_email_onboarding WHERE account_email_onboarding.user_id=registered.user_id;
  INSERT INTO apple_auth_identities(subject,user_id) VALUES(p_subject,registered.user_id);
  RETURN QUERY SELECT registered.user_id,true;
END $$;

CREATE FUNCTION app.apple_subject_for_user(p_user uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
  SELECT subject FROM apple_auth_identities
    WHERE user_id=p_user AND p_user=app.current_user_id()
$$;

CREATE FUNCTION app.attach_apple_account_phone(p_user uuid, p_phone text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
BEGIN
  IF p_user IS DISTINCT FROM app.current_user_id()
    OR p_phone IS NULL OR p_phone !~ '^\+[1-9][0-9]{7,14}$'
    OR NOT EXISTS (SELECT 1 FROM apple_auth_identities WHERE user_id=p_user)
  THEN RETURN false; END IF;
  PERFORM 1 FROM users WHERE id=p_user AND disabled_at IS NULL AND deletion_requested_at IS NULL
    AND (phone_e164 IS NULL OR phone_e164=p_phone) FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  UPDATE users SET phone_e164=p_phone WHERE id=p_user;
  RETURN true;
EXCEPTION WHEN unique_violation THEN RETURN false;
END $$;
REVOKE ALL ON FUNCTION app.resolve_apple_account(text,text,text,text,text) FROM PUBLIC, dawaee_worker;
REVOKE ALL ON FUNCTION app.apple_subject_for_user(uuid) FROM PUBLIC, dawaee_worker;
REVOKE ALL ON FUNCTION app.attach_apple_account_phone(uuid,text) FROM PUBLIC, dawaee_worker;
GRANT EXECUTE ON FUNCTION app.resolve_apple_account(text,text,text,text,text) TO dawaee_app;
GRANT EXECUTE ON FUNCTION app.apple_subject_for_user(uuid) TO dawaee_app;
GRANT EXECUTE ON FUNCTION app.attach_apple_account_phone(uuid,text) TO dawaee_app;
