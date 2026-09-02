import { describe, expect, it } from 'vitest';
import {
  addDays, daysBetween, eachDate, isWithinQuietHours, localDateInZone, localTimeInZone,
  minutesToTime, timeToMinutes, weekdayOf, zonedWallTimeToUtc, zoneOffsetMs,
} from '../src/time.js';

describe('zonedWallTimeToUtc', () => {
  it('converts Riyadh wall time (UTC+3, no DST) correctly', () => {
    const d = zonedWallTimeToUtc('2026-09-02', '20:00', 'Asia/Riyadh');
    expect(d.toISOString()).toBe('2026-09-02T17:00:00.000Z');
  });

  it('converts UTC wall time to itself', () => {
    expect(zonedWallTimeToUtc('2026-01-15', '08:30', 'UTC').toISOString()).toBe('2026-01-15T08:30:00.000Z');
  });

  it('handles a zone behind UTC', () => {
    // New York in September is UTC-4 (EDT).
    expect(zonedWallTimeToUtc('2026-09-02', '08:00', 'America/New_York').toISOString())
      .toBe('2026-09-02T12:00:00.000Z');
  });

  it('handles the winter/summer offset difference in the same zone', () => {
    const winter = zonedWallTimeToUtc('2026-01-15', '08:00', 'America/New_York'); // EST, UTC-5
    const summer = zonedWallTimeToUtc('2026-07-15', '08:00', 'America/New_York'); // EDT, UTC-4
    expect(winter.toISOString()).toBe('2026-01-15T13:00:00.000Z');
    expect(summer.toISOString()).toBe('2026-07-15T12:00:00.000Z');
  });

  it('resolves a nonexistent local time (spring forward) to just after the gap', () => {
    // 2026-03-08 02:30 does not exist in America/New_York.
    const d = zonedWallTimeToUtc('2026-03-08', '02:30', 'America/New_York');
    // Whatever we pick, it must be a real instant on that calendar day and
    // strictly after the transition (07:00Z).
    expect(d.getTime()).toBeGreaterThanOrEqual(Date.parse('2026-03-08T07:00:00.000Z'));
    expect(localDateInZone(d, 'America/New_York')).toBe('2026-03-08');
  });

  it('resolves an ambiguous local time (fall back) to the earlier occurrence', () => {
    // 2026-11-01 01:30 happens twice in America/New_York: 05:30Z (EDT) and 06:30Z (EST).
    const d = zonedWallTimeToUtc('2026-11-01', '01:30', 'America/New_York');
    expect(d.toISOString()).toBe('2026-11-01T05:30:00.000Z');
  });

  it('round-trips wall time through the zone', () => {
    for (const tz of ['Asia/Riyadh', 'Europe/London', 'America/New_York', 'Asia/Tokyo', 'Australia/Sydney']) {
      const utc = zonedWallTimeToUtc('2026-06-15', '21:45', tz);
      expect(localDateInZone(utc, tz)).toBe('2026-06-15');
      expect(localTimeInZone(utc, tz)).toBe('21:45');
    }
  });
});

describe('zoneOffsetMs', () => {
  it('reports +3h for Riyadh', () => {
    expect(zoneOffsetMs(new Date('2026-09-02T00:00:00Z'), 'Asia/Riyadh')).toBe(3 * 3_600_000);
  });
  it('reports 0 for UTC', () => {
    expect(zoneOffsetMs(new Date('2026-09-02T00:00:00Z'), 'UTC')).toBe(0);
  });
});

describe('calendar helpers', () => {
  it('adds days across month and year boundaries', () => {
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2028-03-01', -1)).toBe('2028-02-29'); // leap year
  });

  it('computes day differences', () => {
    expect(daysBetween('2026-09-01', '2026-09-14')).toBe(13);
    expect(daysBetween('2026-09-14', '2026-09-01')).toBe(-13);
    expect(daysBetween('2026-09-01', '2026-09-01')).toBe(0);
  });

  it('uses Sunday=0 weekday numbering', () => {
    expect(weekdayOf('2026-09-06')).toBe(0); // Sunday
    expect(weekdayOf('2026-09-08')).toBe(2); // Tuesday
  });

  it('enumerates an inclusive range and refuses runaway ranges', () => {
    expect(eachDate('2026-09-01', '2026-09-03')).toEqual(['2026-09-01', '2026-09-02', '2026-09-03']);
    expect(eachDate('2026-09-03', '2026-09-01')).toEqual([]);
    expect(() => eachDate('2020-01-01', '2026-01-01', 400)).toThrow(RangeError);
  });
});

describe('time-of-day helpers', () => {
  it('round-trips minutes', () => {
    expect(timeToMinutes('08:30')).toBe(510);
    expect(minutesToTime(510)).toBe('08:30');
    expect(minutesToTime(1440)).toBe('00:00');
    expect(minutesToTime(-30)).toBe('23:30');
  });

  it('detects quiet hours that wrap past midnight', () => {
    expect(isWithinQuietHours('23:30', '22:00', '07:00')).toBe(true);
    expect(isWithinQuietHours('03:00', '22:00', '07:00')).toBe(true);
    expect(isWithinQuietHours('07:00', '22:00', '07:00')).toBe(false);
    expect(isWithinQuietHours('12:00', '22:00', '07:00')).toBe(false);
  });

  it('detects quiet hours inside a single day', () => {
    expect(isWithinQuietHours('13:00', '12:00', '14:00')).toBe(true);
    expect(isWithinQuietHours('15:00', '12:00', '14:00')).toBe(false);
  });

  it('treats a null window as never quiet', () => {
    expect(isWithinQuietHours('03:00', null, '07:00')).toBe(false);
    expect(isWithinQuietHours('03:00', '22:00', null)).toBe(false);
  });
});
