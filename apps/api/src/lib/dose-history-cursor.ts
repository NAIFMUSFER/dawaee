import { AppError } from '@dawaee/shared';
import { requireUuid } from './params.js';

export interface DoseHistoryCursor { at: string; id: string; scope: string }

export function encodeDoseHistoryCursor(cursor: DoseHistoryCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

export function readDoseHistoryCursor(raw: unknown, scope: string): DoseHistoryCursor | null {
  if (raw === undefined) return null;
  try {
    if (typeof raw !== 'string' || raw.length > 1600 || !/^[A-Za-z0-9_-]+$/.test(raw)) throw new Error();
    const value = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as DoseHistoryCursor;
    if (value.scope !== scope || typeof value.at !== 'string' || value.at.length > 40
      || !/^\d{4}-\d{2}-\d{2}[T ]/.test(value.at) || !Number.isFinite(Date.parse(value.at))) throw new Error();
    requireUuid(value.id, 'cursor');
    return value;
  } catch {
    throw AppError.badRequest('validation_failed', 'Invalid history cursor');
  }
}
