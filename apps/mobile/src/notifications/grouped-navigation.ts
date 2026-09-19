/** Injectable Expo response boundary: no native modules, API calls or dose
 * mutations are needed to route a grouped reminder's default tap. */
export interface GroupedNotificationApi {
  DEFAULT_ACTION_IDENTIFIER: string;
  getLastNotificationResponseAsync(): Promise<unknown>;
  clearLastNotificationResponseAsync(): Promise<void>;
  addNotificationResponseReceivedListener(listener: (response: unknown) => void): { remove(): void };
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function groupedResponseKey(response: unknown, defaultAction: string): string | null {
  if (!record(response) || response.actionIdentifier !== defaultAction) return null;
  const notification = response.notification;
  if (!record(notification) || !record(notification.request)) return null;
  const { identifier, content } = notification.request;
  if (typeof identifier !== 'string' || identifier.length === 0 || identifier.length > 1024) return null;
  if (!record(content) || !record(content.data) || !['dose_group_reminder', 'dose_reminder', 'dose_reminder_repeat'].includes(String(content.data.kind))) return null;
  // Repeating local notifications can reuse a request id on another date.
  // Deduplicate one response, not all future occurrences of that request.
  const date = notification.date;
  if (date !== undefined && (typeof date !== 'number' || !Number.isFinite(date))) return null;
  return JSON.stringify([identifier, date ?? null]);
}

/**
 * Route patient reminder default taps through the caller's account-bound intent.
 * Never turn payload URLs/ids into routes or treat the tap as a dose action.
 *
 * The caller's synchronous generation fence invalidates old-account callbacks
 * before passive React cleanup. Native startup reads and cache consumption are
 * fenced independently; Expo has no atomic compare-and-clear, so a response
 * that arrives inside the native clear itself cannot be protected here.
 */
export function startGroupedNotificationListener(
  native: GroupedNotificationApi,
  onOpen: (doseId: string | null) => void,
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
      if (groupedResponseKey(latest, native.DEFAULT_ACTION_IDENTIFIER) !== key) return;
      await native.clearLastNotificationResponseAsync();
    } catch {
      // Native cache failures must neither repeat navigation nor leak payloads.
    }
  };

  const handle = (response: unknown): void => {
    if (!current()) return;
    const key = groupedResponseKey(response, native.DEFAULT_ACTION_IDENTIFIER);
    if (key === null) return;
    if (!seen.has(key)) {
      const data = (response as { notification: { request: { content: { data: Record<string, unknown> } } } }).notification.request.content.data;
      let ids: unknown = data.doseIds;
      // Remote push providers serialize arrays, while Expo local delivery keeps
      // them as arrays. Bound the input before parsing untrusted payload data.
      if (typeof ids === 'string') {
        if (ids.length > 16_384) return;
        try { ids = JSON.parse(ids); } catch { return; }
      }
      const isGroup = data.kind === 'dose_group_reminder';
      if (isGroup && ids !== undefined && (!Array.isArray(ids) || ids.length === 0 || ids.length > 100)) return;
      const selected = isGroup ? (Array.isArray(ids) ? ids[0] : null) : data.doseId;
      const doseId = typeof selected === 'string' && selected.length > 0 && selected.length <= 128 ? selected : null;
      if ((!isGroup || ids !== undefined) && !doseId) return;
      try { onOpen(doseId); } catch { return; }
      seen.add(key);
      if (seen.size > 128) seen.delete(seen.values().next().value!);
    }
    void consume(key, revision);
  };

  // Subscribe first so a tap is not lost while native startup state is pending.
  const subscription = native.addNotificationResponseReceivedListener((response) => {
    liveResponseSeen = true;
    revision += 1;
    handle(response);
  });
  void Promise.resolve().then(() => native.getLastNotificationResponseAsync())
    .then((response) => {
      if (!liveResponseSeen) handle(response);
    })
    .catch(() => undefined);

  return () => {
    if (!active) return;
    active = false;
    subscription.remove();
    seen.clear();
  };
}
