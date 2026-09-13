-- =============================================================================
-- Dawaee — 0055: account erasure follows patient-profile ownership, not uploader
-- =============================================================================
--
-- `stored_objects.owner_user_id` is uploader attribution, not medical-record
-- ownership. Migration 0038 deliberately made that distinction so erasing a
-- caregiver does not delete an image they uploaded into somebody else's
-- profile. The first bounded erasure enumerator in 0039 nevertheless required
-- `owner_user_id = p_user_id` even for objects attached to a profile owned by
-- the departing patient. That left caregiver-uploaded prescription/medication
-- images out of the physical object deletion pass; the subsequent profile
-- cascade removed only PostgreSQL metadata, leaving private bytes behind.
--
-- Enumerate exactly two classes:
--   1. unattached upload tickets owned by the departing account; and
--   2. every object attached to a patient profile OWNED by that account,
--      regardless of who originally uploaded it.
--
-- An object the departing user uploaded into another patient's profile remains
-- excluded: that other patient's profile owns the medical record.

CREATE OR REPLACE FUNCTION app.list_due_account_object_keys(
  p_user_id uuid,
  p_grace_days int
)
RETURNS TABLE(object_key text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'list_due_account_object_keys: user id is required';
  END IF;
  IF p_grace_days IS NULL OR p_grace_days < 1 OR p_grace_days > 90 THEN
    RAISE EXCEPTION 'list_due_account_object_keys: grace days must be between 1 and 90';
  END IF;

  -- Keep the same fail-closed due-account boundary as 0039. This helper must
  -- never become a general object-key browser for a live account.
  IF NOT EXISTS (
    SELECT 1 FROM users u
     WHERE u.id = p_user_id
       AND u.deletion_requested_at IS NOT NULL
       AND u.deletion_requested_at <= now() - make_interval(days => p_grace_days)
  ) THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT so.object_key
    FROM stored_objects so
    LEFT JOIN patient_profiles pp ON pp.id = so.patient_profile_id
   WHERE (so.patient_profile_id IS NULL AND so.owner_user_id = p_user_id)
      OR pp.owner_user_id = p_user_id
   ORDER BY so.object_key;
END $$;

REVOKE EXECUTE ON FUNCTION app.list_due_account_object_keys(uuid, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.list_due_account_object_keys(uuid, int) TO dawaee_worker;

COMMENT ON FUNCTION app.list_due_account_object_keys(uuid, int) IS
  'Worker-only object keys safe to delete for an account already due for erasure: unattached objects uploaded by the account plus every object attached to a profile the account owns, regardless of uploader.';
