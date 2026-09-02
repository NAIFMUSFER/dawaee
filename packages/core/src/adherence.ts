import type { AdherenceSummary, DoseOccurrence, DoseStatus, LocalDate, UUID } from '@dawaee/shared';
import { deriveStatus, type DoseThresholds } from './dose-status.js';
import { localDateInZone } from './time.js';

/**
 * Adherence analytics.
 *
 * Deliberately non-diagnostic: this counts confirmations the user made in the
 * app. It says nothing about whether medication was actually swallowed, and
 * every surface that renders these numbers must carry the disclaimer string
 * `adherence.disclaimer`.
 */

export interface AdherenceInput {
  occurrences: ReadonlyArray<
    Pick<DoseOccurrence, 'status' | 'scheduledAt' | 'snoozedUntil' | 'notifiedAt' | 'confirmedAt'>
  >;
  now: Date;
  thresholds: DoseThresholds;
  from: LocalDate;
  to: LocalDate;
}

export function summarizeAdherence(input: AdherenceInput): AdherenceSummary {
  const counts: Record<DoseStatus, number> = {
    upcoming: 0, due: 0, pending_confirmation: 0, snoozed: 0,
    taken: 0, taken_late: 0, skipped: 0, missed: 0, cancelled: 0,
  };

  for (const occ of input.occurrences) {
    counts[deriveStatus(occ, input.now, input.thresholds)] += 1;
  }

  const takenOnTime = counts.taken;
  const takenLate = counts.taken_late;
  const taken = takenOnTime + takenLate;
  const missed = counts.missed;
  const skipped = counts.skipped;
  // Doses that have not had their chance yet must not drag the number down.
  const pending = counts.upcoming + counts.due + counts.pending_confirmation + counts.snoozed;
  const scheduled = input.occurrences.length - counts.cancelled;
  const resolved = taken + missed + skipped;

  return {
    from: input.from,
    to: input.to,
    scheduled,
    taken,
    takenOnTime,
    takenLate,
    skipped,
    missed,
    pending,
    adherencePercent: resolved > 0 ? Number(((taken / resolved) * 100).toFixed(1)) : null,
  };
}

export interface DailyAdherencePoint {
  date: LocalDate;
  scheduled: number;
  taken: number;
  missed: number;
  adherencePercent: number | null;
}

export function dailyBreakdown(
  occurrences: ReadonlyArray<
    Pick<DoseOccurrence, 'status' | 'scheduledAt' | 'snoozedUntil' | 'notifiedAt' | 'confirmedAt'>
  >,
  now: Date,
  thresholds: DoseThresholds,
  timezone: string,
): DailyAdherencePoint[] {
  const byDate = new Map<LocalDate, { scheduled: number; taken: number; missed: number; resolved: number }>();

  for (const occ of occurrences) {
    const date = localDateInZone(new Date(occ.scheduledAt), timezone);
    const bucket = byDate.get(date) ?? { scheduled: 0, taken: 0, missed: 0, resolved: 0 };
    const status = deriveStatus(occ, now, thresholds);
    if (status === 'cancelled') continue;
    bucket.scheduled += 1;
    if (status === 'taken' || status === 'taken_late') {
      bucket.taken += 1;
      bucket.resolved += 1;
    } else if (status === 'missed') {
      bucket.missed += 1;
      bucket.resolved += 1;
    } else if (status === 'skipped') {
      bucket.resolved += 1;
    }
    byDate.set(date, bucket);
  }

  return [...byDate.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([date, b]) => ({
      date,
      scheduled: b.scheduled,
      taken: b.taken,
      missed: b.missed,
      adherencePercent: b.resolved > 0 ? Number(((b.taken / b.resolved) * 100).toFixed(1)) : null,
    }));
}

/**
 * Consecutive missed doses ending at the most recent resolved dose. Drives the
 * "notify after N consecutive missed" caregiver rule.
 */
export function consecutiveMissed(
  occurrences: ReadonlyArray<Pick<DoseOccurrence, 'status' | 'scheduledAt' | 'snoozedUntil' | 'notifiedAt'>>,
  now: Date,
  thresholds: DoseThresholds,
): number {
  const resolved = occurrences
    .map((o) => ({ at: new Date(o.scheduledAt).getTime(), status: deriveStatus(o, now, thresholds) }))
    .filter((o) => ['taken', 'taken_late', 'skipped', 'missed'].includes(o.status))
    .sort((a, b) => b.at - a.at);

  let streak = 0;
  for (const r of resolved) {
    if (r.status === 'missed') streak += 1;
    else break;
  }
  return streak;
}

export interface MedicationAdherenceRow {
  medicationId: UUID;
  medicationName: string;
  summary: AdherenceSummary;
}
