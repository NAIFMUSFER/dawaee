-- Persist offline client-event identity in the append-only dose event trail.
--
-- dose_occurrences.client_event_id is mutable lifecycle state: undo clears it
-- and later actions replace it. That made an already-applied offline action
-- look new again after undo, allowing a stale replay to resurrect the action
-- and, for a take, decrement stock twice. The event trail is the durable place
-- for this identity because dose_events are append-only.

ALTER TABLE dose_events
  ADD COLUMN client_event_id text;

-- Preserve the client event ids that are still recoverable at upgrade time.
-- Historical ids already cleared by an old undo cannot be reconstructed from
-- schema 0033 safely, so this deliberately backfills only the current action
-- whose identity is still present on dose_occurrences.
WITH current_actions AS (
  SELECT
    d.id AS dose_occurrence_id,
    d.patient_profile_id,
    d.client_event_id,
    CASE
      WHEN d.status IN ('taken','taken_late') THEN 'taken'::dose_event_type
      WHEN d.status = 'skipped' THEN 'skipped'::dose_event_type
      WHEN d.status = 'snoozed' THEN 'snoozed'::dose_event_type
      ELSE NULL
    END AS event_type
  FROM dose_occurrences d
  WHERE d.client_event_id IS NOT NULL
), latest_matching_event AS (
  SELECT DISTINCT ON (c.dose_occurrence_id)
    e.id AS event_id,
    c.client_event_id
  FROM current_actions c
  JOIN dose_events e
    ON e.dose_occurrence_id = c.dose_occurrence_id
   AND e.patient_profile_id = c.patient_profile_id
   AND e.type = c.event_type
  WHERE c.event_type IS NOT NULL
  ORDER BY c.dose_occurrence_id, e.at DESC, e.id DESC
)
UPDATE dose_events e
   SET client_event_id = l.client_event_id
  FROM latest_matching_event l
 WHERE e.id = l.event_id;

-- Keep the same per-patient idempotency scope introduced for occurrences in
-- migration 0019. A client event id may exist in another patient's profile but
-- never twice for the same patient.
CREATE UNIQUE INDEX dose_events_client_event_profile_idx
  ON dose_events (patient_profile_id, client_event_id)
  WHERE client_event_id IS NOT NULL;

COMMENT ON COLUMN dose_events.client_event_id IS
  'Immutable offline action identity used to recognize stale/retried dose actions after later lifecycle changes';
