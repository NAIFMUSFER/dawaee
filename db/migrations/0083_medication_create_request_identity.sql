-- Additive identity for ambiguous network retries; existing rows are untouched.
-- The medication, its schedule/stock and this identity commit in one transaction.
ALTER TABLE medications ADD COLUMN client_request_id text;
ALTER TABLE medications ADD COLUMN create_request_hash text;
ALTER TABLE medications ADD CONSTRAINT medications_create_request_identity_check
  CHECK ((client_request_id IS NULL AND create_request_hash IS NULL) OR
    (client_request_id IS NOT NULL AND create_request_hash IS NOT NULL AND
     length(client_request_id) BETWEEN 8 AND 128 AND create_request_hash ~ '^[a-f0-9]{64}$'));
CREATE UNIQUE INDEX medications_create_request_idx
  ON medications (patient_profile_id, created_by, client_request_id)
  WHERE client_request_id IS NOT NULL;
-- Existing medication RLS and grants protect these columns. No new public API.
