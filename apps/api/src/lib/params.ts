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

export function requireDate(value: unknown, field: string): string {
  if (typeof value !== 'string' || !DATE_RE.test(value)) {
    throw AppError.badRequest(ERROR_CODES.VALIDATION_FAILED, `${field} must be a date in YYYY-MM-DD form`, [
      { path: field, message: 'expected YYYY-MM-DD' },
    ]);
  }
  return value;
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
