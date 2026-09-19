-- Email ownership is independent of a typed login identifier. Never backfill
-- verification for existing accounts. Keep secrets outside users / public RLS.
CREATE TABLE user_email_verifications (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  email text NOT NULL,
  verified_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE account_email_challenges (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose text NOT NULL CHECK (purpose IN ('verify', 'reset')),
  email text NOT NULL,
  previous_email text,
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  credential_updated_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  -- Encrypted delivery payload, never a plaintext bearer token.
  payload text,
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_id uuid,
  leased_until timestamptz,
  completed_at timestamptz,
  request_hash text,
  PRIMARY KEY (user_id, purpose)
);
REVOKE ALL ON user_email_verifications, account_email_challenges FROM PUBLIC, dawaee_app, dawaee_worker;
ALTER TABLE user_email_verifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_email_verifications FORCE ROW LEVEL SECURITY;
ALTER TABLE account_email_challenges ENABLE ROW LEVEL SECURITY;
ALTER TABLE account_email_challenges FORCE ROW LEVEL SECURITY;
SELECT count(*) FROM app.ensure_definer_policies();

CREATE FUNCTION app.has_verified_email(p_user_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
  SELECT p_user_id = app.current_user_id() AND EXISTS (
    SELECT 1 FROM users u JOIN user_email_verifications v ON v.user_id=u.id
    WHERE u.id=p_user_id AND lower(u.email)=v.email AND u.disabled_at IS NULL
  )
$$;
REVOKE ALL ON FUNCTION app.has_verified_email(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.has_verified_email(uuid) TO dawaee_app;

-- Even an older client editing email cannot reuse a previous verification.
CREATE FUNCTION app.invalidate_email_verification() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
BEGIN
  IF lower(NEW.email) IS DISTINCT FROM lower(OLD.email) THEN
    DELETE FROM user_email_verifications WHERE user_id=NEW.id;
    DELETE FROM account_email_challenges WHERE user_id=NEW.id AND purpose='reset';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.invalidate_email_verification() FROM PUBLIC;
CREATE TRIGGER invalidate_email_verification BEFORE UPDATE OF email ON users
  FOR EACH ROW EXECUTE FUNCTION app.invalidate_email_verification();

-- Called after password verification; recheck both credential and session under
-- the common account lock so a concurrent password reset cannot be bypassed.
CREATE FUNCTION app.request_email_verification(
  p_user_id uuid, p_session_id uuid, p_email text, p_token_hash text,
  p_expected_hash text, p_payload text
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
DECLARE old_email text; changed_at timestamptz;
BEGIN
  IF p_user_id IS DISTINCT FROM app.current_user_id() THEN RETURN false; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::text, 20260912));
  SELECT u.email, c.password_updated_at INTO old_email, changed_at
    FROM users u JOIN user_credentials c ON c.user_id=u.id
    WHERE u.id=p_user_id AND u.disabled_at IS NULL AND c.password_hash=p_expected_hash FOR UPDATE OF u;
  IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM auth_sessions WHERE id=p_session_id
      AND user_id=p_user_id AND revoked_at IS NULL AND expires_at>now()) THEN RETURN false; END IF;
  IF EXISTS (SELECT 1 FROM users WHERE lower(email)=p_email AND id<>p_user_id) THEN RETURN false; END IF;
  INSERT INTO account_email_challenges(user_id,purpose,email,previous_email,token_hash,credential_updated_at,expires_at,payload)
    VALUES(p_user_id,'verify',p_email,old_email,p_token_hash,changed_at,now()+interval '30 minutes',p_payload)
    ON CONFLICT(user_id,purpose) DO UPDATE SET email=excluded.email, previous_email=excluded.previous_email,
      token_hash=excluded.token_hash, credential_updated_at=excluded.credential_updated_at,
      expires_at=excluded.expires_at,payload=excluded.payload,attempts=0,next_attempt_at=now(),
      lease_id=NULL,leased_until=NULL,completed_at=NULL,request_hash=NULL;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION app.request_email_verification(uuid,uuid,text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.request_email_verification(uuid,uuid,text,text,text,text) TO dawaee_app;

-- No caller-visible account information. Only previously verified mailboxes
-- receive a job. The API returns the same acknowledgement without waiting for SMTP.
CREATE FUNCTION app.request_email_recovery(p_email text,p_token_hash text,p_payload text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
DECLARE uid uuid; changed_at timestamptz;
BEGIN
  SELECT u.id INTO uid FROM users u JOIN user_email_verifications v ON v.user_id=u.id
    WHERE lower(u.email)=p_email AND v.email=p_email AND u.disabled_at IS NULL;
  IF uid IS NULL THEN RETURN; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(uid::text, 20260912));
  SELECT c.password_updated_at INTO changed_at FROM users u
    JOIN user_email_verifications v ON v.user_id=u.id JOIN user_credentials c ON c.user_id=u.id
    WHERE u.id=uid AND lower(u.email)=p_email AND v.email=p_email AND u.disabled_at IS NULL FOR UPDATE OF u;
  IF NOT FOUND THEN RETURN; END IF;
  INSERT INTO account_email_challenges(user_id,purpose,email,previous_email,token_hash,credential_updated_at,expires_at,payload)
    VALUES(uid,'reset',p_email,p_email,p_token_hash,changed_at,now()+interval '15 minutes',p_payload)
    ON CONFLICT(user_id,purpose) DO UPDATE SET email=excluded.email, previous_email=excluded.previous_email,
      token_hash=excluded.token_hash, credential_updated_at=excluded.credential_updated_at,
      expires_at=excluded.expires_at,payload=excluded.payload,attempts=0,next_attempt_at=now(),
      lease_id=NULL,leased_until=NULL,completed_at=NULL,request_hash=NULL;
END $$;
REVOKE ALL ON FUNCTION app.request_email_recovery(text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.request_email_recovery(text,text,text) TO dawaee_app;

CREATE FUNCTION app.complete_email_action(p_token_hash text,p_purpose text,p_password_hash text,p_request_hash text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
DECLARE item account_email_challenges%ROWTYPE; uid uuid; current_email text; changed_at timestamptz;
BEGIN
  IF p_purpose NOT IN ('verify','reset') THEN RETURN NULL; END IF;
  SELECT user_id INTO uid FROM account_email_challenges WHERE token_hash=p_token_hash AND purpose=p_purpose;
  IF uid IS NULL THEN RETURN NULL; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(uid::text, 20260912));
  SELECT * INTO item FROM account_email_challenges WHERE token_hash=p_token_hash AND purpose=p_purpose FOR UPDATE;
  IF NOT FOUND OR item.expires_at<=now() THEN RETURN NULL; END IF;
  SELECT u.email,c.password_updated_at INTO current_email,changed_at FROM users u
    JOIN user_credentials c ON c.user_id=u.id WHERE u.id=uid AND u.disabled_at IS NULL FOR UPDATE OF u;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF item.completed_at IS NOT NULL THEN
    IF p_purpose='reset' AND item.request_hash=p_request_hash AND item.completed_at=changed_at
       AND lower(current_email)=item.email THEN RETURN uid; END IF;
    RETURN NULL;
  END IF;
  IF changed_at IS DISTINCT FROM item.credential_updated_at
     OR current_email IS DISTINCT FROM item.previous_email THEN RETURN NULL; END IF;
  IF p_purpose='verify' THEN
    IF EXISTS(SELECT 1 FROM users WHERE lower(email)=item.email AND id<>uid) THEN RETURN NULL; END IF;
    BEGIN
      UPDATE users SET email=item.email WHERE id=uid;
    EXCEPTION WHEN unique_violation THEN RETURN NULL;
    END;
    INSERT INTO user_email_verifications(user_id,email) VALUES(uid,item.email)
      ON CONFLICT(user_id) DO UPDATE SET email=excluded.email,verified_at=now();
  ELSE
    IF NOT EXISTS(SELECT 1 FROM user_email_verifications WHERE user_id=uid AND email=item.email)
       OR p_password_hash IS NULL OR length(p_password_hash)<32
       OR p_request_hash IS NULL OR p_request_hash !~ '^[a-f0-9]{64}$' THEN RETURN NULL; END IF;
    PERFORM app.set_password(uid,p_password_hash);
    UPDATE auth_sessions SET revoked_at=now() WHERE user_id=uid AND revoked_at IS NULL;
    UPDATE push_tokens SET active=false WHERE user_id=uid AND active;
    DELETE FROM account_email_challenges WHERE user_id=uid AND purpose='verify';
  END IF;
  UPDATE account_email_challenges SET completed_at=now(),request_hash=p_request_hash,payload=NULL,
    lease_id=NULL,leased_until=NULL WHERE user_id=uid AND purpose=p_purpose;
  RETURN uid;
END $$;
REVOKE ALL ON FUNCTION app.complete_email_action(text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.complete_email_action(text,text,text,text) TO dawaee_app;

-- API-owned durable mail queue. A lease and stable provider idempotency key
-- survive a process restart / ambiguous provider response. No worker DB grants.
CREATE FUNCTION app.claim_account_emails(p_lease uuid) RETURNS TABLE(token_hash text,payload text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
BEGIN
  UPDATE account_email_challenges c SET payload=NULL WHERE c.expires_at<=now() AND c.payload IS NOT NULL;
  RETURN QUERY WITH jobs AS (
    SELECT c.user_id,c.purpose FROM account_email_challenges c
    WHERE c.payload IS NOT NULL AND c.completed_at IS NULL AND c.expires_at>now()
      AND c.attempts<6 AND c.next_attempt_at<=now() AND (c.leased_until IS NULL OR c.leased_until<now())
    ORDER BY c.next_attempt_at LIMIT 5 FOR UPDATE SKIP LOCKED
  ) UPDATE account_email_challenges c SET lease_id=p_lease,leased_until=now()+interval '2 minutes',attempts=c.attempts+1
    FROM jobs WHERE c.user_id=jobs.user_id AND c.purpose=jobs.purpose RETURNING c.token_hash,c.payload;
END $$;
CREATE FUNCTION app.finish_account_email(p_token_hash text,p_lease uuid,p_sent boolean) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
  UPDATE account_email_challenges SET payload=CASE WHEN p_sent OR attempts>=6 THEN NULL ELSE payload END,
    leased_until=NULL,lease_id=NULL,next_attempt_at=now()+make_interval(secs=>least(300,15*(2^attempts)::integer))
    WHERE token_hash=p_token_hash AND lease_id=p_lease
$$;
REVOKE ALL ON FUNCTION app.claim_account_emails(uuid), app.finish_account_email(text,uuid,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.claim_account_emails(uuid), app.finish_account_email(text,uuid,boolean) TO dawaee_app;
