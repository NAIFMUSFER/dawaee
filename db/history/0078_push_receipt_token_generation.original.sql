-- 0078_push_receipt_token_generation.sql
-- A push_tokens row is stable across same-device re-registration, while the
-- provider token stored in that row can rotate. Receipt reconciliation must
-- therefore bind DeviceNotRegistered to the exact provider-token generation
-- that produced the ticket; row id alone is not sufficient authority.

COMMENT ON COLUMN notification_deliveries.provider_receipts IS
  'Worker-only provider receipt tickets: provider message id, internal push-token id, and a SHA-256 token fingerprint; never the push token secret itself.';

-- Retire the id-only worker capability introduced by 0075. Keep the overload
-- present for migration history/owner maintenance, but the runtime worker may
-- no longer invoke it because a delayed receipt could otherwise deactivate a
-- newly registered token that reused the same row id.
REVOKE EXECUTE ON FUNCTION app.deactivate_push_endpoint(uuid, uuid) FROM dawaee_worker;

CREATE OR REPLACE FUNCTION app.deactivate_push_endpoint(
  p_user_id uuid,
  p_push_token_id uuid,
  p_token_fingerprint text
)
RETURNS boolean
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH changed AS (
    UPDATE push_tokens
       SET active = false,
           failure_count = failure_count + 1,
           last_seen_at = now()
     WHERE id = p_push_token_id
       AND user_id = p_user_id
       AND active
       AND p_token_fingerprint ~ '^[0-9a-f]{64}$'
       AND encode(digest(token, 'sha256'), 'hex') = p_token_fingerprint
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM changed)
$$;

REVOKE ALL ON FUNCTION app.deactivate_push_endpoint(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.deactivate_push_endpoint(uuid, uuid, text) TO dawaee_worker;

COMMENT ON FUNCTION app.deactivate_push_endpoint(uuid, uuid, text) IS
  'Worker-only endpoint invalidation guarded by user, stable row id, and the SHA-256 fingerprint of the exact provider token that produced the receipt.';
