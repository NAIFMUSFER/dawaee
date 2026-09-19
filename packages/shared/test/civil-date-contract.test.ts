import { describe, expect, it } from 'vitest';
import { localDate } from '../src/contracts.js';

describe('civil dates are real calendar dates', () => {
  it.each(['2026-02-30', '2026-02-29', '2026-13-01', '2026-00-01', '2026-01-00', '0000-01-01', '2026-04-31'])('rejects %s', (date) => {
    expect(localDate.safeParse(date).success).toBe(false);
  });
  it.each(['2028-02-29', '2026-09-19', '2000-02-29', '2026-12-31'])('preserves %s', (date) => {
    expect(localDate.parse(date)).toBe(date);
  });
});
