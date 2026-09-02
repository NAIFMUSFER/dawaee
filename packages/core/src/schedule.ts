import type {
  DoseUnit, LocalDate, LocalTime, MedicationSchedule, ScheduleRule, TimeZone, UUID,
} from '@dawaee/shared';
import {
  addDays, compareDates, daysBetween, eachDate, hoursToMs, localDateInZone, localTimeInZone,
  timeToMinutes, weekdayOf, zonedWallTimeToUtc,
} from './time.js';

/** A dose the engine says should exist. Persisted rows are built from these. */
export interface PlannedOccurrence {
  scheduleId: UUID;
  medicationId: UUID;
  patientProfileId: UUID;
  scheduledAt: Date;
  scheduledLocalDate: LocalDate;
  scheduledLocalTime: LocalTime;
  scheduledTimezone: TimeZone;
  doseQuantity: number;
  doseUnit: DoseUnit;
}

export interface ExpandWindow {
  /** Inclusive UTC lower bound. */
  from: Date;
  /** Exclusive UTC upper bound. */
  to: Date;
  /** Safety valve so a malformed rule can never generate unbounded rows. */
  maxOccurrences?: number;
}

const DEFAULT_MAX_OCCURRENCES = 2000;

/**
 * Expand a schedule into the concrete doses that fall inside a window.
 *
 * Deterministic: calling it twice for the same window yields identical
 * `scheduledAt` values, which is what makes materialization idempotent
 * (the DB carries a unique index on (schedule_id, scheduled_at)).
 *
 * `as_needed` schedules deliberately produce nothing — a PRN medication has
 * no scheduled dose to miss, so it must never appear in adherence figures.
 */
export function expandSchedule(schedule: MedicationSchedule, window: ExpandWindow): PlannedOccurrence[] {
  if (!schedule.active) return [];
  if (schedule.rule.kind === 'as_needed') return [];

  const max = window.maxOccurrences ?? DEFAULT_MAX_OCCURRENCES;
  const tz = schedule.timezone;

  // Widen the calendar scan by a day on each side: a wall-clock time near
  // midnight can land in the window even though its local date does not.
  const scanFromDate = maxDate(schedule.startDate, addDays(localDateInZone(window.from, tz), -1));
  const scanToDateRaw = addDays(localDateInZone(window.to, tz), 1);
  const scanToDate = schedule.endDate ? minDate(schedule.endDate, scanToDateRaw) : scanToDateRaw;

  if (compareDates(scanFromDate, scanToDate) > 0) return [];

  const planned =
    schedule.rule.kind === 'interval'
      ? expandInterval(schedule, schedule.rule, window, max)
      : expandCalendarRule(schedule, schedule.rule, scanFromDate, scanToDate, max);

  return planned
    .filter((o) => o.scheduledAt >= window.from && o.scheduledAt < window.to)
    .sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime())
    .slice(0, max);
}

function expandCalendarRule(
  schedule: MedicationSchedule,
  rule: Exclude<ScheduleRule, { kind: 'interval' } | { kind: 'as_needed' }>,
  fromDate: LocalDate,
  toDate: LocalDate,
  max: number,
): PlannedOccurrence[] {
  const out: PlannedOccurrence[] = [];
  const dates = eachDate(fromDate, toDate, 500);

  for (const date of dates) {
    if (compareDates(date, schedule.startDate) < 0) continue;
    if (schedule.endDate && compareDates(date, schedule.endDate) > 0) continue;

    let times: LocalTime[];
    switch (rule.kind) {
      case 'fixed_times':
        times = rule.times;
        break;
      case 'days_of_week':
        times = rule.weekdays.includes(weekdayOf(date)) ? rule.times : [];
        break;
      case 'cycle': {
        times = isCycleDayOn(date, rule.cycleAnchorDate, rule.daysOn, rule.daysOff) ? rule.times : [];
        break;
      }
      default: {
        const _exhaustive: never = rule;
        void _exhaustive;
        times = [];
      }
    }

    for (const time of dedupeSorted(times)) {
      out.push(makeOccurrence(schedule, date, time));
      if (out.length >= max * 2) return out; // hard stop; filtered/sliced by caller
    }
  }
  return out;
}

/**
 * Interval dosing steps in REAL time from the anchor instant, so "every 8
 * hours" stays 8 hours apart even across a DST change or a flight. The
 * optional active window skips doses that would land while the patient is
 * expected to be asleep.
 */
function expandInterval(
  schedule: MedicationSchedule,
  rule: Extract<ScheduleRule, { kind: 'interval' }>,
  window: ExpandWindow,
  max: number,
): PlannedOccurrence[] {
  const tz = schedule.timezone;
  const stepMs = hoursToMs(rule.everyHours);
  if (stepMs <= 0) return [];

  const anchor = zonedWallTimeToUtc(schedule.startDate, rule.anchorTime, tz);
  const endBound = schedule.endDate
    ? zonedWallTimeToUtc(addDays(schedule.endDate, 1), '00:00', tz)
    : window.to;
  const upper = new Date(Math.min(window.to.getTime(), endBound.getTime()));

  // Jump straight to the first occurrence at or after the window start.
  const stepsToWindow = Math.max(0, Math.ceil((window.from.getTime() - anchor.getTime()) / stepMs));
  let cursor = anchor.getTime() + stepsToWindow * stepMs;

  const out: PlannedOccurrence[] = [];
  let guard = 0;
  while (cursor < upper.getTime() && out.length < max && guard < max * 4) {
    guard++;
    const at = new Date(cursor);
    const localTime = localTimeInZone(at, tz);
    if (withinActiveWindow(localTime, rule.activeFrom, rule.activeUntil)) {
      out.push({
        scheduleId: schedule.id,
        medicationId: schedule.medicationId,
        patientProfileId: schedule.patientProfileId,
        scheduledAt: at,
        scheduledLocalDate: localDateInZone(at, tz),
        scheduledLocalTime: localTime,
        scheduledTimezone: tz,
        doseQuantity: schedule.doseQuantity,
        doseUnit: schedule.doseUnit,
      });
    }
    cursor += stepMs;
  }
  return out;
}

function withinActiveWindow(time: LocalTime, from?: LocalTime, until?: LocalTime): boolean {
  if (!from || !until) return true;
  const t = timeToMinutes(time);
  const f = timeToMinutes(from);
  const u = timeToMinutes(until);
  if (f === u) return true;
  return f < u ? t >= f && t < u : t >= f || t < u;
}

export function isCycleDayOn(date: LocalDate, anchor: LocalDate, daysOn: number, daysOff: number): boolean {
  const period = daysOn + daysOff;
  if (period <= 0) return false;
  const delta = daysBetween(anchor, date);
  if (delta < 0) return false;
  return delta % period < daysOn;
}

function makeOccurrence(schedule: MedicationSchedule, date: LocalDate, time: LocalTime): PlannedOccurrence {
  const at = zonedWallTimeToUtc(date, time, schedule.timezone);
  return {
    scheduleId: schedule.id,
    medicationId: schedule.medicationId,
    patientProfileId: schedule.patientProfileId,
    scheduledAt: at,
    scheduledLocalDate: date,
    scheduledLocalTime: time,
    scheduledTimezone: schedule.timezone,
    doseQuantity: schedule.doseQuantity,
    doseUnit: schedule.doseUnit,
  };
}

function dedupeSorted(times: readonly LocalTime[]): LocalTime[] {
  return [...new Set(times)].sort((a, b) => timeToMinutes(a) - timeToMinutes(b));
}

function maxDate(a: LocalDate, b: LocalDate): LocalDate {
  return compareDates(a, b) >= 0 ? a : b;
}
function minDate(a: LocalDate, b: LocalDate): LocalDate {
  return compareDates(a, b) <= 0 ? a : b;
}

/** Average number of doses per day a rule produces — drives stock forecasting. */
export function dosesPerDay(rule: ScheduleRule): number {
  switch (rule.kind) {
    case 'fixed_times':
      return new Set(rule.times).size;
    case 'days_of_week':
      return (new Set(rule.times).size * new Set(rule.weekdays).size) / 7;
    case 'cycle': {
      const period = rule.daysOn + rule.daysOff;
      return period > 0 ? (new Set(rule.times).size * rule.daysOn) / period : 0;
    }
    case 'interval': {
      const raw = 24 / rule.everyHours;
      if (!rule.activeFrom || !rule.activeUntil) return raw;
      const f = timeToMinutes(rule.activeFrom);
      const u = timeToMinutes(rule.activeUntil);
      const windowMinutes = f < u ? u - f : 1440 - f + u;
      return Math.min(raw, windowMinutes / (rule.everyHours * 60));
    }
    case 'as_needed':
      return 0;
    default: {
      const _exhaustive: never = rule;
      return _exhaustive;
    }
  }
}

/** Human-facing summary of a rule, resolved per locale by the caller. */
export function describeRule(rule: ScheduleRule): { key: string; params: Record<string, string | number> } {
  switch (rule.kind) {
    case 'fixed_times':
      return { key: 'schedule.fixedTimes', params: { times: rule.times.join(', ') } };
    case 'interval':
      return { key: 'schedule.everyHours', params: { hours: rule.everyHours } };
    case 'days_of_week':
      return { key: 'schedule.daysOfWeek', params: { days: rule.weekdays.join(','), times: rule.times.join(', ') } };
    case 'cycle':
      return { key: 'schedule.cycle', params: { on: rule.daysOn, off: rule.daysOff } };
    case 'as_needed':
      return { key: 'schedule.asNeeded', params: {} };
    default: {
      const _exhaustive: never = rule;
      return _exhaustive;
    }
  }
}
