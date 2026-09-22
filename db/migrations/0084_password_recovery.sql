-- A verified, recent Firebase phone proof may recover only its existing account.
-- One bounded receipt per account supports lost-response retries without letting
-- a refreshed ID token reuse the same authentication to choose another password.
CREATE TABLE password_recovery_receipts (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  proof_key text NOT NULL CHECK (proof_key ~ '^[a-f0-9]{64}$'),
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  authenticated_at timestamptz NOT NULL,
  completed_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON password_recovery_receipts FROM PUBLIC, dawaee_app, dawaee_worker;
ALTER TABLE password_recovery_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE password_recovery_receipts FORCE ROW LEVEL SECURITY;
SELECT count(*) FROM app.ensure_definer_policies();

CREATE FUNCTION app.recover_password(
  p_phone text, p_authenticated_at timestamptz, p_proof_key text,
  p_request_hash text, p_password_hash text
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
DECLARE
  uid uuid;
  changed_at timestamptz;
  receipt password_recovery_receipts%ROWTYPE;
BEGIN
  IF p_authenticated_at IS NULL OR p_authenticated_at < now() - interval '5 minutes'
     OR p_authenticated_at > now() + interval '5 seconds'
     OR p_proof_key IS NULL OR p_proof_key !~ '^[a-f0-9]{64}$'
     OR p_request_hash IS NULL OR p_request_hash !~ '^[a-f0-9]{64}$'
     OR p_password_hash IS NULL OR length(p_password_hash) < 32 THEN RETURN NULL; END IF;
  SELECT id INTO uid FROM users WHERE phone_e164 = p_phone AND disabled_at IS NULL;
  IF uid IS NULL THEN RETURN NULL; END IF;
  -- Shared with password changes, refresh, disable and logout-all. Never lock
  -- a session tuple before this advisory lock (avoids refresh/FK deadlocks).
  PERFORM pg_advisory_xact_lock(hashtextextended(uid::text, 20260912));
  IF NOT EXISTS (SELECT 1 FROM users WHERE id = uid AND phone_e164 = p_phone AND disabled_at IS NULL)
    THEN RETURN NULL; END IF;
  SELECT password_updated_at INTO changed_at FROM user_credentials WHERE user_id = uid;
  SELECT * INTO receipt FROM password_recovery_receipts WHERE user_id = uid;
  IF receipt.proof_key = p_proof_key THEN
    IF receipt.request_hash = p_request_hash AND receipt.completed_at = changed_at THEN RETURN uid; END IF;
    RETURN NULL;
  END IF;
  IF receipt.authenticated_at >= p_authenticated_at
     OR date_trunc('second', changed_at) > p_authenticated_at THEN RETURN NULL; END IF;
  PERFORM app.set_password(uid, p_password_hash);
  UPDATE auth_sessions SET revoked_at = now() WHERE user_id = uid AND revoked_at IS NULL;
  UPDATE push_tokens SET active = false WHERE user_id = uid AND active;
  INSERT INTO password_recovery_receipts (user_id, proof_key, request_hash, authenticated_at, completed_at)
    VALUES (uid, p_proof_key, p_request_hash, p_authenticated_at, now())
    ON CONFLICT (user_id) DO UPDATE SET proof_key = excluded.proof_key,
      request_hash = excluded.request_hash, authenticated_at = excluded.authenticated_at,
      completed_at = excluded.completed_at;
  RETURN uid;
END $$;
REVOKE ALL ON FUNCTION app.recover_password(text,timestamptz,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.recover_password(text,timestamptz,text,text,text) TO dawaee_app;
COMMENT ON FUNCTION app.recover_password(text,timestamptz,text,text,text) IS
  'Server-only auth plane: call after Firebase signature, audience, phone provider and recent auth_time validation. No client user ID, no account creation, no worker access.';
