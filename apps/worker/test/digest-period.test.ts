import { describe, expect, it } from 'vitest';
import { latestDigestPeriod } from '../src/jobs/digests.js';

describe('digest catch-up retains its scheduled period', () => {
  it('uses the latest daily appointment when a minute is missed', () => {
    const period = latestDigestPeriod(new Date('2026-09-19T05:01:00Z'), 'Asia/Riyadh', 'daily_summary', '08:00');
    expect(period.date).toBe('2026-09-19');
    expect([period.from, period.to]).toEqual(['2026-09-18', '2026-09-18']);
  });
  it('before the next appointment, catches only the previous appointment', () => {
    const period = latestDigestPeriod(new Date('2026-09-20T04:59:00Z'), 'Asia/Riyadh', 'daily_summary', '08:00');
    expect(period.date).toBe('2026-09-19');
    expect(period.scheduledAt.toISOString()).toBe('2026-09-19T05:00:00.000Z');
  });
  it('a Monday restart retains the Sunday weekly report dates', () => {
    const period = latestDigestPeriod(new Date('2026-09-21T05:01:00Z'), 'Asia/Riyadh', 'weekly_summary', '08:00');
    expect(period.date).toBe('2026-09-20');
    expect([period.from, period.to]).toEqual(['2026-09-13', '2026-09-19']);
  });
});
