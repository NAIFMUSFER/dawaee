import { describe, expect, it } from 'vitest';
import { parseMedicationText, parsePrescriptionText } from '../src/providers/ocr.js';

describe('OCR strength must retain its full numeric and unit meaning', () => {
  it.each([
    '250 mg/5 ml', '5 mg/ml', '100 mcg per dose', '250 mg + 125 mg',
    '500 mg in 5 ml', '5-10 mg', '1/2 mg', '.5 mg', '-5 mg',
    '1234567 mg', '0.12345 mg', '1e3 mg', '1,250 mg', '1٬250 mg',
    '250 mg   /   ml', '250 mg\n/ 5 ml', '250 mg + 2 g',
    '5 mg - 10', '5–10 mg', '5 mg − 10',
  ])('does not reduce %s to a different scalar strength', (label) => {
    const rawText = 'Synthetic medicine\n' + label;
    const result = parseMedicationText(rawText, 'synthetic');
    expect(result.fields.strengthValue).toBeUndefined();
    expect(result.fields.strengthUnit).toBeUndefined();
    expect(result.rawText).toBe(rawText);
    expect(result.fields.name?.value).toBe('Synthetic medicine');
  });

  it.each([
    ['500 mg', 500, 'mg'], ['٥٠٠ mg', 500, 'mg'],
    ['0,5 mcg', 0.5, 'mcg'], ['0.5 %', 0.5, 'percent'],
  ])('keeps an unambiguous scalar %s', (label, value, unit) => {
    const result = parseMedicationText('Synthetic ' + label, 'synthetic');
    expect(result.fields.strengthValue?.value).toBe(value);
    expect(result.fields.strengthUnit?.value).toBe(unit);
    expect(result.fields.name?.value).toBe('Synthetic');
  });

  it('keeps a compound prescription line available for review without a truncated dosage', () => {
    const rawLine = 'Synthetic 250 mg/5 ml';
    const result = parsePrescriptionText(rawLine, 'synthetic');
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]?.rawLine).toBe(rawLine);
    expect(result.lines[0]?.medicationName?.value).toBe(rawLine);
    expect(result.lines[0]?.dosage).toBeUndefined();
    expect(result.lines[0]?.frequency).toBeUndefined();
  });
});
