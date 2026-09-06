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

// ---------------------------------------------------------------------------

/**
 * The longest an operational error may be once stored.
 *
 * `job_runs` is a table in the same database as the medical records, and
 * nothing purges it on a schedule. A provider that answers with an HTML error
 * page, or a stack a thousand frames deep, must not become a megabyte row
 * there. 500 was already the cap on `job_runs.error_message`; the per-step
 * `metadata` copy had none at all.
 */
export const OPERATIONAL_ERROR_MAX = 500;

/**
 * Fields a `DatabaseError` uses to quote the offending row back. Dropped
 * wholesale — see `serializeLoggedError`.
 */
const PG_VALUE_BEARING = ['detail', 'hint', 'where', 'internalQuery', 'query'] as const;

/**
 * Patterns that must never survive into a stored operational error, each with
 * what replaces it. Ordered: the more specific rules run first.
 *
 * These are a second line, not the first. The first is that the API's own
 * thrown errors do not contain these things — `Vision API returned ${status}`
 * rather than the URL, and so on. But a worker error can also come from a
 * provider's response body, from a driver, or from a database trigger this
 * schema wrote itself, and none of those are under the API's control.
 */
const SCRUB: Array<{ pattern: RegExp; replace: string }> = [
  // A URL with any credential-shaped query parameter. Not hypothetical: the
  // Google Vision client builds `…/images:annotate?key=${API_KEY}`. Node's own
  // fetch does not echo that URL — measured, its cause names the host only —
  // but a provider is free to quote the request back in its error body, and
  // this code re-throws that body verbatim.
  { pattern: /([?&](?:key|api[_-]?key|access[_-]?token|token|signature|sig|password)=)[^\s&"']+/gi, replace: '$1[redacted]' },
  // A connection string with a password in it.
  { pattern: /\b([a-z+]+:\/\/[^\s:/@"']+):[^\s@"']+@/gi, replace: '$1:[redacted]@' },
  // An Authorization header echoed by an upstream.
  { pattern: /\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, replace: '$1 [redacted]' },
  // A JWT anywhere in the text.
  { pattern: /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b/g, replace: '[redacted-jwt]' },
  // An Expo push token, which identifies a device.
  { pattern: /ExponentPushToken\[[^\]]*\]/g, replace: 'ExponentPushToken[redacted]' },
  // A UUID. Every uuid in this system is a patient, profile, medication, dose
  // or object id — `app.assert_profile_matches_medication` raises
  // "medication <uuid> not found" — and a pseudonymous health-related
  // identifier does not belong in a table nothing purges. An operator who
  // needs the id has the job name, the timestamp and the SQLSTATE to find it.
  { pattern: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, replace: '[id]' },
  // An E.164 phone number.
  { pattern: /\+[0-9]{7,15}\b/g, replace: '[phone]' },
  // An email address.
  { pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, replace: '[email]' },
  // An absolute filesystem path, however it is quoted. Reveals the deployment
  // layout and, in the ENOENT case, the name of the file that was missing.
  // `(?<![/:\w])` keeps it off the path component of a URL, so a provider
  // error still names the host it failed against.
  { pattern: /(?<![/:\w])\/(?:[A-Za-z0-9._-]+\/){1,}[A-Za-z0-9._-]*/g, replace: '[path]' },
  /**
   * A JSON object embedded in an error message.
   *
   * Structural rather than pattern-based, and it is the rule that matters most.
   * A medication name cannot be recognised — it is arbitrary text a patient
   * typed — so no pattern will ever catch `Zoprexa` on its own. What CAN be
   * recognised is the shape it arrives in: a provider echoing the request back.
   * Measured, an Expo rejection reads
   * `Expo push rejected message {"title":"<medication>","to":"..."}`, and the
   * notification title IS the medication name.
   *
   * So the payload goes, whole. An operator debugging a rejected push has the
   * delivery id, the channel and the provider's error code; they do not need
   * the message body, and a table nobody purges is the wrong place to keep it.
   */
  { pattern: /\{[^{}]*\}/g, replace: '{redacted}' },
  /**
   * A long opaque token.
   *
   * Capability tokens here are `randomBytes(n).toString('base64url')`, so they
   * are runs of `[A-Za-z0-9_-]` with mixed case and digits. Requiring both an
   * uppercase letter and a digit keeps ordinary identifiers readable — a
   * constraint name like `users_phone_e164_key` is lower case and stays — while
   * an emergency card token, an invitation token or an API key does not.
   */
  { pattern: /\b(?=[A-Za-z0-9_-]{24,}\b)(?=[A-Za-z0-9_-]*[A-Z])(?=[A-Za-z0-9_-]*[0-9])[A-Za-z0-9_-]{24,}\b/g, replace: '[token]' },
];

/** Control characters and bidirectional overrides, which can forge a log line. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/**
 * Reduces a thrown error to something safe to persist in `job_runs`.
 *
 * The order matters. A `DatabaseError` is described by its stable fields —
 * SQLSTATE and constraint — because those say what broke without saying whose
 * row broke it, and they are what an operator actually greps for. Everything
 * else falls back to the message, scrubbed and capped.
 *
 * Measured before this existed, through the real persistence path: a duplicate
 * registration stored the patient's phone number, this schema's own
 * `medication % not found` trigger stored a medication id, and a provider
 * error echoing its request URL would have stored an API key.
 */
export function sanitizeOperationalError(err: unknown): string {
  const e = err as { code?: unknown; constraint?: unknown; table?: unknown; message?: unknown } | null;

  // A Postgres error is better described than quoted.
  if (e && typeof e.code === 'string' && /^[0-9A-Z]{5}$/.test(e.code)) {
    const parts = [`sqlstate=${e.code}`];
    if (typeof e.constraint === 'string') parts.push(`constraint=${e.constraint}`);
    if (typeof e.table === 'string') parts.push(`table=${e.table}`);
    // The message names the constraint, never the value — but a plpgsql
    // RAISE EXCEPTION is free text, so it is scrubbed like any other.
    if (typeof e.message === 'string') parts.push(scrub(e.message));
    return cap(parts.join(' '));
  }

  const message = err instanceof Error ? err.message : String(err ?? 'unknown error');
  return cap(scrub(message));
}

function scrub(text: string): string {
  let out = text.replace(CONTROL_CHARS, ' ');
  for (const { pattern, replace } of SCRUB) out = out.replace(pattern, replace);
  return out.replace(/\s+/g, ' ').trim();
}

function cap(text: string): string {
  if (text.length <= OPERATIONAL_ERROR_MAX) return text;
  const suffix = '… [truncated]';
  return `${text.slice(0, OPERATIONAL_ERROR_MAX - suffix.length)}${suffix}`;
}

/** Exported for the log serializer, which drops the same fields. */
export const PG_VALUE_BEARING_FIELDS: readonly string[] = PG_VALUE_BEARING;
