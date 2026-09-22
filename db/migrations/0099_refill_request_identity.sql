-- Refill identity, result and stock movement commit together. Existing rows are untouched.
ALTER TABLE refill_events
  ADD COLUMN client_request_id text,
  ADD COLUMN request_hash text,
  ADD COLUMN balance_after numeric(12,4),
  ADD COLUMN days_of_supply numeric;
ALTER TABLE refill_events ADD CONSTRAINT refill_request_identity_check CHECK (
  (client_request_id IS NULL AND request_hash IS NULL) OR
  (client_request_id IS NOT NULL AND request_hash IS NOT NULL AND
   length(client_request_id) BETWEEN 8 AND 128 AND request_hash ~ '^[a-f0-9]{64}$')
);
CREATE UNIQUE INDEX refill_request_identity_idx
  ON refill_events (medication_id, created_by, client_request_id)
  WHERE client_request_id IS NOT NULL;
-- Existing table RLS and grants continue to protect these fields.
