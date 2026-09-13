import { describe, expect, it } from 'vitest';
import { parseMedicationText, parsePrescriptionText } from '../src/providers/ocr.js';

describe('OCR parser adversarial input bounds', () => {
  it('preserves normal medication and prescription extraction', () => {
    const medication = parseMedicationText(
      ['Panadol', 'Paracetamol 500 mg', 'tablets', 'expiry: 12/09/2028', '6281000123456'].join('\n'),
      'test',
    );
    expect(medication.fields.strengthValue?.value).toBe(500);
    expect(medication.fields.strengthUnit?.value).toBe('mg');
    expect(medication.fields.form?.value).toBe('tablet');
    expect(medication.fields.expiryDate?.value).toBe('12/09/2028');
    expect(medication.fields.barcode?.value).toBe('6281000123456');

    const prescription = parsePrescriptionText(
      'Metformin 850 mg - twice daily for 30 days',
      'test',
    );
    expect(prescription.lines).toHaveLength(1);
    expect(prescription.lines[0]?.dosage?.value).toBe('850 mg');
    expect(prescription.lines[0]?.frequency?.value).toBe('twice daily');
    expect(prescription.lines[0]?.duration?.value).toBe('for 30 days');
  });

  it('does not enter polynomial regex work on long attacker-influenced OCR text', () => {
    // Before the bounded patterns, 100k non-matching digits force repeated
    // backtracking in strength/frequency/duration scans and take many seconds.
    // A fixed implementation performs only bounded work per candidate start.
    const adversarial = `${'9'.repeat(100_000)} z`;
    expect(parseMedicationText(adversarial, 'test').fields.strengthValue).toBeUndefined();
    expect(parsePrescriptionText(adversarial, 'test').lines).toEqual([]);
  }, 3_000);
});
