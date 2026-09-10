-- =============================================================================
-- Dawaee — 0044: least privilege for non-RLS operational tables.
--
-- Red-team evidence:
--   * production dawaee_app currently has SELECT/INSERT/UPDATE/DELETE on
--     schema_migrations, job_runs and provider_webhook_events;
--   * these tables intentionally have no RLS;
--   * the HTTP API only reads them for readiness/admin surfaces;
--   * worker/migration roles own the corresponding write responsibilities.
--
-- Keep the API reads it actually uses, but remove mutation authority from the
-- three public operational tables that have no row-level security boundary.
-- Do not modify the historical 0008 blanket grant: clinical tables still rely
-- on that grant together with FORCE RLS. Future non-RLS operational tables must
-- be explicitly allowlisted and narrowed by a migration/test before release.
-- =============================================================================

REVOKE INSERT, UPDATE, DELETE ON TABLE
  schema_migrations,
  job_runs,
  provider_webhook_events
FROM dawaee_app;

GRANT SELECT ON TABLE
  schema_migrations,
  job_runs,
  provider_webhook_events
TO dawaee_app;
