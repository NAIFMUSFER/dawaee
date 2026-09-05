-- One missed dose produces one missed event, enforced by the database.
--
-- `markMissedJob` updated the occurrence statuses correctly and then wrote the
-- history by RE-QUERYING, rather than from the rows it had just changed:
--
--   INSERT INTO dose_events (...)
--   SELECT id, ... FROM dose_occurrences
--    WHERE status = 'missed' AND updated_at > now() - interval '2 minutes'
--
-- That is a time window, not a set of changed rows. Any tick that marks
-- anything missed re-scans every dose marked missed in the previous two
-- minutes and writes an event for all of them again. A patient with two
-- medications an hour apart is enough to trigger it: the tick that misses the
-- second one writes a second 'missed' event for the first.
--
-- The occurrence status was idempotent; its history was not. For an adherence
-- record that is the wrong half to get right — the status is what the app
-- shows, but the events are what a clinician-facing report counts, so a
-- duplicated miss inflates non-adherence for a dose that was missed once.
--
-- The job now derives the events from `UPDATE ... RETURNING`, so the rows that
-- changed ARE the rows that get events. This index is the second control: even
-- if a future edit reintroduces a re-query, the database refuses the duplicate.
--
-- Scoped to worker-generated misses only. `missed` is the sole event type the
-- worker manufactures without a human action behind it; every other type
-- records something a person did, and those can legitimately repeat — a
-- patient may snooze the same dose several times, and each snooze is a real
-- event that must be kept.

-- Existing duplicates are collapsed first, keeping the earliest of each set —
-- the earliest is the one that recorded the actual transition.
DELETE FROM dose_events e
 USING dose_events keep
 WHERE e.type = 'missed'
   AND keep.type = 'missed'
   AND e.dose_occurrence_id = keep.dose_occurrence_id
   AND (keep.at < e.at OR (keep.at = e.at AND keep.id < e.id));

CREATE UNIQUE INDEX IF NOT EXISTS dose_events_one_missed_idx
  ON dose_events (dose_occurrence_id)
  WHERE type = 'missed';

COMMENT ON INDEX dose_events_one_missed_idx IS
  'A dose can be missed once. Guards the adherence history against a repeated '
  'worker tick writing the same transition twice; other event types are '
  'deliberately unconstrained because a patient can legitimately snooze or '
  'undo the same dose more than once.';
