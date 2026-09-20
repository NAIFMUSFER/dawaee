-- Registration is a mailbox proof, not an account lookup.  A typed address
-- must never reserve an identity, and the anonymous response must not reveal
-- whether an account already exists.  Only the holder of the emailed bearer
-- token can choose the account name/password and create the account.
CREATE TABLE email_registration_challenges (
  email text NOT NULL CHECK (email = lower(email) AND email = btrim(email)),
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  locale text NOT NULL CHECK (locale IN ('ar','en')),
  expires_at timestamptz NOT NULL,
  payload text,
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_id uuid,
  leased_until timestamptz,
  completed_at timestamptz,
  completed_user_id uuid REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX email_registration_challenges_email_idx ON email_registration_challenges(email);
REVOKE ALL ON email_registration_challenges FROM PUBLIC, dawaee_app, dawaee_worker;
ALTER TABLE email_registration_challenges ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_registration_challenges FORCE ROW LEVEL SECURITY;
SELECT count(*) FROM app.ensure_definer_policies();

-- Always returns void.  Existing and unknown mailboxes therefore have the
-- same SQL and HTTP contract.  An existing account gets no account-creation
-- link; the caller can use sign-in or the equally opaque recovery request.
CREATE FUNCTION app.request_email_registration(
  p_email text, p_token_hash text, p_locale text, p_payload text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
DECLARE normalized text := lower(btrim(p_email));
BEGIN
  IF normalized = '' OR p_token_hash !~ '^[a-f0-9]{64}$'
     OR p_locale NOT IN ('ar','en') THEN
    RAISE EXCEPTION 'Invalid registration request' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(normalized, 20260920));
  IF EXISTS (SELECT 1 FROM users WHERE lower(email)=normalized) THEN
    DELETE FROM email_registration_challenges WHERE email=normalized;
    RETURN;
  END IF;
  DELETE FROM email_registration_challenges WHERE email=normalized AND expires_at<=now();
  INSERT INTO email_registration_challenges(
    email,token_hash,locale,expires_at,payload
  ) VALUES (
    normalized,p_token_hash,p_locale,now()+interval '30 minutes',p_payload
  );
END $$;
REVOKE ALL ON FUNCTION app.request_email_registration(text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.request_email_registration(text,text,text,text) TO dawaee_app;

CREATE FUNCTION app.complete_email_registration(
  p_token_hash text, p_display_name text, p_password_hash text
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
DECLARE item email_registration_challenges%ROWTYPE; registered record; target_email text;
BEGIN
  IF p_display_name IS NULL OR btrim(p_display_name) = '' OR length(btrim(p_display_name)) > 120
     OR p_password_hash IS NULL OR length(p_password_hash) < 32 THEN
    RETURN NULL;
  END IF;
  SELECT email INTO target_email FROM email_registration_challenges WHERE token_hash=p_token_hash;
  IF target_email IS NULL THEN RETURN NULL; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(target_email, 20260920));
  SELECT * INTO item FROM email_registration_challenges WHERE token_hash=p_token_hash FOR UPDATE;
  IF NOT FOUND OR item.expires_at<=now() THEN RETURN NULL; END IF;
  IF item.completed_at IS NOT NULL THEN RETURN item.completed_user_id; END IF;
  IF EXISTS (SELECT 1 FROM users WHERE lower(email)=item.email) THEN RETURN NULL; END IF;

  SELECT * INTO registered FROM app.register_email_account(
    NULL,item.email,btrim(p_display_name),p_password_hash,item.locale);
  IF NOT registered.created OR registered.self_profile_id IS NULL THEN RETURN NULL; END IF;

  INSERT INTO user_email_verifications(user_id,email)
    VALUES(registered.user_id,item.email);
  DELETE FROM account_email_onboarding WHERE user_id=registered.user_id;
  DELETE FROM email_registration_challenges
    WHERE email=item.email AND token_hash<>item.token_hash;
  UPDATE email_registration_challenges SET completed_at=now(),
    completed_user_id=registered.user_id,payload=NULL,lease_id=NULL,leased_until=NULL
    WHERE email=item.email;
  RETURN registered.user_id;
EXCEPTION WHEN unique_violation THEN
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.complete_email_registration(text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.complete_email_registration(text,text,text) TO dawaee_app;

CREATE FUNCTION app.claim_registration_emails(p_lease uuid)
RETURNS TABLE(token_hash text,payload text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
BEGIN
  UPDATE email_registration_challenges c SET payload=NULL
    WHERE c.expires_at<=now() AND c.payload IS NOT NULL;
  RETURN QUERY WITH jobs AS (
    SELECT c.token_hash FROM email_registration_challenges c
    WHERE c.payload IS NOT NULL AND c.completed_at IS NULL AND c.expires_at>now()
      AND c.attempts<6 AND c.next_attempt_at<=now()
      AND (c.leased_until IS NULL OR c.leased_until<now())
    ORDER BY c.next_attempt_at LIMIT 5 FOR UPDATE SKIP LOCKED
  ) UPDATE email_registration_challenges c
    SET lease_id=p_lease,leased_until=now()+interval '2 minutes',attempts=c.attempts+1
    FROM jobs WHERE c.token_hash=jobs.token_hash RETURNING c.token_hash,c.payload;
END $$;
CREATE FUNCTION app.finish_registration_email(
  p_token_hash text,p_lease uuid,p_sent boolean
) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
  UPDATE email_registration_challenges
    SET payload=CASE WHEN p_sent OR attempts>=6 THEN NULL ELSE payload END,
      leased_until=NULL,lease_id=NULL,
      next_attempt_at=now()+make_interval(secs=>least(300,15*(2^attempts)::integer))
    WHERE token_hash=p_token_hash AND lease_id=p_lease
$$;
REVOKE ALL ON FUNCTION app.claim_registration_emails(uuid),
  app.finish_registration_email(text,uuid,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.claim_registration_emails(uuid),
  app.finish_registration_email(text,uuid,boolean) TO dawaee_app;
