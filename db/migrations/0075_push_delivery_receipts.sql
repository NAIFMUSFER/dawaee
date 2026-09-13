-- 0075_push_delivery_receipts.sql
-- A successful Expo push ticket is only queue acceptance. Persist the ticket
-- IDs needed for later receipt reconciliation; never call that state delivered.

ALTER TABLE notification_deliveries
  ADD COLUMN IF NOT EXISTS provider_receipts jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE notification_deliveries
  DROP CONSTRAINT IF EXISTS notification_deliveries_provider_receipts_shape;
ALTER TABLE notification_deliveries
  ADD CONSTRAINT notification_deliveries_provider_receipts_shape
  CHECK (
    jsonb_typeof(provider_receipts) = 'array'
    AND jsonb_array_length(provider_receipts) <= 20
  );

COMMENT ON COLUMN notification_deliveries.provider_receipts IS
  'Worker-only provider receipt tickets: provider message id + internal push-token id; never the push token secret itself.';

-- Keep auth-session data out of the worker. This is the receipt-aware sibling
-- of app.list_live_push_tokens and returns only the endpoint id needed for a
-- later DeviceNotRegistered receipt plus the routing token needed right now.
CREATE OR REPLACE FUNCTION app.list_live_push_endpoints(
  p_user_id uuid,
  p_limit integer DEFAULT 5
)
RETURNS TABLE(push_token_id uuid, token text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT pt.id, pt.token
    FROM push_tokens pt
   WHERE pt.user_id = p_user_id
     AND pt.active
     AND EXISTS (
       SELECT 1
         FROM auth_sessions s
        WHERE s.user_id = pt.user_id
          AND s.device_id = pt.device_id
          AND s.revoked_at IS NULL
          AND s.expires_at > now()
     )
   ORDER BY pt.updated_at DESC, pt.id DESC
   LIMIT LEAST(GREATEST(COALESCE(p_limit, 5), 1), 20)
$$;

REVOKE ALL ON FUNCTION app.list_live_push_endpoints(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.list_live_push_endpoints(uuid, integer) TO dawaee_worker;

-- Receipt reconciliation can retire exactly the endpoint Expo identified,
-- without granting the worker broad auth-session access or storing a push token
-- in notification metadata.
CREATE OR REPLACE FUNCTION app.deactivate_push_endpoint(
  p_user_id uuid,
  p_push_token_id uuid
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
           updated_at = now()
     WHERE id = p_push_token_id
       AND user_id = p_user_id
       AND active
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM changed)
$$;

REVOKE ALL ON FUNCTION app.deactivate_push_endpoint(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.deactivate_push_endpoint(uuid, uuid) TO dawaee_worker;
