import { describe, expect, it } from 'vitest';
import { quietHoursResumeAt, zonedWallTimeToUtc } from '../src/time.js';
import { snooze } from '../src/dose-status.js';

describe('civil reminder boundaries', () => {
  it.each([
    ['Europe/London', '2026-10-25', '01:30', '2026-10-25T00:30:00.000Z'],
    ['Europe/Paris', '2026-10-25', '02:30', '2026-10-25T00:30:00.000Z'],
    ['America/New_York', '2026-11-01', '01:30', '2026-11-01T05:30:00.000Z'],
    ['Australia/Lord_Howe', '2026-04-05', '01:45', '2026-04-04T14:45:00.000Z'],
  ])('chooses the first fold in %s', (zone, date, time, expected) => {
    expect(zonedWallTimeToUtc(date, time, zone).toISOString()).toBe(expected);
  });
  it('defers through a repeated quiet hour without adding a day', () => {
    expect(quietHoursResumeAt(new Date('2026-10-25T00:45:00Z'), 'Europe/London', '00:00', '02:00')?.toISOString())
      .toBe('2026-10-25T02:00:00.000Z');
  });
  it('defers a midnight window to its end and leaves an urgent-time caller free to bypass it', () => {
    expect(quietHoursResumeAt(new Date('2026-09-19T20:00:00Z'), 'Asia/Riyadh', '22:00', '07:00')?.toISOString())
      .toBe('2026-09-20T04:00:00.000Z');
    expect(quietHoursResumeAt(new Date('2026-09-20T04:00:00Z'), 'Asia/Riyadh', '22:00', '07:00')).toBeNull();
  });
});

describe('a snooze deadline belongs to the original action', () => {
  const dose = { status: 'pending_confirmation' as const, scheduledAt: '2026-09-19T10:00:00Z', snoozeCount: 1 };
  it('does not add the offline delay again when reconnecting', () => {
    const result = snooze(dose, 15, new Date('2026-09-19T10:10:00Z'), {
      actionAt: new Date('2026-09-19T10:03:00Z'), missedAfterMinutes: 120,
    });
    expect(result.snoozedUntil.toISOString()).toBe('2026-09-19T10:18:00.000Z');
    expect(result.snoozeCount).toBe(2);
  });
  it.each([
    ['2026-09-19T10:03:00Z', '2026-09-19T10:18:00Z', 15],
    ['2026-09-19T10:11:00Z', '2026-09-19T10:10:00Z', 15],
    ['2026-09-19T11:45:00Z', '2026-09-19T11:45:00Z', 15],
    ['2026-09-19T11:45:00Z', '2026-09-19T11:45:00Z', 16],
  ])('refuses expired, future or out-of-window intent %s %s %i', (actionAt, now, minutes) => {
    expect(() => snooze(dose, minutes, new Date(now), { actionAt: new Date(actionAt), missedAfterMinutes: 120 })).toThrow();
  });
  it('accepts a reminder a minute before the existing missed boundary', () => {
    expect(snooze(dose, 14, new Date('2026-09-19T11:45:00Z'), { missedAfterMinutes: 120 }).snoozedUntil.toISOString())
      .toBe('2026-09-19T11:59:00.000Z');
  });
});
