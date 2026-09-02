-- =============================================================================
-- Dawaee — 0009: close the caregiver self-escalation hole
--
-- The 0008 policy let a caregiver UPDATE their own relationship row so they
-- could accept or leave. RLS WITH CHECK only sees the NEW row, so it could not
-- tell "accepting an invitation" from "adding edit_medication to my own
-- permissions". The adversarial probe caught exactly that. Column-level
-- protection therefore moves to a trigger that compares OLD and NEW, and
-- invitation acceptance moves behind a token-validating SECURITY DEFINER
-- function that the app role cannot sidestep.
-- =============================================================================

-- Deliberately SECURITY INVOKER: the guard needs to see the REAL current_user
-- to tell a direct request-role UPDATE from one made inside an audited
-- SECURITY DEFINER entry point. A DEFINER function would always report its own
-- owner and the distinction would collapse. Owner lookup still goes through
-- app.owns_profile(), which is DEFINER, so RLS on patient_profiles cannot make
-- this misjudge.
CREATE OR REPLACE FUNCTION app.guard_caregiver_relationship_update() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, app AS $$
DECLARE
  caller uuid := app.current_user_id();
  is_owner boolean;
BEGIN
  -- Server-side jobs (worker, migrations) run without app.user_id set.
  IF caller IS NULL THEN RETURN NEW; END IF;

  -- The guard exists to constrain the *request-serving* role. Audited
  -- SECURITY DEFINER entry points (invitation acceptance, housekeeping) run as
  -- the function owner, and `current_user` is the one thing dawaee_app cannot
  -- forge with set_config, so it is the right signal to trust here.
  IF current_user <> 'dawaee_app' THEN RETURN NEW; END IF;

  is_owner := app.owns_profile(OLD.patient_profile_id);

  IF COALESCE(is_owner, false) THEN
    -- The patient owns the grant and may change anything except which profile
    -- the row belongs to.
    IF NEW.patient_profile_id <> OLD.patient_profile_id THEN
      RAISE EXCEPTION 'a caregiver relationship cannot be moved between profiles'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;

  -- From here the caller is the caregiver acting on their own row. The only
  -- legitimate action is leaving the circle.
  IF OLD.caregiver_user_id IS DISTINCT FROM caller THEN
    RAISE EXCEPTION 'not permitted to modify this caregiver relationship'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NEW.permissions IS DISTINCT FROM OLD.permissions
     OR NEW.role IS DISTINCT FROM OLD.role
     OR NEW.escalation_priority IS DISTINCT FROM OLD.escalation_priority
     OR NEW.patient_profile_id IS DISTINCT FROM OLD.patient_profile_id
     OR NEW.caregiver_user_id IS DISTINCT FROM OLD.caregiver_user_id
     OR NEW.invitation_token_hash IS DISTINCT FROM OLD.invitation_token_hash
     OR NEW.invitation_expires_at IS DISTINCT FROM OLD.invitation_expires_at THEN
    RAISE EXCEPTION 'only the patient can change caregiver permissions'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NOT (OLD.status = 'active' AND NEW.status IN ('active','revoked')) THEN
    RAISE EXCEPTION 'a caregiver may only leave the care circle'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER caregiver_rel_privilege_guard
  BEFORE UPDATE ON caregiver_relationships
  FOR EACH ROW EXECUTE FUNCTION app.guard_caregiver_relationship_update();

-- ------------------------------------------------- invitation acceptance

-- Accepting an invitation must prove possession of the token. Doing it through
-- a plain UPDATE would require an RLS policy permissive enough to be abused,
-- so it lives here instead: the app role can call it, but cannot reach the
-- underlying row any other way.
CREATE OR REPLACE FUNCTION app.accept_caregiver_invitation(
  p_token_hash text,
  p_user_id uuid,
  p_now timestamptz DEFAULT now()
) RETURNS TABLE (relationship_id uuid, patient_profile_id uuid, outcome text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
#variable_conflict use_column
DECLARE rel caregiver_relationships%ROWTYPE;
        prof patient_profiles%ROWTYPE;
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

  UPDATE caregiver_relationships
     SET caregiver_user_id = p_user_id,
         status = 'active',
         accepted_at = p_now,
         -- Burn the token: an invitation link works exactly once.
         invitation_token_hash = NULL,
         invitation_expires_at = NULL
   WHERE id = rel.id;

  RETURN QUERY SELECT rel.id, rel.patient_profile_id, 'accepted'::text;
END $$;

REVOKE EXECUTE ON FUNCTION app.accept_caregiver_invitation(text, uuid, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.accept_caregiver_invitation(text, uuid, timestamptz) TO dawaee_app;

-- Same reasoning for the emergency QR: the token is checked inside the
-- database, and the response carries only the fields the patient chose to
-- expose. There is no path from a QR scan to the full account.
CREATE OR REPLACE FUNCTION app.resolve_emergency_qr(p_token_hash text)
RETURNS TABLE (
  patient_display_name text,
  blood_type text,
  allergies text[],
  conditions_note text,
  emergency_contacts jsonb,
  medications jsonb
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
#variable_conflict use_column
DECLARE card emergency_cards%ROWTYPE;
BEGIN
  SELECT * INTO card FROM emergency_cards
   WHERE qr_token_hash = p_token_hash AND qr_enabled;
  IF card.id IS NULL THEN RETURN; END IF;

  UPDATE emergency_cards
     SET qr_view_count = qr_view_count + 1, qr_last_viewed_at = now()
   WHERE id = card.id;

  RETURN QUERY
  SELECT
    pp.display_name,
    CASE WHEN card.include_allergies THEN card.blood_type END,
    CASE WHEN card.include_allergies THEN card.allergies ELSE '{}'::text[] END,
    card.conditions_note,
    CASE WHEN card.include_contacts THEN card.emergency_contacts ELSE '[]'::jsonb END,
    CASE WHEN card.include_medications THEN COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'name', m.name,
               'strength', CASE WHEN m.strength_value IS NULL THEN NULL
                                ELSE m.strength_value::text || ' ' || m.strength_unit::text END,
               'form', m.form))
        FROM medications m
       WHERE m.patient_profile_id = card.patient_profile_id AND m.status = 'active'
    ), '[]'::jsonb) ELSE '[]'::jsonb END
  FROM patient_profiles pp WHERE pp.id = card.patient_profile_id;
END $$;

REVOKE EXECUTE ON FUNCTION app.resolve_emergency_qr(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.resolve_emergency_qr(text) TO dawaee_app;
