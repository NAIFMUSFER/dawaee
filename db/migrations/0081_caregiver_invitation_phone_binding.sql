-- =============================================================================
-- Dawaee — 0081: bind caregiver invitation redemption to the invited phone
--
-- The invitation token is a bearer capability, but it is not the whole grant:
-- the patient also chose the phone number the invitation was addressed to.
-- Previously app.accept_caregiver_invitation() accepted any authenticated
-- p_user_id holding the token, so a copied/forwarded link could bind the wrong
-- account as caregiver and burn the intended recipient's invitation.
--
-- Resolve the authenticated account's canonical phone inside the same
-- SECURITY DEFINER transaction that locks and redeems the invitation. A
-- wrong-account attempt returns the same generic "invalid" outcome as an
-- unknown token and does not mutate the invitation, so the intended recipient
-- can still redeem it.
-- =============================================================================

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

  SELECT phone_e164 INTO account_phone FROM users WHERE id = p_user_id;
  IF account_phone IS NULL
     OR rel.invited_phone_e164 IS NULL
     OR account_phone <> rel.invited_phone_e164 THEN
    -- Do not disclose that the token is real and do not burn it. The route maps
    -- this to the same generic invalid-invitation response as an unknown token.
    RETURN QUERY SELECT NULL::uuid, NULL::uuid, 'invalid'::text; RETURN;
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
