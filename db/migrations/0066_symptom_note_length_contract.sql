-- =============================================================================
-- Dawaee — 0066: align symptom-note storage with the public API contract
-- =============================================================================
--
-- PROVEN CONTRACT MISMATCH
--   createSymptomNoteSchema accepts text through 2000 characters, while the
--   original symptom_notes table rejects anything over 1000. A request can
--   therefore pass edge validation and still be refused by PostgreSQL.
--
-- Keep the stricter boundary at the same 2000-character value advertised by
-- the public schema. Existing rows are already <= 1000, so widening this CHECK
-- requires no data rewrite or cleanup.
-- =============================================================================

ALTER TABLE public.symptom_notes
  DROP CONSTRAINT IF EXISTS symptom_notes_text_check;

ALTER TABLE public.symptom_notes
  ADD CONSTRAINT symptom_notes_text_check
  CHECK (text IS NULL OR length(text) <= 2000);
