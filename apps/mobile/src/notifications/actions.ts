import { api, NetworkError } from '../api/client.js';
import { enqueue, newClientEventId } from '../storage/offline-queue.js';
import { getDeviceId } from '../api/client.js';

/**
 * What happens when the patient taps a button on the reminder itself.
 *
 * Nothing handled these. Three action buttons were registered on every
 * medication reminder — Taken, Remind me later, Skip — two of them declared
 * `opensAppToForeground: false`, and no listener anywhere read the response.
 * So the patient tapped "Taken" on the lock screen, the notification
 * disappeared, and the dose stayed unconfirmed: marked missed, then escalated
 * to their family. The feature did not merely fail quietly, it manufactured a
 * false alarm to the people who care about them, from the exact gesture that
 * was meant to prevent one.
 *
 * Two properties this file has to hold:
 *
 *  - It must work with the app in the background. The patient taps a button on
 *    the lock screen and never opens the app; the write has to happen from the
 *    response listener, not from a screen that may never mount.
 *  - It must survive no network. The tap is applied to the offline queue when
 *    the request fails, exactly as the Today screen does, so the confirmation
 *    is replayed later instead of lost.
 */

export const ACTION_TAKEN = 'TAKEN';
export const ACTION_SNOOZE = 'SNOOZE';
export const ACTION_SKIP = 'SKIP';

/** The default snooze when the patient taps the button rather than choosing. */
const QUICK_SNOOZE_MINUTES = 15;

export type NotificationAction = 'taken' | 'snoozed' | 'skipped';

export interface ActionOutcome {
  action: NotificationAction;
  doseId: string;
  /** True when the server accepted it; false when it went to the queue. */
  synced: boolean;
}

/**
 * Applies one notification action.
 *
 * Returns null when the notification carries no dose id — a payload shape we
 * do not recognise is not an error to report to a patient at 8pm, it is simply
 * not ours to act on.
 */
export async function applyNotificationAction(
  actionIdentifier: string,
  data: Record<string, unknown>,
): Promise<ActionOutcome | null> {
  const doseId = typeof data.doseId === 'string' ? data.doseId : null;
  if (!doseId) return null;

  const action: NotificationAction | null =
    actionIdentifier === ACTION_TAKEN ? 'taken'
      : actionIdentifier === ACTION_SNOOZE ? 'snoozed'
        : actionIdentifier === ACTION_SKIP ? 'skipped'
          : null;
  if (!action) return null;

  const clientEventId = newClientEventId();
  const at = new Date().toISOString();
  const deviceId = await getDeviceId();

  try {
    if (action === 'taken') {
      await api.post('/v1/dose/action', {
        doseId, action: 'taken', clientEventId, method: 'push_action', deviceId, takenAt: at,
      });
    } else if (action === 'skipped') {
      await api.post('/v1/dose/action', { doseId, action: 'skip', clientEventId, deviceId });
    } else {
      await api.post('/v1/dose/action', {
        doseId, action: 'snooze', minutes: QUICK_SNOOZE_MINUTES, clientEventId, deviceId,
      });
    }
    return { action, doseId, synced: true };
  } catch (err) {
    // Only a request that never reached the server is worth replaying. A
    // rejection — an already-confirmed dose, a revoked permission — is an
    // answer, and queueing it would replay a refusal forever.
    if (!(err instanceof NetworkError)) return { action, doseId, synced: false };

    await enqueue(
      action === 'taken' ? { type: 'taken', doseOccurrenceId: doseId, at, clientEventId }
        : action === 'skipped' ? { type: 'skipped', doseOccurrenceId: doseId, at, clientEventId }
          : { type: 'snoozed', doseOccurrenceId: doseId, at, clientEventId, minutes: QUICK_SNOOZE_MINUTES },
    );
    return { action, doseId, synced: false };
  }
}
