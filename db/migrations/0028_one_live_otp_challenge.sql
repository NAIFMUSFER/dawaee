-- Only one sign-in code can be live for a phone number at a time.
--
-- `issue_otp` retired the previous challenge and inserted the new one:
--
--   UPDATE auth_otp_challenges SET consumed_at = now()
--    WHERE phone_e164 = p_phone AND consumed_at IS NULL;
--   INSERT INTO auth_otp_challenges (...) VALUES (...);
--
-- Correct in sequence, and not correct under concurrency. Two transactions
-- issuing for the same number both run the UPDATE before either INSERT has
-- committed, so neither sees the other's row to retire, and both insert.
-- Measured with two connections against this function: twelve trials produced
-- two simultaneously valid codes in six of them.
--
-- The count that guards the per-identifier rate limit races the same way. Two
-- callers can both read "four codes in the window" and both issue a fifth.
--
-- Why it matters beyond tidiness: the attempt counter belongs to a CHALLENGE,
-- not to a phone number. Two live challenges are two independent budgets of
-- five guesses, and the app resolves a verification against the newest row —
-- so the older one sits there, valid, with its own untouched allowance, for the
-- rest of its five-minute life.
--
-- Two controls, in the order they take effect.
--
-- 1. A transaction-scoped advisory lock keyed on the phone number, taken before
--    anything is read. Issuance for one number serializes, so the second caller
--    reads the first's committed row, retires it, and the rate-limit count is
--    the real one. Different numbers do not contend: the key is derived from
--    the number itself. It is `pg_advisory_xact_lock`, not the `try_` variant —
--    a caller that arrives second should wait its turn, not silently skip.
--
-- 2. A partial unique index, so the invariant survives an edit that removes the
--    lock. `consumed_at IS NULL` is the definition of live, and the index says
--    a number may have at most one such row. Same belt-and-braces shape as the
--    missed-dose index in 0025: the code is the fix, the constraint is what
--    stops the fix being quietly undone later.

-- Any duplicates already produced by the race are collapsed first, keeping the
-- newest — that is the one the verify path would have matched, so keeping it
-- preserves whatever a user is currently looking at on their phone.
UPDATE auth_otp_challenges c
   SET consumed_at = now()
  FROM (
    SELECT id, row_number() OVER (PARTITION BY phone_e164 ORDER BY created_at DESC, id DESC) AS rn
      FROM auth_otp_challenges
     WHERE consumed_at IS NULL
  ) ranked
 WHERE ranked.id = c.id AND ranked.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS auth_otp_one_live_per_phone_idx
  ON auth_otp_challenges (phone_e164)
  WHERE consumed_at IS NULL;

COMMENT ON INDEX auth_otp_one_live_per_phone_idx IS
  'A phone number has at most one live challenge. Two would be two independent '
  'attempt budgets against the same account.';

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
  -- Serializes issuance for THIS number and nothing else. Everything below —
  -- the window count, the cooldown check, the retire-then-insert — reads state
  -- that another caller could otherwise be halfway through changing.
  PERFORM pg_advisory_xact_lock(hashtext('otp:' || p_phone));

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
