-- The push provider is no longer called inside a database transaction.
--
-- The dispatcher ran claim, send and finalise inside one transaction, with the
-- claimed rows held under FOR UPDATE for the whole batch. Four consequences,
-- and the last is the one that reached users:
--
--   * a transaction lived as long as the provider took to answer, so a slow or
--     hanging Expo call held a pooled connection and its row locks for that
--     entire time;
--   * the batch was serial, so one slow send stalled every delivery behind it;
--   * connection-pool pressure scaled with provider latency rather than work;
--   * and a rollback AFTER a successful send returned the row to `queued`, so
--     the next tick sent the same medication reminder again.
--
-- The fix is a lease. A short transaction claims the row and commits; the
-- provider is called with no transaction open; a second short transaction
-- records the outcome. Nothing holds a lock across the network.
--
-- LEASE, not just a status. `status='sending'` alone cannot be recovered from:
-- a worker that dies mid-send leaves the row in `sending` forever, and no other
-- worker can tell that apart from a send still in progress. `lease_until` gives
-- it an expiry, so a crashed worker's deliveries return to the pool by
-- themselves.
--
-- LEASE TOKEN, not just an expiry. Once a lease can expire, two workers can
-- believe they own the same row: worker A stalls past its lease, worker B
-- claims it, then A comes back and finalises. A writes a result for a send B is
-- also performing, and the row's state describes neither. Every claim stamps a
-- fresh random token and every finalisation matches on it, so a worker whose
-- lease has been taken away writes nothing and says so.

ALTER TABLE notification_deliveries
  ADD COLUMN IF NOT EXISTS lease_until timestamptz,
  ADD COLUMN IF NOT EXISTS lease_token uuid;

-- The claim query orders by `next_attempt_at` among rows that are claimable:
-- queued and due, or leased-but-expired. Indexed so a growing outbox does not
-- turn every tick into a sequential scan.
CREATE INDEX IF NOT EXISTS notification_claimable_idx
  ON notification_deliveries (next_attempt_at)
  WHERE status IN ('queued', 'sending');

COMMENT ON COLUMN notification_deliveries.lease_until IS
  'When the claiming worker''s exclusive right to send this expires. A row in '
  'status=sending past this time is recoverable by another worker.';
COMMENT ON COLUMN notification_deliveries.lease_token IS
  'Stamped fresh on every claim. A worker may only finalise a delivery whose '
  'token still matches the one it claimed with, so a worker returning after '
  'its lease was reassigned cannot overwrite the new owner''s result.';
