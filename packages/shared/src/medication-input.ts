import type { DoseUnit, MedicationForm } from './enums.js';

/** Technical entry limits, not treatment recommendations. */
export const MAX_DAILY_TIMES = 12;
export const MAX_DOSE_QUANTITY = 1000;

export function normalizeDigits(value: string): string {
  return value.replace(/[٠-٩۰-۹]/g, (digit) =>
    String(digit.charCodeAt(0) - (digit <= '٩' ? 0x0660 : 0x06f0)));
}

/** Match PostgreSQL numeric(*,4), without silently rounding clinical input. */
function exactStoredNumber(value: number): number {
  return Number.isFinite(value) && Math.abs(value * 10_000 - Math.round(value * 10_000)) < 1e-7 ? value : NaN;
}

/** No grouping separators, exponents, units or partial parses in health input.
 * Fractions must have an exact decimal representation within four places.
 */
export function parseMedicationNumber(raw: string): number {
  const value = normalizeDigits(raw.trim()).replace(/[٫,]/g, '.');
  if (/^\d+\s*[/⁄]\s*\d+$/.test(value)) {
    const [numerator, denominator] = value.split(/[/⁄]/).map(Number);
    return denominator! > 0 ? exactStoredNumber(numerator! / denominator!) : NaN;
  }
  const fractions: Record<string, number> = { '½': 0.5, '¼': 0.25, '¾': 0.75 };
  if (Object.hasOwn(fractions, value)) return fractions[value]!;
  return /^(?:\d+(?:\.\d+)?|\.\d+)$/.test(value) ? exactStoredNumber(Number(value)) : NaN;
}

/** Entry shortcuts by dosage form. Extras require an explicit user selection. */
export const FORM_DOSE_UNITS: Record<MedicationForm, readonly DoseUnit[]> = {
  tablet: ['tablet'], capsule: ['capsule'], syrup: ['ml'], drops: ['drop', 'ml'],
  injection: ['ml', 'unit'], cream: ['application', 'g'], inhaler: ['puff'],
  patch: ['patch'], suppository: ['unit'], powder: ['sachet', 'g'],
  spray: ['spray'], other: ['unit'],
};
