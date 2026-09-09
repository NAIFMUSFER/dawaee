-- =============================================================================
-- Dawaee — 0038: execute account erasure after the promised grace period
-- =============================================================================
--
-- `/v1/me/deletion-request` records deletion_requested_at and returns a
-- scheduledFor timestamp 14 days later. Until this migration there was no job,
-- function or other code path that consumed that marker: an account could be
-- "scheduled" forever and never be erased.
--
-- Deleting a user must also avoid destroying another patient's medical record
-- merely because the departing user created it while acting as a caregiver.
-- Creator/uploader columns are attribution, not ownership. Make those references
-- nullable and SET NULL on user deletion; data owned through the departing
-- user's own patient_profiles still disappears through the existing
-- patient_profiles.owner_user_id ON DELETE CASCADE graph.

ALTER TABLE medications ALTER COLUMN created_by DROP NOT NULL;
ALTER TABLE medications DROP CONSTRAINT medications_created_by_fkey;
ALTER TABLE medications
  ADD CONSTRAINT medications_created_by_fkey
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE medication_schedules ALTER COLUMN created_by DROP NOT NULL;
ALTER TABLE medication_schedules DROP CONSTRAINT medication_schedules_created_by_fkey;
ALTER TABLE medication_schedules
  ADD CONSTRAINT medication_schedules_created_by_fkey
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE prescriptions ALTER COLUMN created_by DROP NOT NULL;
ALTER TABLE prescriptions DROP CONSTRAINT prescriptions_created_by_fkey;
ALTER TABLE prescriptions
  ADD CONSTRAINT prescriptions_created_by_fkey
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE refill_events ALTER COLUMN created_by DROP NOT NULL;
ALTER TABLE refill_events DROP CONSTRAINT refill_events_created_by_fkey;
ALTER TABLE refill_events
  ADD CONSTRAINT refill_events_created_by_fkey
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE symptom_notes ALTER COLUMN created_by DROP NOT NULL;
ALTER TABLE symptom_notes DROP CONSTRAINT symptom_notes_created_by_fkey;
ALTER TABLE symptom_notes
  ADD CONSTRAINT symptom_notes_created_by_fkey
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE health_measurements ALTER COLUMN created_by DROP NOT NULL;
ALTER TABLE health_measurements DROP CONSTRAINT health_measurements_created_by_fkey;
ALTER TABLE health_measurements
  ADD CONSTRAINT health_measurements_created_by_fkey
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE caregiver_relationships ALTER COLUMN invited_by_user_id DROP NOT NULL;
ALTER TABLE caregiver_relationships DROP CONSTRAINT caregiver_relationships_invited_by_user_id_fkey;
ALTER TABLE caregiver_relationships
  ADD CONSTRAINT caregiver_relationships_invited_by_user_id_fkey
  FOREIGN KEY (invited_by_user_id) REFERENCES users(id) ON DELETE SET NULL;

-- An image uploaded by a caregiver can belong to another patient's profile.
-- Removing the caregiver must not delete that patient's medication image. The
-- profile relationship remains the authorization boundary; uploader identity
-- becomes optional after erasure.
ALTER TABLE stored_objects ALTER COLUMN owner_user_id DROP NOT NULL;
ALTER TABLE stored_objects DROP CONSTRAINT stored_objects_owner_user_id_fkey;
ALTER TABLE stored_objects
  ADD CONSTRAINT stored_objects_owner_user_id_fkey
  FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE SET NULL;

-- The worker deliberately has no DELETE privilege on users. Expose exactly one
-- operation: erase one account only when its durable request is at least the
-- configured grace period old. The function returns a boolean, never account
-- data, and cannot be used to delete an arbitrary live user.
CREATE OR REPLACE FUNCTION app.erase_due_account(p_user_id uuid, p_grace_days int)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
DECLARE
  requested_at timestamptz;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'erase_due_account: user id is required';
  END IF;
  IF p_grace_days IS NULL OR p_grace_days < 1 OR p_grace_days > 90 THEN
    RAISE EXCEPTION 'erase_due_account: grace days must be between 1 and 90';
  END IF;

  SELECT deletion_requested_at INTO requested_at
    FROM users
   WHERE id = p_user_id
   FOR UPDATE;

  IF requested_at IS NULL OR requested_at > now() - make_interval(days => p_grace_days) THEN
    RETURN false;
  END IF;

  DELETE FROM users WHERE id = p_user_id;
  RETURN FOUND;
END $$;

REVOKE EXECUTE ON FUNCTION app.erase_due_account(uuid, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.erase_due_account(uuid, int) TO dawaee_worker;

COMMENT ON FUNCTION app.erase_due_account(uuid, int) IS
  'Worker-only final account erasure. Refuses users whose deletion request has not completed its grace period.';
