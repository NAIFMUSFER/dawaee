/**
 * One redaction policy, for every process that writes a log line.
 *
 * The API and the worker each built their own pino instance with their own
 * list, and the worker's carried the comment "Same redaction posture as the
 * API". It was not. The API's list had grown to twenty-one paths; the worker's
 * still had seven, missing `allergies`, `invitedPhone`, the free-text note
 * fields, and the error serializer entirely — and nothing anywhere would have
 * failed if they drifted further, because the claim lived in a comment.
 *
 * A rule that two processes must both obey belongs in one place they both
 * import. This is that place. `apps/api/test/log-redaction.test.ts` runs both
 * loggers over the same payloads and compares what comes out, so the claim is
 * checked rather than asserted.
 */

/**
 * Object paths whose value is replaced with `[redacted]`.
 *
 * The rule these encode: a log line may say that something happened to a
 * patient, and may not say what. An operator debugging a failed reminder needs
 * to know the delivery failed and why the provider refused it; they do not
 * need the medication, and giving it to them makes every person with log
 * access a holder of medical records.
 */
export const LOG_REDACTED_PATHS: readonly string[] = [
  // Credentials in flight.
  'req.headers.authorization',
  'req.headers.cookie',
  'req.body.code',
  'req.body.token',
  'req.body.refreshToken',

  // Identifiers that name a person.
  'req.body.phone',
  'phone',
  'phoneE164',
  'invitedPhone',
  'to',
  '*.phoneE164',

  // Medical content.
  'req.body.name',
  'req.body.brandName',
  'req.body.genericName',
  'req.body.instructions',
  'req.body.doctorInstructions',
  'req.body.allergies',
  'req.body.conditionsNote',
  'medication',
  'medicationName',
  'allergies',
  'conditionsNote',
  '*.medicationName',

  // Free-text the patient wrote about their own symptoms. `req.body.notes`
  // was here alone and missed the shape the contract actually uses:
  // `confirmDoseSchema` carries `note: { tags, text }`, so "felt dizzy" went
  // through unredacted.
  'req.body.notes',
  'req.body.note',
  'notes',
  'note',
  'note.text',
  'text',
  '*.note',
];

const PG_ERROR_FIELDS_KEPT = ['code', 'constraint', 'table', 'schema', 'routine', 'severity'] as const;

/**
 * What is kept from a thrown error, and what is thrown away.
 *
 * Pino's default serializer copies every own enumerable property of the thrown
 * object. A node-postgres `DatabaseError` has a dozen, and some of them quote
 * the offending VALUE back verbatim. Measured against the real logger, the
 * line written for a duplicate registration was:
 *
 *   "detail":"Key (phone_e164)=(+966500999777) already exists."
 *
 * A patient's phone number, in plaintext, in a log that leaves the process for
 * an aggregator and is kept far longer than the request that produced it. A
 * foreign-key violation writes the same shape with a patient identifier.
 *
 * `redact` cannot reach these — they are properties of a serialized error, not
 * paths the redaction config walks — so the serializer is replaced instead.
 *
 * Kept, because an operator debugging a 500 needs them and none can carry a
 * row value: the SQLSTATE `code`, the `constraint`, `table`, `schema`,
 * `routine` and `severity`, plus the message and stack. A Postgres message
 * names the constraint that failed, never the value that failed it.
 *
 * Dropped: `detail`, `where`, `hint`, `internalQuery`, `query` and `params` —
 * each of which can quote row content. Knowing which constraint broke is
 * enough to fix it, and it is enough without naming whose row broke it.
 */
export function serializeLoggedError(err: unknown): Record<string, unknown> {
  if (!(err instanceof Error)) return { type: typeof err, message: String(err) };

  const out: Record<string, unknown> = {
    type: err.constructor?.name ?? 'Error',
    message: err.message,
    stack: err.stack,
  };
  const source = err as unknown as Record<string, unknown>;
  for (const field of PG_ERROR_FIELDS_KEPT) {
    if (source[field] !== undefined) out[field] = source[field];
  }
  if (err.cause instanceof Error) out.cause = serializeLoggedError(err.cause);
  return out;
}

/** The redaction block every pino instance in this system is built with. */
export const LOG_REDACTION = {
  paths: [...LOG_REDACTED_PATHS],
  censor: '[redacted]',
};
