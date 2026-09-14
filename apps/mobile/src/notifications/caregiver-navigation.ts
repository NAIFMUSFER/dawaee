/** Structural Expo boundary; keeping it injectable allows tests to execute the
 * real listener without native modules, credentials, or outbound traffic. */
export interface CaregiverNotificationApi {
  DEFAULT_ACTION_IDENTIFIER: string;
  getLastNotificationResponseAsync(): Promise<unknown>;
  clearLastNotificationResponseAsync(): Promise<void>;
  addNotificationResponseReceivedListener(listener: (response: unknown) => void): { remove(): void };
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const DELIVERY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type CaregiverPushKind = 'escalation' | 'daily_summary' | 'weekly_summary';

export interface CaregiverNotificationSelection {
  deliveryId: string;
  kind: CaregiverPushKind;
}

function caregiverPushKind(value: unknown): value is CaregiverPushKind {
  return value === 'escalation' || value === 'daily_summary' || value === 'weekly_summary';
}

function caregiverResponse(response: unknown, defaultAction: string): (CaregiverNotificationSelection & { key: string }) | null {
  if (!record(response) || response.actionIdentifier !== defaultAction) return null;
  const notification = response.notification;
  if (!record(notification) || !record(notification.request)) return null;
  const { identifier, content } = notification.request;
  if (typeof identifier !== 'string' || identifier.length === 0 || identifier.length > 1024) return null;
  if (!record(content) || !record(content.data)) return null;
  const data = content.data;
  if (!caregiverPushKind(data.kind) || typeof data.deliveryId !== 'string' || !DELIVERY_ID.test(data.deliveryId)) return null;
  const date = notification.date;
  if (date !== undefined && (typeof date !== 'number' || !Number.isFinite(date))) return null;
  return { deliveryId: data.deliveryId, kind: data.kind, key: JSON.stringify([identifier, date ?? null, data.deliveryId]) };
}

/**
 * Private caregiver pushes carry deliveryId + kind, not a patient/dose id.
 * Their default tap hands only the delivery selection to a fixed route.
 * Never guess the active/first patient or turn payload fields into a URL.
 * Resolving an exact delivery to its currently-authorized patient is a separate
 * concern and must stay behind authenticated server authorization.
 *
 * The caller supplies a synchronous account-generation fence, invalidated on
 * logout/account change even before React's passive effect cleanup can run.
 */
export function startCaregiverNotificationListener(
  native: CaregiverNotificationApi,
  onOpen: (selection: CaregiverNotificationSelection) => void,
  isCurrent: () => boolean,
): () => void {
  let active = true;
  let liveResponseSeen = false;
  let revision = 0;
  const seen = new Set<string>();
  const current = () => active && isCurrent();

  const consume = async (key: string, observedRevision: number): Promise<void> => {
    if (!current() || observedRevision !== revision) return;
    try {
      const latest = await native.getLastNotificationResponseAsync();
      if (!current() || observedRevision !== revision) return;
      if (caregiverResponse(latest, native.DEFAULT_ACTION_IDENTIFIER)?.key !== key) return;
      // Do not knowingly clear a newer or unrelated dose-action response.
      // Expo does not offer an atomic compare-and-clear operation.
      await native.clearLastNotificationResponseAsync();
    } catch {
      // A native cache failure must not reject a live event or repeat its
      // navigation during this subscription. Never log payload contents.
    }
  };

  const handle = (response: unknown): void => {
    if (!current()) return;
    const selection = caregiverResponse(response, native.DEFAULT_ACTION_IDENTIFIER);
    if (selection === null) return;
    if (!seen.has(selection.key)) {
      try { onOpen({ deliveryId: selection.deliveryId, kind: selection.kind }); } catch { return; }
      seen.add(selection.key);
      // Bound native-response bookkeeping during a long-running session.
      if (seen.size > 128) seen.delete(seen.values().next().value!);
    }
    void consume(selection.key, revision);
  };

  // Register BEFORE awaiting native startup state: a tap during that lookup
  // must not fall into an interval where no caregiver listener exists.
  const subscription = native.addNotificationResponseReceivedListener((response) => {
    liveResponseSeen = true;
    revision += 1;
    handle(response);
  });
  void Promise.resolve().then(() => native.getLastNotificationResponseAsync())
    .then((response) => {
      // A stale cold-start read must not override a newer live user gesture.
      if (!liveResponseSeen) handle(response);
    })
    .catch(() => undefined);

  return () => {
    active = false;
    subscription.remove();
    seen.clear();
  };
}
