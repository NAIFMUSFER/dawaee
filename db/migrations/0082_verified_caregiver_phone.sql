-- Phone ownership is separate from knowing an account password.
-- No existing account or relationship is silently marked as verified.
CREATE TABLE user_phone_verifications (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  phone_e164 text NOT NULL,
  authenticated_at timestamptz NOT NULL,
  verified_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON user_phone_verifications FROM PUBLIC, dawaee_app, dawaee_worker;
ALTER TABLE user_phone_verifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_phone_verifications FORCE ROW LEVEL SECURITY;
SELECT count(*) FROM app.ensure_definer_policies();

CREATE FUNCTION app.has_verified_phone(p_user_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
  SELECT EXISTS (
    SELECT 1 FROM users u JOIN user_phone_verifications v ON v.user_id = u.id
    WHERE u.id = p_user_id AND u.disabled_at IS NULL
      AND u.phone_e164 = v.phone_e164
  )
$$;
REVOKE ALL ON FUNCTION app.has_verified_phone(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.has_verified_phone(uuid) TO dawaee_app, dawaee_worker;

-- Called only after server-side Google signature/claims validation, in the
-- authenticated user's transaction. Never accept a client-provided phone flag.
CREATE FUNCTION app.record_verified_phone(
  p_user_id uuid, p_phone text, p_authenticated_at timestamptz
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
BEGIN
  IF p_user_id IS DISTINCT FROM app.current_user_id()
     OR p_authenticated_at IS NULL
     OR p_authenticated_at > now() + interval '5 seconds'
     OR p_authenticated_at < now() - interval '10 minutes' THEN
    RETURN false;
  END IF;
  PERFORM 1 FROM users WHERE id = p_user_id AND disabled_at IS NULL
    AND phone_e164 = p_phone FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  INSERT INTO user_phone_verifications (user_id, phone_e164, authenticated_at)
  VALUES (p_user_id, p_phone, p_authenticated_at)
  ON CONFLICT (user_id) DO UPDATE SET phone_e164 = excluded.phone_e164,
    authenticated_at = excluded.authenticated_at, verified_at = now();
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION app.record_verified_phone(uuid, text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.record_verified_phone(uuid, text, timestamptz) TO dawaee_app;

-- Existing caregivers also need proof before accessing another person's
-- records. Their relationship/consent stays intact and access resumes after
-- verification; owners retain their own ordinary access.
CREATE OR REPLACE FUNCTION app.caregives_profile(p_profile uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
  SELECT app.has_verified_phone(app.current_user_id()) AND EXISTS (
    SELECT 1 FROM caregiver_relationships cr
    WHERE cr.patient_profile_id = p_profile
      AND cr.caregiver_user_id = app.current_user_id() AND cr.status = 'active'
  )
$$;
CREATE OR REPLACE FUNCTION app.has_permission(p_profile uuid, p_perm text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
  SELECT app.owns_profile(p_profile) OR (
    app.has_verified_phone(app.current_user_id()) AND EXISTS (
      SELECT 1 FROM caregiver_relationships cr WHERE cr.patient_profile_id = p_profile
        AND cr.caregiver_user_id = app.current_user_id() AND cr.status = 'active'
        AND p_perm = ANY(cr.permissions)
    )
  )
$$;

CREATE OR REPLACE FUNCTION app.accept_caregiver_invitation(
  p_token_hash text,
  p_user_id uuid,
  p_now timestamptz DEFAULT now()
) RETURNS TABLE (relationship_id uuid, patient_profile_id uuid, outcome text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
#variable_conflict use_column
DECLARE
  rel caregiver_relationships%ROWTYPE;
  prof patient_profiles%ROWTYPE;
  account_phone text;
BEGIN
  SELECT * INTO rel FROM caregiver_relationships
   WHERE invitation_token_hash = p_token_hash FOR UPDATE;

  IF rel.id IS NULL THEN
    RETURN QUERY SELECT NULL::uuid, NULL::uuid, 'invalid'::text; RETURN;
  END IF;
  IF rel.status <> 'pending' THEN
    RETURN QUERY SELECT rel.id, rel.patient_profile_id, 'already_used'::text; RETURN;
  END IF;
  IF rel.invitation_expires_at IS NULL OR rel.invitation_expires_at <= p_now THEN
    UPDATE caregiver_relationships SET status = 'expired' WHERE id = rel.id;
    RETURN QUERY SELECT rel.id, rel.patient_profile_id, 'expired'::text; RETURN;
  END IF;

  SELECT * INTO prof FROM patient_profiles WHERE id = rel.patient_profile_id;
  IF p_user_id IN (prof.owner_user_id, prof.linked_user_id) THEN
    RETURN QUERY SELECT rel.id, rel.patient_profile_id, 'self'::text; RETURN;
  END IF;

  SELECT phone_e164 INTO account_phone FROM users WHERE id = p_user_id AND disabled_at IS NULL FOR SHARE;
  IF account_phone IS NULL
     OR rel.invited_phone_e164 IS NULL
     OR account_phone <> rel.invited_phone_e164 THEN
    -- Do not disclose that the token is real and do not burn it. The route maps
    -- this to the same generic invalid-invitation response as an unknown token.
    RETURN QUERY SELECT NULL::uuid, NULL::uuid, 'invalid'::text; RETURN;
  END IF;

  IF NOT app.has_verified_phone(p_user_id) THEN
    RETURN QUERY SELECT NULL::uuid, NULL::uuid, 'verification_required'::text; RETURN;
  END IF;

  UPDATE caregiver_relationships
     SET caregiver_user_id = p_user_id,
         status = 'active',
         accepted_at = p_now,
         invitation_token_hash = NULL,
         invitation_expires_at = NULL
   WHERE id = rel.id;

  RETURN QUERY SELECT rel.id, rel.patient_profile_id, 'accepted'::text;
END $$;

REVOKE EXECUTE ON FUNCTION app.accept_caregiver_invitation(text, uuid, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.accept_caregiver_invitation(text, uuid, timestamptz) TO dawaee_app;
