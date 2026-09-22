import { describe, expect, it } from 'vitest';
import { normalizePhone } from '../src/lib/crypto.js';

describe('phone identity parsing', () => {
  it('never turns an email or arbitrary text into a phone identity', () => {
    for (const value of ['audit-0501234567@example.invalid', 'audit-12345678901234567890@example.invalid', 'call0501234567']) {
      expect(normalizePhone(value)).toBeNull();
    }
  });
  it('preserves supported local and international formatting', () => {
    for (const value of ['0501234567', '+966501234567', '00966501234567', '(050) 123-4567']) {
      expect(normalizePhone(value)).toBe('+966501234567');
    }
  });
});
