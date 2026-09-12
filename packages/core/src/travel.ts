import { timezone, type LocalDate, type MedicationSchedule, type TimeZone, type UUID } from '@dawaee/shared';
import { localDateInZone, zonedWallTimeToUtc } from './time.js';

/**
 * Travel mode.
 *
 * The one rule that matters: medication times are NEVER moved silently. When
 * the device timezone stops matching the schedule timezone we surface a
 * decision and act only on the patient's answer.
 */

export interface TimezoneChangeDetection {
  changed: boolean;
  from: TimeZone;
  to: TimeZone;
  /** Hours the wall clock would shift if converted. Signed, e.g. -3. */
  offsetShiftHours: number;
}

export function detectTimezoneChange(scheduleTz: TimeZone, deviceTz: TimeZone, at: Date): TimezoneChangeDetection {
  // Device timezone is caller-controlled at the API boundary. Validate it with
  // the same IANA contract used by profile writes before Intl sees it; Intl
  // throws RangeError for unknown zones, which otherwise becomes a misleading
  // 500 instead of the existing validation_failed response.
  const validatedDeviceTz = timezone.parse(deviceTz);
  if (scheduleTz === validatedDeviceTz) {
    return { changed: false, from: scheduleTz, to: validatedDeviceTz, offsetShiftHours: 0 };
  }
  const probe = localDateInZone(at, scheduleTz) as LocalDate;
  const inSchedule = zonedWallTimeToUtc(probe, '12:00', scheduleTz).getTime();
  const inDevice = zonedWallTimeToUtc(probe, '12:00', validatedDeviceTz).getTime();
  return {
    changed: true,
    from: scheduleTz,
    to: validatedDeviceTz,
    offsetShiftHours: Number(((inSchedule - inDevice) / 3_600_000).toFixed(2)),
  };
}

export interface TravelPlan {
  scheduleId: UUID;
  /** The timezone the schedule should carry after the decision is applied. */
  newTimezone: TimeZone;
  /** True when future occurrences must be regenerated. */
  regenerate: boolean;
  /** Preview of how the first day shifts, for the confirmation screen. */
  preview: Array<{ was: string; becomes: string }>;
}

/**
 * `keep_home_time` keeps the schedule's authored timezone: 08:00 Riyadh stays
 * 08:00 Riyadh, which the traveller experiences as a different local hour.
 * `follow_local_time` re-anchors the same wall-clock numbers to the new zone.
 */
export function planTravelDecision(
  schedule: Pick<MedicationSchedule, 'id' | 'timezone' | 'rule'>,
  homeTimezone: TimeZone,
  deviceTimezone: TimeZone,
  decision: 'keep_home_time' | 'follow_local_time',
  at: Date,
): TravelPlan {
  const newTimezone = decision === 'keep_home_time' ? homeTimezone : deviceTimezone;
  const times = extractTimes(schedule.rule);
  const date = localDateInZone(at, schedule.timezone) as LocalDate;

  const preview = times.map((time) => {
    const currentInstant = zonedWallTimeToUtc(date, time, schedule.timezone);
    const newInstant = zonedWallTimeToUtc(date, time, newTimezone);
    return {
      was: currentInstant.toISOString(),
      becomes: newInstant.toISOString(),
    };
  });

  return {
    scheduleId: schedule.id,
    newTimezone,
    regenerate: newTimezone !== schedule.timezone,
    preview,
  };
}

function extractTimes(rule: MedicationSchedule['rule']): string[] {
  switch (rule.kind) {
    case 'fixed_times':
    case 'days_of_week':
    case 'cycle':
      return rule.times;
    case 'interval':
      return [rule.anchorTime];
    case 'as_needed':
      return [];
    default:
      return [];
  }
}
