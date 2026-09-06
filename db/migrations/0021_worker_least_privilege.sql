-- The worker gets exactly the privileges the worker code uses, and no others.
--
-- Two problems, one of which had been silently breaking a data-retention
-- control since it was written.
--
-- OVER-PRIVILEGE (finding P8-1). `dawaee_worker` held SELECT, INSERT and UPDATE
-- on all 27 user tables with `USING (true)` policies, so it could read every row
-- of every patient. Static analysis of apps/worker/src shows it touches 17, and
-- among the ten it never queries are emergency_cards, symptom_notes,
-- health_measurements, prescriptions and consents — the most sensitive data in
-- the system. The worker is a trusted service role, so this was not a
-- patient-to-patient break; but it is the process that talks to the push,
-- WhatsApp and OCR providers, so a compromise there yielded the entire PHI
-- corpus instead of the reminder subset it actually needs.
--
-- HOUSEKEEPING HAS NEVER RUN (finding P8-2). The worker was granted no DELETE on
-- anything, while housekeepingJob issues five of them. The first —
-- `DELETE FROM auth_sessions` — raises "permission denied", the job has no
-- catch, and every housekeeping run has aborted there. Verified by executing
-- the job's statements one at a time as `dawaee_worker`.
--
-- The consequences are exactly the retention that was supposed to be happening:
-- expired sessions were never purged, provider webhook events and job runs grew
-- without bound, orphaned upload objects were never removed, and
-- notification_deliveries was never trimmed to 90 days — which is why rows
-- containing medication names from before the notification-privacy change are
-- still present. A retention control that reports itself as implemented and has
-- never executed is worse than an absent one, because nobody goes looking.

-- ─────────────────────────────────────────── 1. start from nothing

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM dawaee_worker;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM dawaee_worker;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM dawaee_worker;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM dawaee_worker;

-- Default privileges are removed above so a table added by a future migration
-- is NOT automatically readable by the worker. A new table becomes visible only
-- when someone writes the grant deliberately, which is the point.

-- ─────────────────────────────────────────── 2. the manifest
--
-- Derived from every SQL statement in apps/worker/src. Each line names the job
-- that needs it, so a reviewer can check the claim rather than trust it.

-- reminders.ts — reads the open dose set and the people to notify
GRANT SELECT                         ON dose_occurrences            TO dawaee_worker;
GRANT UPDATE                         ON dose_occurrences            TO dawaee_worker;
GRANT SELECT                         ON medications                 TO dawaee_worker;
GRANT UPDATE                         ON medications                 TO dawaee_worker;
GRANT SELECT                         ON medication_schedules        TO dawaee_worker;
GRANT SELECT                         ON patient_profiles            TO dawaee_worker;
GRANT SELECT                         ON users                       TO dawaee_worker;
GRANT SELECT                         ON user_preferences            TO dawaee_worker;
GRANT SELECT                         ON escalation_policies         TO dawaee_worker;
GRANT SELECT                         ON caregiver_notification_rules TO dawaee_worker;
GRANT INSERT                         ON dose_events                 TO dawaee_worker;

-- dispatcher + reminders — the outbox
GRANT SELECT, INSERT, UPDATE, DELETE ON notification_deliveries     TO dawaee_worker;
GRANT SELECT, UPDATE                 ON push_tokens                 TO dawaee_worker;

-- stock-alerts.ts
GRANT SELECT, UPDATE                 ON medication_stock            TO dawaee_worker;

-- housekeeping.ts
GRANT SELECT, UPDATE                 ON caregiver_relationships     TO dawaee_worker;
GRANT SELECT, DELETE                 ON stored_objects              TO dawaee_worker;

-- operational tables with no patient data and no RLS
GRANT SELECT, INSERT, UPDATE, DELETE ON job_runs                    TO dawaee_worker;
GRANT SELECT, UPDATE, DELETE         ON provider_webhook_events     TO dawaee_worker;

-- Deliberately NOT granted, and each is data the worker never queries:
--   emergency_cards, symptom_notes, health_measurements, prescriptions,
--   consents, refill_events, travel_prompts, stock_transactions, audit_logs,
--   auth_otp_challenges, user_credentials, auth_sessions.

-- ─────────────────────────────────────────── 3. sessions, without the table
--
-- The worker's only session work is deleting rows that expired more than a
-- month ago. Granting DELETE would carry SELECT-shaped visibility of the whole
-- table in practice — a USING clause is evaluated against every row — and
-- auth_sessions holds refresh token hashes, device names and IP hashes for
-- every user in the system.
--
-- So the worker never touches the table. It calls a function that performs the
-- one DELETE and returns a count, and nothing else. SECURITY DEFINER with a
-- pinned search_path, EXECUTE revoked from PUBLIC and granted only to the
-- worker, and the argument is validated rather than trusted: a caller passing 0
-- or a negative number would otherwise delete live sessions and sign every user
-- out.

CREATE OR REPLACE FUNCTION app.cleanup_expired_sessions(p_older_than_days int)
RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
DECLARE removed bigint;
BEGIN
  -- A grace period below one day would let a clock skew or a long-running
  -- deploy delete sessions that are still in use; above a year it is not
  -- retention, it is a no-op that looks like one.
  IF p_older_than_days IS NULL OR p_older_than_days < 1 OR p_older_than_days > 365 THEN
    RAISE EXCEPTION 'cleanup_expired_sessions: p_older_than_days must be between 1 and 365';
  END IF;

  DELETE FROM auth_sessions
   WHERE expires_at < now() - make_interval(days => p_older_than_days);

  GET DIAGNOSTICS removed = ROW_COUNT;
  -- A count. Never a row, never a token hash, never a device name.
  RETURN removed;
END $$;

REVOKE EXECUTE ON FUNCTION app.cleanup_expired_sessions(int) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION app.cleanup_expired_sessions(int) TO dawaee_worker;

-- The two functions the worker already calls, re-asserted so the grant set is
-- readable in one place.
REVOKE EXECUTE ON FUNCTION app.purge_expired_otp(int) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION app.purge_expired_otp(int) TO dawaee_worker;

-- ─────────────────────────────────────────── 4. caregiver update, narrowed
--
-- Defence in depth for the one place a caregiver may write their own
-- relationship row.
--
-- The policy previously allowed `caregiver_user_id = current_user_id()` to
-- UPDATE the row with no constraint on the result, which meant the OLD/NEW
-- trigger was the ONLY thing preventing a caregiver from granting themselves
-- every permission. Proven load-bearing: dropping the trigger opens the
-- escalation immediately.
--
-- A WITH CHECK clause cannot compare OLD to NEW, so it cannot express
-- "permissions unchanged" — that is genuinely the trigger's job and the trigger
-- stays. But it CAN constrain the row the caregiver is allowed to produce, and
-- the only legitimate self-update is leaving the care circle (routes/caregivers
-- self-removal sets status='revoked'). Pinning that makes a second, independent
-- control: even with the trigger gone, a caregiver's UPDATE can only ever
-- result in a revoked row.

DROP POLICY IF EXISTS caregiver_rel_update ON caregiver_relationships;

-- `TO dawaee_app`, restored. 0008 scoped this policy to the application role;
-- the rewrite above dropped the clause, which in PostgreSQL means TO PUBLIC —
-- a permissive policy that unions with every other role's own policies,
-- including the worker's. The predicate happens to evaluate false for the
-- worker (it has no `app.user_id`, so `app.current_user_id()` is NULL), so
-- nothing was actually widened; but "happens to be false" is not a control, and
-- an accidental PUBLIC policy is exactly what 0030 refuses to let the schema
-- carry. Caught by that assertion, not by review.
CREATE POLICY caregiver_rel_update ON caregiver_relationships
  FOR UPDATE TO dawaee_app
  USING (
    app.owns_profile(patient_profile_id)
    OR caregiver_user_id = app.current_user_id()
  )
  WITH CHECK (
    app.owns_profile(patient_profile_id)
    -- A caregiver may only ever write a row that revokes their own access.
    OR (caregiver_user_id = app.current_user_id() AND status = 'revoked')
  );

COMMENT ON POLICY caregiver_rel_update ON caregiver_relationships IS
  'Patient owners may update freely. A caregiver may only produce a revoked '
  'row (self-removal). Permission widening is separately blocked by the '
  'caregiver_rel_privilege_guard trigger, which compares OLD to NEW; this '
  'policy is the second, independent control.';
