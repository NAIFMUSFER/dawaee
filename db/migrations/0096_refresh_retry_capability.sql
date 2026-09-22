-- Opt-in recovery of a committed rotation whose response never reached secure
-- storage. Only a digest of the client's independent 256-bit attempt secret is
-- retained. Legacy rotation and its 30-second theft-detection grace are intact.
ALTER TABLE auth_sessions ADD COLUMN refresh_retry_hash text
  CHECK (refresh_retry_hash IS NULL OR refresh_retry_hash ~ '^[0-9a-f]{64}$');

CREATE FUNCTION app.rotate_session_retry(
  p_presented_hash text, p_new_hash text, p_ip_hash text, p_ttl_days int,
  p_retry_hash text
) RETURNS TABLE (outcome text, user_id uuid, is_admin boolean, session_id uuid, expires_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
#variable_conflict use_column
DECLARE
  predecessor auth_sessions%ROWTYPE;
  successor auth_sessions%ROWTYPE;
  rotated record;
  admin boolean;
BEGIN
  IF p_retry_hash IS NULL OR p_retry_hash !~ '^[0-9a-f]{64}$' THEN
    RETURN QUERY SELECT 'invalid'::text, NULL::uuid, NULL::boolean, NULL::uuid, NULL::timestamptz;
    RETURN;
  END IF;

  SELECT * INTO predecessor FROM auth_sessions WHERE refresh_token_hash = p_presented_hash;
  IF predecessor.id IS NULL THEN
    RETURN QUERY SELECT 'invalid'::text, NULL::uuid, NULL::boolean, NULL::uuid, NULL::timestamptz;
    RETURN;
  END IF;

  -- Same lock and order as password change, disable, logout-all and rotation.
  PERFORM pg_advisory_xact_lock(hashtextextended(predecessor.user_id::text, 20260912));
  SELECT * INTO predecessor FROM auth_sessions WHERE refresh_token_hash = p_presented_hash FOR UPDATE;

  IF predecessor.revoked_at IS NOT NULL AND predecessor.refresh_retry_hash = p_retry_hash THEN
    SELECT * INTO successor FROM auth_sessions WHERE id = predecessor.replaced_by FOR UPDATE;
    SELECT u.is_admin INTO admin FROM users u
      WHERE u.id = predecessor.user_id AND u.disabled_at IS NULL;
    IF FOUND AND successor.user_id = predecessor.user_id
      AND successor.device_id = predecessor.device_id
      AND successor.refresh_token_hash = p_new_hash
      AND successor.revoked_at IS NULL AND successor.replaced_by IS NULL
      AND successor.expires_at > now() THEN
      -- Reissue this exact still-live capability. Do not mint a row, transfer
      -- a push endpoint again, change expiry, or follow a replacement chain.
      RETURN QUERY SELECT 'rotated'::text, successor.user_id, admin, successor.id, successor.expires_at;
      RETURN;
    END IF;
  END IF;

  SELECT * INTO rotated FROM app.rotate_session(p_presented_hash, p_new_hash, p_ip_hash, p_ttl_days);
  IF rotated.outcome = 'rotated' THEN
    UPDATE auth_sessions SET refresh_retry_hash = p_retry_hash WHERE id = predecessor.id;
  END IF;
  RETURN QUERY SELECT rotated.outcome, rotated.user_id, rotated.is_admin, rotated.session_id, rotated.expires_at;
END $$;

REVOKE ALL ON FUNCTION app.rotate_session_retry(text,text,text,int,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.rotate_session_retry(text,text,text,int,text) TO dawaee_app;
COMMENT ON FUNCTION app.rotate_session_retry(text,text,text,int,text) IS
  'Opt-in recovery of the exact live immediate refresh successor using a precommitted client attempt secret; legacy reuse revocation and expiry remain enforced.';
