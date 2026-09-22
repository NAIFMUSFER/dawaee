import type { DoseView } from '../api/types.js';
import type { CachedSchedule, QueuedAction } from './offline-queue.js';

export function cacheDose(d: DoseView): CachedSchedule['doses'][number] {
  return { id: d.id, scheduledAt: d.scheduledAt, scheduledLocalTime: d.scheduledLocalTime,
    scheduledLocalDate: d.scheduledLocalDate, scheduledTimezone: d.scheduledTimezone,
    medicationId: d.medicationId, medicationName: d.medication.name, imageKey: d.medication.imageKey,
    medicationForm: d.medication.form, strengthValue: d.medication.strengthValue,
    strengthUnit: d.medication.strengthUnit, instructions: d.medication.instructions,
    medicationNotes: d.medication.notes ?? null, notes: d.notes ?? [],
    doseQuantity: d.doseQuantity, doseUnit: d.doseUnit, foodInstruction: d.medication.foodInstruction,
    status: d.status, snoozedUntil: d.snoozedUntil, confirmedAt: d.confirmedAt, confirmedReceivedAt: d.confirmedReceivedAt ?? null, thresholds: d.thresholds };
}

/** Keep unsent decisions visible even after a successful, older server read. */
export function applyQueuedToDoses(doses: DoseView[], queue: QueuedAction[]): DoseView[] {
  const byId = new Map(queue.map(action => [action.doseOccurrenceId, action]));
  return doses.map(dose => {
    const action = byId.get(dose.id);
    return action ? { ...dose, ...queuedPatch(action) } : dose;
  });
}

export function queuedPatch(action: QueuedAction): Pick<DoseView, 'status' | 'confirmedAt' | 'confirmedReceivedAt' | 'snoozedUntil'> {
  if (action.type === 'taken') return { status: 'taken', confirmedAt: action.at, confirmedReceivedAt: null, snoozedUntil: null };
  if (action.type === 'skipped') return { status: 'skipped', confirmedAt: action.at, confirmedReceivedAt: null, snoozedUntil: null };
  const deadline = Date.parse(action.at) + action.minutes * 60_000;
  return { status: 'snoozed', confirmedAt: null, confirmedReceivedAt: null,
    snoozedUntil: Number.isFinite(deadline) ? new Date(deadline).toISOString() : null };
}
