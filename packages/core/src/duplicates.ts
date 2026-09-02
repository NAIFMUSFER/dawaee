import type { Medication, StrengthUnit, UUID } from '@dawaee/shared';

/**
 * Duplicate medication detection.
 *
 * Runs BEFORE a medication record is created. It never blocks the user — it
 * surfaces a warning with the candidate matches so the patient decides. Silent
 * merging of two medications would be dangerous.
 */

export interface DuplicateCandidateInput {
  name: string;
  strengthValue?: number | null;
  strengthUnit?: StrengthUnit | null;
  barcode?: string | null;
}

export interface DuplicateMatch {
  medicationId: UUID;
  medicationName: string;
  /** 0–1. Anything at or above `DUPLICATE_WARN_THRESHOLD` is shown to the user. */
  score: number;
  reasons: Array<'barcode' | 'exact_name' | 'similar_name' | 'same_strength' | 'active'>;
}

export const DUPLICATE_WARN_THRESHOLD = 0.62;

/** Arabic and Latin normalization so "بنادول" / "Panadol " / "PANADOL" collapse. */
export function normalizeMedicationName(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    // Arabic diacritics and tatweel
    .replace(/[ً-ْـ]/g, '')
    // Alef variants → bare alef
    .replace(/[آأإٱ]/g, 'ا')
    // Teh marbuta → heh, alef maksura → yeh
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    // Arabic-Indic digits → Latin
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The numeric tokens in a normalized name, e.g. "humalog mix 25" -> ["25"]. */
function numericTokens(normalized: string): string[] {
  return normalized.match(/\d+/g) ?? [];
}

/**
 * Normalized Levenshtein similarity in [0,1], with one important exception.
 *
 * Numbers inside a medication name are almost never incidental — "Humalog
 * Mix25" and "Humalog Mix50", "Lantus 100" and "Lantus 300" are different
 * products, yet they sit one character apart. Treating those as the same
 * medication would push a patient toward merging two records that must stay
 * separate, so differing digits collapse the score instead of raising it.
 */
export function nameSimilarity(a: string, b: string): number {
  const x = normalizeMedicationName(a);
  const y = normalizeMedicationName(b);
  if (!x || !y) return 0;
  if (x === y) return 1;

  const nx = numericTokens(x);
  const ny = numericTokens(y);
  if (nx.join(',') !== ny.join(',')) {
    // Compare the names with their numbers stripped. If they are otherwise
    // identical, this is a variant of the same brand, not a duplicate.
    const bareX = x.replace(/\d+/g, '').replace(/\s+/g, ' ').trim();
    const bareY = y.replace(/\d+/g, '').replace(/\s+/g, ' ').trim();
    if (bareX === bareY) return 0.4;
    const bareDistance = levenshtein(bareX, bareY);
    const bareScore = bareX && bareY ? 1 - bareDistance / Math.max(bareX.length, bareY.length) : 0;
    return Math.min(bareScore, 0.7);
  }

  const distance = levenshtein(x, y);
  return 1 - distance / Math.max(x.length, y.length);
}

function levenshtein(a: string, b: string): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let curr = new Array<number>(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length]!;
}

export function findDuplicates(
  candidate: DuplicateCandidateInput,
  existing: ReadonlyArray<
    Pick<Medication, 'id' | 'name' | 'brandName' | 'genericName' | 'strengthValue' | 'strengthUnit' | 'barcode' | 'status'>
  >,
): DuplicateMatch[] {
  const matches: DuplicateMatch[] = [];

  for (const med of existing) {
    if (med.status === 'archived') continue;

    const reasons: DuplicateMatch['reasons'] = [];
    let score = 0;

    // A barcode match is near-conclusive: same GTIN means same product.
    if (candidate.barcode && med.barcode && candidate.barcode.trim() === med.barcode.trim()) {
      score = 0.95;
      reasons.push('barcode');
    } else {
      const nameScore = Math.max(
        nameSimilarity(candidate.name, med.name),
        med.brandName ? nameSimilarity(candidate.name, med.brandName) : 0,
        med.genericName ? nameSimilarity(candidate.name, med.genericName) : 0,
      );
      if (nameScore >= 0.999) {
        score = 0.75;
        reasons.push('exact_name');
      } else if (nameScore >= 0.82) {
        score = 0.5 + (nameScore - 0.82) * 1.2;
        reasons.push('similar_name');
      } else {
        continue;
      }
    }

    const strengthKnown = candidate.strengthValue != null && med.strengthValue != null;
    if (strengthKnown) {
      const same =
        candidate.strengthValue === med.strengthValue &&
        (candidate.strengthUnit ?? null) === (med.strengthUnit ?? null);
      if (same) {
        score += 0.2;
        reasons.push('same_strength');
      } else {
        // Different strengths of the same drug are legitimately separate
        // records (5 mg vs 10 mg), so pull the score down hard.
        score -= 0.3;
      }
    }

    if (med.status === 'active') {
      score += 0.05;
      reasons.push('active');
    }

    score = Math.max(0, Math.min(1, score));
    if (score >= DUPLICATE_WARN_THRESHOLD) {
      matches.push({ medicationId: med.id, medicationName: med.name, score: Number(score.toFixed(3)), reasons });
    }
  }

  return matches.sort((a, b) => b.score - a.score).slice(0, 5);
}
