-- =============================================================================
-- Dawaee — 0037: preserve every stock movement across take/undo/re-take cycles
-- =============================================================================
--
-- `stock_transactions` is documented as the reconstructable quantity ledger,
-- but its original UNIQUE (dose_occurrence_id, reason) index allowed only one
-- `dose_taken` and one `dose_undone` row for the lifetime of an occurrence.
-- A supported sequence such as take -> undo -> take therefore changed the live
-- balance a second time while ON CONFLICT silently discarded the second ledger
-- row. The balance was correct but the audit ledger no longer reconstructed it.
--
-- Idempotency is already enforced where the action happens: the occurrence is
-- row-locked, recorded statuses reject a second action, and client_event_id
-- handles offline replay. The ledger should instead identify the *dose event*
-- that caused each movement. Every genuine take/undo creates a distinct event;
-- a replay creates none.

ALTER TABLE stock_transactions
  ADD COLUMN dose_event_id bigint REFERENCES dose_events(id) ON DELETE SET NULL;

DROP INDEX IF EXISTS stock_tx_dose_idx;

-- Exactly one stock movement may be attached to one append-only dose event.
CREATE UNIQUE INDEX stock_tx_dose_event_idx
  ON stock_transactions (dose_event_id)
  WHERE dose_event_id IS NOT NULL;

-- Keep the efficient per-occurrence lookup used by undo and investigations,
-- without suppressing legitimate repeated cycles.
CREATE INDEX stock_tx_dose_occurrence_idx
  ON stock_transactions (dose_occurrence_id, created_at DESC)
  WHERE dose_occurrence_id IS NOT NULL;
