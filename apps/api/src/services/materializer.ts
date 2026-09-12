import type { PoolClient } from 'pg';
import type { MedicationSchedule, ScheduleRule } from '@dawaee/shared';
import { expandSchedule, type PlannedOccurrence } from '@dawaee/core';

/**
 * Turns schedule rules into concrete dose rows.
 *
 * Occurrences are materialized rather than computed on the fly because a dose
 * needs identity: it accumulates a notification history, an escalation stage,
 * a confirmation and a stock movement. A purely computed view could not carry
 * any of that.
 *
 * The horizon is deliberately short. Generating months ahead would mean a
 * schedule edit had to rewrite a huge tail of rows; generating a rolling
 * window keeps edits cheap and keeps the table small.
 */
export const MATERIALIZE_HORIZON_DAYS = 14;
/** Devices cache this far ahead so offline reminders survive a flat network. */
export const CLIENT_PREFETCH_DAYS = 7;

export interface MaterializeResult {
  scheduleId: string;
  created: number;
  horizonEnd: Date;
}

/**
 * Serializes every transaction that can change a medication's actionable dose
 * lifecycle. The key is deterministic per medication. A theoretical hash
 * collision can only serialize two unrelated medications; it cannot let two
 * operations for the same medication run concurrently, so the safety property
 * is preserved.
 *
 * We intentionally use a transaction advisory lock instead of SELECT ... FOR
 * SHARE on medications. The latter participates in PostgreSQL's UPDATE
 * privilege / row-security semantics and caused a proven least-privilege
 * regression: a caregiver with the exact grants required to add a medication,
 * view it, and edit/view its schedule could create the medication and schedule
 * but materialization then saw no lockable medication row and returned zero
 * doses unless edit_medication was also granted. That permission is unrelated
 * to schedule creation and must not be smuggled in as a hidden dependency.
 */
export async function lockMedicationLifecycle(tx: PoolClient, medicationId: string): Promise<void> {
  await tx.query(
    'SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0::bigint))',
    [medicationId],
  );
}

export function scheduleFromRow(row: {
  id: string; medication_id: string; patient_profile_id: string; rule: ScheduleRule; rule_kind: string;
  dose_quantity: string | number; dose_unit: string; timezone: string; start_date: string;
  end_date: string | null; missed_after_minutes: number; late_after_minutes: number; active: boolean;
  created_by?: string;
}): MedicationSchedule {
  return {
    id: row.id,
    medicationId: row.medication_id,
    patientProfileId: row.patient_profile_id,
    rule: row.rule,
    ruleKind: row.rule_kind as MedicationSchedule['ruleKind'],
    doseQuantity: Number(row.dose_quantity),
    doseUnit: row.dose_unit as MedicationSchedule['doseUnit'],
    timezone: row.timezone,
    startDate: row.start_date,
    endDate: row.end_date,
    missedAfterMinutes: row.missed_after_minutes,
    lateAfterMinutes: row.late_after_minutes,
    active: row.active,
    createdBy: row.created_by ?? '',
    createdAt: '',
    updatedAt: '',
  };
}

/**
 * Generate any missing occurrences for one schedule up to the horizon.
 *
 * Idempotent by construction: the unique index on (schedule_id, scheduled_at)
 * plus ON CONFLICT DO NOTHING means running this every minute, or twice
 * concurrently, produces exactly the same rows.
 */
export async function materializeSchedule(
  tx: PoolClient,
  schedule: MedicationSchedule,
  now: Date,
  horizonDays = MATERIALIZE_HORIZON_DAYS,
): Promise<MaterializeResult> {
  const horizonEnd = new Date(now.getTime() + horizonDays * 86_400_000);

  if (!schedule.active || schedule.rule.kind === 'as_needed') {
    await tx.query('UPDATE medication_schedules SET materialized_through = $2 WHERE id = $1', [
      schedule.id, horizonEnd,
    ]);
    return { scheduleId: schedule.id, created: 0, horizonEnd };
  }

  /**
   * Medication status is authoritative for whether a schedule may create an
   * actionable occurrence. The lifecycle advisory lock is also taken by every
   * medication status/archive path and by rematerialization before it touches
   * existing dose rows. Therefore the status read and occurrence inserts are
   * one serialized lifecycle operation:
   *
   * - if pause/completion/archive wins, this waits and then sees inactive;
   * - if materialization wins, the status transition waits, then cancels the
   *   newly created future doses before it commits.
   */
  await lockMedicationLifecycle(tx, schedule.medicationId);
  const { rows: medicationRows } = await tx.query<{ status: string }>(
    'SELECT status::text AS status FROM medications WHERE id = $1',
    [schedule.medicationId],
  );
  if (medicationRows[0]?.status !== 'active') {
    await tx.query('UPDATE medication_schedules SET materialized_through = $2 WHERE id = $1', [
      schedule.id, horizonEnd,
    ]);
    return { scheduleId: schedule.id, created: 0, horizonEnd };
  }

  // Start from a little before now so a dose whose window is still open but
  // which was never materialized (e.g. worker downtime) still gets created.
  const from = new Date(now.getTime() - 6 * 3_600_000);
  const planned = expandSchedule(schedule, { from, to: horizonEnd });
  const created = planned.length ? await insertOccurrences(tx, planned) : 0;

  await tx.query('UPDATE medication_schedules SET materialized_through = $2 WHERE id = $1', [
    schedule.id, horizonEnd,
  ]);
  return { scheduleId: schedule.id, created, horizonEnd };
}

async function insertOccurrences(tx: PoolClient, planned: PlannedOccurrence[]): Promise<number> {
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO dose_occurrences
       (schedule_id, medication_id, patient_profile_id, scheduled_at, scheduled_local_date,
        scheduled_local_time, scheduled_timezone, dose_quantity, dose_unit, status)
     SELECT * FROM unnest(
       $1::uuid[], $2::uuid[], $3::uuid[], $4::timestamptz[], $5::date[],
       $6::time[], $7::text[], $8::numeric[], $9::dose_unit[], $10::dose_status[])
     ON CONFLICT (schedule_id, scheduled_at) DO NOTHING
     RETURNING id`,
    [
      planned.map((p) => p.scheduleId),
      planned.map((p) => p.medicationId),
      planned.map((p) => p.patientProfileId),
      planned.map((p) => p.scheduledAt.toISOString()),
      planned.map((p) => p.scheduledLocalDate),
      planned.map((p) => p.scheduledLocalTime),
      planned.map((p) => p.scheduledTimezone),
      planned.map((p) => p.doseQuantity),
      planned.map((p) => p.doseUnit),
      planned.map(() => 'upcoming'),
    ],
  );
  return rows.length;
}

/**
 * Re-materialize after a schedule change.
 *
 * Only FUTURE, untouched doses are removed. A dose the patient already acted
 * on is history and must survive an edit — deleting it would silently rewrite
 * the adherence record.
 */
export async function rematerializeSchedule(
  tx: PoolClient,
  schedule: MedicationSchedule,
  now: Date,
): Promise<{ removed: number; created: number }> {
  // Lock before deleting dose rows. Taking this after the DELETE would allow a
  // deadlock with a concurrent status transition that owns the lifecycle lock
  // and is waiting to cancel the same dose rows.
  await lockMedicationLifecycle(tx, schedule.medicationId);
  const { rowCount: removed } = await tx.query(
    `DELETE FROM dose_occurrences
      WHERE schedule_id = $1
        AND scheduled_at > $2
        AND status IN ('upcoming','due','pending_confirmation','snoozed')
        AND confirmed_at IS NULL
        AND notified_at IS NULL`,
    [schedule.id, now],
  );
  const { created } = await materializeSchedule(tx, schedule, now);
  return { removed: removed ?? 0, created };
}

/** Cancels future doses when a medication is paused, completed or archived. */
export async function cancelFutureDoses(tx: PoolClient, medicationId: string, now: Date): Promise<number> {
  // A status transition calls this before its transaction can commit. Taking
  // the same lifecycle lock as materialization means either materialization
  // finishes first and these rows are cancelled, or the transition commits
  // first and the materializer observes the inactive status.
  await lockMedicationLifecycle(tx, medicationId);
  const { rowCount } = await tx.query(
    `UPDATE dose_occurrences
        SET status = 'cancelled', snoozed_until = NULL
      WHERE medication_id = $1
        AND scheduled_at > $2
        AND status IN ('upcoming','due','pending_confirmation','snoozed')`,
    [medicationId, now],
  );
  return rowCount ?? 0;
}

/**
 * Restores doses that were cancelled when a medication was paused.
 *
 * Materialization alone cannot do this: the cancelled rows still occupy their
 * (schedule_id, scheduled_at) slots, so `ON CONFLICT DO NOTHING` skips them and
 * a resumed medication would silently never remind anyone again. Only FUTURE,
 * untouched doses from schedules that are still active are revived — a dose
 * from a deliberately stopped schedule stays cancelled, and a dose that was
 * already answered keeps its recorded status.
 */
export async function reviveCancelledDoses(tx: PoolClient, medicationId: string, now: Date): Promise<number> {
  // Activation and top-up are one lifecycle operation. The later call to
  // materializeSchedule is re-entrant on the same transaction advisory lock.
  await lockMedicationLifecycle(tx, medicationId);
  const { rowCount } = await tx.query(
    `UPDATE dose_occurrences d
        SET status = 'upcoming', snoozed_until = NULL, notified_at = NULL,
            escalation_stage = 0, escalation_completed_at = NULL
       FROM medication_schedules s
      WHERE d.schedule_id = s.id
        AND s.active
        AND d.medication_id = $1
        AND d.scheduled_at > $2
        AND d.status = 'cancelled'
        AND d.confirmed_at IS NULL`,
    [medicationId, now],
  );
  return rowCount ?? 0;
}

/** Loads every schedule that needs topping up. Used by the worker each tick. */
export async function loadSchedulesNeedingMaterialization(
  tx: PoolClient,
  now: Date,
  limit = 500,
): Promise<MedicationSchedule[]> {
  const threshold = new Date(now.getTime() + (MATERIALIZE_HORIZON_DAYS - 3) * 86_400_000);
  const { rows } = await tx.query(
    /**
     * `s.end_date` is a patient-local calendar date, so it is compared against
     * the schedule's OWN local date derived from the caller's instant — not
     * `current_date`, which is the date in the database session's zone
     * (`Etc/UTC` everywhere here).
     *
     * For a schedule west of UTC the UTC date rolls over first, so
     * `end_date >= current_date` goes false while the patient is still on the
     * final day. This filter is what decides whether a schedule gets topped up,
     * so a schedule dropped here stops being materialized with the last day's
     * doses possibly not yet generated.
     *
     * Using `now` rather than the database clock also removes the second
     * dependency: two sources of "today" that can disagree under clock skew, in
     * a job whose other half already works from `now`.
     */
    `SELECT s.id, s.medication_id, s.patient_profile_id, s.rule, s.rule_kind::text AS rule_kind,
            s.dose_quantity, s.dose_unit::text AS dose_unit, s.timezone, s.start_date, s.end_date,
            s.missed_after_minutes, s.late_after_minutes, s.active, s.created_by
       FROM medication_schedules s
       JOIN medications m ON m.id = s.medication_id
      WHERE s.active
        AND s.rule_kind <> 'as_needed'
        AND m.status = 'active'
        AND (s.end_date IS NULL OR s.end_date >= ($3::timestamptz AT TIME ZONE s.timezone)::date)
        AND (s.materialized_through IS NULL OR s.materialized_through < $1)
      ORDER BY s.materialized_through NULLS FIRST
      LIMIT $2`,
    [threshold, limit, now],
  );
  return rows.map(scheduleFromRow);
}
