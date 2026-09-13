-- 0078_push_receipt_claim_recovery.sql
-- Receipt claims are intentionally short-lived. If a worker process dies after
-- claiming a batch but before completing it, the row must become claimable
-- again rather than remaining in receipt_state='checking' forever.

CREATE OR REPLACE FUNCTION app.claim_push_receipts(
  p_now timestamptz,
  p_limit integer DEFAULT 1000
)
RETURNS TABLE(
  id uuid,
  provider text,
  provider_receipts jsonb,
  receipt_attempts integer,
  receipt_first_sent_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RETURN QUERY
  WITH due AS (
    SELECT d.id
      FROM notification_deliveries d
     WHERE d.channel = 'push'
       AND d.status = 'sent'
       AND d.provider IS NOT NULL
       AND d.provider_message_id IS NOT NULL
       AND jsonb_array_length(COALESCE(d.provider_receipts, '[]'::jsonb)) > 0
       AND (
         (
           d.receipt_state = 'pending'
           AND d.receipt_next_check_at IS NOT NULL
           AND d.receipt_next_check_at <= p_now
         )
         OR (
           d.receipt_state = 'checking'
           AND d.receipt_checked_at IS NOT NULL
           AND d.receipt_checked_at <= p_now - interval '5 minutes'
         )
       )
     ORDER BY
       CASE WHEN d.receipt_state = 'checking' THEN 0 ELSE 1 END,
       COALESCE(d.receipt_checked_at, d.receipt_next_check_at) ASC,
       d.id ASC
     LIMIT LEAST(GREATEST(COALESCE(p_limit, 1000), 1), 1000)
     FOR UPDATE SKIP LOCKED
  )
  UPDATE notification_deliveries d
     SET receipt_state = 'checking',
         receipt_checked_at = p_now
    FROM due
   WHERE d.id = due.id
  RETURNING d.id,
            d.provider,
            d.provider_receipts,
            d.receipt_attempts,
            d.receipt_first_sent_at;
END
$$;

REVOKE ALL ON FUNCTION app.claim_push_receipts(timestamptz, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.claim_push_receipts(timestamptz, integer) TO dawaee_worker;

COMMENT ON FUNCTION app.claim_push_receipts(timestamptz, integer) IS
  'Worker-only receipt claim; reclaims checking rows after five minutes so a crashed worker cannot strand receipt reconciliation.';
