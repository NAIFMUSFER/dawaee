-- =============================================================================
-- Dawaee — 0039: narrow worker retention/account-erasure enumeration
-- =============================================================================
--
-- P20 CI reproduced the production privilege boundary: housekeeping tried to
-- discover abandoned uploads with direct subqueries over `prescriptions`, a PHI
-- table the least-privilege worker is intentionally forbidden to SELECT. That
-- statement raised `permission denied for table prescriptions` before account
-- erasure could run, so one retention class disabled every later housekeeping
-- class in the tick.
--
-- Do not repair that by giving the worker prescription access. Expose only the
-- three pieces of enumeration it actually needs, through owner-executed,
-- argument-bounded functions that return object keys or due user ids and no PHI.

CREATE OR REPLACE FUNCTION app.list_abandoned_object_keys(
  p_older_than_hours int,
  p_limit int
)
RETURNS TABLE(object_key text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
BEGIN
  IF p_older_than_hours IS NULL OR p_older_than_hours < 24 OR p_older_than_hours > 720 THEN
    RAISE EXCEPTION 'list_abandoned_object_keys: age must be between 24 and 720 hours';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 500 THEN
    RAISE EXCEPTION 'list_abandoned_object_keys: limit must be between 1 and 500';
  END IF;

  RETURN QUERY
  SELECT so.object_key
    FROM stored_objects so
   WHERE so.uploaded_at IS NULL
     AND so.created_at < now() - make_interval(hours => p_older_than_hours)
     AND NOT EXISTS (SELECT 1 FROM medications m WHERE m.image_key = so.object_key)
     AND NOT EXISTS (SELECT 1 FROM prescriptions p WHERE p.image_key = so.object_key)
     AND NOT EXISTS (SELECT 1 FROM patient_profiles pp WHERE pp.avatar_key = so.object_key)
   ORDER BY so.created_at, so.object_key
   LIMIT p_limit;
END $$;

CREATE OR REPLACE FUNCTION app.list_due_account_ids(
  p_grace_days int,
  p_limit int
)
RETURNS TABLE(user_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
BEGIN
  IF p_grace_days IS NULL OR p_grace_days < 1 OR p_grace_days > 90 THEN
    RAISE EXCEPTION 'list_due_account_ids: grace days must be between 1 and 90';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 500 THEN
    RAISE EXCEPTION 'list_due_account_ids: limit must be between 1 and 500';
  END IF;

  RETURN QUERY
  SELECT u.id
    FROM users u
   WHERE u.deletion_requested_at IS NOT NULL
     AND u.deletion_requested_at <= now() - make_interval(days => p_grace_days)
   ORDER BY u.deletion_requested_at, u.id
   LIMIT p_limit;
END $$;

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

  -- The same due condition is checked here and again by erase_due_account.
  -- This prevents the worker from using the helper as a general object-key
  -- browser for a live account.
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
   WHERE so.owner_user_id = p_user_id
     AND (so.patient_profile_id IS NULL OR pp.owner_user_id = p_user_id)
   ORDER BY so.object_key;
END $$;

REVOKE EXECUTE ON FUNCTION app.list_abandoned_object_keys(int, int) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.list_due_account_ids(int, int) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.list_due_account_object_keys(uuid, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.list_abandoned_object_keys(int, int) TO dawaee_worker;
GRANT EXECUTE ON FUNCTION app.list_due_account_ids(int, int) TO dawaee_worker;
GRANT EXECUTE ON FUNCTION app.list_due_account_object_keys(uuid, int) TO dawaee_worker;

-- Housekeeping no longer needs raw stored-object table access. The physical
-- object is deleted through the storage provider and metadata is removed by the
-- existing narrow definer function from 0038.
REVOKE SELECT, DELETE ON stored_objects FROM dawaee_worker;

COMMENT ON FUNCTION app.list_abandoned_object_keys(int, int) IS
  'Worker-only bounded list of old, unreferenced private object keys; exposes no prescription or medication row data.';
COMMENT ON FUNCTION app.list_due_account_ids(int, int) IS
  'Worker-only bounded list of account ids whose explicit deletion grace period has elapsed.';
COMMENT ON FUNCTION app.list_due_account_object_keys(uuid, int) IS
  'Worker-only object keys safe to delete for an account already due for erasure; refuses live/not-due accounts.';
