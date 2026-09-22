import { describe, expect, it } from 'vitest';
import { encodeDoseHistoryCursor, readDoseHistoryCursor } from '../src/lib/dose-history-cursor.js';

describe('history cursor validation', () => {
  const value = { at: '2026-09-22 08:30:00.123456+00', id: '11111111-2222-4333-8444-555555555555', scope: 'patient/filter/range' };
  it('preserves database timestamp precision and the row tie-breaker', () => {
    expect(readDoseHistoryCursor(encodeDoseHistoryCursor(value), value.scope)).toEqual(value);
  });
  it('accepts an absent first-page cursor', () => {
    expect(readDoseHistoryCursor(undefined, value.scope)).toBeNull();
  });
  it.each([null, [], 'invalid', 'a'.repeat(1601)])('rejects malformed metadata %s', raw => {
    expect(() => readDoseHistoryCursor(raw, value.scope)).toThrow('Invalid history cursor');
  });
  it('refuses a cursor from another filter or profile', () => {
    expect(() => readDoseHistoryCursor(encodeDoseHistoryCursor(value), 'other')).toThrow();
  });
});
