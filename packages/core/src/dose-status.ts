import type { ConfirmationMethod, DoseOccurrence, DoseStatus, UUID } from '@dawaee/shared';
import { AppError, ERROR_CODES, TERMINAL_DOSE_STATUSES } from '@dawaee/shared';
import { minutesToMs } from './time.js';

/**
 * The dose state machine.
 *
 * Two kinds of status exist and it matters which is which:
 *  - *Derived* statuses (upcoming / due / snoozed / missed) are a pure
 *    function of the clock. They are recomputed on read so a phone that was
 *    off for two days still shows the truth.
 *  - *Recorded* statuses (taken / taken_late / skipped / cancelled) are
 *    written once by an explicit action and never move on their own.
 */

export interface DoseThresholds {
  /** Grace period after which a dose confirmed still counts, but as late. */
  lateAfterMinutes: number;
  /** Point at which an unconfirmed dose is considered missed. */
  missedAfterMinutes: number;
  /**
   * How long after the scheduled time the patient may still record a dose.
   * Beyond this the row stays `missed` — retro-editing old history silently
   * would make adherence figures meaningless.
   */
  lateConfirmationWindowMinutes?: number;
}

export const DEFAULT_THRESHOLDS: Required<DoseThresholds> = {
  lateAfterMinutes: 15,
  missedAfterMinutes: 120,
  lateConfirmationWindowMinutes: 24 * 60,
};

/**
 * A small early-recording window for real life (a patient taking a dose just
 * before leaving home), but never hours before the scheduled occurrence.
 *
 * Production evidence during the P20 audit found four `app` confirmations
 * whose `confirmed_at` preceded `scheduled_at` by 474–1314 minutes. An older
 * UI bug had exposed tomorrow's dose as the current action, but the server
 * accepted the result because it only bounded confirmations on the late side.
 * A manipulated/offline client could do the same even after the UI was fixed.
 * The API therefore owns this invariant as well as the interface.
 */
export const EARLY_CONFIRMATION_WINDOW_MINUTES = 15;

/**
 * Statuses at which the reminder and escalation engines stop acting. `missed`
 * belongs here — nobody should be paged about it any more.
 */
export function isTerminal(status: DoseStatus): boolean {
  return TERMINAL_DOSE_STATUSES.includes(status);
}

/**
 * Statuses the *user* authored. These are final: only these block a later
 * action. `missed` is deliberately NOT one of them — it is a derived
 * observation, and a patient who took their medication but forgot to tap must
 * still be able to record it inside the late-confirmation window. Making
 * `missed` final would push people into leaving their history wrong.
 */
const RECORDED_DOSE_STATUSES: readonly DoseStatus[] = ['taken', 'taken_late', 'skipped', 'cancelled'];

export function isRecorded(status: DoseStatus): boolean {
  return RECORDED_DOSE_STATUSES.includes(status);
}

/** The status a stored occurrence should display at `now`. */
export function deriveStatus(
  occ: Pick<DoseOccurrence, 'status' | 'scheduledAt' | 'snoozedUntil' | 'notifiedAt'>,
  now: Date,
  thresholds: DoseThresholds,
): DoseStatus {
  if (isTerminal(occ.status)) return occ.status;

  const scheduled = new Date(occ.scheduledAt).getTime();
  const t = now.getTime();
  const missedAt = scheduled + minutesToMs(thresholds.missedAfterMinutes);

  if (t >= missedAt) return 'missed';

  if (occ.snoozedUntil) {
    const until = new Date(occ.snoozedUntil).getTime();
    if (t < until) return 'snoozed';
  }

  if (t < scheduled) return 'upcoming';
  return occ.notifiedAt ? 'pending_confirmation' : 'due';
}

export interface ConfirmResult {
  status: Extract<DoseStatus, 'taken' | 'taken_late'>;
  confirmedAt: Date;
  minutesLate: number;
}

/** Voice confirmations below this confidence are rejected and fall back to a tap. */
export const VOICE_CONFIDENCE_FLOOR = 0.8;

export interface ConfirmInput {
  occurrence: Pick<DoseOccurrence, 'id' | 'status' | 'scheduledAt'>;
  at: Date;
  now: Date;
  thresholds: DoseThresholds;
  method: ConfirmationMethod;
  voiceConfidence?: number;
}

/**
 * Validate and resolve a "taken" action.
 *
 * Throws rather than returning a soft failure: a dose being recorded twice,
 * or recorded far outside its window, is a correctness problem the caller
 * must surface, not paper over.
 */
export function confirmTaken(input: ConfirmInput): ConfirmResult {
  const { occurrence, at, now, thresholds, method } = input;

  if (isRecorded(occurrence.status)) {
    throw new AppError(ERROR_CODES.DOSE_ALREADY_RESOLVED, 409, `Dose already recorded as ${occurrence.status}`, {
      meta: { status: occurrence.status },
    });
  }
  if (method === 'voice' && (input.voiceConfidence ?? 0) < VOICE_CONFIDENCE_FLOOR) {
    throw new AppError(
      ERROR_CODES.VOICE_CONFIDENCE_TOO_LOW,
      422,
      'Voice confirmation confidence below the required threshold',
    );
  }

  const scheduled = new Date(occurrence.scheduledAt).getTime();
  // Never trust a client clock that is ahead of the server.
  const effective = Math.min(at.getTime(), now.getTime());

  if (effective < scheduled - minutesToMs(EARLY_CONFIRMATION_WINDOW_MINUTES)) {
    throw new AppError(
      ERROR_CODES.DOSE_NOT_ACTIONABLE,
      422,
      'This dose is too early to record. Wait until it is closer to the scheduled time.',
    );
  }

  const window = thresholds.lateConfirmationWindowMinutes ?? DEFAULT_THRESHOLDS.lateConfirmationWindowMinutes;
  if (effective > scheduled + minutesToMs(window)) {
    throw new AppError(
      ERROR_CODES.DOSE_NOT_ACTIONABLE,
      422,
      'This dose is too old to record. It remains in history as missed.',
    );
  }

  const minutesLate = Math.max(0, Math.round((effective - scheduled) / 60_000));
  return {
    status: minutesLate > thresholds.lateAfterMinutes ? 'taken_late' : 'taken',
    confirmedAt: new Date(effective),
    minutesLate,
  };
}

export interface SnoozeResult {
  snoozedUntil: Date;
  snoozeCount: number;
}

/** Snoozing is capped so a dose cannot be pushed past its missed boundary forever. */
export const MAX_SNOOZES = 5;

export function snooze(
  occ: Pick<DoseOccurrence, 'status' | 'scheduledAt' | 'snoozeCount'>,
  minutes: number,
  now: Date,
): SnoozeResult {
  if (isRecorded(occ.status)) {
    throw new AppError(ERROR_CODES.DOSE_ALREADY_RESOLVED, 409, `Dose already recorded as ${occ.status}`);
  }
  if (occ.status === 'missed') {
    // Snoozing a dose that is already past its window would only hide it.
    throw new AppError(ERROR_CODES.DOSE_NOT_ACTIONABLE, 422, 'This dose is already missed and cannot be snoozed');
  }
  if (occ.snoozeCount >= MAX_SNOOZES) {
    throw new AppError(ERROR_CODES.DOSE_NOT_ACTIONABLE, 422, 'Snooze limit reached for this dose');
  }
  return { snoozedUntil: new Date(now.getTime() + minutesToMs(minutes)), snoozeCount: occ.snoozeCount + 1 };
}

export function skip(occ: Pick<DoseOccurrence, 'status'>): { status: 'skipped' } {
  if (isRecorded(occ.status)) {
    throw new AppError(ERROR_CODES.DOSE_ALREADY_RESOLVED, 409, `Dose already recorded as ${occ.status}`);
  }
  return { status: 'skipped' };
}

/**
 * Undo is deliberately narrow: only within a short window, and it restores the
 * dose to a derived state rather than inventing one. The original event stays
 * in the audit trail.
 */
export const UNDO_WINDOW_MINUTES = 10;

export function canUndo(
  occ: Pick<DoseOccurrence, 'status' | 'confirmedAt'>,
  now: Date,
): boolean {
  if (!occ.confirmedAt) return false;
  if (!['taken', 'taken_late', 'skipped'].includes(occ.status)) return false;
  return now.getTime() - new Date(occ.confirmedAt).getTime() <= minutesToMs(UNDO_WINDOW_MINUTES);
}

/** Doses that a reminder job should act on right now. */
export function isDueForReminder(
  occ: Pick<DoseOccurrence, 'status' | 'scheduledAt' | 'snoozedUntil' | 'notifiedAt'>,
  now: Date,
  thresholds: DoseThresholds,
): boolean {
  const status = deriveStatus(occ, now, thresholds);
  if (status === 'due') return true;
  if (status === 'snoozed') return false;
  return false;
}

export interface OccurrenceView {
  id: UUID;
  status: DoseStatus;
  minutesLate: number | null;
}

export function viewOf(
  occ: Pick<DoseOccurrence, 'id' | 'status' | 'scheduledAt' | 'snoozedUntil' | 'notifiedAt' | 'confirmedAt'>,
  now: Date,
  thresholds: DoseThresholds,
): OccurrenceView {
  const status = deriveStatus(occ, now, thresholds);
  const minutesLate =
    occ.confirmedAt && (status === 'taken' || status === 'taken_late')
      ? Math.max(0, Math.round((new Date(occ.confirmedAt).getTime() - new Date(occ.scheduledAt).getTime()) / 60_000))
      : null;
  return { id: occ.id, status, minutesLate };
}
