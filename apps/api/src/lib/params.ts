import type { IncomingHttpHeaders } from 'node:http';
import { AppError, ERROR_CODES } from '@dawaee/shared';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Validates an identifier at the edge.
 *
 * Without this a malformed id reaches Postgres and comes back as a cast error,
 * which is both a 500 and a small information leak about the storage layer.
 */
export function requireUuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw AppError.badRequest(ERROR_CODES.VALIDATION_FAILED, `${field} must be a valid identifier`, [
      { path: field, message: 'expected a UUID' },
    ]);
  }
  return value;
}

export function optionalUuid(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  return requireUuid(value, field);
}

/**
 * Resolve a private UUID transported either by the legacy query contract or by
 * Dawaee's privacy-preserving routing header.
 *
 * The global preValidation promotion normally copies the header into req.query.
 * Production Android evidence showed a harder failure mode: the URL correctly
 * omitted profileId (so Render did not log PHI-adjacent identifiers) while
 * several handlers still observed an empty query and returned validation_failed.
 * Reading the authenticated routing metadata again at the handler boundary is a
 * defence-in-depth fallback; it keeps identifiers out of infrastructure URLs
 * without making every clinical screen depend on hook mutation succeeding.
 */
export function requireRoutedUuid(
  queryValue: unknown,
  headers: IncomingHttpHeaders,
  headerName: string,
  field: string,
): string {
  const fromQuery = optionalUuid(queryValue, field);
  const rawHeader = headers[headerName.toLowerCase()];
  if (Array.isArray(rawHeader)) {
    throw AppError.badRequest(ERROR_CODES.VALIDATION_FAILED, `Invalid ${field} routing metadata`, [
      { path: field, message: 'expected one identifier' },
    ]);
  }
  const fromHeader = rawHeader === undefined || rawHeader === null || rawHeader.trim() === ''
    ? null
    : requireUuid(rawHeader.trim(), field);
  if (fromQuery && fromHeader && fromQuery !== fromHeader) {
    throw AppError.badRequest(ERROR_CODES.VALIDATION_FAILED, `Conflicting ${field} routing metadata`, [
      { path: field, message: 'query and routing metadata disagree' },
    ]);
  }
  if (fromQuery) return fromQuery;
  if (fromHeader) return fromHeader;
  return requireUuid(undefined, field);
}

export function requireDate(value: unknown, field: string): string {
  if (typeof value !== 'string' || !DATE_RE.test(value)) {
    throw AppError.badRequest(ERROR_CODES.VALIDATION_FAILED, `${field} must be a date in YYYY-MM-DD form`, [
      { path: field, message: 'expected YYYY-MM-DD' },
    ]);
  }
  return value;
}

/**
 * Parses a caller-supplied row limit.
 *
 * The previous form, `Math.min(Number(q.limit ?? 500), 2000)`, sent whatever it
 * produced straight into `LIMIT $n`. Measured against PostgreSQL 16, three
 * ordinary query strings therefore became 500s rather than 400s:
 *
 *   ?limit=abc    -> NaN  -> invalid input syntax for type bigint: "NaN"
 *   ?limit=-5     -> -5   -> LIMIT must not be negative
 *   ?limit=1.5    -> 1.5  -> invalid input syntax for type bigint: "1.5"
 *
 * Not a data-exposure bug — the ceiling still held, and `?limit=1e999` clamped
 * to the maximum correctly — but a malformed parameter should be refused at the
 * edge with a message the client can act on, not surface as a database error.
 * A repeated parameter (`?limit=1&limit=2`) arrives as an array and is refused
 * for the same reason.
 */
export function requireLimit(value: unknown, fallback: number, max: number, field = 'limit'): number {
  if (value === undefined || value === null || value === '') return fallback;
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isInteger(n) || n < 1) {
    throw AppError.badRequest(ERROR_CODES.VALIDATION_FAILED, `${field} must be a positive whole number`, [
      { path: field, message: `expected an integer between 1 and ${max}` },
    ]);
  }
  return Math.min(n, max);
}

export function optionalDate(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  return requireDate(value, field);
}

/**
 * Constrains an optional filter to a known set before it is cast to a Postgres
 * enum. An unrecognised value cast with `$1::some_enum` raises "invalid input
 * value for enum", which reaches the client as a 500.
 */
export function requireEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
): T | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw AppError.badRequest(ERROR_CODES.VALIDATION_FAILED, `${field} is not a recognised value`, [
      { path: field, message: `expected one of: ${allowed.join(', ')}` },
    ]);
  }
  return value as T;
}

/** Guards report and history ranges so one request cannot scan years of rows. */
export function requireDateRange(from: unknown, to: unknown, maxDays = 400): { from: string; to: string } {
  const f = requireDate(from, 'from');
  const t = requireDate(to, 'to');
  if (t < f) throw AppError.badRequest(ERROR_CODES.VALIDATION_FAILED, '"to" must not be before "from"');
  const span = (Date.parse(`${t}T00:00:00Z`) - Date.parse(`${f}T00:00:00Z`)) / 86_400_000;
  if (span > maxDays) {
    throw AppError.badRequest(ERROR_CODES.VALIDATION_FAILED, `The range must not exceed ${maxDays} days`);
  }
  return { from: f, to: t };
}
