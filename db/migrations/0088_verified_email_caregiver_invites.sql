-- Bind invitations to the recipient's verified identity on every platform.
ALTER TABLE caregiver_relationships ADD COLUMN invited_email text;
ALTER TABLE caregiver_relationships DROP CONSTRAINT caregiver_pending_has_target;
ALTER TABLE caregiver_relationships ADD CONSTRAINT caregiver_pending_has_target CHECK (
  status <> 'pending' OR (
    (invited_phone_e164 IS NOT NULL) <> (invited_email IS NOT NULL)
    AND invitation_token_hash IS NOT NULL AND invitation_expires_at IS NOT NULL
  )
);
ALTER TABLE caregiver_relationships ADD CONSTRAINT caregiver_invited_email_canonical
  CHECK (invited_email IS NULL OR (invited_email = lower(btrim(invited_email)) AND length(invited_email) <= 320 AND position('@' in invited_email) > 1));

CREATE FUNCTION app.caregiver_identity_verified(p_relationship uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
  SELECT EXISTS (
    SELECT 1 FROM caregiver_relationships cr JOIN users u ON u.id = cr.caregiver_user_id
    WHERE cr.id = p_relationship AND u.disabled_at IS NULL
      AND CASE WHEN cr.invited_email IS NOT NULL
        THEN lower(u.email) = cr.invited_email AND app.has_verified_email(u.id)
        ELSE app.has_verified_phone(u.id) END
  )
$$;
REVOKE ALL ON FUNCTION app.caregiver_identity_verified(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.caregiver_identity_verified(uuid) TO dawaee_app, dawaee_worker;

CREATE OR REPLACE FUNCTION app.caregives_profile(p_profile uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
  SELECT EXISTS (SELECT 1 FROM caregiver_relationships cr
    WHERE cr.patient_profile_id = p_profile AND cr.caregiver_user_id = app.current_user_id()
      AND cr.status = 'active' AND app.caregiver_identity_verified(cr.id))
$$;
CREATE OR REPLACE FUNCTION app.has_permission(p_profile uuid, p_perm text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
  SELECT app.owns_profile(p_profile) OR EXISTS (SELECT 1 FROM caregiver_relationships cr
    WHERE cr.patient_profile_id = p_profile AND cr.caregiver_user_id = app.current_user_id()
      AND cr.status = 'active' AND p_perm = ANY(cr.permissions) AND app.caregiver_identity_verified(cr.id))
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
  account_email text;
BEGIN
  IF p_user_id IS DISTINCT FROM app.current_user_id() THEN
    RETURN QUERY SELECT NULL::uuid, NULL::uuid, 'invalid'::text; RETURN;
  END IF;
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

  SELECT phone_e164, lower(email) INTO account_phone, account_email FROM users WHERE id = p_user_id AND disabled_at IS NULL FOR SHARE;
  IF rel.invited_email IS NOT NULL THEN
    -- A link alone is insufficient: the signed-in account must own the exact
    -- verified mailbox selected by the patient. Phone invitations retain their
    -- original phone proof requirement, including existing relationships.
    IF account_email IS DISTINCT FROM rel.invited_email OR NOT app.has_verified_email(p_user_id) THEN
      RETURN QUERY SELECT NULL::uuid, NULL::uuid, 'invalid'::text; RETURN;
    END IF;
  ELSE
    IF account_phone IS NULL OR rel.invited_phone_e164 IS NULL OR account_phone <> rel.invited_phone_e164 THEN
      RETURN QUERY SELECT NULL::uuid, NULL::uuid, 'invalid'::text; RETURN;
    END IF;
    IF NOT app.has_verified_phone(p_user_id) THEN
      RETURN QUERY SELECT NULL::uuid, NULL::uuid, 'verification_required'::text; RETURN;
    END IF;
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

-- Link a missing login phone to the existing email account; never merge two
-- accounts or call this phone verified merely because the password is known.
CREATE FUNCTION app.attach_account_phone(p_user uuid, p_phone text, p_password_hash text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
BEGIN
  IF p_user IS DISTINCT FROM app.current_user_id() OR p_phone !~ '^\+[1-9][0-9]{7,14}$' THEN RETURN false; END IF;
  PERFORM 1 FROM users u JOIN user_credentials c ON c.user_id = u.id
    WHERE u.id = p_user AND u.disabled_at IS NULL AND c.password_hash = p_password_hash
      AND (u.phone_e164 IS NULL OR u.phone_e164 = p_phone) FOR UPDATE OF u, c;
  IF NOT FOUND THEN RETURN false; END IF;
  UPDATE users SET phone_e164 = p_phone WHERE id = p_user;
  RETURN true;
EXCEPTION WHEN unique_violation THEN RETURN false;
END $$;
REVOKE ALL ON FUNCTION app.attach_account_phone(uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.attach_account_phone(uuid,text,text) TO dawaee_app;

-- A verified recipient can recover an invitation after the verification email
-- opens a different browser tab. Never persist the invitation bearer in web storage.
CREATE FUNCTION app.pending_email_invitations()
RETURNS TABLE (id uuid, patient_name text, role text, expires_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
  SELECT cr.id, p.display_name, cr.role::text, cr.invitation_expires_at
  FROM caregiver_relationships cr JOIN patient_profiles p ON p.id = cr.patient_profile_id
  JOIN users u ON u.id = app.current_user_id() AND u.disabled_at IS NULL
  WHERE cr.status = 'pending' AND cr.invitation_expires_at > now()
    AND cr.invited_email = lower(u.email) AND app.has_verified_email(u.id)
    AND p.owner_user_id <> u.id AND p.linked_user_id IS DISTINCT FROM u.id
  ORDER BY cr.created_at
$$;
REVOKE ALL ON FUNCTION app.pending_email_invitations() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.pending_email_invitations() TO dawaee_app;

CREATE FUNCTION app.accept_email_invitation(p_relationship uuid)
RETURNS TABLE (relationship_id uuid, patient_profile_id uuid, outcome text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
DECLARE rel caregiver_relationships%ROWTYPE;
BEGIN
  SELECT cr.* INTO rel FROM caregiver_relationships cr JOIN users u ON u.id = app.current_user_id()
   WHERE cr.id = p_relationship AND u.disabled_at IS NULL
     AND cr.invited_email = lower(u.email) AND app.has_verified_email(u.id) FOR UPDATE OF cr;
  IF NOT FOUND THEN RETURN QUERY SELECT NULL::uuid, NULL::uuid, 'invalid'::text; RETURN; END IF;
  -- The account can safely retry a committed acceptance after a lost response.
  IF rel.status = 'active' AND rel.caregiver_user_id = app.current_user_id() THEN
    RETURN QUERY SELECT rel.id, rel.patient_profile_id, 'accepted'::text; RETURN;
  END IF;
  RETURN QUERY SELECT * FROM app.accept_caregiver_invitation(rel.invitation_token_hash, app.current_user_id());
END $$;
REVOKE ALL ON FUNCTION app.accept_email_invitation(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.accept_email_invitation(uuid) TO dawaee_app;
