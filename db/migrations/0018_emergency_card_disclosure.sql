-- The emergency card was published wider than the patient chose.
--
-- Two independent problems, both of which put health information in front of
-- anyone holding the URL:
--
-- 1. `include_medications`, `include_allergies` and `include_contacts` all
--    defaulted to TRUE, and `POST /v1/emergency/qr/enable` inserts a row
--    naming only the QR columns. So a patient who tapped "enable" without ever
--    opening the card editor published every active medication, their
--    allergies, their blood type and their contacts in one action — while the
--    route's own comment promised the card "is OFF by default and the patient
--    chooses field by field what appears".
--
-- 2. `conditions_note` had no flag at all. It is the free-text "what is wrong
--    with me" field — the most sensitive thing on the card — and the resolver
--    returned it unconditionally, with no way for the patient to exclude it.
--
-- Both are fixed here rather than in the route, because the default is the
-- thing that was wrong: a disclosure decision must not depend on which
-- endpoint happened to create the row.

-- The missing flag. Default false for the same reason as the others below.
ALTER TABLE emergency_cards
  ADD COLUMN IF NOT EXISTS include_conditions boolean NOT NULL DEFAULT false;

-- Existing cards keep exactly what they are currently sharing, so this
-- migration never silently widens or narrows a live card. Only new rows get
-- the safe default.
--
-- One deliberate exception: a card that already carries a conditions note has
-- been publishing it with no way to opt out, so the flag is set to true to
-- preserve current behaviour rather than silently removing information a
-- patient may be relying on. They can now turn it off, which they could not
-- before.
UPDATE emergency_cards SET include_conditions = true
 WHERE conditions_note IS NOT NULL AND length(trim(conditions_note)) > 0;

ALTER TABLE emergency_cards ALTER COLUMN include_medications SET DEFAULT false;
ALTER TABLE emergency_cards ALTER COLUMN include_allergies   SET DEFAULT false;
ALTER TABLE emergency_cards ALTER COLUMN include_contacts    SET DEFAULT false;

/**
 * Resolve a scanned QR.
 *
 * Every field is now gated on the patient's own choice. This function is
 * SECURITY DEFINER and runs as the migration owner, which holds blanket access
 * to emergency_cards, patient_profiles and medications — so these CASE
 * expressions are not one safeguard among several. They are the only thing
 * standing between a scanned token and the patient's records.
 */
CREATE OR REPLACE FUNCTION app.resolve_emergency_qr(p_token_hash text)
RETURNS TABLE (
  patient_display_name text,
  blood_type text,
  allergies text[],
  conditions_note text,
  emergency_contacts jsonb,
  medications jsonb
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
#variable_conflict use_column
DECLARE card emergency_cards%ROWTYPE;
BEGIN
  SELECT * INTO card FROM emergency_cards
   WHERE qr_token_hash = p_token_hash AND qr_enabled;
  IF card.id IS NULL THEN RETURN; END IF;

  UPDATE emergency_cards
     SET qr_view_count = qr_view_count + 1, qr_last_viewed_at = now()
   WHERE id = card.id;

  RETURN QUERY
  SELECT
    pp.display_name,
    CASE WHEN card.include_allergies THEN card.blood_type END,
    CASE WHEN card.include_allergies THEN card.allergies ELSE '{}'::text[] END,
    CASE WHEN card.include_conditions THEN card.conditions_note END,
    CASE WHEN card.include_contacts THEN card.emergency_contacts ELSE '[]'::jsonb END,
    CASE WHEN card.include_medications THEN COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'name', m.name,
               'strength', CASE WHEN m.strength_value IS NULL THEN NULL
                                ELSE m.strength_value::text || ' ' || m.strength_unit::text END,
               'form', m.form))
        FROM medications m
       WHERE m.patient_profile_id = card.patient_profile_id AND m.status = 'active'
    ), '[]'::jsonb) ELSE '[]'::jsonb END
  FROM patient_profiles pp WHERE pp.id = card.patient_profile_id;
END $$;

REVOKE EXECUTE ON FUNCTION app.resolve_emergency_qr(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.resolve_emergency_qr(text) TO dawaee_app;
