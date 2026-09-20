-- A preview is recipient-bound, read-only and does not activate care access.
-- The reviewed acceptance locks the invitation before comparing the exact
-- role/permissions shown to the recipient. Existing token endpoints remain
-- available to older installed clients during rollout.
CREATE FUNCTION app.preview_caregiver_invitation(p_token_hash text, p_relationship uuid)
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

CREATE FUNCTION app.pending_caregiver_invitation_previews()
RETURNS TABLE (id uuid, patient_name text, role text, permissions text[], expires_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
  SELECT preview.id, preview.patient_name, preview.role, preview.permissions, preview.expires_at
  FROM app.pending_email_invitations() pending
  CROSS JOIN LATERAL app.preview_caregiver_invitation(NULL,pending.id) preview
  WHERE preview.outcome = 'ready'
$$;
REVOKE ALL ON FUNCTION app.pending_caregiver_invitation_previews() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.pending_caregiver_invitation_previews() TO dawaee_app;

CREATE FUNCTION app.accept_reviewed_caregiver_invitation(p_relationship uuid, p_role text, p_permissions text[])
RETURNS TABLE (relationship_id uuid, patient_profile_id uuid, outcome text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
DECLARE rel caregiver_relationships%ROWTYPE; preview record;
BEGIN
  SELECT cr.* INTO rel FROM caregiver_relationships cr WHERE cr.id = p_relationship FOR UPDATE;
  -- A lost response can be retried by the same still-verified recipient. This
  -- never reinstates revoked access or grants a second relationship.
  IF rel.status = 'active' AND rel.caregiver_user_id = app.current_user_id()
     AND app.caregiver_identity_verified(rel.id) THEN
    RETURN QUERY SELECT rel.id,rel.patient_profile_id,'accepted'::text; RETURN;
  END IF;
  SELECT * INTO preview FROM app.preview_caregiver_invitation(NULL,p_relationship);
  IF preview.outcome IS DISTINCT FROM 'ready' THEN
    RETURN QUERY SELECT NULL::uuid,NULL::uuid,coalesce(preview.outcome,'invalid'); RETURN;
  END IF;
  IF p_role IS DISTINCT FROM preview.role OR p_permissions IS NULL
     OR NOT (p_permissions @> preview.permissions AND p_permissions <@ preview.permissions) THEN
    RETURN QUERY SELECT NULL::uuid,NULL::uuid,'changed'::text; RETURN;
  END IF;
  RETURN QUERY SELECT * FROM app.accept_caregiver_invitation(rel.invitation_token_hash,app.current_user_id());
END $$;
REVOKE ALL ON FUNCTION app.accept_reviewed_caregiver_invitation(uuid,text,text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.accept_reviewed_caregiver_invitation(uuid,text,text[]) TO dawaee_app;
