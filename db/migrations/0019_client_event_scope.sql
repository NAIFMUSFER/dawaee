-- A client event id must be unique per patient, not across the whole system.
--
-- `dose_occurrences_client_event_idx` was unique on `client_event_id` alone,
-- across every patient in the database, and the idempotency lookup that reads
-- it carried no profile predicate:
--
--   SELECT id, status FROM dose_occurrences WHERE client_event_id = $1
--
-- Row level security hides another patient's row from that SELECT, but an
-- index is not RLS-filtered. So two things could happen, and the second is the
-- dangerous one.
--
-- Cross-patient: patient A confirms a dose using an id patient B has already
-- used. A's SELECT finds nothing, the UPDATE proceeds, and the write collides
-- with the unique index — 23505, surfaced as 409 "this record already exists".
-- A's confirmation fails because of a string belonging to someone A cannot
-- see, and the 409-versus-404 difference reveals that the string is in use.
--
-- Same-patient: the id collides with a DIFFERENT dose the caller can read.
-- `findByClientEvent` returns that other dose, `confirmDose` reports
-- `idempotentReplay: true` with its status, and the dose actually named in the
-- request is never confirmed. The API answers 200. The patient is told the
-- dose is recorded. It is not, and the adherence record is quietly wrong —
-- which for a medication app is the worst available outcome, because nothing
-- anywhere reports a fault.
--
-- The ids the app generates (`evt-<ms base36>-<8 random chars>`) make an
-- accidental collision unlikely; the schema accepts any 8-to-128-character
-- string, so a deliberate one costs nothing. Scoping the constraint removes
-- both cases rather than making them rarer: an id is now meaningful only
-- within the patient it belongs to, which is what "client event" always meant.

DROP INDEX IF EXISTS dose_occurrences_client_event_idx;

CREATE UNIQUE INDEX dose_occurrences_client_event_idx
  ON dose_occurrences (patient_profile_id, client_event_id)
  WHERE client_event_id IS NOT NULL;
