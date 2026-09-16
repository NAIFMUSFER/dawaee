import type { DoseUnit, MedicationForm } from './enums.js';

/** Technical entry limits, not treatment recommendations. */
export const MAX_DAILY_TIMES = 12;
export const MAX_DOSE_QUANTITY = 1000;

export function normalizeDigits(value: string): string {
  return value.replace(/[٠-٩۰-۹]/g, (digit) =>
    String(digit.charCodeAt(0) - (digit <= '٩' ? 0x0660 : 0x06f0)));
}

/** No grouping separators, exponents, units or partial parses in health input. */
export function parseMedicationNumber(raw: string): number {
  const value = normalizeDigits(raw.trim()).replace(/[٫,]/g, '.');
  if (/^\d+\s*[/⁄]\s*\d+$/.test(value)) {
    const [numerator, denominator] = value.split(/[/⁄]/).map(Number);
    return denominator! > 0 ? numerator! / denominator! : NaN;
  }
  const fractions: Record<string, number> = { '½': 0.5, '¼': 0.25, '¾': 0.75 };
  if (value in fractions) return fractions[value]!;
  return /^(?:\d+(?:\.\d+)?|\.\d+)$/.test(value) ? Number(value) : NaN;
}

/** Entry shortcuts by dosage form. Extras require an explicit user selection. */
export const FORM_DOSE_UNITS: Record<MedicationForm, readonly DoseUnit[]> = {
  tablet: ['tablet'], capsule: ['capsule'], syrup: ['ml'], drops: ['drop', 'ml'],
  injection: ['ml', 'unit'], cream: ['application', 'g'], inhaler: ['puff'],
  patch: ['patch'], suppository: ['unit'], powder: ['sachet', 'g'],
  spray: ['spray'], other: ['unit'],
};
