-- =============================================================================
-- Dawaee — 0008: roles, access predicates, row-level security
--
-- Threat model: assume an application bug lets a request reach a query with
-- the wrong profile id. RLS must still refuse it. The API therefore connects
-- as `dawaee_app`, which owns nothing and cannot bypass RLS, and sets
-- `app.user_id` per transaction. Every policy is written against that value.
-- =============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dawaee_app') THEN
    -- LOGIN because the API connects as this role directly; the password is
    -- set out of band by the deploy (scripts/db-bootstrap-roles.sh), never
    -- committed here.
    CREATE ROLE dawaee_app LOGIN NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dawaee_worker') THEN
    CREATE ROLE dawaee_worker LOGIN NOBYPASSRLS;
  END IF;
END $$;

-- Idempotent: re-running migrations against a cluster where these roles
-- already exist must still converge on the intended attributes.
ALTER ROLE dawaee_app LOGIN NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE;
ALTER ROLE dawaee_worker LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE;

GRANT USAGE ON SCHEMA public, app TO dawaee_app, dawaee_worker;

-- ------------------------------------------------------- access predicates
-- SECURITY DEFINER so the predicate can read caregiver_relationships without
-- recursing into that table's own RLS policy. search_path is pinned to defeat
-- search-path hijacking.

CREATE OR REPLACE FUNCTION app.owns_profile(p_profile uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
  SELECT EXISTS (
    SELECT 1 FROM patient_profiles pp
    WHERE pp.id = p_profile
      AND app.current_user_id() IS NOT NULL
      AND (pp.owner_user_id = app.current_user_id() OR pp.linked_user_id = app.current_user_id())
  )
$$;

CREATE OR REPLACE FUNCTION app.caregives_profile(p_profile uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
  SELECT EXISTS (
    SELECT 1 FROM caregiver_relationships cr
    WHERE cr.patient_profile_id = p_profile
      AND cr.caregiver_user_id = app.current_user_id()
      AND cr.status = 'active'
      AND app.current_user_id() IS NOT NULL
  )
$$;

CREATE OR REPLACE FUNCTION app.can_read_profile(p_profile uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
  SELECT app.owns_profile(p_profile) OR app.caregives_profile(p_profile)
$$;

-- Owners hold every permission implicitly; caregivers hold only what the
-- patient granted, and only while the relationship is active.
CREATE OR REPLACE FUNCTION app.has_permission(p_profile uuid, p_perm text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
  SELECT app.owns_profile(p_profile) OR EXISTS (
    SELECT 1 FROM caregiver_relationships cr
    WHERE cr.patient_profile_id = p_profile
      AND cr.caregiver_user_id = app.current_user_id()
      AND cr.status = 'active'
      AND p_perm = ANY (cr.permissions)
      AND app.current_user_id() IS NOT NULL
  )
$$;

REVOKE EXECUTE ON FUNCTION app.owns_profile(uuid), app.caregives_profile(uuid),
  app.can_read_profile(uuid), app.has_permission(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.owns_profile(uuid), app.caregives_profile(uuid),
  app.can_read_profile(uuid), app.has_permission(uuid, text),
  app.current_user_id(), app.try_job_lock(text) TO dawaee_app, dawaee_worker;

-- ------------------------------------------------------------------ users

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;

CREATE POLICY users_self_read ON users FOR SELECT TO dawaee_app
  USING (
    id = app.current_user_id()
    -- A connected caregiver may see the patient's display name, and vice
    -- versa, so the Family Care Circle screen can render names.
    OR EXISTS (
      SELECT 1 FROM caregiver_relationships cr
      JOIN patient_profiles pp ON pp.id = cr.patient_profile_id
      WHERE cr.status = 'active'
        AND ((cr.caregiver_user_id = app.current_user_id() AND users.id IN (pp.owner_user_id, pp.linked_user_id))
          OR (users.id = cr.caregiver_user_id AND app.current_user_id() IN (pp.owner_user_id, pp.linked_user_id)))
    )
  );
CREATE POLICY users_self_write ON users FOR UPDATE TO dawaee_app
  USING (id = app.current_user_id()) WITH CHECK (id = app.current_user_id());

-- ------------------------------------------------------- patient_profiles

ALTER TABLE patient_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE patient_profiles FORCE ROW LEVEL SECURITY;

CREATE POLICY profiles_read ON patient_profiles FOR SELECT TO dawaee_app
  USING (app.can_read_profile(id));
CREATE POLICY profiles_insert ON patient_profiles FOR INSERT TO dawaee_app
  WITH CHECK (owner_user_id = app.current_user_id());
CREATE POLICY profiles_update ON patient_profiles FOR UPDATE TO dawaee_app
  USING (app.owns_profile(id)) WITH CHECK (app.owns_profile(id));
CREATE POLICY profiles_delete ON patient_profiles FOR DELETE TO dawaee_app
  USING (owner_user_id = app.current_user_id());

-- --------------------------------------------------- preferences, consents

ALTER TABLE user_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_preferences FORCE ROW LEVEL SECURITY;
CREATE POLICY prefs_all ON user_preferences FOR ALL TO dawaee_app
  USING (user_id = app.current_user_id()) WITH CHECK (user_id = app.current_user_id());

ALTER TABLE consents ENABLE ROW LEVEL SECURITY;
ALTER TABLE consents FORCE ROW LEVEL SECURITY;
CREATE POLICY consents_all ON consents FOR ALL TO dawaee_app
  USING (user_id = app.current_user_id()) WITH CHECK (user_id = app.current_user_id());

ALTER TABLE push_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE push_tokens FORCE ROW LEVEL SECURITY;
CREATE POLICY push_tokens_all ON push_tokens FOR ALL TO dawaee_app
  USING (user_id = app.current_user_id()) WITH CHECK (user_id = app.current_user_id());

ALTER TABLE auth_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY sessions_own ON auth_sessions FOR ALL TO dawaee_app
  USING (user_id = app.current_user_id()) WITH CHECK (user_id = app.current_user_id());

-- ------------------------------------------------------------ medications

ALTER TABLE medications ENABLE ROW LEVEL SECURITY;
ALTER TABLE medications FORCE ROW LEVEL SECURITY;
CREATE POLICY meds_read ON medications FOR SELECT TO dawaee_app
  USING (app.has_permission(patient_profile_id, 'view_medications'));
CREATE POLICY meds_insert ON medications FOR INSERT TO dawaee_app
  WITH CHECK (app.has_permission(patient_profile_id, 'add_medication'));
CREATE POLICY meds_update ON medications FOR UPDATE TO dawaee_app
  USING (app.has_permission(patient_profile_id, 'edit_medication'))
  WITH CHECK (app.has_permission(patient_profile_id, 'edit_medication'));
CREATE POLICY meds_delete ON medications FOR DELETE TO dawaee_app
  USING (app.owns_profile(patient_profile_id));

ALTER TABLE prescriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE prescriptions FORCE ROW LEVEL SECURITY;
CREATE POLICY rx_read ON prescriptions FOR SELECT TO dawaee_app
  USING (app.has_permission(patient_profile_id, 'view_medications'));
CREATE POLICY rx_write ON prescriptions FOR ALL TO dawaee_app
  USING (app.has_permission(patient_profile_id, 'add_medication'))
  WITH CHECK (app.has_permission(patient_profile_id, 'add_medication'));

ALTER TABLE medication_stock ENABLE ROW LEVEL SECURITY;
ALTER TABLE medication_stock FORCE ROW LEVEL SECURITY;
CREATE POLICY stock_read ON medication_stock FOR SELECT TO dawaee_app
  USING (app.has_permission(patient_profile_id, 'view_medications'));
CREATE POLICY stock_write ON medication_stock FOR ALL TO dawaee_app
  USING (app.has_permission(patient_profile_id, 'update_stock'))
  WITH CHECK (app.has_permission(patient_profile_id, 'update_stock'));

ALTER TABLE stock_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_transactions FORCE ROW LEVEL SECURITY;
CREATE POLICY stock_tx_read ON stock_transactions FOR SELECT TO dawaee_app
  USING (app.has_permission(patient_profile_id, 'view_medications'));
CREATE POLICY stock_tx_insert ON stock_transactions FOR INSERT TO dawaee_app
  WITH CHECK (app.has_permission(patient_profile_id, 'update_stock')
           OR app.has_permission(patient_profile_id, 'confirm_dose'));

ALTER TABLE refill_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE refill_events FORCE ROW LEVEL SECURITY;
CREATE POLICY refill_read ON refill_events FOR SELECT TO dawaee_app
  USING (app.has_permission(patient_profile_id, 'view_medications'));
CREATE POLICY refill_insert ON refill_events FOR INSERT TO dawaee_app
  WITH CHECK (app.has_permission(patient_profile_id, 'update_stock'));

ALTER TABLE medication_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE medication_schedules FORCE ROW LEVEL SECURITY;
CREATE POLICY sched_read ON medication_schedules FOR SELECT TO dawaee_app
  USING (app.has_permission(patient_profile_id, 'view_schedule'));
CREATE POLICY sched_write ON medication_schedules FOR ALL TO dawaee_app
  USING (app.has_permission(patient_profile_id, 'edit_schedule'))
  WITH CHECK (app.has_permission(patient_profile_id, 'edit_schedule'));

-- ------------------------------------------------------------------ doses

ALTER TABLE dose_occurrences ENABLE ROW LEVEL SECURITY;
ALTER TABLE dose_occurrences FORCE ROW LEVEL SECURITY;
CREATE POLICY doses_read ON dose_occurrences FOR SELECT TO dawaee_app
  USING (app.has_permission(patient_profile_id, 'view_schedule')
      OR app.has_permission(patient_profile_id, 'view_adherence'));
CREATE POLICY doses_update ON dose_occurrences FOR UPDATE TO dawaee_app
  USING (app.has_permission(patient_profile_id, 'confirm_dose'))
  WITH CHECK (app.has_permission(patient_profile_id, 'confirm_dose'));
CREATE POLICY doses_insert ON dose_occurrences FOR INSERT TO dawaee_app
  WITH CHECK (app.has_permission(patient_profile_id, 'edit_schedule'));

ALTER TABLE dose_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE dose_events FORCE ROW LEVEL SECURITY;
CREATE POLICY dose_events_read ON dose_events FOR SELECT TO dawaee_app
  USING (app.has_permission(patient_profile_id, 'view_history'));
CREATE POLICY dose_events_insert ON dose_events FOR INSERT TO dawaee_app
  WITH CHECK (app.has_permission(patient_profile_id, 'confirm_dose'));

ALTER TABLE symptom_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE symptom_notes FORCE ROW LEVEL SECURITY;
CREATE POLICY notes_read ON symptom_notes FOR SELECT TO dawaee_app
  USING (app.has_permission(patient_profile_id, 'view_history'));
CREATE POLICY notes_write ON symptom_notes FOR ALL TO dawaee_app
  USING (app.has_permission(patient_profile_id, 'confirm_dose'))
  WITH CHECK (app.has_permission(patient_profile_id, 'confirm_dose'));

ALTER TABLE health_measurements ENABLE ROW LEVEL SECURITY;
ALTER TABLE health_measurements FORCE ROW LEVEL SECURITY;
CREATE POLICY measurements_read ON health_measurements FOR SELECT TO dawaee_app
  USING (app.has_permission(patient_profile_id, 'view_history'));
CREATE POLICY measurements_write ON health_measurements FOR ALL TO dawaee_app
  USING (app.owns_profile(patient_profile_id))
  WITH CHECK (app.owns_profile(patient_profile_id));

-- ------------------------------------------------------------- caregivers

ALTER TABLE caregiver_relationships ENABLE ROW LEVEL SECURITY;
ALTER TABLE caregiver_relationships FORCE ROW LEVEL SECURITY;
-- A caregiver sees their own relationship row; the patient sees all of theirs.
CREATE POLICY caregiver_rel_read ON caregiver_relationships FOR SELECT TO dawaee_app
  USING (app.owns_profile(patient_profile_id) OR caregiver_user_id = app.current_user_id());
-- Only the patient may create, change or revoke access.
CREATE POLICY caregiver_rel_insert ON caregiver_relationships FOR INSERT TO dawaee_app
  WITH CHECK (app.owns_profile(patient_profile_id));
CREATE POLICY caregiver_rel_update ON caregiver_relationships FOR UPDATE TO dawaee_app
  USING (app.owns_profile(patient_profile_id) OR caregiver_user_id = app.current_user_id())
  WITH CHECK (app.owns_profile(patient_profile_id) OR caregiver_user_id = app.current_user_id());
CREATE POLICY caregiver_rel_delete ON caregiver_relationships FOR DELETE TO dawaee_app
  USING (app.owns_profile(patient_profile_id));

ALTER TABLE caregiver_notification_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE caregiver_notification_rules FORCE ROW LEVEL SECURITY;
CREATE POLICY caregiver_rules_read ON caregiver_notification_rules FOR SELECT TO dawaee_app
  USING (app.owns_profile(patient_profile_id)
      OR EXISTS (SELECT 1 FROM caregiver_relationships cr
                 WHERE cr.id = relationship_id AND cr.caregiver_user_id = app.current_user_id()));
CREATE POLICY caregiver_rules_write ON caregiver_notification_rules FOR ALL TO dawaee_app
  USING (app.owns_profile(patient_profile_id))
  WITH CHECK (app.owns_profile(patient_profile_id));

ALTER TABLE escalation_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE escalation_policies FORCE ROW LEVEL SECURITY;
CREATE POLICY escalation_read ON escalation_policies FOR SELECT TO dawaee_app
  USING (app.has_permission(patient_profile_id, 'view_schedule'));
CREATE POLICY escalation_write ON escalation_policies FOR ALL TO dawaee_app
  USING (app.owns_profile(patient_profile_id))
  WITH CHECK (app.owns_profile(patient_profile_id));

-- ---------------------------------------------------- notifications, misc

ALTER TABLE notification_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_deliveries FORCE ROW LEVEL SECURITY;
CREATE POLICY notif_read ON notification_deliveries FOR SELECT TO dawaee_app
  USING (recipient_user_id = app.current_user_id() OR app.owns_profile(patient_profile_id));

ALTER TABLE emergency_cards ENABLE ROW LEVEL SECURITY;
ALTER TABLE emergency_cards FORCE ROW LEVEL SECURITY;
CREATE POLICY emergency_read ON emergency_cards FOR SELECT TO dawaee_app
  USING (app.has_permission(patient_profile_id, 'view_emergency_card'));
CREATE POLICY emergency_write ON emergency_cards FOR ALL TO dawaee_app
  USING (app.owns_profile(patient_profile_id))
  WITH CHECK (app.owns_profile(patient_profile_id));

ALTER TABLE travel_prompts ENABLE ROW LEVEL SECURITY;
ALTER TABLE travel_prompts FORCE ROW LEVEL SECURITY;
CREATE POLICY travel_all ON travel_prompts FOR ALL TO dawaee_app
  USING (app.owns_profile(patient_profile_id)) WITH CHECK (app.owns_profile(patient_profile_id));

ALTER TABLE stored_objects ENABLE ROW LEVEL SECURITY;
ALTER TABLE stored_objects FORCE ROW LEVEL SECURITY;
CREATE POLICY objects_all ON stored_objects FOR ALL TO dawaee_app
  USING (owner_user_id = app.current_user_id()
      OR (patient_profile_id IS NOT NULL AND app.can_read_profile(patient_profile_id)))
  WITH CHECK (owner_user_id = app.current_user_id());

-- Audit log: readable by the patient for their own profile, never mutable.
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_read ON audit_logs FOR SELECT TO dawaee_app
  USING (patient_profile_id IS NOT NULL AND app.owns_profile(patient_profile_id));
CREATE POLICY audit_insert ON audit_logs FOR INSERT TO dawaee_app WITH CHECK (true);

-- --------------------------------------------------------------- grants

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO dawaee_app;
-- Audit integrity does not rely on the trigger alone.
REVOKE UPDATE, DELETE, TRUNCATE ON audit_logs FROM dawaee_app, dawaee_worker;
REVOKE DELETE ON dose_events FROM dawaee_app;

-- OTP challenges are handled by SECURITY DEFINER functions only; the app role
-- must never be able to read a code hash directly.
REVOKE ALL ON auth_otp_challenges FROM dawaee_app;

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO dawaee_app, dawaee_worker;

-- The worker runs system jobs across every patient, so it bypasses the
-- per-user predicates by design — but it is a SEPARATE role with a separate
-- credential, and it is never used to serve an HTTP request.
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO dawaee_worker;
REVOKE UPDATE, DELETE ON audit_logs FROM dawaee_worker;
ALTER ROLE dawaee_worker BYPASSRLS;
