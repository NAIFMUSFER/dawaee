-- 0080_remove_unused_push_receipt_claim.sql
--
-- 0077 introduced app.claim_push_receipts() for a receipt_state/claim model that
-- never became the runtime design. The actual worker reconciles receipts inside
-- the transaction-scoped push-receipts job and never calls this function.
-- Keeping an unused SECURITY DEFINER entry point expands the worker privilege
-- surface for no production benefit. Retire it explicitly rather than widening
-- the audited allowlist around dead code.
--
-- The function body also refers to receipt_state/receipt_next_check_at style
-- columns that are not part of the current notification_deliveries contract, so
-- preserving it as a dormant compatibility path would be misleading and unsafe.

REVOKE ALL ON FUNCTION app.claim_push_receipts(timestamptz, integer) FROM dawaee_worker;
DROP FUNCTION IF EXISTS app.claim_push_receipts(timestamptz, integer);
