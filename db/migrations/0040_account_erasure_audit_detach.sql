-- =============================================================================
-- Dawaee — 0040: account erasure may detach audit identity, never rewrite audit
-- =============================================================================
--
-- CI reproduced a real erasure failure in 0038. `audit_logs.actor_user_id` is
-- `ON DELETE SET NULL`, but the append-only trigger introduced in 0014 permits
-- only patient_profile_id to be nulled. Deleting a due user therefore aborts
-- with SQLSTATE 42501 before the account is erased.
--
-- The repair is deliberately narrower than "allow actor changes":
--   * profile detachment remains the existing FK redaction;
--   * actor detachment is accepted only while app.erase_due_account() has set a
--     transaction-local marker naming exactly that actor;
--   * every other audit column must be byte-for-byte unchanged. Using to_jsonb
--     minus the one allowed field means a future audit column is immutable by
--     default instead of silently falling outside an old hand-written list.

CREATE OR REPLACE FUNCTION app.audit_allow_only_profile_redaction() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  erasing_actor text := current_setting('app.erasing_user_id', true);
  profile_detach boolean;
  actor_detach boolean;
BEGIN
  profile_detach :=
    NEW.patient_profile_id IS NULL
    AND OLD.patient_profile_id IS NOT NULL
    AND (to_jsonb(NEW) - 'patient_profile_id')
        IS NOT DISTINCT FROM (to_jsonb(OLD) - 'patient_profile_id');

  actor_detach :=
    NEW.actor_user_id IS NULL
    AND OLD.actor_user_id IS NOT NULL
    AND erasing_actor IS NOT NULL
    AND erasing_actor = OLD.actor_user_id::text
    AND (to_jsonb(NEW) - 'actor_user_id')
        IS NOT DISTINCT FROM (to_jsonb(OLD) - 'actor_user_id');

  IF profile_detach OR actor_detach THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION
    'audit_logs is append-only; only FK detachment during verified erasure is permitted'
    USING ERRCODE = 'insufficient_privilege';
END $$;

-- Re-state the erasure function so the actor FK cascade has an authenticated,
-- transaction-local context. The setting disappears automatically when the
-- transaction ends; callers cannot use this function to detach any other actor.
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

  DELETE FROM stored_objects
   WHERE owner_user_id = p_user_id AND patient_profile_id IS NULL;

  -- Authorize exactly the FK-driven actor_user_id redaction caused by the next
  -- statement. `is_local=true` keeps the marker inside this transaction.
  PERFORM set_config('app.erasing_user_id', p_user_id::text, true);
  DELETE FROM users WHERE id = p_user_id;
  RETURN FOUND;
END $$;

REVOKE EXECUTE ON FUNCTION app.erase_due_account(uuid, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.erase_due_account(uuid, int) TO dawaee_worker;

COMMENT ON FUNCTION app.audit_allow_only_profile_redaction() IS
  'Append-only audit guard: permits only FK nulling of profile ids, or actor ids while erase_due_account names that exact actor; all other columns remain immutable.';
