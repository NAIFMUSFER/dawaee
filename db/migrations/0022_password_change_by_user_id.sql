-- The current-password check on POST /v1/auth/password never executed.
--
-- The route read the existing hash with `app.find_user_for_password_login($1)`
-- and passed it the authenticated USER ID. That function matches on
-- `phone_e164` or `lower(email)`:
--
--   WHERE u.phone_e164 = p_identifier OR lower(u.email) = lower(p_identifier)
--
-- A UUID matches neither, so it returned no row on every call. The route then
-- read that as "this account has no password yet", skipped the verification
-- block entirely, and set whatever new password it had been given.
--
-- So anyone holding a valid access token could change the account password
-- without knowing the current one. Paired with the fact that a password change
-- did not end other sessions, a single stolen access token was a permanent
-- account takeover: the attacker sets a password, and the owner's own stops
-- working. Both halves are fixed — the session revocation in the route, the
-- lookup here.
--
-- It has to be a function rather than a direct SELECT because `user_credentials`
-- is deliberately unreachable from `dawaee_app`: RLS enabled with zero policies
-- and no grant, so password hashes are reachable only through the SECURITY
-- DEFINER auth plane. That property is worth more than the convenience of a
-- plain query, so this adds the narrowest possible door rather than widening
-- the wall.

CREATE OR REPLACE FUNCTION app.password_hash_for_user(p_user_id uuid)
RETURNS text
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public, app
STABLE AS $$
  -- The hash and nothing else. Not the failure count, not the lock state, not
  -- the update timestamp: this exists to answer one question — "does this
  -- account already have a password, and does the one presented match it" —
  -- and every extra column would be a fact the caller did not need.
  SELECT c.password_hash
    FROM user_credentials c
   WHERE c.user_id = p_user_id
$$;

REVOKE EXECUTE ON FUNCTION app.password_hash_for_user(uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION app.password_hash_for_user(uuid) TO dawaee_app;

COMMENT ON FUNCTION app.password_hash_for_user(uuid) IS
  'Returns the stored password hash for one user, by id. Used only by the '
  'password-change route to verify the current password. Not granted to '
  'dawaee_worker: the worker has no business with credentials.';
