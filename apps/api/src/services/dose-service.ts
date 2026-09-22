import type { PoolClient } from 'pg';
import { AppError, ERROR_CODES, type ConfirmationMethod, type DoseStatus } from '@dawaee/shared';
import { confirmTaken, DEFAULT_THRESHOLDS, deriveStatus, skip as skipDose, snooze } from '@dawaee/core';
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
  confirmed_received_at: Date | null;
  snooze_count: number;
  dose_quantity: string;
  dose_unit: string;
  late_after_minutes: number;
  missed_after_minutes: number;
  client_event_id: string | null;
}

const DOSE_SELECT = `
  SELECT d.id, d.medication_id, d.patient_profile_id, d.scheduled_at, d.status, d.snoozed_until,
         d.notified_at, d.confirmed_at, d.confirmed_received_at, d.snooze_count, d.dose_quantity, d.dose_unit::text AS dose_unit,
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
 * The append-only event trail keeps every applied identity so
 * an old action remains a replay even after undo clears/replaces occurrence
 * state. Its bounded eligibility helper works even when the caller cannot read
 * history. Replay is scoped to the dose and authenticated actor; the database
 * uniqueness boundary remains per patient as established by migration 0019.
 */
async function findByClientEvent(
  tx: PoolClient, doseId: string, clientEventId: string,
): Promise<{ id: string; status: DoseStatus } | null> {
  const { rows } = await tx.query<{ id: string; status: DoseStatus }>(
    `SELECT d.id, d.status
       FROM dose_occurrences d
      WHERE d.id = $1
        AND app.dose_action_order(d.id, $2, NULL) = 'replay'`,
    [doseId, clientEventId],
  );
  return rows[0] ?? null;
}

async function requireCurrentAction(
  tx: PoolClient, doseId: string, clientEventId: string, actionAt: Date,
): Promise<void> {
  const { rows } = await tx.query<{ action_order: string }>(
    'SELECT app.dose_action_order($1, $2, $3) AS action_order', [doseId, clientEventId, actionAt],
  );
  if (rows[0]?.action_order !== 'new') {
    throw new AppError(ERROR_CODES.DOSE_NOT_ACTIONABLE, 422,
      'A newer action has already been recorded for this dose. Refresh its current state.');
  }
}

/**
 * Read only the identity allocated by this transaction's authorized INSERT.
 * INSERT ... RETURNING also requires SELECT under RLS, which confirm-only
 * caregivers intentionally lack on the historical event table.
 */
async function insertedEventId(tx: PoolClient): Promise<string> {
  const { rows } = await tx.query<{ id: string }>(
    "SELECT currval('public.dose_events_id_seq'::regclass)::text AS id",
  );
  return rows[0]!.id;
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
  // Serialize before replay lookup: a concurrent identical request may have
  // committed while this transaction waited for the occurrence lock.
  const dose = await loadDoseForUpdate(tx, input.doseId);
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
  await requireCurrentAction(tx, dose.id, input.clientEventId, result.confirmedAt);

  await tx.query(
    `UPDATE dose_occurrences
        SET status = $2::dose_status, confirmed_at = $3, confirmed_by_user_id = $4,
            confirmation_method = $5::confirmation_method, confirmation_device_id = $6,
            client_event_id = $7, confirmed_received_at = $8, snoozed_until = NULL,
            escalation_completed_at = COALESCE(escalation_completed_at, now())
      WHERE id = $1`,
    [dose.id, result.status, result.confirmedAt, input.userId, input.method, input.deviceId ?? null, input.clientEventId, input.now],
  );

  await tx.query(
    `INSERT INTO dose_events
       (dose_occurrence_id, patient_profile_id, type, at, actor_user_id, method, device_id, metadata, client_event_id)
     VALUES ($1,$2,'taken',$3,$4,$5::confirmation_method,$6,$7,$8)`,
    [
      dose.id, dose.patient_profile_id, result.confirmedAt, input.userId, input.method,
      input.deviceId ?? null,
      JSON.stringify({ stockLedgerVersion: 1, minutesLate: result.minutesLate, actorRole: input.actorRole, ...(input.voiceConfidence ? { voiceConfidence: input.voiceConfidence } : {}) }),
      input.clientEventId,
    ],
  );

  const stock = await applyStockForDose(tx, dose, await insertedEventId(tx));

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
  doseEventId: string,
): Promise<{ remainingQuantity: number; clamped: boolean } | null> {
  const { rows } = await tx.query<{ remaining_quantity: string; clamped: boolean }>(
    'SELECT remaining_quantity, clamped FROM app.apply_dose_stock_event($1, $2)',
    [dose.id, doseEventId],
  );
  return rows[0] ? { remainingQuantity: Number(rows[0].remaining_quantity), clamped: rows[0].clamped } : null;
}

export async function snoozeDose(
  tx: PoolClient,
  input: { doseId: string; userId: string; actorRole?: 'patient' | 'caregiver'; minutes: number; actionAt?: string; clientEventId: string; deviceId?: string; now: Date; requestId?: string; ipHash?: string | null },
) {
  // Serialize before replay lookup: a concurrent identical request may have
  // committed while this transaction waited for the occurrence lock.
  const dose = await loadDoseForUpdate(tx, input.doseId);
  const existing = await findByClientEvent(tx, input.doseId, input.clientEventId);
  if (existing) {
    const { rows } = await tx.query<{ snoozed_until: Date | null; snooze_count: number }>(
      'SELECT snoozed_until, snooze_count FROM dose_occurrences WHERE id = $1', [existing.id],
    );
    return {
      doseId: existing.id,
      status: existing.status,
      snoozedUntil: rows[0]?.snoozed_until?.toISOString() ?? null,
      snoozeCount: rows[0]?.snooze_count ?? 0,
      idempotentReplay: true,
    };
  }

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
    { actionAt: input.actionAt ? new Date(input.actionAt) : undefined, missedAfterMinutes: dose.missed_after_minutes },
  );
  await requireCurrentAction(tx, dose.id, input.clientEventId, input.actionAt ? new Date(input.actionAt) : input.now);

  await tx.query(
    `UPDATE dose_occurrences SET status = 'snoozed', snoozed_until = $2, snooze_count = $3, client_event_id = $4
      WHERE id = $1`,
    [dose.id, result.snoozedUntil, result.snoozeCount, input.clientEventId],
  );
  await tx.query(
    `INSERT INTO dose_events
       (dose_occurrence_id, patient_profile_id, type, actor_user_id, device_id, metadata, client_event_id, at)
     VALUES ($1,$2,'snoozed',$3,$4,$5,$6,$7)`,
    [dose.id, dose.patient_profile_id, input.userId, input.deviceId ?? null,
     JSON.stringify({ minutes: input.minutes, snoozeCount: result.snoozeCount,
       snoozedUntil: result.snoozedUntil.toISOString(), actorRole: input.actorRole ?? 'patient' }),
     input.clientEventId, input.actionAt ?? input.now],
  );
  await recordAudit(tx, {
    actorUserId: input.userId, patientProfileId: dose.patient_profile_id, action: 'dose.snoozed',
    actorRole: input.actorRole,
    entityType: 'dose_occurrence', entityId: dose.id, requestId: input.requestId, ipHash: input.ipHash,
    newValue: { minutes: input.minutes, snoozedUntil: result.snoozedUntil.toISOString() },
  });

  return {
    doseId: dose.id,
    status: 'snoozed' as const,
    snoozedUntil: result.snoozedUntil.toISOString(),
    snoozeCount: result.snoozeCount,
    idempotentReplay: false,
  };
}

export async function skipDoseAction(
  tx: PoolClient,
  input: { doseId: string; userId: string; actorRole?: 'patient' | 'caregiver'; actionAt?: string; reason?: string | null; clientEventId: string; deviceId?: string; now: Date; requestId?: string; ipHash?: string | null },
) {
  // Serialize before replay lookup: a concurrent identical request may have
  // committed while this transaction waited for the occurrence lock.
  const dose = await loadDoseForUpdate(tx, input.doseId);
  const existing = await findByClientEvent(tx, input.doseId, input.clientEventId);
  if (existing) return { doseId: existing.id, status: existing.status, idempotentReplay: true };

  const thresholds = { lateAfterMinutes: dose.late_after_minutes, missedAfterMinutes: dose.missed_after_minutes };
  const effectiveStatus = deriveStatus(
    { status: dose.status, scheduledAt: dose.scheduled_at.toISOString(), snoozedUntil: dose.snoozed_until?.toISOString() ?? null, notifiedAt: dose.notified_at?.toISOString() ?? null },
    input.now,
    thresholds,
  );
  const actionAt = input.actionAt ? new Date(input.actionAt) : input.now;
  skipDose(
    { status: effectiveStatus, scheduledAt: dose.scheduled_at.toISOString() },
    actionAt,
  );
  if (!Number.isFinite(actionAt.getTime()) || actionAt > input.now ||
    actionAt.getTime() > dose.scheduled_at.getTime() + DEFAULT_THRESHOLDS.lateConfirmationWindowMinutes * 60_000) {
    throw new AppError(ERROR_CODES.DOSE_NOT_ACTIONABLE, 422,
      'The action time must be within this dose’s recording window and not ahead of the server.');
  }
  await requireCurrentAction(tx, dose.id, input.clientEventId, actionAt);

  await tx.query(
    `UPDATE dose_occurrences
        SET status = 'skipped', confirmed_at = $2, confirmed_by_user_id = $3,
            client_event_id = $4, confirmed_received_at = $5, snoozed_until = NULL,
            escalation_completed_at = COALESCE(escalation_completed_at, now())
      WHERE id = $1`,
    [dose.id, actionAt, input.userId, input.clientEventId, input.now],
  );
  await tx.query(
    `INSERT INTO dose_events
       (dose_occurrence_id, patient_profile_id, type, actor_user_id, device_id, metadata, client_event_id, at)
     VALUES ($1,$2,'skipped',$3,$4,$5,$6,$7)`,
    [dose.id, dose.patient_profile_id, input.userId, input.deviceId ?? null,
     JSON.stringify({ reason: input.reason ?? null, actorRole: input.actorRole ?? 'patient' }), input.clientEventId, actionAt],
  );
  await recordAudit(tx, {
    actorUserId: input.userId, patientProfileId: dose.patient_profile_id, action: 'dose.skipped',
    actorRole: input.actorRole,
    entityType: 'dose_occurrence', entityId: dose.id, requestId: input.requestId, ipHash: input.ipHash,
    previousValue: { status: effectiveStatus }, newValue: { status: 'skipped', actionAt: actionAt.toISOString() },
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
  input: { doseId: string; userId: string; actorRole?: 'patient' | 'caregiver'; clientEventId?: string; now: Date; requestId?: string; ipHash?: string | null },
) {
  const dose = await loadDoseForUpdate(tx, input.doseId);
  if (input.clientEventId && await findByClientEvent(tx, input.doseId, input.clientEventId)) {
    return { doseId: dose.id, status: dose.status, idempotentReplay: true };
  }
  if (!['taken', 'taken_late', 'skipped'].includes(dose.status)) {
    throw new AppError(ERROR_CODES.DOSE_NOT_ACTIONABLE, 422, 'Only a recorded dose can be undone');
  }
  const acceptedAt = dose.confirmed_received_at ?? dose.confirmed_at;
  const elapsed = acceptedAt ? input.now.getTime() - acceptedAt.getTime() : NaN;
  if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed > 10 * 60_000) {
    throw new AppError(ERROR_CODES.DOSE_NOT_ACTIONABLE, 422, 'The undo window for this dose has passed');
  }

  // Record the undo first so any stock reversal can point at the exact event
  // that caused it. Everything is in one transaction; a later failure rolls
  // the event back as well.
  await tx.query(
    `INSERT INTO dose_events (dose_occurrence_id, patient_profile_id, type, actor_user_id, metadata, client_event_id, at)
     VALUES ($1,$2,'undone',$3,$4,$5,$6)`,
    [dose.id, dose.patient_profile_id, input.userId, JSON.stringify({ previousStatus: dose.status }), input.clientEventId ?? null, input.now],
  );
  const undoEventId = await insertedEventId(tx);

  // The bounded transition reads the matching ledger without granting history
  // or manual stock editing. A skip produces no reversal.
  await tx.query('SELECT * FROM app.apply_dose_stock_event($1, $2)', [dose.id, undoEventId]);

  await tx.query(
    `UPDATE dose_occurrences
        SET status = 'upcoming', confirmed_at = NULL, confirmed_received_at = NULL, confirmed_by_user_id = NULL,
            confirmation_method = NULL, client_event_id = NULL, snoozed_until = NULL
      WHERE id = $1`,
    [dose.id],
  );
  await recordAudit(tx, {
    actorUserId: input.userId, patientProfileId: dose.patient_profile_id, action: 'dose.undone',
    actorRole: input.actorRole,
    entityType: 'dose_occurrence', entityId: dose.id, requestId: input.requestId, ipHash: input.ipHash,
    previousValue: { status: dose.status }, newValue: { status: 'upcoming' },
  });

  return { doseId: dose.id, status: 'upcoming' as const };
}
