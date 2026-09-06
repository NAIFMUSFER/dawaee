-- Authentication rate limits that survive a second replica and a restart.
--
-- `@fastify/rate-limit` is configured without a store, so it uses its
-- in-process LRU. Two consequences, and the second one is live today:
--
--   * N replicas mean N independent budgets. An attacker gets N times the
--     limit, and nothing in the application can tell.
--   * every restart resets every counter. The API runs on Render's free plan,
--     which spins a service down when idle and cold-starts it on the next
--     request — so an attacker does not need to wait for a deploy to get a
--     fresh budget, they only need the service to have been quiet.
--
-- The cheap global limiter stays in process: shedding obvious load does not
-- need to be exact, and a database round trip per request would be a worse
-- trade. What moves here is the small set of limits that exist to stop
-- credential attacks, where being approximately right is not good enough.
--
-- WHY POSTGRESQL AND NOT REDIS. Every route this protects already cannot
-- function without this database — a login that cannot read `user_credentials`
-- fails regardless. Adding a second datastore would add a failure mode, a
-- credential, a network path and an operational surface to protect something
-- that is already gated on Postgres being up. The fail-closed behaviour below
-- is only coherent BECAUSE of that: refusing to authenticate when the limiter
-- is unreachable costs nothing extra, since authentication was going to fail
-- anyway.
--
-- ── the bucket model ──────────────────────────────────────────────────────
--
-- A fixed window, keyed by (scope, key, window_start), incremented by one
-- statement. Not `SELECT count(*) FROM attempts WHERE created_at > …`: that
-- grows without bound, scans on every request, and races two callers into the
-- same count. `INSERT … ON CONFLICT DO UPDATE … RETURNING` is atomic on its
-- own — no advisory lock, no read-then-write — and touches exactly one row.
--
-- A fixed window admits the usual boundary burst: up to 2×max across the seam
-- between two windows. Accepted deliberately. A sliding log would fix it at the
-- cost of storing every attempt, and for "twelve sign-in attempts per ten
-- minutes" the difference between 12 and a worst-case 24 does not change what
-- an attacker can accomplish.
--
-- ── what goes in the key ──────────────────────────────────────────────────
--
-- Never a phone number, an email address or an IP address. The caller passes a
-- keyed digest, so this table cannot be read as a list of who tried to sign in
-- and from where. `scope` is a short constant like 'login:ip' or
-- 'login:identifier' and carries nothing about the subject.

CREATE TABLE IF NOT EXISTS auth_rate_buckets (
  scope         text        NOT NULL,
  key_hash      text        NOT NULL,
  window_start  timestamptz NOT NULL,
  count         integer     NOT NULL DEFAULT 0,
  PRIMARY KEY (scope, key_hash, window_start)
);

COMMENT ON TABLE auth_rate_buckets IS
  'Fixed-window counters for authentication rate limits, shared across API '
  'replicas and surviving restarts. Keys are keyed digests: no phone number, '
  'email address or IP address is stored here.';

-- Housekeeping deletes by age, so the index it needs is on the window.
CREATE INDEX IF NOT EXISTS auth_rate_buckets_window_idx
  ON auth_rate_buckets (window_start);

ALTER TABLE auth_rate_buckets ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_rate_buckets FORCE ROW LEVEL SECURITY;
-- No policy for anyone: the table is reachable only through the SECURITY
-- DEFINER functions below, exactly like the OTP challenges.

/**
 * Count one attempt against a bucket and say whether it is allowed.
 *
 * Returns the count AFTER this attempt, so the caller does not need a second
 * query, and `retry_after_seconds` measured to the end of the current window.
 *
 * The whole decision is one statement. Two API instances calling this at the
 * same instant for the same key serialize on the primary key, and both see a
 * correct running total.
 */
CREATE OR REPLACE FUNCTION app.consume_rate_budget(
  p_scope text,
  p_key_hash text,
  p_window_seconds int,
  p_max int
) RETURNS TABLE (allowed boolean, hits int, retry_after_seconds int)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
DECLARE
  w_start timestamptz;
  n int;
BEGIN
  -- Windows are aligned to absolute time rather than to first use, so every
  -- replica computes the same boundary for the same key without coordinating.
  w_start := to_timestamp(floor(extract(epoch FROM now()) / p_window_seconds) * p_window_seconds);

  INSERT INTO auth_rate_buckets (scope, key_hash, window_start, count)
  VALUES (p_scope, p_key_hash, w_start, 1)
  ON CONFLICT (scope, key_hash, window_start)
  DO UPDATE SET count = auth_rate_buckets.count + 1
  RETURNING count INTO n;

  RETURN QUERY SELECT
    n <= p_max,
    n,
    GREATEST(1, ceil(extract(epoch FROM (w_start + make_interval(secs => p_window_seconds) - now())))::int);
END $$;

/**
 * Forget a bucket. Used after a SUCCESSFUL sign-in so a person who mistyped
 * their password twice and then got it right is not still carrying those
 * attempts for the rest of the window.
 *
 * Deliberately not called on failure paths: that is the whole point of the
 * counter.
 */
CREATE OR REPLACE FUNCTION app.clear_rate_budget(p_scope text, p_key_hash text)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
  DELETE FROM auth_rate_buckets WHERE scope = p_scope AND key_hash = p_key_hash
$$;

/** Retention. Windows are minutes long; nothing here is useful after a day. */
CREATE OR REPLACE FUNCTION app.purge_rate_buckets(p_older_than_hours int DEFAULT 24)
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
DECLARE removed int;
BEGIN
  DELETE FROM auth_rate_buckets
   WHERE window_start < now() - make_interval(hours => p_older_than_hours);
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END $$;

REVOKE EXECUTE ON FUNCTION app.consume_rate_budget(text,text,int,int) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.clear_rate_budget(text,text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.purge_rate_buckets(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.consume_rate_budget(text,text,int,int) TO dawaee_app;
GRANT EXECUTE ON FUNCTION app.clear_rate_budget(text,text) TO dawaee_app;
GRANT EXECUTE ON FUNCTION app.purge_rate_buckets(int) TO dawaee_worker;
