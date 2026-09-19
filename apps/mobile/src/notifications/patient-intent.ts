/** A single process-local handoff. Never put it in a URL, storage or telemetry. */
export interface PatientReminderIntent {
  readonly doseId: string | null;
  readonly userId: string;
  readonly revision: number;
}

let owner: string | null = null;
let revision = 0;
let intent: PatientReminderIntent | null = null;
const subscribers = new Set<() => void>();

/** Called synchronously by Shell before account-scoped children render.
 * Do not notify React subscribers from another component's render. The app
 * context change already rerenders them, and the snapshot is invalid now. */
export function bindPatientReminderAccount(userId: string | null): void {
  if (owner === userId) return;
  owner = userId;
  revision++;
  intent = null;
}

export function setPatientReminderIntent(
  userId: string,
  selection: { doseId: string | null },
): void {
  if (owner !== userId) return;
  intent = Object.freeze({ userId, doseId: selection.doseId, revision: ++revision });
  for (const notify of subscribers) notify();
}

export function getPatientReminderIntent(): PatientReminderIntent | null {
  return intent;
}

export function isPatientReminderIntentCurrent(value: PatientReminderIntent): boolean {
  return intent === value && owner === value.userId;
}

/** Compare before clearing: an old screen's cleanup must preserve a newer tap. */
export function clearPatientReminderIntent(value: PatientReminderIntent | null): void {
  if (value === null || intent !== value) return;
  intent = null;
  for (const notify of subscribers) notify();
}

export function subscribePatientReminderIntent(notify: () => void): () => void {
  subscribers.add(notify);
  return () => { subscribers.delete(notify); };
}
