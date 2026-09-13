-- 0079_audit_preview_ledger_repair.sql
-- One-time compatibility repair for the synthetic Render audit-preview DB.
--
-- During the push-receipt audit, that preview briefly applied two migration
-- filenames that were superseded before merge:
--   0077_push_receipt_token_generation.sql
--   0078_push_receipt_claim_recovery.sql
-- Their schema effects are intentionally re-applied by the canonical current
-- 0077/0078 migrations. The stale ledger names alone prevent the preview's
-- strict post-migration checksum/size verification from starting.
--
-- This migration is a hard no-op everywhere except the dedicated synthetic
-- audit database, and even there it deletes only the two exact known checksums.
-- Any unexpected checksum fails closed for operator review.

DO $$
DECLARE
  v_token_checksum text;
  v_claim_checksum text;
BEGIN
  IF current_database() <> 'dawaee_audit_db' THEN
    RETURN;
  END IF;

  SELECT checksum
    INTO v_token_checksum
    FROM schema_migrations
   WHERE filename = '0077_push_receipt_token_generation.sql';

  IF v_token_checksum IS NOT NULL
     AND v_token_checksum <> 'd3847be8e08f8f13424d0231e87dad68' THEN
    RAISE EXCEPTION 'AUDIT_PREVIEW_LEDGER_REPAIR_TOKEN_CHECKSUM_MISMATCH';
  END IF;

  SELECT checksum
    INTO v_claim_checksum
    FROM schema_migrations
   WHERE filename = '0078_push_receipt_claim_recovery.sql';

  IF v_claim_checksum IS NOT NULL
     AND v_claim_checksum <> '46a4f03944f8139f74866d78ef6be4f0' THEN
    RAISE EXCEPTION 'AUDIT_PREVIEW_LEDGER_REPAIR_CLAIM_CHECKSUM_MISMATCH';
  END IF;

  DELETE FROM schema_migrations
   WHERE (filename = '0077_push_receipt_token_generation.sql'
          AND checksum = 'd3847be8e08f8f13424d0231e87dad68')
      OR (filename = '0078_push_receipt_claim_recovery.sql'
          AND checksum = '46a4f03944f8139f74866d78ef6be4f0');
END
$$;
