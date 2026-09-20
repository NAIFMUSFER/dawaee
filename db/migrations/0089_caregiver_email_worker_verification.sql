-- Background workers have no app.user_id. The self-only email inspection
-- helper therefore cannot authorize a caregiver on their behalf. Keep that
-- helper private to the current user and verify the exact relationship here.
CREATE OR REPLACE FUNCTION app.caregiver_identity_verified(p_relationship uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
  SELECT EXISTS (
    SELECT 1 FROM caregiver_relationships cr JOIN users u ON u.id = cr.caregiver_user_id
    WHERE cr.id = p_relationship AND u.disabled_at IS NULL
      AND CASE WHEN cr.invited_email IS NOT NULL
        THEN lower(u.email) = cr.invited_email AND EXISTS (
          SELECT 1 FROM user_email_verifications v
          WHERE v.user_id = u.id AND v.email = cr.invited_email
        )
        ELSE app.has_verified_phone(u.id) END
  )
$$;
REVOKE ALL ON FUNCTION app.caregiver_identity_verified(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.caregiver_identity_verified(uuid) TO dawaee_app, dawaee_worker;
