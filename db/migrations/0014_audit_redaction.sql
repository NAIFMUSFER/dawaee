-- =============================================================================
-- Dawaee — 0014: let a patient be erased without breaking the audit log
--
-- 0007 made audit_logs append-only with STATEMENT-level triggers. That is too
-- broad in one specific way: audit_logs.patient_profile_id is a foreign key
-- declared ON DELETE SET NULL, so deleting a profile makes PostgreSQL issue its
-- own UPDATE against audit_logs — and a statement-level trigger fires on that
-- update even when it matches zero rows.
--
-- The effect is that a patient profile can never be deleted. Not "is hard to
-- delete": the DELETE always fails, whether or not the patient has any audit
-- history at all. For a health application that is a real problem — a person
-- asking for their data to be erased could not be served, and Saudi PDPL
-- treats erasure as a right, not a courtesy.
--
-- The fix keeps the property that matters. What must be immutable is the
-- CONTENT of an audit entry: who did what, to what, when. Detaching an entry
-- from a profile that no longer exists does not rewrite history — it is the
-- redaction that erasure requires, and the entry survives with its action,
-- timestamp and actor intact.
--
-- So: block every UPDATE except one that changes nothing but
-- patient_profile_id, and only in the direction of NULL. DELETE and TRUNCATE
-- stay blocked outright.
-- =============================================================================

CREATE OR REPLACE FUNCTION app.block_audit_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only; % is not permitted', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END $$;

CREATE OR REPLACE FUNCTION app.audit_allow_only_profile_redaction() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- The only permitted change: severing the link to a deleted profile.
  IF NEW.patient_profile_id IS NULL AND OLD.patient_profile_id IS NOT NULL
     AND NEW.id              IS NOT DISTINCT FROM OLD.id
     AND NEW.at              IS NOT DISTINCT FROM OLD.at
     AND NEW.actor_user_id   IS NOT DISTINCT FROM OLD.actor_user_id
     AND NEW.action          IS NOT DISTINCT FROM OLD.action
     AND NEW.entity_type     IS NOT DISTINCT FROM OLD.entity_type
     AND NEW.entity_id       IS NOT DISTINCT FROM OLD.entity_id
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'audit_logs is append-only; only detaching a deleted profile is permitted'
    USING ERRCODE = 'insufficient_privilege';
END $$;

-- Row-level, so an update matching no rows is not an error in itself.
DROP TRIGGER IF EXISTS audit_logs_no_update ON audit_logs;
CREATE TRIGGER audit_logs_no_update BEFORE UPDATE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION app.audit_allow_only_profile_redaction();

-- Deletion and truncation remain categorically refused.
DROP TRIGGER IF EXISTS audit_logs_no_delete ON audit_logs;
CREATE TRIGGER audit_logs_no_delete BEFORE DELETE ON audit_logs
  FOR EACH STATEMENT EXECUTE FUNCTION app.block_audit_mutation();
DROP TRIGGER IF EXISTS audit_logs_no_truncate ON audit_logs;
CREATE TRIGGER audit_logs_no_truncate BEFORE TRUNCATE ON audit_logs
  FOR EACH STATEMENT EXECUTE FUNCTION app.block_audit_mutation();
