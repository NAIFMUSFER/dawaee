-- =============================================================================
-- Dawaee — 0061: bind every active remote-push endpoint to one exact session
-- =============================================================================
--
-- PROVEN DEFECT
--   push-token-session-binding-expiry.test.ts
--
-- `device_id` is supplied by the client and is only installation-routing
-- metadata. Migration 0052 correctly stopped routing push after natural session
-- expiry, but it authorized an endpoint whenever *any* live session for the
-- same account claimed the same device_id. Two independent sessions can claim
-- that label. If the session that registered the provider endpoint expires
-- naturally while the unrelated colliding session stays live, the worker would
-- continue routing medication notifications to the expired session's endpoint.
--
-- Make endpoint ownership explicit. `push_tokens.session_id` records the exact
-- authenticated session that most recently registered the endpoint. Normal
-- refresh rotation transfers that binding to its server-written successor in
-- the same serialized transaction. Revocation retires only endpoints bound to
-- the revoked session, and worker delivery requires that exact bound session to
-- still be live. A client-controlled device label can no longer substitute for
-- session authority.
-- =============================================================================

ALTER TABLE push_tokens
  ADD COLUMN session_id uuid REFERENCES auth_sessions(id) ON DELETE SET NULL;

CREATE INDEX push_tokens_session_active_idx
  ON push_tokens (session_id)
  WHERE active AND session_id IS NOT NULL;

-- Safe upgrade of already-registered endpoints. A unique live session for the
-- existing user/device pair is sufficient to bind the historical row. If zero
-- or multiple live sessions match, ownership is ambiguous: fail closed and let
-- the next authenticated client sync register the endpoint again.
WITH live_candidates AS (
  SELECT pt.id AS push_token_id,
         count(*)::int AS live_count,
         (array_agg(s.id ORDER BY s.last_used_at DESC, s.id))[1] AS session_id
    FROM push_tokens pt
    JOIN auth_sessions s
      ON s.user_id = pt.user_id
     AND s.device_id = pt.device_id
     AND s.revoked_at IS NULL
     AND s.expires_at > now()
   WHERE pt.active
   GROUP BY pt.id
)
UPDATE push_tokens pt
   SET session_id = c.session_id
  FROM live_candidates c
 WHERE pt.id = c.push_token_id
   AND c.live_count = 1;

UPDATE push_tokens
   SET active = false
 WHERE active
   AND session_id IS NULL;

-- Any future active row must identify one live same-account/same-device session.
-- The API supplies session_id explicitly. The unique-live-session fallback keeps
-- trusted maintenance/tests and old clients fail-safe during rollout without
-- permitting an ambiguous client device label to choose authority.
CREATE OR REPLACE FUNCTION app.guard_push_token_session_binding()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app
AS $$
DECLARE
  live_count int;
  resolved_session uuid;
BEGIN
  IF NOT NEW.active THEN
    RETURN NEW;
  END IF;

  IF NEW.session_id IS NULL THEN
    SELECT count(*)::int,
           (array_agg(s.id ORDER BY s.last_used_at DESC, s.id))[1]
      INTO live_count, resolved_session
      FROM auth_sessions s
     WHERE s.user_id = NEW.user_id
       AND s.device_id = NEW.device_id
       AND s.revoked_at IS NULL
       AND s.expires_at > now();

    IF live_count <> 1 THEN
      RAISE EXCEPTION 'active push token requires one unambiguous live session binding'
        USING ERRCODE = '23514';
    END IF;

    NEW.session_id := resolved_session;
    RETURN NEW;
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM auth_sessions s
     WHERE s.id = NEW.session_id
       AND s.user_id = NEW.user_id
       AND s.device_id = NEW.device_id
       AND s.revoked_at IS NULL
       AND s.expires_at > now()
  ) THEN
    RAISE EXCEPTION 'push token session binding is not a live session for this account/device'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION app.guard_push_token_session_binding() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.guard_push_token_session_binding() FROM dawaee_app;
REVOKE ALL ON FUNCTION app.guard_push_token_session_binding() FROM dawaee_worker;

DROP TRIGGER IF EXISTS push_tokens_session_binding_guard ON push_tokens;
CREATE TRIGGER push_tokens_session_binding_guard
BEFORE INSERT OR UPDATE OF user_id, device_id, session_id, active ON push_tokens
FOR EACH ROW
EXECUTE FUNCTION app.guard_push_token_session_binding();

-- Worker authorization is exact-session based. The worker still receives no
-- direct auth_sessions privilege and sees only the provider routing token.
CREATE OR REPLACE FUNCTION app.list_live_push_tokens(
  p_user_id uuid,
  p_limit int
)
RETURNS TABLE(token text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app
AS $$
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'list_live_push_tokens: user id is required'
      USING ERRCODE = '22023';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 20 THEN
    RAISE EXCEPTION 'list_live_push_tokens: limit must be between 1 and 20'
      USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  SELECT pt.token
    FROM push_tokens pt
    JOIN auth_sessions s
      ON s.id = pt.session_id
     AND s.user_id = pt.user_id
     AND s.device_id = pt.device_id
     AND s.revoked_at IS NULL
     AND s.expires_at > now()
   WHERE pt.user_id = p_user_id
     AND pt.active
   ORDER BY pt.last_seen_at DESC
   LIMIT p_limit;
END
$$;

REVOKE EXECUTE ON FUNCTION app.list_live_push_tokens(uuid, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.list_live_push_tokens(uuid, int) TO dawaee_worker;

COMMENT ON FUNCTION app.list_live_push_tokens(uuid, int) IS
  'Worker-only bounded provider tokens whose exact bound auth session is still live; client device_id alone never confers push eligibility.';

-- Session revocation retires only the endpoint actually bound to that session.
-- Refresh rotation moves the binding to the successor before revoking the
-- predecessor, so the normal rotation edge remains notification-transparent.
CREATE OR REPLACE FUNCTION app.deactivate_push_after_device_session_revocation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app
AS $$
BEGIN
  IF OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL THEN
    UPDATE push_tokens
       SET active = false
     WHERE user_id = NEW.user_id
       AND session_id = NEW.id
       AND active;
  END IF;

  RETURN NULL;
END
$$;

REVOKE EXECUTE ON FUNCTION app.deactivate_push_after_device_session_revocation() FROM PUBLIC;

COMMENT ON FUNCTION app.deactivate_push_after_device_session_revocation() IS
  'Retires only provider endpoints bound to the session crossing live -> revoked; refresh rotation transfers binding before this trigger fires.';

-- Preserve migration 0058's theft-lineage semantics and 0054's account lock,
-- while transferring the provider endpoint to a normal refresh successor before
-- the predecessor is revoked.
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
  grace constant interval := interval '30 seconds';
BEGIN
  SELECT * INTO s
    FROM auth_sessions
   WHERE refresh_token_hash = p_presented_hash;

  IF s.id IS NULL THEN
    RETURN QUERY SELECT 'invalid'::text, NULL::uuid, NULL::boolean, NULL::uuid, NULL::timestamptz;
    RETURN;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(s.user_id::text, 20260912));

  SELECT * INTO s
    FROM auth_sessions
   WHERE refresh_token_hash = p_presented_hash
   FOR UPDATE;

  IF s.id IS NULL THEN
    RETURN QUERY SELECT 'invalid'::text, NULL::uuid, NULL::boolean, NULL::uuid, NULL::timestamptz;
    RETURN;
  END IF;

  SELECT u.disabled_at INTO disabled FROM users u WHERE u.id = s.user_id;
  IF disabled IS NOT NULL THEN
    RETURN QUERY SELECT 'invalid'::text, NULL::uuid, NULL::boolean, NULL::uuid, NULL::timestamptz;
    RETURN;
  END IF;

  IF s.revoked_at IS NOT NULL THEN
    IF s.replaced_by IS NOT NULL AND s.revoked_at > now() - grace THEN
      RETURN QUERY SELECT 'superseded'::text, NULL::uuid, NULL::boolean, NULL::uuid, NULL::timestamptz;
      RETURN;
    END IF;

    IF s.replaced_by IS NOT NULL THEN
      WITH RECURSIVE replacement_lineage(id) AS (
        SELECT s.replaced_by
        UNION
        SELECT child.replaced_by
          FROM auth_sessions child
          JOIN replacement_lineage lineage ON child.id = lineage.id
         WHERE child.user_id = s.user_id
           AND child.replaced_by IS NOT NULL
      )
      UPDATE auth_sessions target
         SET revoked_at = now()
       WHERE target.user_id = s.user_id
         AND target.id IN (SELECT id FROM replacement_lineage WHERE id IS NOT NULL)
         AND target.revoked_at IS NULL;
    END IF;

    RETURN QUERY SELECT 'reuse_detected'::text, s.user_id, NULL::boolean, NULL::uuid, NULL::timestamptz;
    RETURN;
  END IF;

  IF s.expires_at <= now() THEN
    RETURN QUERY SELECT 'expired'::text, s.user_id, NULL::boolean, NULL::uuid, NULL::timestamptz;
    RETURN;
  END IF;

  SELECT u.is_admin INTO admin FROM users u WHERE u.id = s.user_id;

  INSERT INTO auth_sessions
    (user_id, refresh_token_hash, device_id, device_name, ip_hash, expires_at)
  VALUES
    (s.user_id, p_new_hash, s.device_id, s.device_name, p_ip_hash, now() + make_interval(days => p_ttl_days))
  RETURNING id, auth_sessions.expires_at INTO new_id, new_expiry;

  -- Transfer exact endpoint ownership while both sessions are live. The binding
  -- guard verifies the successor belongs to the same account/device. This must
  -- happen before predecessor revocation or the revocation trigger would retire
  -- the endpoint during an ordinary refresh.
  UPDATE push_tokens
     SET session_id = new_id
   WHERE user_id = s.user_id
     AND session_id = s.id
     AND active;

  UPDATE auth_sessions
     SET revoked_at = now(), replaced_by = new_id, last_used_at = now()
   WHERE id = s.id;

  RETURN QUERY SELECT 'rotated'::text, s.user_id, admin, new_id, new_expiry;
END $$;

COMMENT ON FUNCTION app.rotate_session(text,text,text,int) IS
  'Rotates refresh tokens under the account advisory lock, transfers exact push-session ownership to the normal successor, and on reuse revokes only the server-linked replacement lineage.';
