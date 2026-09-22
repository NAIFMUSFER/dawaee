import { normalizeDigits } from '@dawaee/shared';

/** Match the API's Saudi-default normalization before asking Firebase to send. */
export function phoneForProof(raw: string): string | null {
  let value = normalizeDigits(raw).replace(/[\s()\-.]/g, '');
  if (!/^\+?\d+$/.test(value)) return null;
  if (value.startsWith('00')) value = `+${value.slice(2)}`;
  if (value.startsWith('+')) return /^\+[1-9]\d{7,14}$/.test(value) ? value : null;
  if (value.startsWith('966')) value = `+${value}`;
  else if (value.startsWith('0')) value = `+966${value.slice(1)}`;
  else if (value.length >= 8) value = `+966${value}`;
  return /^\+[1-9]\d{7,14}$/.test(value) ? value : null;
}

