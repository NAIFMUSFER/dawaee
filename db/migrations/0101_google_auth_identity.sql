-- Google subject is the stable identity; a mutable mailbox is not its key.
CREATE TABLE google_auth_identities (
  subject text PRIMARY KEY CHECK (length(subject) BETWEEN 1 AND 255),
  user_id uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON google_auth_identities FROM PUBLIC, dawaee_app, dawaee_worker;
ALTER TABLE google_auth_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE google_auth_identities FORCE ROW LEVEL SECURITY;
SELECT count(*) FROM app.ensure_definer_policies();

-- Called only by the API after signature, issuer, audience, expiry and Google
-- mailbox-authority validation. Never expose this function to anon/authenticated.
CREATE FUNCTION app.resolve_google_account(
  p_subject text, p_email text, p_name text, p_password_hash text, p_locale text
) RETURNS TABLE(user_id uuid, created boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
DECLARE target uuid; existing users%ROWTYPE; registered record; normalized text := lower(btrim(p_email));
BEGIN
  IF p_subject IS NULL OR length(p_subject) NOT BETWEEN 1 AND 255
    OR normalized IS NULL OR normalized = '' OR p_locale NOT IN ('ar','en') THEN
    RETURN QUERY SELECT NULL::uuid, false; RETURN;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_subject, 20261007));
  SELECT g.user_id INTO target FROM google_auth_identities g WHERE g.subject=p_subject;
  IF target IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(target::text, 20260912));
    SELECT * INTO existing FROM users WHERE id=target FOR UPDATE;
    IF existing.disabled_at IS NOT NULL OR existing.deletion_requested_at IS NOT NULL THEN
      RETURN QUERY SELECT NULL::uuid, false; RETURN;
    END IF;
    RETURN QUERY SELECT target,false; RETURN;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(normalized, 20260920));
  SELECT * INTO existing FROM users WHERE lower(email)=normalized;
  IF existing.id IS NOT NULL THEN
    -- Gmail ownership can link an already verified mailbox. Workspace email
    -- may be reassigned by an administrator; never auto-link an old account.
    IF normalized NOT LIKE '%@gmail.com' OR NOT EXISTS (
      SELECT 1 FROM user_email_verifications v WHERE v.user_id=existing.id AND v.email=normalized
    ) THEN RETURN QUERY SELECT NULL::uuid,false; RETURN; END IF;
    target := existing.id;
    PERFORM pg_advisory_xact_lock(hashtextextended(target::text, 20260912));
    SELECT * INTO existing FROM users WHERE id=target FOR UPDATE;
    IF existing.disabled_at IS NOT NULL OR existing.deletion_requested_at IS NOT NULL
      OR lower(existing.email) IS DISTINCT FROM normalized
      OR EXISTS (SELECT 1 FROM google_auth_identities g WHERE g.user_id=target) THEN
      RETURN QUERY SELECT NULL::uuid,false; RETURN;
    END IF;
    INSERT INTO google_auth_identities(subject,user_id) VALUES(p_subject,target);
    RETURN QUERY SELECT target,false; RETURN;
  END IF;
  SELECT * INTO registered FROM app.register_email_account(NULL,normalized,p_name,p_password_hash,p_locale);
  IF NOT registered.created THEN RETURN QUERY SELECT NULL::uuid,false; RETURN; END IF;
  INSERT INTO user_email_verifications(user_id,email) VALUES(registered.user_id,normalized);
  DELETE FROM account_email_onboarding WHERE account_email_onboarding.user_id=registered.user_id;
  INSERT INTO google_auth_identities(subject,user_id) VALUES(p_subject,registered.user_id);
  RETURN QUERY SELECT registered.user_id,true;
END $$;
REVOKE ALL ON FUNCTION app.resolve_google_account(text,text,text,text,text) FROM PUBLIC, dawaee_worker;
GRANT EXECUTE ON FUNCTION app.resolve_google_account(text,text,text,text,text) TO dawaee_app;
