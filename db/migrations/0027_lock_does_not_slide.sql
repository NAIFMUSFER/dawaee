-- A lockout is fifteen minutes from when it started, not fifteen minutes from
-- the attacker's last attempt.
--
-- `record_login_failure` recomputed `locked_until` as `now() + lock_minutes` on
-- every failure once the threshold was crossed. While an account was locked
-- nothing called it — the login path returned early — so the sliding window was
-- invisible. It stops being invisible now that a failed attempt against a
-- locked account is recorded, which it must be: without recording, the lock
-- window is a stretch of time in which an attacker can guess as often as they
-- like and no counter moves.
--
-- Those two requirements pull against each other, and the resolution is to keep
-- counting but stop the clock moving:
--
--   * every wrong guess still increments `failed_login_count`, so there is no
--     free guessing window;
--   * `locked_until` is only ever SET, never pushed further out, so an attacker
--     cannot hold a patient out of their own medication reminders indefinitely
--     by sending one wrong password every fourteen minutes.
--
-- The availability half matters as much as the brute-force half here. A patient
-- locked out of this app does not see their doses, and a caregiver watching for
-- a missed-dose alert does not get one. A lockout that an outsider can renew
-- forever, on nothing but a known phone number, would be a denial of service
-- against someone's medication schedule.
--
-- COALESCE is what makes it stick: once `locked_until` holds a timestamp, it is
-- kept. `app.clear_login_failures` (on a successful sign-in) is still the way
-- it is released, and an expired lock is cleared by the same path the next time
-- the account authenticates successfully.

CREATE OR REPLACE FUNCTION app.record_login_failure(
  p_user_id uuid, p_max_attempts int, p_lock_minutes int
) RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
DECLARE
  lock_at timestamptz := NULL;
BEGIN
  UPDATE user_credentials
     SET failed_login_count = failed_login_count + 1,
         locked_until = CASE
           WHEN failed_login_count + 1 >= p_max_attempts
           -- Only fills an empty or already-expired lock. An attempt made while
           -- the account is locked counts, but does not extend the lock.
           THEN CASE
             WHEN locked_until IS NULL OR locked_until <= now()
             THEN now() + make_interval(mins => p_lock_minutes)
             ELSE locked_until
           END
           ELSE locked_until
         END
   WHERE user_id = p_user_id
   RETURNING locked_until INTO lock_at;
  RETURN lock_at;
END $$;

COMMENT ON FUNCTION app.record_login_failure(uuid, int, int) IS
  'Counts a failed sign-in. Sets locked_until when the attempt threshold is '
  'crossed, but never pushes an existing lock further out — a lockout is a '
  'fixed window from when it began, so it cannot be renewed indefinitely by an '
  'outsider who only knows the account identifier.';
