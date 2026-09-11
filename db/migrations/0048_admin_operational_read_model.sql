-- =============================================================================
-- Dawaee — 0048: narrow operational admin read model
--
-- The HTTP role is deliberately a plain `dawaee_app` role with FORCE-RLS on
-- clinical tables. Admin authorization lives in the API JWT, not in a database
-- role. The admin routes therefore must not solve global observability by
-- disabling RLS, granting BYPASSRLS, or exposing raw clinical tables.
--
-- These SECURITY DEFINER functions expose only the non-PHI operational fields
-- the existing admin endpoints already promise: aggregate counts, delivery
-- failure mechanics, and seven-day channel/status counts. They cannot return a
-- patient id, recipient id, medication name, profile name, message body or
-- payload. The migration owner already has the reviewed per-table definer
-- policies required under FORCE RLS; runtime roles still cannot become it.
-- =============================================================================

CREATE OR REPLACE FUNCTION app.admin_operational_overview()
RETURNS TABLE (
  users bigint,
  profiles bigint,
  active_medications bigint,
  active_caregivers bigint,
  doses_24h bigint,
  taken_24h bigint
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, app
AS $$
  SELECT
    (SELECT count(*) FROM public.users WHERE disabled_at IS NULL),
    (SELECT count(*) FROM public.patient_profiles WHERE archived_at IS NULL),
    (SELECT count(*) FROM public.medications WHERE status = 'active'),
    (SELECT count(*) FROM public.caregiver_relationships WHERE status = 'active'),
    (SELECT count(*) FROM public.dose_occurrences
      WHERE scheduled_at > now() - interval '24 hours'),
    (SELECT count(*) FROM public.dose_occurrences
      WHERE scheduled_at > now() - interval '24 hours'
        AND status IN ('taken','taken_late'))
$$;

CREATE OR REPLACE FUNCTION app.admin_failed_deliveries(
  p_channel public.notification_channel,
  p_limit integer
)
RETURNS TABLE (
  id uuid,
  kind text,
  channel text,
  provider text,
  error_code text,
  attempts integer,
  created_at timestamptz,
  scheduled_for timestamptz
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, app
AS $$
  SELECT d.id, d.kind::text, d.channel::text, d.provider, d.error_code,
         d.attempts, d.created_at, d.scheduled_for
    FROM public.notification_deliveries d
   WHERE d.status = 'failed'
     AND (p_channel IS NULL OR d.channel = p_channel)
   ORDER BY d.created_at DESC
   LIMIT LEAST(GREATEST(COALESCE(p_limit, 100), 1), 500)
$$;

CREATE OR REPLACE FUNCTION app.admin_delivery_stats()
RETURNS TABLE (
  channel text,
  status text,
  count integer
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, app
AS $$
  SELECT d.channel::text, d.status::text, count(*)::int
    FROM public.notification_deliveries d
   WHERE d.created_at > now() - interval '7 days'
   GROUP BY 1,2
   ORDER BY 1,2
$$;

REVOKE ALL ON FUNCTION app.admin_operational_overview() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.admin_failed_deliveries(public.notification_channel, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.admin_delivery_stats() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION app.admin_operational_overview() TO dawaee_app;
GRANT EXECUTE ON FUNCTION app.admin_failed_deliveries(public.notification_channel, integer) TO dawaee_app;
GRANT EXECUTE ON FUNCTION app.admin_delivery_stats() TO dawaee_app;

COMMENT ON FUNCTION app.admin_operational_overview() IS
  'Admin operational aggregates only; deliberately returns no row identifiers or health data.';
COMMENT ON FUNCTION app.admin_failed_deliveries(public.notification_channel, integer) IS
  'Admin delivery mechanics only; omits recipient, patient, medication, body and payload.';
COMMENT ON FUNCTION app.admin_delivery_stats() IS
  'Admin seven-day channel/status aggregates only; returns no patient-linked fields.';
