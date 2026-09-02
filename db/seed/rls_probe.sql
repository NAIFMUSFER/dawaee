-- =============================================================================
-- Adversarial RLS probe. Creates two unrelated patients plus a caregiver with
-- narrow permissions, then attempts every cross-boundary access we care about.
-- Run against a freshly migrated database. Any FAIL line is a security defect.
-- =============================================================================
\set ON_ERROR_STOP off
\set QUIET on
SET client_min_messages = warning;

BEGIN;

-- ---------------------------------------------------------------- fixtures
INSERT INTO users (id, phone_e164, display_name) VALUES
  ('11111111-1111-1111-1111-111111111111', '+966500000001', 'Patient A'),
  ('22222222-2222-2222-2222-222222222222', '+966500000002', 'Patient B'),
  ('33333333-3333-3333-3333-333333333333', '+966500000003', 'Caregiver C'),
  ('44444444-4444-4444-4444-444444444444', '+966500000004', 'Stranger D'),
  ('55555555-5555-5555-5555-555555555555', '+966500000005', 'Invitee E');

INSERT INTO patient_profiles (id, owner_user_id, display_name, is_self) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'Patient A', true),
  ('bbbbbbbb-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222222', 'Patient B', true);

INSERT INTO medications (id, patient_profile_id, name, form, start_date, created_by) VALUES
  ('ccccccc1-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'Med of A', 'tablet', '2026-09-01', '11111111-1111-1111-1111-111111111111'),
  ('ccccccc2-0000-0000-0000-000000000002', 'bbbbbbbb-0000-0000-0000-000000000002', 'Med of B', 'tablet', '2026-09-01', '22222222-2222-2222-2222-222222222222');

-- Caregiver C may only view A's adherence. No medication list, no editing.
INSERT INTO caregiver_relationships
  (id, patient_profile_id, caregiver_user_id, role, status, permissions, escalation_priority, invited_by_user_id, accepted_at)
VALUES
  ('dddddddd-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001',
   '33333333-3333-3333-3333-333333333333', 'son', 'active',
   ARRAY['view_adherence','receive_notifications'], 1,
   '11111111-1111-1111-1111-111111111111', now());

-- An expired, never-accepted invitation for stranger D.
INSERT INTO caregiver_relationships
  (id, patient_profile_id, invited_phone_e164, invitation_token_hash, invitation_expires_at,
   role, status, permissions, invited_by_user_id)
VALUES
  ('dddddddd-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000001',
   '+966500000004', 'expired-token-hash', now() - interval '1 day',
   'other', 'pending', ARRAY['view_medications'], '11111111-1111-1111-1111-111111111111');

-- A live invitation for stranger D, and one the patient will try to self-accept.
INSERT INTO caregiver_relationships
  (id, patient_profile_id, invited_phone_e164, invitation_token_hash, invitation_expires_at,
   role, status, permissions, invited_by_user_id)
VALUES
  ('dddddddd-0000-0000-0000-000000000003', 'aaaaaaaa-0000-0000-0000-000000000001',
   '+966500000005', 'live-token-hash', now() + interval '2 days',
   'other', 'pending', ARRAY['view_adherence'], '11111111-1111-1111-1111-111111111111'),
  ('dddddddd-0000-0000-0000-000000000004', 'aaaaaaaa-0000-0000-0000-000000000001',
   '+966500000009', 'self-token-hash', now() + interval '2 days',
   'other', 'pending', ARRAY['view_adherence'], '11111111-1111-1111-1111-111111111111');

CREATE TABLE probe_results (name text, expected text, actual text, pass boolean);
GRANT ALL ON probe_results TO dawaee_app;

CREATE FUNCTION pg_temp.probe(p_name text, p_user text, p_sql text, p_expected text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE got text;
BEGIN
  PERFORM set_config('app.user_id', p_user, true);
  BEGIN
    EXECUTE p_sql INTO got;
    got := COALESCE(got, 'null');
  EXCEPTION WHEN others THEN
    got := 'error:' || SQLSTATE;
  END;
  INSERT INTO probe_results VALUES (p_name, p_expected, got, got = p_expected);
END $$;

GRANT EXECUTE ON FUNCTION pg_temp.probe(text,text,text,text) TO dawaee_app;
SET ROLE dawaee_app;

-- ============================ READ ISOLATION ================================
SELECT pg_temp.probe('A sees own medication',
  '11111111-1111-1111-1111-111111111111',
  $q$SELECT count(*)::text FROM medications WHERE patient_profile_id='aaaaaaaa-0000-0000-0000-000000000001'$q$, '1');

SELECT pg_temp.probe('A CANNOT see B medication',
  '11111111-1111-1111-1111-111111111111',
  $q$SELECT count(*)::text FROM medications WHERE patient_profile_id='bbbbbbbb-0000-0000-0000-000000000002'$q$, '0');

SELECT pg_temp.probe('A CANNOT see B by direct row id (IDOR)',
  '11111111-1111-1111-1111-111111111111',
  $q$SELECT count(*)::text FROM medications WHERE id='ccccccc2-0000-0000-0000-000000000002'$q$, '0');

SELECT pg_temp.probe('A CANNOT see B profile',
  '11111111-1111-1111-1111-111111111111',
  $q$SELECT count(*)::text FROM patient_profiles WHERE id='bbbbbbbb-0000-0000-0000-000000000002'$q$, '0');

SELECT pg_temp.probe('unscoped medication scan returns only own rows',
  '22222222-2222-2222-2222-222222222222',
  $q$SELECT count(*)::text FROM medications$q$, '1');

-- ====================== CAREGIVER PERMISSION SCOPE ==========================
SELECT pg_temp.probe('caregiver with view_adherence can read A doses',
  '33333333-3333-3333-3333-333333333333',
  $q$SELECT count(*)::text FROM dose_occurrences WHERE patient_profile_id='aaaaaaaa-0000-0000-0000-000000000001'$q$, '0');

SELECT pg_temp.probe('caregiver WITHOUT view_medications cannot read the medication list',
  '33333333-3333-3333-3333-333333333333',
  $q$SELECT count(*)::text FROM medications WHERE patient_profile_id='aaaaaaaa-0000-0000-0000-000000000001'$q$, '0');

SELECT pg_temp.probe('caregiver cannot read a DIFFERENT patient',
  '33333333-3333-3333-3333-333333333333',
  $q$SELECT count(*)::text FROM medications WHERE patient_profile_id='bbbbbbbb-0000-0000-0000-000000000002'$q$, '0');

SELECT pg_temp.probe('caregiver cannot insert a medication for A',
  '33333333-3333-3333-3333-333333333333',
  $q$WITH i AS (INSERT INTO medications (patient_profile_id,name,form,start_date,created_by)
     VALUES ('aaaaaaaa-0000-0000-0000-000000000001','Injected','tablet','2026-09-01','33333333-3333-3333-3333-333333333333')
     RETURNING 1) SELECT count(*)::text FROM i$q$, 'error:42501');

SELECT pg_temp.probe('caregiver cannot grant themselves more permissions',
  '33333333-3333-3333-3333-333333333333',
  $q$WITH u AS (UPDATE caregiver_relationships SET permissions=ARRAY['view_medications','edit_medication']
     WHERE id='dddddddd-0000-0000-0000-000000000001' RETURNING 1) SELECT count(*)::text FROM u$q$, 'error:42501');

SELECT pg_temp.probe('caregiver CAN leave the circle themselves',
  '33333333-3333-3333-3333-333333333333',
  $q$WITH u AS (UPDATE caregiver_relationships SET status='revoked'
     WHERE id='dddddddd-0000-0000-0000-000000000001' RETURNING 1) SELECT count(*)::text FROM u$q$, '1');

SELECT pg_temp.probe('caregiver cannot raise their escalation priority',
  '33333333-3333-3333-3333-333333333333',
  $q$WITH u AS (UPDATE caregiver_relationships SET escalation_priority=1
     WHERE id='dddddddd-0000-0000-0000-000000000001' RETURNING 1) SELECT count(*)::text FROM u$q$, 'error:42501');

SELECT pg_temp.probe('patient CAN change caregiver permissions',
  '11111111-1111-1111-1111-111111111111',
  $q$WITH u AS (UPDATE caregiver_relationships SET permissions=ARRAY['view_adherence']
     WHERE id='dddddddd-0000-0000-0000-000000000001' RETURNING 1) SELECT count(*)::text FROM u$q$, '1');

SELECT pg_temp.probe('expired invitation token is refused by the accept function',
  '44444444-4444-4444-4444-444444444444',
  $q$SELECT outcome FROM app.accept_caregiver_invitation('expired-token-hash','44444444-4444-4444-4444-444444444444')$q$,
  'expired');

SELECT pg_temp.probe('a valid invitation can be accepted exactly once',
  '55555555-5555-5555-5555-555555555555',
  $q$SELECT outcome FROM app.accept_caregiver_invitation('live-token-hash','55555555-5555-5555-5555-555555555555')$q$,
  'accepted');

SELECT pg_temp.probe('the same invitation token cannot be replayed',
  '55555555-5555-5555-5555-555555555555',
  $q$SELECT outcome FROM app.accept_caregiver_invitation('live-token-hash','55555555-5555-5555-5555-555555555555')$q$,
  'invalid');

SELECT pg_temp.probe('the patient cannot accept their own invitation',
  '11111111-1111-1111-1111-111111111111',
  $q$SELECT outcome FROM app.accept_caregiver_invitation('self-token-hash','11111111-1111-1111-1111-111111111111')$q$,
  'self');

SELECT pg_temp.probe('unknown invitation token is refused',
  '44444444-4444-4444-4444-444444444444',
  $q$SELECT outcome FROM app.accept_caregiver_invitation('no-such-token','44444444-4444-4444-4444-444444444444')$q$,
  'invalid');

-- ========================= STRANGER / EXPIRED INVITE ========================
SELECT pg_temp.probe('stranger sees nothing',
  '44444444-4444-4444-4444-444444444444',
  $q$SELECT count(*)::text FROM medications$q$, '0');

SELECT pg_temp.probe('expired pending invitation grants no read access',
  '44444444-4444-4444-4444-444444444444',
  $q$SELECT count(*)::text FROM patient_profiles WHERE id='aaaaaaaa-0000-0000-0000-000000000001'$q$, '0');

SELECT pg_temp.probe('unauthenticated session sees nothing',
  '',
  $q$SELECT count(*)::text FROM medications$q$, '0');

-- ============================ WRITE ISOLATION ===============================
SELECT pg_temp.probe('A cannot update B medication',
  '11111111-1111-1111-1111-111111111111',
  $q$WITH u AS (UPDATE medications SET name='hacked' WHERE id='ccccccc2-0000-0000-0000-000000000002' RETURNING 1)
     SELECT count(*)::text FROM u$q$, '0');

SELECT pg_temp.probe('A cannot delete B medication',
  '11111111-1111-1111-1111-111111111111',
  $q$WITH d AS (DELETE FROM medications WHERE id='ccccccc2-0000-0000-0000-000000000002' RETURNING 1)
     SELECT count(*)::text FROM d$q$, '0');

SELECT pg_temp.probe('A cannot create a medication under B profile',
  '11111111-1111-1111-1111-111111111111',
  $q$WITH i AS (INSERT INTO medications (patient_profile_id,name,form,start_date,created_by)
     VALUES ('bbbbbbbb-0000-0000-0000-000000000002','Planted','tablet','2026-09-01','11111111-1111-1111-1111-111111111111')
     RETURNING 1) SELECT count(*)::text FROM i$q$, 'error:42501');

SELECT pg_temp.probe('A cannot attach themselves as B caregiver',
  '11111111-1111-1111-1111-111111111111',
  $q$WITH i AS (INSERT INTO caregiver_relationships
     (patient_profile_id, caregiver_user_id, role, status, permissions, invited_by_user_id, accepted_at)
     VALUES ('bbbbbbbb-0000-0000-0000-000000000002','11111111-1111-1111-1111-111111111111','other','active',
             ARRAY['view_medications'],'11111111-1111-1111-1111-111111111111',now()) RETURNING 1)
     SELECT count(*)::text FROM i$q$, 'error:42501');

-- ============================== AUDIT INTEGRITY =============================
SELECT pg_temp.probe('audit rows can be written',
  '11111111-1111-1111-1111-111111111111',
  $q$WITH i AS (INSERT INTO audit_logs (actor_user_id, patient_profile_id, action, entity_type, entity_id)
     VALUES ('11111111-1111-1111-1111-111111111111','aaaaaaaa-0000-0000-0000-000000000001',
             'medication.created','medication','ccccccc1-0000-0000-0000-000000000001') RETURNING 1)
     SELECT count(*)::text FROM i$q$, '1');

SELECT pg_temp.probe('audit rows CANNOT be updated',
  '11111111-1111-1111-1111-111111111111',
  $q$WITH u AS (UPDATE audit_logs SET action='tampered' RETURNING 1) SELECT count(*)::text FROM u$q$, 'error:42501');

SELECT pg_temp.probe('audit rows CANNOT be deleted',
  '11111111-1111-1111-1111-111111111111',
  $q$WITH d AS (DELETE FROM audit_logs RETURNING 1) SELECT count(*)::text FROM d$q$, 'error:42501');

SELECT pg_temp.probe('OTP hashes are unreadable by the app role',
  '11111111-1111-1111-1111-111111111111',
  $q$SELECT count(*)::text FROM auth_otp_challenges$q$, 'error:42501');

-- ====================== STRUCTURAL PROFILE GUARD ============================
SELECT pg_temp.probe('a schedule cannot claim a profile its medication does not belong to',
  '11111111-1111-1111-1111-111111111111',
  $q$WITH i AS (INSERT INTO medication_schedules
     (medication_id, patient_profile_id, rule_kind, rule, dose_quantity, dose_unit, start_date, created_by)
     VALUES ('ccccccc1-0000-0000-0000-000000000001','bbbbbbbb-0000-0000-0000-000000000002','fixed_times',
             '{"kind":"fixed_times","times":["08:00"]}'::jsonb,1,'tablet','2026-09-01',
             '11111111-1111-1111-1111-111111111111') RETURNING 1)
     SELECT count(*)::text FROM i$q$, 'error:P0001');

RESET ROLE;
\set QUIET off
SELECT CASE WHEN pass THEN 'PASS' ELSE 'FAIL' END AS result,
       name, expected, actual
FROM probe_results ORDER BY pass, name;

SELECT count(*) FILTER (WHERE pass) AS passed,
       count(*) FILTER (WHERE NOT pass) AS failed
FROM probe_results;
ROLLBACK;
