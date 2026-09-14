import type { CaregiverNotificationSelection } from './caregiver-navigation';

/** A single process-local handoff. Never put it in a URL, storage or telemetry. */
export interface CaregiverNotificationIntent extends CaregiverNotificationSelection {
  readonly userId: string;
  readonly revision: number;
}

let owner: string | null = null;
let revision = 0;
let intent: CaregiverNotificationIntent | null = null;
const subscribers = new Set<() => void>();

/** Called synchronously by Shell before account-scoped children render.
 * Do not notify React subscribers from another component's render. The app
 * context change already rerenders them, and the snapshot is invalid now. */
export function bindCaregiverNotificationAccount(userId: string | null): void {
  if (owner === userId) return;
  owner = userId;
  revision++;
  intent = null;
}

export function setCaregiverNotificationIntent(
  userId: string,
  selection: CaregiverNotificationSelection,
): void {
  if (owner !== userId) return;
  intent = Object.freeze({ userId, deliveryId: selection.deliveryId, kind: selection.kind, revision: ++revision });
  for (const notify of subscribers) notify();
}

export function getCaregiverNotificationIntent(): CaregiverNotificationIntent | null {
  return intent;
}

export function isCaregiverNotificationIntentCurrent(value: CaregiverNotificationIntent): boolean {
  return intent === value && owner === value.userId;
}

/** Compare before clearing: an old screen's cleanup must preserve a newer tap. */
export function clearCaregiverNotificationIntent(value: CaregiverNotificationIntent | null): void {
  if (value === null || intent !== value) return;
  intent = null;
  for (const notify of subscribers) notify();
}

export function subscribeCaregiverNotificationIntent(notify: () => void): () => void {
  subscribers.add(notify);
  return () => { subscribers.delete(notify); };
}
