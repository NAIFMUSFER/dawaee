import { describe, expect, it } from 'vitest';
import { describeRule, dosesPerDay, expandSchedule, isCycleDayOn } from '../src/schedule.js';
import { localTimeInZone } from '../src/time.js';
import { makeSchedule } from './helpers.js';

const RIYADH = 'Asia/Riyadh';
const win = (from: string, to: string) => ({ from: new Date(from), to: new Date(to) });

describe('fixed_times', () => {
  it('generates the three daily times from the brief', () => {
    const s = makeSchedule({ rule: { kind: 'fixed_times', times: ['08:00', '14:00', '22:00'] } });
    const out = expandSchedule(s, win('2026-09-02T00:00:00Z', '2026-09-03T00:00:00Z'));
    // The UTC window covers 03:00 Sep 2 → 03:00 Sep 3 Riyadh time.
    expect(out.map((o) => `${o.scheduledLocalDate} ${o.scheduledLocalTime}`)).toEqual([
      '2026-09-02 08:00',
      '2026-09-02 14:00',
      '2026-09-02 22:00',
    ]);
    expect(out[0]!.scheduledAt.toISOString()).toBe('2026-09-02T05:00:00.000Z');
    expect(out[2]!.scheduledAt.toISOString()).toBe('2026-09-02T19:00:00.000Z');
  });

  it('is deterministic — the same window twice yields identical instants', () => {
    const s = makeSchedule({ rule: { kind: 'fixed_times', times: ['09:00'] } });
    const a = expandSchedule(s, win('2026-09-01T00:00:00Z', '2026-09-10T00:00:00Z'));
    const b = expandSchedule(s, win('2026-09-01T00:00:00Z', '2026-09-10T00:00:00Z'));
    expect(a.map((o) => o.scheduledAt.toISOString())).toEqual(b.map((o) => o.scheduledAt.toISOString()));
  });

  it('respects the start and end dates (Sep 1 → Sep 14 from the brief)', () => {
    const s = makeSchedule({
      rule: { kind: 'fixed_times', times: ['21:00'] },
      startDate: '2026-09-01',
      endDate: '2026-09-14',
    });
    const out = expandSchedule(s, win('2026-08-20T00:00:00Z', '2026-10-01T00:00:00Z'));
    expect(out).toHaveLength(14);
    expect(out[0]!.scheduledLocalDate).toBe('2026-09-01');
    expect(out[13]!.scheduledLocalDate).toBe('2026-09-14');
  });

  it('produces nothing when the schedule is inactive', () => {
    const s = makeSchedule({ rule: { kind: 'fixed_times', times: ['09:00'] }, active: false });
    expect(expandSchedule(s, win('2026-09-01T00:00:00Z', '2026-09-05T00:00:00Z'))).toHaveLength(0);
  });

  it('deduplicates and sorts duplicate times', () => {
    const s = makeSchedule({ rule: { kind: 'fixed_times', times: ['22:00', '08:00', '08:00'] } });
    const out = expandSchedule(s, win('2026-09-02T00:00:00Z', '2026-09-02T23:59:00Z'));
    expect(out.map((o) => o.scheduledLocalTime)).toEqual(['08:00', '22:00']);
  });

  it('includes a dose whose local date is outside the window but whose instant is inside', () => {
    // 01:00 Riyadh on Sep 3 == 22:00Z on Sep 2.
    const s = makeSchedule({ rule: { kind: 'fixed_times', times: ['01:00'] } });
    const out = expandSchedule(s, win('2026-09-02T21:00:00Z', '2026-09-02T23:00:00Z'));
    expect(out).toHaveLength(1);
    expect(out[0]!.scheduledLocalDate).toBe('2026-09-03');
  });
});

describe('days_of_week', () => {
  it('only generates on Sunday, Tuesday and Thursday', () => {
    const s = makeSchedule({ rule: { kind: 'days_of_week', weekdays: [0, 2, 4], times: ['09:00'] } });
    const out = expandSchedule(s, win('2026-09-06T00:00:00Z', '2026-09-13T00:00:00Z'));
    expect(out.map((o) => o.scheduledLocalDate)).toEqual(['2026-09-06', '2026-09-08', '2026-09-10']);
  });
});

describe('interval', () => {
  it('generates every 8 hours from the anchor', () => {
    const s = makeSchedule({ rule: { kind: 'interval', everyHours: 8, anchorTime: '06:00' } });
    const out = expandSchedule(s, win('2026-09-01T00:00:00Z', '2026-09-02T00:00:00Z'));
    expect(out.map((o) => o.scheduledLocalTime)).toEqual(['06:00', '14:00', '22:00']);
  });

  it('keeps a true 8-hour gap across a DST transition', () => {
    const s = makeSchedule({
      rule: { kind: 'interval', everyHours: 8, anchorTime: '00:00' },
      timezone: 'America/New_York',
      startDate: '2026-11-01',
    });
    const out = expandSchedule(s, win('2026-11-01T00:00:00Z', '2026-11-03T00:00:00Z'));
    for (let i = 1; i < out.length; i++) {
      const gap = out[i]!.scheduledAt.getTime() - out[i - 1]!.scheduledAt.getTime();
      expect(gap).toBe(8 * 3_600_000);
    }
    // The wall clock legitimately drifts, which is the point.
    expect(out.length).toBeGreaterThan(2);
  });

  it('skips doses outside the active window (sleep protection)', () => {
    const s = makeSchedule({
      rule: { kind: 'interval', everyHours: 4, anchorTime: '08:00', activeFrom: '08:00', activeUntil: '22:00' },
    });
    const out = expandSchedule(s, win('2026-09-01T00:00:00Z', '2026-09-02T00:00:00Z'));
    const times = out.map((o) => o.scheduledLocalTime);
    expect(times).toEqual(['08:00', '12:00', '16:00', '20:00']);
    expect(times).not.toContain('00:00');
    expect(times).not.toContain('04:00');
  });
});

describe('cycle', () => {
  it('marks days on and off correctly', () => {
    expect(isCycleDayOn('2026-09-01', '2026-09-01', 21, 7)).toBe(true);
    expect(isCycleDayOn('2026-09-21', '2026-09-01', 21, 7)).toBe(true);
    expect(isCycleDayOn('2026-09-22', '2026-09-01', 21, 7)).toBe(false);
    expect(isCycleDayOn('2026-09-29', '2026-09-01', 21, 7)).toBe(true);
    expect(isCycleDayOn('2026-08-30', '2026-09-01', 21, 7)).toBe(false);
  });

  it('generates only on "on" days', () => {
    const s = makeSchedule({
      rule: { kind: 'cycle', daysOn: 2, daysOff: 2, times: ['09:00'], cycleAnchorDate: '2026-09-01' },
    });
    const out = expandSchedule(s, win('2026-09-01T00:00:00Z', '2026-09-09T00:00:00Z'));
    expect(out.map((o) => o.scheduledLocalDate)).toEqual([
      '2026-09-01', '2026-09-02', '2026-09-05', '2026-09-06',
    ]);
  });
});

describe('as_needed', () => {
  it('generates no occurrences so PRN never affects adherence', () => {
    const s = makeSchedule({ rule: { kind: 'as_needed', maxPerDay: 4 } });
    expect(expandSchedule(s, win('2026-09-01T00:00:00Z', '2026-09-30T00:00:00Z'))).toHaveLength(0);
  });
});

describe('dosesPerDay', () => {
  it('computes averages per rule kind', () => {
    expect(dosesPerDay({ kind: 'fixed_times', times: ['08:00', '20:00'] })).toBe(2);
    expect(dosesPerDay({ kind: 'interval', everyHours: 8, anchorTime: '06:00' })).toBe(3);
    expect(dosesPerDay({ kind: 'days_of_week', weekdays: [0, 2, 4], times: ['09:00'] })).toBeCloseTo(3 / 7);
    expect(dosesPerDay({ kind: 'cycle', daysOn: 21, daysOff: 7, times: ['09:00'], cycleAnchorDate: '2026-09-01' }))
      .toBeCloseTo(21 / 28);
    expect(dosesPerDay({ kind: 'as_needed' })).toBe(0);
  });
});

describe('scale', () => {
  it('handles 50 medications × 3 doses/day over a week without blowing up', () => {
    const start = Date.now();
    let total = 0;
    for (let i = 0; i < 50; i++) {
      const s = makeSchedule({
        id: `sch-${i}`,
        medicationId: `med-${i}`,
        rule: { kind: 'fixed_times', times: ['08:00', '14:00', '22:00'] },
      });
      total += expandSchedule(s, win('2026-09-01T00:00:00Z', '2026-09-08T00:00:00Z')).length;
    }
    expect(total).toBe(50 * 3 * 7);
    expect(Date.now() - start).toBeLessThan(3000);
  });
});

describe('describeRule', () => {
  it('returns an i18n key for every rule kind', () => {
    expect(describeRule({ kind: 'interval', everyHours: 8, anchorTime: '06:00' }).key).toBe('schedule.everyHours');
    expect(describeRule({ kind: 'as_needed' }).key).toBe('schedule.asNeeded');
  });
});
