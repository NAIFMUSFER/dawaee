-- One-off production follow-up requested by the project owner on 2026-09-20.
-- Default is a ROLLBACK rehearsal. Execute only after an encrypted recovery
-- snapshot has been saved and decrypted successfully. This is NOT a migration.
-- Scope is the one remaining non-disabled account at the fixed inventory cutoff.
-- The owner explicitly expanded the reset to include new accounts. Already
-- retired accounts retain their original deletion timestamps and audit record.
-- Existing audit guards, RLS, session revocation and 14-day erasure stay active.
-- This retires accounts and releases identifiers NOW; physical account/image
-- erasure is performed by the existing worker after the real request timestamp.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
DO $reset$
DECLARE
  cutoff constant timestamptz := '2026-09-20T09:09:51.718313+00:00';
  fingerprint constant text := '1d95f0f643b3ecdac5a0389bd1a87abb9b93b78fd41e8f88df38659326c296fa';
  batch constant text := 'owner-account-reset-20260920-production';
  account_ids uuid[];
  profile_ids uuid[];
  old_phones text[];
  old_emails text[];
  uid uuid;
  job_name text;
  before_migrations integer;
  before_objects integer;
  before_audit bigint;
  changed integer;
BEGIN
  IF current_user <> 'postgres' OR current_database() <> 'postgres' THEN
    RAISE EXCEPTION 'Reset requires the inventoried production operator connection';
  END IF;
  IF EXISTS (SELECT 1 FROM public.audit_logs WHERE request_id = batch) THEN
    RAISE EXCEPTION 'This account reset has already been recorded; do not replay it';
  END IF;

  -- Do not race an in-flight provider send, clinical job or erasure job.
  FOREACH job_name IN ARRAY ARRAY['digests','dispatch','housekeeping','mark-missed',
      'materialize','push-receipts','reminders','stock-alerts'] LOOP
    IF NOT app.try_job_lock(job_name) THEN
      RAISE EXCEPTION 'Worker job % is in flight; reset made no changes', job_name;
    END IF;
  END LOOP;

  SELECT array_agg(id ORDER BY id) INTO account_ids
    FROM public.users WHERE created_at <= cutoff AND disabled_at IS NULL;
  IF cardinality(account_ids) IS DISTINCT FROM 1 OR
     (SELECT encode(extensions.digest(string_agg(id::text, ',' ORDER BY id), 'sha256'), 'hex')
        FROM public.users WHERE id = ANY(account_ids)) IS DISTINCT FROM fingerprint THEN
    RAISE EXCEPTION 'Account inventory changed; stop and review the scope';
  END IF;
  FOREACH uid IN ARRAY account_ids LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended(uid::text, 20260912));
  END LOOP;
  PERFORM 1 FROM public.users WHERE id = ANY(account_ids) ORDER BY id FOR UPDATE;
  IF EXISTS (SELECT 1 FROM public.users WHERE id = ANY(account_ids)
      AND disabled_at IS NOT NULL) THEN
    RAISE EXCEPTION 'Account state changed since review; do not overwrite it';
  END IF;
  SELECT array_agg(phone_e164) FILTER (WHERE phone_e164 IS NOT NULL),
         array_agg(lower(email)) FILTER (WHERE email IS NOT NULL)
    INTO old_phones, old_emails FROM public.users WHERE id = ANY(account_ids);
  SELECT array_agg(id) INTO profile_ids FROM public.patient_profiles
    WHERE owner_user_id = ANY(account_ids);
  IF cardinality(profile_ids) IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'Patient profile inventory changed; stop and review the scope';
  END IF;
  SELECT count(*) INTO before_migrations FROM public.schema_migrations;
  SELECT count(*) INTO before_objects FROM public.stored_objects;
  SELECT count(*) INTO before_audit FROM public.audit_logs;

  UPDATE public.auth_otp_challenges SET consumed_at = now()
    WHERE phone_e164 = ANY(old_phones) AND consumed_at IS NULL;
  -- .invalid is reserved and cannot deliver email. The old contacts are freed
  -- for new UUIDs; no old verified-identity or patient relationship is inherited.
  UPDATE public.users SET disabled_at = now(), deletion_requested_at = coalesce(deletion_requested_at, now()),
      phone_e164 = NULL, email = 'reset-' || id::text || '@deleted.invalid',
      display_name = 'حساب محذوف', is_admin = false
    WHERE id = ANY(account_ids);
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed <> 1 THEN RAISE EXCEPTION 'Expected exactly one additional retired account'; END IF;
  UPDATE public.auth_sessions SET revoked_at = now()
    WHERE user_id = ANY(account_ids) AND revoked_at IS NULL;
  UPDATE public.push_tokens SET active = false WHERE user_id = ANY(account_ids) AND active;
  DELETE FROM public.user_credentials WHERE user_id = ANY(account_ids);
  DELETE FROM public.user_phone_verifications WHERE user_id = ANY(account_ids);
  DELETE FROM public.user_email_verifications WHERE user_id = ANY(account_ids);
  DELETE FROM public.account_email_challenges WHERE user_id = ANY(account_ids);
  DELETE FROM public.account_email_onboarding WHERE user_id = ANY(account_ids);
  DELETE FROM public.password_recovery_receipts WHERE user_id = ANY(account_ids);

  UPDATE public.patient_profiles SET archived_at = now() WHERE id = ANY(profile_ids);
  UPDATE public.medication_schedules SET active = false
    WHERE patient_profile_id = ANY(profile_ids) AND active;
  UPDATE public.medications SET status = 'archived'
    WHERE patient_profile_id = ANY(profile_ids) AND status <> 'archived';
  UPDATE public.caregiver_relationships SET status = 'revoked', revoked_at = now(),
      revoked_by_user_id = NULL, invitation_token_hash = NULL,
      invitation_expires_at = NULL, permissions = '{}'
    WHERE patient_profile_id = ANY(profile_ids) OR caregiver_user_id = ANY(account_ids);
  UPDATE public.caregiver_notification_rules SET enabled = false
    WHERE patient_profile_id = ANY(profile_ids) AND enabled;
  UPDATE public.escalation_policies SET enabled = false
    WHERE patient_profile_id = ANY(profile_ids) AND enabled;
  UPDATE public.emergency_cards SET qr_enabled = false, qr_token_hash = NULL,
      qr_rotated_at = now() WHERE patient_profile_id = ANY(profile_ids);
  UPDATE public.notification_deliveries SET status = 'skipped',
      error_code = 'ACCOUNT_RESET', error_detail = 'Account retired by owner reset',
      lease_token = NULL, lease_until = NULL
    WHERE (patient_profile_id = ANY(profile_ids) OR recipient_user_id = ANY(account_ids))
      AND status IN ('queued','sending');

  IF EXISTS (SELECT 1 FROM public.users
      WHERE phone_e164 = ANY(old_phones) OR lower(email) = ANY(old_emails)) OR
     EXISTS (SELECT 1 FROM public.auth_sessions WHERE user_id = ANY(account_ids) AND revoked_at IS NULL) OR
     EXISTS (SELECT 1 FROM public.push_tokens WHERE user_id = ANY(account_ids) AND active) OR
     EXISTS (SELECT 1 FROM public.user_credentials WHERE user_id = ANY(account_ids)) OR
     EXISTS (SELECT 1 FROM public.patient_profiles WHERE id = ANY(profile_ids) AND archived_at IS NULL) OR
     EXISTS (SELECT 1 FROM public.medication_schedules WHERE patient_profile_id = ANY(profile_ids) AND active) OR
     EXISTS (SELECT 1 FROM public.caregiver_relationships WHERE patient_profile_id = ANY(profile_ids)
       AND (status IN ('active','pending') OR invitation_token_hash IS NOT NULL)) OR
     EXISTS (SELECT 1 FROM public.emergency_cards WHERE patient_profile_id = ANY(profile_ids)
       AND (qr_enabled OR qr_token_hash IS NOT NULL)) OR
     EXISTS (SELECT 1 FROM public.notification_deliveries WHERE patient_profile_id = ANY(profile_ids)
       AND status IN ('queued','sending')) THEN
    RAISE EXCEPTION 'Reset postconditions failed; every change must roll back';
  END IF;
  IF (SELECT count(*) FROM public.schema_migrations) <> before_migrations OR
     (SELECT count(*) FROM public.stored_objects) <> before_objects OR
     (SELECT count(*) FROM public.audit_logs) <> before_audit THEN
    RAISE EXCEPTION 'Protected schema, storage metadata or audit history changed';
  END IF;
  INSERT INTO public.audit_logs(actor_user_id, actor_role, action, entity_type, request_id, new_value)
    VALUES(NULL, 'admin', 'accounts.registration_reset', 'account_batch', batch,
      jsonb_build_object('account_count',1,'profile_count',1,'cutoff',cutoff,
        'identifier_fingerprint',fingerprint,'authorization','project owner request in work session',
        'identifiers_released',true,'sessions_revoked',true,'physical_erasure','existing worker after 14 days',
        'scheduled_for',(SELECT max(deletion_requested_at)+interval '14 days' FROM public.users WHERE id = ANY(account_ids))));
END
$reset$;
ROLLBACK;
SELECT 'Reset rehearsal completed; all account changes rolled back' AS result;
