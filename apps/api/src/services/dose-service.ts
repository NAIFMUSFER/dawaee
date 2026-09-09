import type { PoolClient } from 'pg';
import { AppError, ERROR_CODES, type ConfirmationMethod, type DoseStatus } from '@dawaee/shared';
import { applyDoseToStock, confirmTaken, deriveStatus, skip as skipDose, snooze } from '@dawaee/core';
import { recordAudit } from './audit-service.js';

/**
 * Everything that happens when a patient answers a reminder.
 *
 * Confirming a dose touches four tables — the occurrence, its event trail,
 * the stock balance and the audit log — and they must move together or not at
 * all, which is why this all lives in one transactional function rather than
 * being spread across the route handler.
 */

export interface DoseRow {
  id: string;
  medication_id: string;
  patient_profile_id: string;
  scheduled_at: Date;
  status: DoseStatus;
  snoozed_until: Date | null;
  notified_at: Date | null;
  confirmed_at: Date | null;
  snooze_count: number;
  dose_quantity: string;
  dose_unit: string;
  late_after_minutes: number;
  missed_after_minutes: number;
  client_event_id: string | null;
}

const DOSE_SELECT = `
  SELECT d.id, d.medication_id, d.patient_profile_id, d.scheduled_at, d.status, d.snoozed_until,
         d.notified_at, d.confirmed_at, d.snooze_count, d.dose_quantity, d.dose_unit::text AS dose_unit,
         d.client_event_id, s.late_after_minutes, s.missed_after_minutes
    FROM dose_occurrences d
    JOIN medication_schedules s ON s.id = d.schedule_id
   WHERE d.id = $1
   FOR UPDATE OF d`;

export async function loadDoseForUpdate(tx: PoolClient, doseId: string): Promise<DoseRow> {
  const { rows } = await tx.query<DoseRow>(DOSE_SELECT, [doseId]);
  if (!rows[0]) throw AppError.notFound('Dose not found');
  return rows[0];
}

/**
 * Idempotency for the offline queue.
 *
 * A phone that confirmed a dose while offline retries on reconnect, possibly
 * several times, possibly after the app was reinstalled. The client event id
 * identifies that one intent, so the second attempt returns the first result
 * instead of double-decrementing the medication box.
 *
 * Scoped to the dose being acted on, not searched globally. It used to match
 * on `client_event_id` alone across every patient in the database — so an id
 * that collided with a DIFFERENT dose returned that dose's status, reported
 * `idempotentReplay: true`, and left the dose actually named in the request
 * unconfirmed. The API answered 200 and the adherence record was quietly
 * wrong, which for a medication app is the worst shape a bug can take. The
 * unique index is scoped per patient in migration 0019 for the same reason.
 */
async function findByClientEvent(
  tx: PoolClient, doseId: string, clientEventId: string,
): Promise<{ id: string; status: DoseStatus } | null> {
  const { rows } = await tx.query<{ id: string; status: DoseStatus }>(
    'SELECT id, status FROM dose_occurrences WHERE id = $1 AND client_event_id = $2',
    [doseId, clientEventId],
  );
  return rows[0] ?? null;
}

export interface ConfirmDoseInput {
  doseId: string;
  userId: string;
  actorRole: 'patient' | 'caregiver';
  clientEventId: string;
  takenAt?: string;
  method: ConfirmationMethod;
  deviceId?: string;
  voiceConfidence?: number;
  note?: { tags: string[]; text?: string | null };
  now: Date;
  requestId?: string;
  ipHash?: string | null;
}

export interface ConfirmDoseResult {
  doseId: string;
  status: DoseStatus;
  confirmedAt: string;
  minutesLate: number;
  stock: { remainingQuantity: number; clamped: boolean } | null;
  idempotentReplay: boolean;
}

export async function confirmDose(tx: PoolClient, input: ConfirmDoseInput): Promise<ConfirmDoseResult> {
  const replay = await findByClientEvent(tx, input.doseId, input.clientEventId);
  if (replay) {
    const { rows } = await tx.query<{ status: DoseStatus; confirmed_at: Date | null; scheduled_at: Date }>(
      'SELECT status, confirmed_at, scheduled_at FROM dose_occurrences WHERE id = $1',
      [replay.id],
    );
    const row = rows[0]!;
    return {
      doseId: replay.id,
      status: row.status,
      confirmedAt: (row.confirmed_at ?? row.scheduled_at).toISOString(),
      minutesLate: row.confirmed_at
        ? Math.max(0, Math.round((row.confirmed_at.getTime() - row.scheduled_at.getTime()) / 60_000))
        : 0,
      stock: null,
      idempotentReplay: true,
    };
  }

  const dose = await loadDoseForUpdate(tx, input.doseId);
  const thresholds = {
    lateAfterMinutes: dose.late_after_minutes,
    missedAfterMinutes: dose.missed_after_minutes,
    lateConfirmationWindowMinutes: 24 * 60,
  };

  // Re-derive first: a row still marked 'upcoming' whose time has long passed
  // must be treated as missed, not as freshly due.
  const effectiveStatus = deriveStatus(
    { status: dose.status, scheduledAt: dose.scheduled_at.toISOString(), snoozedUntil: dose.snoozed_until?.toISOString() ?? null, notifiedAt: dose.notified_at?.toISOString() ?? null },
    input.now,
    thresholds,
  );

  const result = confirmTaken({
    occurrence: { id: dose.id, status: effectiveStatus, scheduledAt: dose.scheduled_at.toISOString() },
    at: input.takenAt ? new Date(input.takenAt) : input.now,
    now: input.now,
    thresholds,
    method: input.method,
    voiceConfidence: input.voiceConfidence,
  });

  await tx.query(
    `UPDATE dose_occurrences
        SET status = $2::dose_status, confirmed_at = $3, confirmed_by_user_id = $4,
            confirmation_method = $5::confirmation_method, confirmation_device_id = $6,
            client_event_id = $7, snoozed_until = NULL,
            escalation_completed_at = COALESCE(escalation_completed_at, now())
      WHERE id = $1`,
    [dose.id, result.status, result.confirmedAt, input.userId, input.method, input.deviceId ?? null, input.clientEventId],
  );

  const { rows: eventRows } = await tx.query<{ id: string }>(
    `INSERT INTO dose_events (dose_occurrence_id, patient_profile_id, type, at, actor_user_id, method, device_id, metadata)
     VALUES ($1,$2,'taken',$3,$4,$5::confirmation_method,$6,$7)
     RETURNING id`,
    [
      dose.id, dose.patient_profile_id, result.confirmedAt, input.userId, input.method,
      input.deviceId ?? null,
      JSON.stringify({ minutesLate: result.minutesLate, actorRole: input.actorRole, ...(input.voiceConfidence ? { voiceConfidence: input.voiceConfidence } : {}) }),
    ],
  );

  const stock = await applyStockForDose(tx, dose, input.userId, eventRows[0]!.id);

  if (input.note && (input.note.tags.length > 0 || input.note.text)) {
    // Stored verbatim. The system never interprets a symptom or links it to an
    // adverse-effect conclusion.
    await tx.query(
      `INSERT INTO symptom_notes (patient_profile_id, dose_occurrence_id, tags, text, created_by)
       VALUES ($1,$2,$3,$4,$5)`,
      [dose.patient_profile_id, dose.id, input.note.tags, input.note.text ?? null, input.userId],
    );
  }

  await recordAudit(tx, {
    actorUserId: input.userId,
    actorRole: input.actorRole,
    patientProfileId: dose.patient_profile_id,
    action: 'dose.confirmed', entityType: 'dose_occurrence', entityId: dose.id,
    requestId: input.requestId, ipHash: input.ipHash,
    previousValue: { status: effectiveStatus },
    newValue: { status: result.status, method: input.method, minutesLate: result.minutesLate },
  });

  return {
    doseId: dose.id,
    status: result.status,
    confirmedAt: result.confirmedAt.toISOString(),
    minutesLate: result.minutesLate,
    stock,
    idempotentReplay: false,
  };
}

async function applyStockForDose(
  tx: PoolClient,
  dose: DoseRow,
  userId: string,
  doseEventId: string,
): Promise<{ remainingQuantity: number; clamped: boolean } | null> {
  const { rows } = await tx.query<{ remaining_quantity: string | null; tracking_enabled: boolean }>(
    'SELECT remaining_quantity, tracking_enabled FROM medication_stock WHERE medication_id = $1 FOR UPDATE',
    [dose.medication_id],
  );
  const stockRow = rows[0];
  if (!stockRow) return null;

  const applied = applyDoseToStock(
    stockRow.remaining_quantity === null ? null : Number(stockRow.remaining_quantity),
    Number(dose.dose_quantity),
    stockRow.tracking_enabled,
  );
  if (!applied) return null;

  await tx.query('UPDATE medication_stock SET remaining_quantity = $2 WHERE medication_id = $1', [
    dose.medication_id, applied.balanceAfter,
  ]);

  // One append-only dose event causes one stock movement. Offline replay never
  // creates a second event, while a legitimate take -> undo -> take cycle does.
  // This keeps the ledger reconstructable without sacrificing idempotency.
  await tx.query(
    `INSERT INTO stock_transactions
       (medication_id, patient_profile_id, delta, reason, dose_occurrence_id, dose_event_id,
        balance_after, actor_user_id)
     VALUES ($1,$2,$3,'dose_taken',$4,$5,$6,$7)`,
    [dose.medication_id, dose.patient_profile_id, applied.delta, dose.id, doseEventId, applied.balanceAfter, userId],
  );

  return { remainingQuantity: applied.balanceAfter, clamped: applied.clamped };
}

export async function snoozeDose(
  tx: PoolClient,
  input: { doseId: string; userId: string; minutes: number; clientEventId: string; deviceId?: string; now: Date; requestId?: string; ipHash?: string | null },
) {
  const existing = await findByClientEvent(tx, input.doseId, input.clientEventId);
  if (existing) {
    const { rows } = await tx.query<{ snoozed_until: Date | null; snooze_count: number }>(
      'SELECT snoozed_until, snooze_count FROM dose_occurrences WHERE id = $1', [existing.id],
    );
    return {
      doseId: existing.id,
      snoozedUntil: rows[0]?.snoozed_until?.toISOString() ?? null,
      snoozeCount: rows[0]?.snooze_count ?? 0,
      idempotentReplay: true,
    };
  }

  const dose = await loadDoseForUpdate(tx, input.doseId);
  const thresholds = { lateAfterMinutes: dose.late_after_minutes, missedAfterMinutes: dose.missed_after_minutes };
  const effectiveStatus = deriveStatus(
    { status: dose.status, scheduledAt: dose.scheduled_at.toISOString(), snoozedUntil: dose.snoozed_until?.toISOString() ?? null, notifiedAt: dose.notified_at?.toISOString() ?? null },
    input.now,
    thresholds,
  );

  const result = snooze(
    { status: effectiveStatus, scheduledAt: dose.scheduled_at.toISOString(), snoozeCount: dose.snooze_count },
    input.minutes,
    input.now,
  );

  await tx.query(
    `UPDATE dose_occurrences SET status = 'snoozed', snoozed_until = $2, snooze_count = $3, client_event_id = $4
      WHERE id = $1`,
    [dose.id, result.snoozedUntil, result.snoozeCount, input.clientEventId],
  );
  await tx.query(
    `INSERT INTO dose_events (dose_occurrence_id, patient_profile_id, type, actor_user_id, device_id, metadata)
     VALUES ($1,$2,'snoozed',$3,$4,$5)`,
    [dose.id, dose.patient_profile_id, input.userId, input.deviceId ?? null,
     JSON.stringify({ minutes: input.minutes, snoozeCount: result.snoozeCount })],
  );
  await recordAudit(tx, {
    actorUserId: input.userId, patientProfileId: dose.patient_profile_id, action: 'dose.snoozed',
    entityType: 'dose_occurrence', entityId: dose.id, requestId: input.requestId, ipHash: input.ipHash,
    newValue: { minutes: input.minutes, snoozedUntil: result.snoozedUntil.toISOString() },
  });

  return {
    doseId: dose.id,
    snoozedUntil: result.snoozedUntil.toISOString(),
    snoozeCount: result.snoozeCount,
    idempotentReplay: false,
  };
}

export async function skipDoseAction(
  tx: PoolClient,
  input: { doseId: string; userId: string; reason?: string | null; clientEventId: string; deviceId?: string; now: Date; requestId?: string; ipHash?: string | null },
) {
  const existing = await findByClientEvent(tx, input.doseId, input.clientEventId);
  if (existing) return { doseId: existing.id, status: existing.status, idempotentReplay: true };

  const dose = await loadDoseForUpdate(tx, input.doseId);
  const thresholds = { lateAfterMinutes: dose.late_after_minutes, missedAfterMinutes: dose.missed_after_minutes };
  const effectiveStatus = deriveStatus(
    { status: dose.status, scheduledAt: dose.scheduled_at.toISOString(), snoozedUntil: dose.snoozed_until?.toISOString() ?? null, notifiedAt: dose.notified_at?.toISOString() ?? null },
    input.now,
    thresholds,
  );
  skipDose({ status: effectiveStatus });

  await tx.query(
    `UPDATE dose_occurrences
        SET status = 'skipped', confirmed_at = $2, confirmed_by_user_id = $3,
            client_event_id = $4, snoozed_until = NULL,
            escalation_completed_at = COALESCE(escalation_completed_at, now())
      WHERE id = $1`,
    [dose.id, input.now, input.userId, input.clientEventId],
  );
  await tx.query(
    `INSERT INTO dose_events (dose_occurrence_id, patient_profile_id, type, actor_user_id, device_id, metadata)
     VALUES ($1,$2,'skipped',$3,$4,$5)`,
    [dose.id, dose.patient_profile_id, input.userId, input.deviceId ?? null, JSON.stringify({ reason: input.reason ?? null })],
  );
  await recordAudit(tx, {
    actorUserId: input.userId, patientProfileId: dose.patient_profile_id, action: 'dose.skipped',
    entityType: 'dose_occurrence', entityId: dose.id, requestId: input.requestId, ipHash: input.ipHash,
    previousValue: { status: effectiveStatus }, newValue: { status: 'skipped' },
  });

  return { doseId: dose.id, status: 'skipped' as const, idempotentReplay: false };
}

/**
 * Undo a confirmation inside a short window, restoring the stock movement.
 * The original event stays in the trail — undo adds a record, it does not
 * erase one.
 */
export async function undoDose(
  tx: PoolClient,
  input: { doseId: string; userId: string; now: Date; requestId?: string; ipHash?: string | null },
) {
  const dose = await loadDoseForUpdate(tx, input.doseId);
  if (!['taken', 'taken_late', 'skipped'].includes(dose.status)) {
    throw new AppError(ERROR_CODES.DOSE_NOT_ACTIONABLE, 422, 'Only a recorded dose can be undone');
  }
  if (!dose.confirmed_at || input.now.getTime() - dose.confirmed_at.getTime() > 10 * 60_000) {
    throw new AppError(ERROR_CODES.DOSE_NOT_ACTIONABLE, 422, 'The undo window for this dose has passed');
  }

  // Record the undo first so any stock reversal can point at the exact event
  // that caused it. Everything is in one transaction; a later failure rolls
  // the event back as well.
  const { rows: undoEventRows } = await tx.query<{ id: string }>(
    `INSERT INTO dose_events (dose_occurrence_id, patient_profile_id, type, actor_user_id, metadata)
     VALUES ($1,$2,'undone',$3,$4)
     RETURNING id`,
    [dose.id, dose.patient_profile_id, input.userId, JSON.stringify({ previousStatus: dose.status })],
  );

  // The latest take movement is the one represented by the currently recorded
  // dose. Repeated take/undo cycles are legitimate, so there may be older ones.
  const { rows: txRows } = await tx.query<{ delta: string }>(
    `SELECT delta
       FROM stock_transactions
      WHERE dose_occurrence_id = $1 AND reason = 'dose_taken'
      ORDER BY created_at DESC
      LIMIT 1`,
    [dose.id],
  );
  if (txRows[0]) {
    const delta = -Number(txRows[0].delta);
    const { rows: stockRows } = await tx.query<{ remaining_quantity: string | null }>(
      'UPDATE medication_stock SET remaining_quantity = remaining_quantity + $2 WHERE medication_id = $1 RETURNING remaining_quantity',
      [dose.medication_id, delta],
    );
    await tx.query(
      `INSERT INTO stock_transactions
         (medication_id, patient_profile_id, delta, reason, dose_occurrence_id, dose_event_id,
          balance_after, actor_user_id)
       VALUES ($1,$2,$3,'dose_undone',$4,$5,$6,$7)`,
      [dose.medication_id, dose.patient_profile_id, delta, dose.id, undoEventRows[0]!.id,
       stockRows[0]?.remaining_quantity ?? null, input.userId],
    );
  }

  await tx.query(
    `UPDATE dose_occurrences
        SET status = 'upcoming', confirmed_at = NULL, confirmed_by_user_id = NULL,
            confirmation_method = NULL, client_event_id = NULL, snoozed_until = NULL
      WHERE id = $1`,
    [dose.id],
  );
  await recordAudit(tx, {
    actorUserId: input.userId, patientProfileId: dose.patient_profile_id, action: 'dose.undone',
    entityType: 'dose_occurrence', entityId: dose.id, requestId: input.requestId, ipHash: input.ipHash,
    previousValue: { status: dose.status }, newValue: { status: 'upcoming' },
  });

  return { doseId: dose.id, status: 'upcoming' as const };
}
