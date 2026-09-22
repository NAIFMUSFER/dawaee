-- Recover invitations after registration/phone proof even when the original
-- QR opened a browser and its bearer is no longer in the native app.
-- Only an exact, verified recipient sees a preview; discovery grants no access.
CREATE OR REPLACE FUNCTION app.pending_caregiver_invitation_previews()
RETURNS TABLE (id uuid, patient_name text, role text, permissions text[], expires_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
  SELECT preview.id, preview.patient_name, preview.role, preview.permissions, preview.expires_at
  FROM caregiver_relationships cr
  JOIN users u ON u.id = app.current_user_id() AND u.disabled_at IS NULL
  CROSS JOIN LATERAL app.preview_caregiver_invitation(NULL,cr.id) preview
  WHERE cr.status = 'pending' AND cr.invitation_expires_at > now()
    AND CASE WHEN cr.invited_email IS NOT NULL
      THEN cr.invited_email = lower(u.email) AND app.has_verified_email(u.id)
      ELSE cr.invited_phone_e164 = u.phone_e164 AND app.has_verified_phone(u.id)
    END
    AND preview.outcome = 'ready'
  ORDER BY cr.created_at, cr.id
$$;
REVOKE ALL ON FUNCTION app.pending_caregiver_invitation_previews() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.pending_caregiver_invitation_previews() TO dawaee_app;

CREATE OR REPLACE FUNCTION app.preview_caregiver_invitation(p_token_hash text, p_relationship uuid)
RETURNS TABLE (id uuid, patient_name text, role text, permissions text[], expires_at timestamptz, outcome text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
DECLARE rel caregiver_relationships%ROWTYPE; account users%ROWTYPE; prof patient_profiles%ROWTYPE;
BEGIN
  IF (p_token_hash IS NULL) = (p_relationship IS NULL) THEN
    RETURN QUERY SELECT NULL::uuid,NULL::text,NULL::text,NULL::text[],NULL::timestamptz,'invalid'::text; RETURN;
  END IF;
  SELECT * INTO account FROM users WHERE users.id = app.current_user_id() AND disabled_at IS NULL;
  IF account.id IS NULL THEN
    RETURN QUERY SELECT NULL::uuid,NULL::text,NULL::text,NULL::text[],NULL::timestamptz,'invalid'::text; RETURN;
  END IF;
  SELECT cr.* INTO rel FROM caregiver_relationships cr
    WHERE (p_token_hash IS NOT NULL AND cr.invitation_token_hash = p_token_hash)
       OR (p_relationship IS NOT NULL AND cr.id = p_relationship);
  -- A valid phone invitation may precede linking any phone to the new
  -- mailbox account. Request proof without disclosing patient or target data.
  IF rel.id IS NOT NULL AND p_token_hash IS NOT NULL AND rel.invited_email IS NULL
     AND rel.invited_phone_e164 IS NOT NULL AND account.phone_e164 IS NULL
     AND rel.status = 'pending' AND rel.invitation_expires_at > now() THEN
    RETURN QUERY SELECT NULL::uuid,NULL::text,NULL::text,NULL::text[],NULL::timestamptz,'verification_required'::text; RETURN;
  END IF;
  IF rel.id IS NULL OR (CASE WHEN rel.invited_email IS NOT NULL
    THEN rel.invited_email IS DISTINCT FROM lower(account.email) OR NOT app.has_verified_email(account.id)
    ELSE rel.invited_phone_e164 IS NULL OR rel.invited_phone_e164 IS DISTINCT FROM account.phone_e164 END) THEN
    RETURN QUERY SELECT NULL::uuid,NULL::text,NULL::text,NULL::text[],NULL::timestamptz,'invalid'::text; RETURN;
  END IF;
  IF rel.invited_email IS NULL AND NOT app.has_verified_phone(account.id) THEN
    RETURN QUERY SELECT NULL::uuid,NULL::text,NULL::text,NULL::text[],NULL::timestamptz,'verification_required'::text; RETURN;
  END IF;
  SELECT * INTO prof FROM patient_profiles WHERE patient_profiles.id = rel.patient_profile_id;
  IF prof.id IS NULL OR prof.archived_at IS NOT NULL OR account.id IN (prof.owner_user_id, prof.linked_user_id) THEN
    RETURN QUERY SELECT NULL::uuid,NULL::text,NULL::text,NULL::text[],NULL::timestamptz,'invalid'::text; RETURN;
  END IF;
  IF rel.status <> 'pending' THEN
    RETURN QUERY SELECT NULL::uuid,NULL::text,NULL::text,NULL::text[],NULL::timestamptz,'invalid'::text; RETURN;
  END IF;
  IF rel.invitation_expires_at IS NULL OR rel.invitation_expires_at <= now() THEN
    RETURN QUERY SELECT NULL::uuid,NULL::text,NULL::text,NULL::text[],NULL::timestamptz,'expired'::text; RETURN;
  END IF;
  RETURN QUERY SELECT rel.id, prof.display_name, rel.role::text, rel.permissions, rel.invitation_expires_at, 'ready'::text;
END $$;
REVOKE ALL ON FUNCTION app.preview_caregiver_invitation(text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.preview_caregiver_invitation(text,uuid) TO dawaee_app;

