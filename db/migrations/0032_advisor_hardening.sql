-- =============================================================================
-- Dawaee — 0032: Supabase advisor hardening
--
-- Scope is intentionally narrow and evidence-driven:
--   1. Pin search_path on eight existing app functions flagged by Supabase's
--      function_search_path_mutable advisor. ALTER FUNCTION preserves each
--      function body, volatility, owner, grants, and SECURITY mode.
--   2. Remove the legacy notification_queue_idx, which is byte-for-byte
--      equivalent in keys and predicate to notification_claimable_idx created
--      by 0026_delivery_lease.sql. Keep the newer claimable index because its
--      name and migration describe the current lease-based dispatcher model.
--
-- This migration does NOT move extensions, rewrite RLS policies, add every
-- suggested FK index, or remove "unused" indexes. Those require workload and
-- dependency evidence rather than advisor output alone.
-- =============================================================================

ALTER FUNCTION app.current_user_id()
  SET search_path = pg_catalog, public, app;

ALTER FUNCTION app.touch_updated_at()
  SET search_path = pg_catalog, public, app;

ALTER FUNCTION app.valid_permissions(text[])
  SET search_path = pg_catalog, public, app;

ALTER FUNCTION app.assert_profile_matches_medication()
  SET search_path = pg_catalog, public, app;

ALTER FUNCTION app.assert_caregiver_not_patient()
  SET search_path = pg_catalog, public, app;

ALTER FUNCTION app.try_job_lock(text)
  SET search_path = pg_catalog, public, app;

ALTER FUNCTION app.block_audit_mutation()
  SET search_path = pg_catalog, public, app;

ALTER FUNCTION app.audit_allow_only_profile_redaction()
  SET search_path = pg_catalog, public, app;

DROP INDEX IF EXISTS public.notification_queue_idx;
