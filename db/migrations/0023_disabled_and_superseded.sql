-- Two changes to the auth plane, both at the boundary every request passes.
--
-- ── P9-4: a disabled account kept its live sessions ────────────────────────
--
-- `users.disabled_at` blocks both login paths — `find_or_create_user_by_phone`
-- raises "account is disabled", and the password path refuses — so its meaning
-- is account disablement, not "no new logins". But nothing consulted it after
-- authentication, so every session that existed at the moment of disabling kept
-- working until its refresh token expired.
--
-- That inverts the control exactly when it matters. Disabling is what an
-- operator does in response to a compromised account, an abusive user, or a
-- safety concern; in all three the sessions already open are the problem being
-- addressed. An account marked disabled that continues serving requests is a
-- control that reports success and does nothing.
--
-- No route sets `disabled_at` — it is written out of band, by an operator with
-- SQL access. That is precisely why the check belongs HERE and not in an API
-- handler that revokes sessions: there is no handler to hook, and a future
-- admin endpoint would have to remember to do the same thing. Checking at read
-- time also makes the state reversible: clearing `disabled_at` restores access
-- to sessions that are still live and unexpired, with no cleanup and no
-- forced re-authentication of an account that was disabled by mistake.

CREATE OR REPLACE FUNCTION app.session_is_live(p_session_id uuid)
RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public, app STABLE AS $$
  SELECT EXISTS (
    SELECT 1
      FROM auth_sessions s
      JOIN users u ON u.id = s.user_id
     WHERE s.id = p_session_id
       AND s.revoked_at IS NULL
       AND s.expires_at > now()
       -- The account itself must not be disabled. Checked on every
       -- authenticated request, so disabling takes effect at once rather than
       -- at the natural expiry of whatever access token happens to be held.
       AND u.disabled_at IS NULL
  )
$$;

-- ── P9-1: the loser of a legitimate refresh race was treated as a thief ────
--
-- Rotation is correct and stays exactly as it is: one row lock, exactly one
-- winner, exactly one descendant. The problem is what the LOSER is told.
--
-- Two honest requests can carry the same refresh token — a phone that resumes
-- and fires two API calls at once, both finding the access token expired. The
-- loser presents a token that is now revoked, which is indistinguishable from a
-- thief replaying a stolen one, so it took the reuse branch and revoked the
-- whole device — including the fresh session the winner had just created. The
-- user is signed out for doing nothing wrong, and on a medication app being
-- signed out means the reminders stop.
--
-- The distinguishing evidence is narrow but real: a race loser presents the
-- IMMEDIATE PREDECESSOR of a session that was replaced moments ago. A thief
-- replaying a stolen token is overwhelmingly likely to do so later than that,
-- and from a token whose replacement is not seconds old.
--
-- GRACE WINDOW — a security policy, and the number is not arbitrary. The mobile
-- client aborts a request at 15 seconds (`timeoutMs = 15_000` in
-- apps/mobile/src/api/client.ts). Two concurrent refreshes that begin together
-- can therefore complete at most about 15 seconds apart, so the loser cannot
-- legitimately arrive later than that. 30 seconds is that bound doubled, which
-- covers a slow network and a retry without extending into the range where a
-- replay is more likely to be theft than a race.
--
-- WHAT THE GRACE DOES NOT DO — and this is the property that makes it safe: it
-- mints NOTHING. A `superseded` outcome returns no session id, no token, no
-- user id. An attacker replaying a stolen token inside the window avoids
-- tripping the immediate device revocation and receives zero usable material
-- for it. The trade is a short window in which a replay is not ALARMED on,
-- against a client that stays signed in; after 30 seconds the same replay
-- produces reuse_detected and revokes the device exactly as before.

CREATE OR REPLACE FUNCTION app.rotate_session(
  p_presented_hash text,
  p_new_hash text,
  p_ip_hash text,
  p_ttl_days int
) RETURNS TABLE (outcome text, user_id uuid, is_admin boolean, session_id uuid, expires_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
#variable_conflict use_column
DECLARE
  s auth_sessions%ROWTYPE;
  admin boolean;
  new_id uuid;
  new_expiry timestamptz;
  disabled timestamptz;
  -- Named so the policy is greppable and changing it is a deliberate act.
  grace constant interval := interval '30 seconds';
BEGIN
  -- The row lock is what makes exactly-one-winner true. Unchanged.
  SELECT * INTO s FROM auth_sessions WHERE refresh_token_hash = p_presented_hash FOR UPDATE;
  IF s.id IS NULL THEN
    RETURN QUERY SELECT 'invalid'::text, NULL::uuid, NULL::boolean, NULL::uuid, NULL::timestamptz; RETURN;
  END IF;

  -- A disabled account cannot refresh, whatever the token's state. Returned as
  -- 'invalid' rather than a distinct code so the API answer is identical to an
  -- unknown token and disablement is not observable from the outside.
  SELECT u.disabled_at INTO disabled FROM users u WHERE u.id = s.user_id;
  IF disabled IS NOT NULL THEN
    RETURN QUERY SELECT 'invalid'::text, NULL::uuid, NULL::boolean, NULL::uuid, NULL::timestamptz; RETURN;
  END IF;

  IF s.revoked_at IS NOT NULL THEN
    -- The narrow race case: this exact token was superseded moments ago by a
    -- successful rotation. Tell the caller so, mint nothing, revoke nothing.
    IF s.replaced_by IS NOT NULL AND s.revoked_at > now() - grace THEN
      RETURN QUERY SELECT 'superseded'::text, NULL::uuid, NULL::boolean, NULL::uuid, NULL::timestamptz;
      RETURN;
    END IF;

    -- Everything else is treated as theft, exactly as before: a token revoked
    -- longer ago than the window, or one revoked by a logout rather than
    -- replaced by a rotation.
    UPDATE auth_sessions SET revoked_at = now()
     WHERE user_id = s.user_id AND device_id = s.device_id AND revoked_at IS NULL;
    RETURN QUERY SELECT 'reuse_detected'::text, s.user_id, NULL::boolean, NULL::uuid, NULL::timestamptz;
    RETURN;
  END IF;

  IF s.expires_at <= now() THEN
    RETURN QUERY SELECT 'expired'::text, s.user_id, NULL::boolean, NULL::uuid, NULL::timestamptz; RETURN;
  END IF;

  SELECT u.is_admin INTO admin FROM users u WHERE u.id = s.user_id;

  INSERT INTO auth_sessions
    (user_id, refresh_token_hash, device_id, device_name, ip_hash, expires_at)
  VALUES
    (s.user_id, p_new_hash, s.device_id, s.device_name, p_ip_hash, now() + make_interval(days => p_ttl_days))
  RETURNING id, auth_sessions.expires_at INTO new_id, new_expiry;

  UPDATE auth_sessions SET revoked_at = now(), replaced_by = new_id, last_used_at = now() WHERE id = s.id;

  RETURN QUERY SELECT 'rotated'::text, s.user_id, admin, new_id, new_expiry;
END $$;

COMMENT ON FUNCTION app.rotate_session(text,text,text,int) IS
  'Rotates a refresh token under a row lock: exactly one concurrent caller wins. '
  'A loser presenting the immediate predecessor within 30 seconds gets '
  'outcome=superseded — no credentials, no device revocation. Any other reuse '
  'revokes every session on the device.';
