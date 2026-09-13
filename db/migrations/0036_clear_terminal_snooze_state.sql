-- =============================================================================
-- Dawaee — 0036: terminal/non-snoozed doses cannot retain active snooze metadata
-- =============================================================================
--
-- Production P20 evidence found one dose with status='taken' while
-- snoozed_until was still populated. The API confirmation path changed status
-- and confirmation fields but did not clear the previous snooze deadline.
-- The same stale state was possible through skip, mark-missed and medication
-- cancellation. Status is authoritative, so this migration removes only the
-- obsolete deadline; it does not alter any dose outcome or history event.

UPDATE dose_occurrences
   SET snoozed_until = NULL
 WHERE status <> 'snoozed'
   AND snoozed_until IS NOT NULL;
