-- Restore only the writes used by the rolling-horizon materializer.
--
-- CI #571 on 342a99833aae044e12d68be9c7f6dc9ecc09b382 reproduced SQLSTATE
-- 42501 through the real non-superuser worker connection. The 0021 manifest
-- includes reads and reminder updates, but omits the shared API materializer's
-- occurrence INSERT and materialized_through UPDATE. Initial API-created
-- occurrences therefore work while the worker cannot extend their horizon.
--
-- Keep shipped migrations immutable. The existing worker RLS policies, SELECT
-- privileges and lifecycle locks are unchanged. Do not grant table-wide INSERT
-- or schedule UPDATE, and do not expose confirmation fields or unrelated data.
-- Regression: apps/api/test/worker-materialization-privileges.test.ts covers
-- each missing grant, the real worker login, replay/concurrent top-up, profile
-- binding and the denied clinical/private-data boundaries.

GRANT INSERT (
  schedule_id, medication_id, patient_profile_id, scheduled_at,
  scheduled_local_date, scheduled_local_time, scheduled_timezone,
  dose_quantity, dose_unit, status
) ON public.dose_occurrences TO dawaee_worker;

GRANT UPDATE (materialized_through)
  ON public.medication_schedules TO dawaee_worker;
