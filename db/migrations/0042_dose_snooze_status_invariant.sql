-- =============================================================================
-- Dawaee — 0042: keep snooze metadata consistent with dose status
-- =============================================================================
--
-- Migration 0036 removed stale snooze deadlines that already existed, and the
-- normal medication-cancellation paths clear the deadline explicitly. The
-- schedule DELETE path can also transition a future snoozed dose to cancelled,
-- but previously left snoozed_until populated. Keep the status invariant at
-- the data boundary so every write has the same semantics: only a dose whose
-- current status is 'snoozed' may retain an active snooze deadline.

CREATE OR REPLACE FUNCTION app.clear_non_snoozed_deadline()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, app
AS $$
BEGIN
  IF NEW.status <> 'snoozed' AND NEW.snoozed_until IS NOT NULL THEN
    NEW.snoozed_until := NULL;
  END IF;
  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION app.clear_non_snoozed_deadline() FROM PUBLIC;

DROP TRIGGER IF EXISTS dose_occurrences_clear_non_snoozed_deadline ON public.dose_occurrences;
CREATE TRIGGER dose_occurrences_clear_non_snoozed_deadline
BEFORE INSERT OR UPDATE ON public.dose_occurrences
FOR EACH ROW
WHEN (NEW.status <> 'snoozed' AND NEW.snoozed_until IS NOT NULL)
EXECUTE FUNCTION app.clear_non_snoozed_deadline();
