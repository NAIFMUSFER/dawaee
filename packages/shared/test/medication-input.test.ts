import { describe, expect, it } from 'vitest';
import { parseMedicationNumber, MAX_DAILY_TIMES } from '../src/medication-input.js';
import { createScheduleSchema, daysOfWeekRuleSchema } from '../src/contracts.js';

describe('medication quantity entry and schedule contracts', () => {
  it.each([['6', 6], ['٦', 6], ['۶', 6], ['١٫٥', 1.5], ['1,5', 1.5], ['۱.۵', 1.5], ['١/٢', 0.5], ['½', 0.5], ['3/4', 0.75]])('reads %s without confusing amount and frequency', (raw, value) => {
    expect(parseMedicationNumber(raw)).toBe(value);
  });
  it.each(['', ' ', '-1', '١/٠', '1e3', '0x10', '1,2,3', '12mg', '1٬000'])('rejects ambiguous numeric input %s', (raw) => {
    expect(Number.isNaN(parseMedicationNumber(raw))).toBe(true);
  });
  it('accepts twelve distinct daily times and a custom amount of six', () => {
    const times = Array.from({ length: MAX_DAILY_TIMES }, (_, i) => `${String(i * 2).padStart(2, '0')}:13`);
    expect(createScheduleSchema.parse({ rule: { kind: 'fixed_times', times }, doseQuantity: 6, doseUnit: 'tablet', startDate: '2026-09-16' }).rule).toEqual({ kind: 'fixed_times', times });
    expect(daysOfWeekRuleSchema.safeParse({ kind: 'days_of_week', times: [...times, '23:59'], weekdays: [0] }).success).toBe(false);
  });
  it('rejects duplicate times and invalid amounts instead of silently dropping input', () => {
    for (const kind of ['fixed_times', 'days_of_week', 'cycle']) {
      expect(createScheduleSchema.safeParse({
        rule: { kind, times: ['08:00', '08:00'], weekdays: [0, 6], daysOn: 2, daysOff: 1, cycleAnchorDate: '2026-09-16' },
        doseQuantity: 6, doseUnit: 'tablet', startDate: '2026-09-16',
      }).success).toBe(false);
    }
    for (const doseQuantity of [0, -1, 1001]) expect(createScheduleSchema.safeParse({ rule: { kind: 'fixed_times', times: ['08:00'] }, doseQuantity, doseUnit: 'tablet', startDate: '2026-09-16' }).success).toBe(false);
  });
});
