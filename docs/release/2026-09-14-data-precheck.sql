-- Read-only, aggregate-only review of the 0033 + 0047 production baseline.
-- Run using the existing approved administrative connection. Never grant a
-- runtime role BYPASSRLS to make this diagnostic work. No identifiers or payloads
-- are returned. A clean result is not a backup, restore or upgrade rehearsal.
BEGIN READ ONLY;
SET LOCAL statement_timeout = '10s';
SET LOCAL lock_timeout = '2s';
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user
                 AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'Use the existing administrative read context; RLS-filtered counts are not release evidence';
  END IF;
END $$;

WITH metrics AS (
  SELECT '0034_schedule_stock_unit_mismatch' AS check_name, count(*) AS affected
    FROM medication_schedules s JOIN medication_stock st ON st.medication_id=s.medication_id
   WHERE s.dose_unit<>st.unit
  UNION ALL SELECT '0034_refill_stock_unit_mismatch', count(*)
    FROM refill_events r JOIN medication_stock st ON st.medication_id=r.medication_id WHERE r.unit<>st.unit
  UNION ALL SELECT '0035_unavailable_channel_rules_to_disable', count(*)
    FROM caregiver_notification_rules WHERE channel IN ('sms','whatsapp') AND enabled
  UNION ALL SELECT '0036_terminal_snooze_deadlines_to_clear', count(*)
    FROM dose_occurrences WHERE status<>'snoozed' AND snoozed_until IS NOT NULL
  UNION ALL SELECT '0038_accounts_due_for_erasure_at_14_days', count(*)
    FROM users WHERE deletion_requested_at<=now()-interval '14 days'
  UNION ALL SELECT '0049_pending_digests_to_suppress', count(*)
    FROM notification_deliveries d JOIN caregiver_relationships cr ON cr.id=d.relationship_id
   WHERE d.kind IN ('daily_summary','weekly_summary') AND d.status IN ('queued','sending')
     AND NOT (cr.status='active' AND cr.permissions @> ARRAY['receive_notifications','view_adherence','view_schedule']::text[])
  UNION ALL SELECT '0061_active_endpoints_with_one_live_session', count(*)
    FROM push_tokens pt WHERE pt.active AND 1=(
      SELECT count(*) FROM auth_sessions s WHERE s.user_id=pt.user_id AND s.device_id=pt.device_id
       AND s.revoked_at IS NULL AND s.expires_at>now())
  UNION ALL SELECT '0061_active_endpoints_to_retire', count(*)
    FROM push_tokens pt WHERE pt.active AND 1<>(
      SELECT count(*) FROM auth_sessions s WHERE s.user_id=pt.user_id AND s.device_id=pt.device_id
       AND s.revoked_at IS NULL AND s.expires_at>now())
  UNION ALL SELECT '0068_caregiver_rule_profile_mismatch', count(*)
    FROM caregiver_notification_rules r JOIN caregiver_relationships cr ON cr.id=r.relationship_id
   WHERE r.patient_profile_id<>cr.patient_profile_id
  UNION ALL SELECT '0069_escalation_medication_profile_mismatch', count(*)
    FROM escalation_policies ep JOIN medications m ON m.id=ep.medication_id
   WHERE ep.medication_id IS NOT NULL AND ep.patient_profile_id<>m.patient_profile_id
  UNION ALL SELECT '0070_dose_schedule_graph_mismatch', count(*)
    FROM dose_occurrences d JOIN medication_schedules s ON s.id=d.schedule_id
   WHERE d.medication_id<>s.medication_id OR d.patient_profile_id<>s.patient_profile_id
  UNION ALL SELECT '0071_notification_dose_profile_mismatch', count(*)
    FROM notification_deliveries nd JOIN dose_occurrences d ON d.id=nd.dose_occurrence_id
   WHERE d.patient_profile_id<>nd.patient_profile_id
  UNION ALL SELECT '0071_notification_medication_profile_mismatch', count(*)
    FROM notification_deliveries nd JOIN medications m ON m.id=nd.medication_id
   WHERE m.patient_profile_id<>nd.patient_profile_id
  UNION ALL SELECT '0071_notification_dose_medication_mismatch', count(*)
    FROM notification_deliveries nd JOIN dose_occurrences d ON d.id=nd.dose_occurrence_id
   WHERE nd.medication_id IS NOT NULL AND d.medication_id<>nd.medication_id
  UNION ALL SELECT '0071_patient_notification_recipient_mismatch', count(*)
    FROM notification_deliveries nd JOIN patient_profiles pp ON pp.id=nd.patient_profile_id
   WHERE nd.relationship_id IS NULL AND nd.recipient_user_id IS NOT NULL
     AND nd.recipient_user_id IS DISTINCT FROM COALESCE(pp.linked_user_id,pp.owner_user_id)
  UNION ALL SELECT '0072_stock_dose_graph_mismatch', count(*)
    FROM stock_transactions st JOIN dose_occurrences d ON d.id=st.dose_occurrence_id
   WHERE st.medication_id<>d.medication_id OR st.patient_profile_id<>d.patient_profile_id
  UNION ALL SELECT '0073_consent_owner_mismatch', count(*)
    FROM consents c JOIN patient_profiles pp ON pp.id=c.patient_profile_id
   WHERE c.user_id IS DISTINCT FROM pp.owner_user_id AND c.user_id IS DISTINCT FROM pp.linked_user_id
), current_actions AS (
  SELECT id, patient_profile_id, client_event_id,
    CASE WHEN status IN ('taken','taken_late') THEN 'taken'::dose_event_type
         WHEN status='skipped' THEN 'skipped'::dose_event_type
         WHEN status='snoozed' THEN 'snoozed'::dose_event_type END AS event_type
    FROM dose_occurrences WHERE client_event_id IS NOT NULL
), backfill AS (
  SELECT DISTINCT ON (c.id) c.patient_profile_id, c.client_event_id
    FROM current_actions c JOIN dose_events e ON e.dose_occurrence_id=c.id
     AND e.patient_profile_id=c.patient_profile_id AND e.type=c.event_type
   WHERE c.event_type IS NOT NULL ORDER BY c.id,e.at DESC,e.id DESC
)
SELECT now() AS observed_at, current_database() AS database_name,
  (SELECT jsonb_object_agg(check_name,affected ORDER BY check_name) FROM metrics) AS aggregates,
  (SELECT count(*) FROM backfill) AS client_event_backfill_rows,
  (SELECT count(*) FROM (SELECT 1 FROM backfill GROUP BY patient_profile_id,client_event_id HAVING count(*)>1) duplicates)
    AS client_event_backfill_duplicate_groups,
  (SELECT jsonb_object_agg(table_name||'.'||column_name, present) FROM (
    SELECT v.*, EXISTS (SELECT 1 FROM information_schema.columns c
      WHERE c.table_schema='public' AND c.table_name=v.table_name AND c.column_name=v.column_name) AS present
      FROM (VALUES ('stock_transactions','dose_event_id'),('dose_events','client_event_id'),
                   ('push_tokens','session_id'),('notification_deliveries','provider_receipts')) v(table_name,column_name)
  ) columns) AS candidate_columns_present;
COMMIT;
