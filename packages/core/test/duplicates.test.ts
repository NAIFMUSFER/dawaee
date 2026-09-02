import { describe, expect, it } from 'vitest';
import { DUPLICATE_WARN_THRESHOLD, findDuplicates, nameSimilarity, normalizeMedicationName } from '../src/duplicates.js';
import type { Medication } from '@dawaee/shared';

const med = (o: Partial<Medication> & { id: string; name: string }): Medication =>
  ({
    brandName: null, genericName: null, strengthValue: null, strengthUnit: null,
    barcode: null, status: 'active', ...o,
  }) as Medication;

describe('normalizeMedicationName', () => {
  it('normalizes Arabic orthography', () => {
    expect(normalizeMedicationName('بَنَادُول')).toBe(normalizeMedicationName('بنادول'));
    expect(normalizeMedicationName('أسبرين')).toBe(normalizeMedicationName('اسبرين'));
    expect(normalizeMedicationName('حبّة')).toBe(normalizeMedicationName('حبه'));
  });
  it('converts Arabic-Indic digits', () => {
    expect(normalizeMedicationName('بنادول ٥٠٠')).toBe('بنادول 500');
  });
  it('collapses case and punctuation', () => {
    expect(normalizeMedicationName('  PANADOL-Extra ')).toBe('panadol extra');
  });
});

describe('nameSimilarity', () => {
  it('scores identical names at 1', () => {
    expect(nameSimilarity('Panadol', 'panadol ')).toBe(1);
  });
  it('scores a typo highly', () => {
    expect(nameSimilarity('Panadol', 'Panadl')).toBeGreaterThan(0.82);
  });
  it('scores unrelated names low', () => {
    expect(nameSimilarity('Panadol', 'Metformin')).toBeLessThan(0.4);
  });

  it('does not treat a differing NUMBER in the name as a near-match', () => {
    // These are genuinely different products one character apart.
    expect(nameSimilarity('Humalog Mix25', 'Humalog Mix50')).toBeLessThan(0.62);
    expect(nameSimilarity('Lantus 100', 'Lantus 300')).toBeLessThan(0.62);
    expect(nameSimilarity('Medication 1', 'Medication 2')).toBeLessThan(0.62);
  });

  it('still matches identical names that happen to contain a number', () => {
    expect(nameSimilarity('Augmentin 625', 'augmentin 625')).toBe(1);
  });
});

describe('findDuplicates', () => {
  const existing = [
    med({ id: 'm1', name: 'Panadol', strengthValue: 500, strengthUnit: 'mg', barcode: '6281000123456' }),
    med({ id: 'm2', name: 'Metformin', strengthValue: 850, strengthUnit: 'mg' }),
    med({ id: 'm3', name: 'Old Drug', status: 'archived' }),
  ];

  it('flags an exact name + strength match', () => {
    const m = findDuplicates({ name: 'Panadol', strengthValue: 500, strengthUnit: 'mg' }, existing);
    expect(m).toHaveLength(1);
    expect(m[0]!.medicationId).toBe('m1');
    expect(m[0]!.reasons).toContain('exact_name');
    expect(m[0]!.reasons).toContain('same_strength');
  });

  it('treats a barcode match as near-conclusive', () => {
    const m = findDuplicates({ name: 'Completely Different Brand', barcode: '6281000123456' }, existing);
    expect(m[0]!.medicationId).toBe('m1');
    expect(m[0]!.score).toBeGreaterThan(0.9);
  });

  it('does NOT flag a different strength of the same drug', () => {
    // 500 mg and 1000 mg Panadol are legitimately separate records.
    const m = findDuplicates({ name: 'Panadol', strengthValue: 1000, strengthUnit: 'mg' }, existing);
    expect(m).toHaveLength(0);
  });

  it('ignores archived medications', () => {
    expect(findDuplicates({ name: 'Old Drug' }, existing)).toHaveLength(0);
  });

  it('matches across Arabic and Latin spellings of the same entry', () => {
    const arabic = [med({ id: 'm4', name: 'بنادول', strengthValue: 500, strengthUnit: 'mg' })];
    const m = findDuplicates({ name: 'بَنادول', strengthValue: 500, strengthUnit: 'mg' }, arabic);
    expect(m).toHaveLength(1);
  });

  it('does not flag a numbered variant of an existing medication', () => {
    const variants = [med({ id: 'v1', name: 'Humalog Mix25' })];
    expect(findDuplicates({ name: 'Humalog Mix50' }, variants)).toHaveLength(0);
  });

  it('returns nothing for an unrelated new medication', () => {
    expect(findDuplicates({ name: 'Atorvastatin', strengthValue: 20, strengthUnit: 'mg' }, existing)).toHaveLength(0);
  });

  it('caps the candidate list at five', () => {
    const many = Array.from({ length: 12 }, (_, i) => med({ id: `x${i}`, name: 'Panadol' }));
    expect(findDuplicates({ name: 'Panadol' }, many).length).toBeLessThanOrEqual(5);
  });

  it('keeps the warning threshold meaningful', () => {
    expect(DUPLICATE_WARN_THRESHOLD).toBeGreaterThan(0.5);
    expect(DUPLICATE_WARN_THRESHOLD).toBeLessThan(0.9);
  });
});
