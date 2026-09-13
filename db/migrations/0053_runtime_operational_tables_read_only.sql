-- =============================================================================
-- Dawaee — 0053: HTTP runtime role is read-only on non-RLS operational tables
-- =============================================================================
--
-- Red-team evidence from production showed dawaee_app held INSERT/UPDATE/DELETE
-- in addition to SELECT on schema_migrations, job_runs and
-- provider_webhook_events. These tables intentionally have no row-level
-- security; their boundary is table privileges instead. The API only needs to
-- read this operational state (readiness/admin visibility). Allowing writes lets
-- a compromised HTTP runtime forge migration history, fabricate worker success,
-- or alter/delete webhook evidence.
--
-- The broad default privilege for patient-facing tables remains unchanged. This
-- migration narrows only the three reviewed non-RLS operational tables, and is
-- deliberately idempotent so a restored database converges to the same ACL.

REVOKE ALL PRIVILEGES ON TABLE
  public.schema_migrations,
  public.job_runs,
  public.provider_webhook_events
FROM dawaee_app;

GRANT SELECT ON TABLE
  public.schema_migrations,
  public.job_runs,
  public.provider_webhook_events
TO dawaee_app;
