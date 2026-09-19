-- 0021 granted DELETE for retention, but 0008's worker RLS policies permit
-- only SELECT/INSERT/UPDATE. Without a DELETE policy housekeeping silently
-- retained every notification. Permit only the existing ninety-day terminal
-- retention window; queued/sending and fresh rows remain protected by RLS.
CREATE POLICY notification_deliveries_worker_retention_delete
  ON notification_deliveries FOR DELETE TO dawaee_worker
  USING (
    created_at < now() - interval '90 days'
    AND status IN ('sent','delivered','read','skipped','failed','expired')
  );
