import type { Instant, LocalDate, LocalTime, TimeZone } from '@dawaee/shared';

/**
 * Timezone-correct date arithmetic built only on `Intl`, so there is no
 * dependency on a bundled tz database that could drift between the mobile
 * client and the server.
 *
 * The rule the whole platform follows: a dose has ONE authoritative instant
 * (`scheduledAt`, UTC). The wall-clock time the patient authored is kept
 * alongside it so travel mode can re-anchor without inventing new times.
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

const offsetFormatterCache = new Map<TimeZone, Intl.DateTimeFormat>();

function offsetFormatter(tz: TimeZone): Intl.DateTimeFormat {
  let f = offsetFormatterCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    offsetFormatterCache.set(tz, f);
  }
  return f;
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

interface Parts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** Wall-clock components of `instant` as observed in `tz`. */
export function partsInZone(instant: Date, tz: TimeZone): Parts {
  const parts = offsetFormatter(tz).formatToParts(instant);
  const get = (type: string): number => {
    const p = parts.find((x) => x.type === type);
    return p ? Number(p.value) : 0;
  };
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second'),
  };
}

/** UTC offset of `tz` at `instant`, in milliseconds (east of UTC is positive). */
export function zoneOffsetMs(instant: Date, tz: TimeZone): number {
  const p = partsInZone(instant, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  // Discard sub-second noise: formatToParts has second precision.
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/**
 * Convert a wall-clock date+time in `tz` to the corresponding UTC instant.
 *
 * DST corner cases:
 *  - Ambiguous (clocks went back, the time happens twice): the FIRST
 *    occurrence is chosen, so a dose is never delayed by an hour.
 *  - Nonexistent (clocks went forward, the time is skipped): the instant
 *    lands just after the transition, so the reminder still fires that day.
 */
export function zonedWallTimeToUtc(date: LocalDate, time: LocalTime, tz: TimeZone): Date {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const [hh, mm] = time.split(':').map(Number) as [number, number];
  const naiveUtc = Date.UTC(y, m - 1, d, hh, mm, 0, 0);

  // First approximation using the offset in effect at the naive instant.
  let guess = naiveUtc - zoneOffsetMs(new Date(naiveUtc), tz);
  // Re-evaluate with the offset actually in effect at the guess.
  const refinedOffset = zoneOffsetMs(new Date(guess), tz);
  const refined = naiveUtc - refinedOffset;

  if (refined !== guess) {
    // Offsets disagree: we are near a transition. Prefer whichever candidate
    // actually round-trips back to the requested wall clock.
    const roundTrips = (candidate: number): boolean => {
      const p = partsInZone(new Date(candidate), tz);
      return p.year === y && p.month === m && p.day === d && p.hour === hh && p.minute === mm;
    };
    if (roundTrips(refined)) guess = refined;
    else if (roundTrips(guess)) {
      /* keep guess — ambiguous time, earlier occurrence wins */
    } else {
      // Nonexistent local time (spring forward). Take the later of the two,
      // which lands immediately after the gap.
      guess = Math.max(guess, refined);
    }
  }
  return new Date(guess);
}

/** Wall-clock calendar date observed in `tz` at `instant`. */
export function localDateInZone(instant: Date, tz: TimeZone): LocalDate {
  const p = partsInZone(instant, tz);
  return `${pad4(p.year)}-${pad2(p.month)}-${pad2(p.day)}`;
}

/** Wall-clock HH:mm observed in `tz` at `instant`. */
export function localTimeInZone(instant: Date, tz: TimeZone): LocalTime {
  const p = partsInZone(instant, tz);
  return `${pad2(p.hour)}:${pad2(p.minute)}`;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}
function pad4(n: number): string {
  return String(n).padStart(4, '0');
}

/** Add whole days to a calendar date without ever touching a timezone. */
export function addDays(date: LocalDate, days: number): LocalDate {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const t = Date.UTC(y, m - 1, d) + days * DAY_MS;
  const dt = new Date(t);
  return `${pad4(dt.getUTCFullYear())}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
}

/** Whole days from `a` to `b` (b - a). Both are calendar dates. */
export function daysBetween(a: LocalDate, b: LocalDate): number {
  const [ay, am, ad] = a.split('-').map(Number) as [number, number, number];
  const [by, bm, bd] = b.split('-').map(Number) as [number, number, number];
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / DAY_MS);
}

/** 0 = Sunday … 6 = Saturday, matching the Saudi week convention used in rules. */
export function weekdayOf(date: LocalDate): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function compareDates(a: LocalDate, b: LocalDate): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function minutesToMs(minutes: number): number {
  return minutes * MINUTE_MS;
}
export function hoursToMs(hours: number): number {
  return hours * HOUR_MS;
}

export function toInstant(d: Date): Instant {
  return d.toISOString();
}

/** Minutes since midnight for an HH:mm string. */
export function timeToMinutes(time: LocalTime): number {
  const [hh, mm] = time.split(':').map(Number) as [number, number];
  return hh * 60 + mm;
}

export function minutesToTime(total: number): LocalTime {
  const norm = ((total % 1440) + 1440) % 1440;
  return `${pad2(Math.floor(norm / 60))}:${pad2(norm % 60)}`;
}

/**
 * True when `time` falls inside a quiet-hours window, which may wrap past
 * midnight (e.g. 22:00 → 07:00).
 */
export function isWithinQuietHours(time: LocalTime, start: LocalTime | null, end: LocalTime | null): boolean {
  if (!start || !end) return false;
  const t = timeToMinutes(time);
  const s = timeToMinutes(start);
  const e = timeToMinutes(end);
  if (s === e) return false;
  return s < e ? t >= s && t < e : t >= s || t < e;
}

/** Inclusive list of calendar dates from `from` to `to`. Guards against runaway ranges. */
export function eachDate(from: LocalDate, to: LocalDate, maxDays = 400): LocalDate[] {
  const span = daysBetween(from, to);
  if (span < 0) return [];
  if (span + 1 > maxDays) {
    throw new RangeError(`date range of ${span + 1} days exceeds the ${maxDays} day limit`);
  }
  const out: LocalDate[] = [];
  for (let i = 0; i <= span; i++) out.push(addDays(from, i));
  return out;
}
