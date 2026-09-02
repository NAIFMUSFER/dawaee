import AsyncStorage from '@react-native-async-storage/async-storage';
import { api, NetworkError } from '../api/client.js';

/**
 * The offline queue.
 *
 * This is the feature that makes the app trustworthy on a patchy connection:
 * pressing "Taken" ALWAYS succeeds locally and is replayed later. Every action
 * carries a client event id that the server treats as an idempotency key, so a
 * retry after a crash, a reinstall or a duplicated batch can never record the
 * same dose twice or decrement the medication box twice.
 */

const QUEUE_KEY = 'dawaee.offlineQueue';
const CACHE_KEY = 'dawaee.todayCache';

export type QueuedAction =
  | { type: 'taken'; doseOccurrenceId: string; at: string; clientEventId: string }
  | { type: 'skipped'; doseOccurrenceId: string; at: string; clientEventId: string; reason?: string | null }
  | { type: 'snoozed'; doseOccurrenceId: string; at: string; clientEventId: string; minutes: number };

export function newClientEventId(): string {
  // Long enough for the server's minimum, and unique per action per device.
  return `evt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export async function readQueue(): Promise<QueuedAction[]> {
  const raw = await AsyncStorage.getItem(QUEUE_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as QueuedAction[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeQueue(actions: QueuedAction[]): Promise<void> {
  await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(actions.slice(-500)));
}

export async function enqueue(action: QueuedAction): Promise<void> {
  const queue = await readQueue();
  // Guard against a double tap producing two entries for one intent.
  if (queue.some((a) => a.clientEventId === action.clientEventId)) return;
  queue.push(action);
  await writeQueue(queue);
}

export interface FlushResult {
  attempted: number;
  applied: number;
  replayed: number;
  failed: number;
  offline: boolean;
}

/**
 * Replays everything queued. Actions the server accepted — including ones it
 * recognises as replays — are dropped from the queue. Actions that failed for
 * a *permanent* reason are dropped too, because retrying them forever would
 * block the queue; anything else stays for the next attempt.
 */
export async function flushQueue(deviceId: string): Promise<FlushResult> {
  const queue = await readQueue();
  if (queue.length === 0) return { attempted: 0, applied: 0, replayed: 0, failed: 0, offline: false };

  try {
    const res = await api.post<{
      results: Array<{ clientEventId: string; ok: boolean; error?: string; replay?: boolean }>;
      applied: number; replayed: number; failed: number;
    }>('/v1/doses/sync', { deviceId, actions: queue });

    const permanent = new Set(['not_found', 'forbidden', 'dose_already_resolved', 'validation_failed', 'dose_not_actionable']);
    const settled = new Set(
      res.results.filter((r) => r.ok || permanent.has(r.error ?? '')).map((r) => r.clientEventId),
    );
    await writeQueue(queue.filter((a) => !settled.has(a.clientEventId)));

    return { attempted: queue.length, applied: res.applied, replayed: res.replayed, failed: res.failed, offline: false };
  } catch (err) {
    if (err instanceof NetworkError) {
      return { attempted: queue.length, applied: 0, replayed: 0, failed: 0, offline: true };
    }
    throw err;
  }
}

export async function queueSize(): Promise<number> {
  return (await readQueue()).length;
}

// ------------------------------------------------------------------ cache

export interface CachedSchedule {
  profileId: string;
  cachedAt: string;
  timezone: string;
  doses: Array<{
    id: string; scheduledAt: string; scheduledLocalTime: string; scheduledLocalDate: string;
    medicationName: string; doseQuantity: number; doseUnit: string; foodInstruction: string; status: string;
  }>;
}

/**
 * The prefetch window the server returns is stored so the phone can render
 * Today and schedule its LOCAL notifications with no network at all — which is
 * what keeps reminders working on a plane, in a basement, or on an expired
 * data plan.
 */
export async function cacheSchedule(cache: CachedSchedule): Promise<void> {
  await AsyncStorage.setItem(CACHE_KEY, JSON.stringify(cache));
}

export async function readCachedSchedule(profileId: string): Promise<CachedSchedule | null> {
  const raw = await AsyncStorage.getItem(CACHE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as CachedSchedule;
    return parsed.profileId === profileId ? parsed : null;
  } catch {
    return null;
  }
}

/** Applies a queued action to the cached view so the UI updates instantly offline. */
export function applyQueuedToCache(cache: CachedSchedule, queue: QueuedAction[]): CachedSchedule {
  const byId = new Map(queue.map((a) => [a.doseOccurrenceId, a]));
  return {
    ...cache,
    doses: cache.doses.map((d) => {
      const action = byId.get(d.id);
      if (!action) return d;
      if (action.type === 'taken') return { ...d, status: 'taken' };
      if (action.type === 'skipped') return { ...d, status: 'skipped' };
      return { ...d, status: 'snoozed' };
    }),
  };
}
