-- =============================================================================
-- Dawaee — 0010: OTP issue/verify as SECURITY DEFINER functions
--
-- Migration 0008 revoked the app role's access to auth_otp_challenges so a
-- code hash can never be read by request-serving code. These two functions are
-- the only way in. Beyond hiding the hash, doing it here makes the rate limit
-- and the attempt counter atomic across every API instance — a horizontally
-- scaled deployment cannot be raced into extra guesses.
-- =============================================================================

CREATE OR REPLACE FUNCTION app.issue_otp(
  p_phone text,
  p_code_hash text,
  p_ttl_minutes int,
  p_max_attempts int,
  p_ip_hash text,
  p_window_minutes int DEFAULT 15,
  p_max_per_window int DEFAULT 5,
  p_cooldown_seconds int DEFAULT 45
) RETURNS TABLE (challenge_id uuid, expires_at timestamptz, outcome text, retry_after_seconds int)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
#variable_conflict use_column
DECLARE
  recent_count int;
  last_created timestamptz;
  elapsed numeric;
  new_id uuid;
  new_expiry timestamptz;
BEGIN
  SELECT count(*), max(created_at) INTO recent_count, last_created
    FROM auth_otp_challenges
   WHERE phone_e164 = p_phone
     AND created_at > now() - make_interval(mins => p_window_minutes);

  IF recent_count >= p_max_per_window THEN
    RETURN QUERY SELECT NULL::uuid, NULL::timestamptz, 'rate_limited'::text,
                        (p_window_minutes * 60)::int;
    RETURN;
  END IF;

  IF last_created IS NOT NULL THEN
    elapsed := extract(epoch FROM (now() - last_created));
    IF elapsed < p_cooldown_seconds THEN
      RETURN QUERY SELECT NULL::uuid, NULL::timestamptz, 'cooldown'::text,
                          ceil(p_cooldown_seconds - elapsed)::int;
      RETURN;
    END IF;
  END IF;

  -- Retire any earlier live challenge so only the newest code can be used.
  UPDATE auth_otp_challenges SET consumed_at = now()
   WHERE phone_e164 = p_phone AND consumed_at IS NULL;

  INSERT INTO auth_otp_challenges (phone_e164, code_hash, max_attempts, expires_at, created_ip_hash)
  VALUES (p_phone, p_code_hash, p_max_attempts, now() + make_interval(mins => p_ttl_minutes), p_ip_hash)
  RETURNING id, auth_otp_challenges.expires_at INTO new_id, new_expiry;

  RETURN QUERY SELECT new_id, new_expiry, 'issued'::text, 0;
END $$;

/**
 * Verify a code. Returns an outcome rather than raising, so the caller maps it
 * to an API error without the database transaction being poisoned.
 * The comparison is on hashes only; the plaintext never reaches the database.
 */
CREATE OR REPLACE FUNCTION app.verify_otp(p_phone text, p_code_hash text)
RETURNS TABLE (outcome text, attempts_remaining int)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
#variable_conflict use_column
DECLARE ch auth_otp_challenges%ROWTYPE;
BEGIN
  SELECT * INTO ch FROM auth_otp_challenges
   WHERE phone_e164 = p_phone AND consumed_at IS NULL
   ORDER BY created_at DESC LIMIT 1
   FOR UPDATE;

  IF ch.id IS NULL THEN
    RETURN QUERY SELECT 'no_challenge'::text, 0; RETURN;
  END IF;

  IF ch.expires_at <= now() THEN
    UPDATE auth_otp_challenges SET consumed_at = now() WHERE id = ch.id;
    RETURN QUERY SELECT 'expired'::text, 0; RETURN;
  END IF;

  IF ch.attempts >= ch.max_attempts THEN
    UPDATE auth_otp_challenges SET consumed_at = now() WHERE id = ch.id;
    RETURN QUERY SELECT 'too_many_attempts'::text, 0; RETURN;
  END IF;

  -- Both sides are fixed-length hex digests, so a plain comparison here is not
  -- a timing oracle for the code itself.
  IF ch.code_hash <> p_code_hash THEN
    UPDATE auth_otp_challenges SET attempts = attempts + 1 WHERE id = ch.id;
    RETURN QUERY SELECT 'invalid'::text, (ch.max_attempts - ch.attempts - 1)::int; RETURN;
  END IF;

  UPDATE auth_otp_challenges SET consumed_at = now() WHERE id = ch.id;
  RETURN QUERY SELECT 'verified'::text, 0;
END $$;

/** Housekeeping: consumed and expired challenges are not kept around. */
CREATE OR REPLACE FUNCTION app.purge_expired_otp(p_older_than_hours int DEFAULT 24)
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
DECLARE removed int;
BEGIN
  DELETE FROM auth_otp_challenges
   WHERE created_at < now() - make_interval(hours => p_older_than_hours);
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END $$;

REVOKE EXECUTE ON FUNCTION app.issue_otp(text,text,int,int,text,int,int,int) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.verify_otp(text,text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.purge_expired_otp(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.issue_otp(text,text,int,int,text,int,int,int) TO dawaee_app;
GRANT EXECUTE ON FUNCTION app.verify_otp(text,text) TO dawaee_app;
GRANT EXECUTE ON FUNCTION app.purge_expired_otp(int) TO dawaee_worker;
