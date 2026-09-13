import { api, NetworkError } from '../api/client.js';
import { clearSlot, purgeAllSlots, readSlot, writeSlot } from './secure-cache.js';
import type { CacheSlot } from './secure-cache.js';
import { LOW_STOCK_SLOT, purgeSnoozes } from './low-stock-snooze.js';
import { OFFLINE_BOOTSTRAP_SLOT } from './offline-bootstrap.js';
export { readOfflineBootstrap, writeOfflineBootstrap } from './offline-bootstrap.js';

/**
 * The offline queue.
 *
 * This is the feature that makes the app trustworthy on a patchy connection:
 * pressing "Taken" ALWAYS succeeds locally and is replayed later. Every action
 * carries a client event id that the server treats as an idempotency key, so a
 * retry after a crash, a reinstall or a duplicated batch can never record the
 * same dose twice or decrement the medication box twice.
 */

/**
 * Both of these held plain text until now: the queue is a list of dose
 * confirmations naming dose ids and times, and the cache is the medication
 * name, quantity, unit and schedule for the day — enough to infer a diagnosis
 * from a stolen phone. They are encrypted per account now; see
 * ./secure-cache.ts for the migration and ./crypto.ts for the threat model.
 *
 * The names below are the LEGACY plaintext keys. Nothing writes them any more;
 * they exist so the migration can find what earlier builds left behind.
 */
const QUEUE_SLOT: CacheSlot = { plaintextKey: 'dawaee.offlineQueue' };
const CACHE_SLOT: CacheSlot = { plaintextKey: 'dawaee.todayCache' };
export const ALL_SLOTS: CacheSlot[] = [QUEUE_SLOT, CACHE_SLOT, LOW_STOCK_SLOT, OFFLINE_BOOTSTRAP_SLOT];

/**
 * Who the stored data belongs to.
 *
 * Set at sign-in and cleared at sign-out. Every read and write is scoped to it,
 * so User B signing in on a shared phone cannot reach User A's cache even if
 * cleanup failed: different storage key, different encryption key.
 *
 * Null means "nobody is signed in", and in that state nothing is read from or
 * written to disk at all — a queued dose action with no owner has nowhere
 * legitimate to go.
 */
let currentUserId: string | null = null;
let ownerGeneration = 0;
type QueueOwner = { userId: string; generation: number };
const queueMutations = new Map<string, Promise<void>>();
const scheduleCacheMutations = new Map<string, Promise<void>>();

export function setCacheOwner(userId: string | null): void {
  if (userId !== currentUserId) ownerGeneration++;
  currentUserId = userId;
}

function captureOwner(): QueueOwner | null {
  return currentUserId ? { userId: currentUserId, generation: ownerGeneration } : null;
}

function isCurrentOwner(owner: QueueOwner): boolean {
  return owner.userId === currentUserId && owner.generation === ownerGeneration;
}

function requireCurrentOwner(owner: QueueOwner): void {
  if (!isCurrentOwner(owner)) throw new QueuePersistFailed('account changed');
}

/** Serialize local read/modify/write operations, never the network request. */
function mutateQueue<T>(owner: QueueOwner, operation: () => Promise<T>): Promise<T> {
  const previous = queueMutations.get(owner.userId) ?? Promise.resolve();
  const result = previous.then(() => {
    requireCurrentOwner(owner);
    return operation();
  });
  // A failed disk write must not poison the next action's turn.
  const settled = result.then(() => undefined, () => undefined);
  queueMutations.set(owner.userId, settled);
  void settled.then(() => {
    if (queueMutations.get(owner.userId) === settled) queueMutations.delete(owner.userId);
  });
  return result;
}

/** Raised when a dose action could not be persisted. Carries no medication data. */
export class QueuePersistFailed extends Error {
  constructor(readonly reason: string) {
    super(`the action could not be saved on this device (${reason})`);
    this.name = 'QueuePersistFailed';
  }
}

export type QueuedAction =
  | { type: 'taken'; doseOccurrenceId: string; at: string; clientEventId: string }
  | { type: 'skipped'; doseOccurrenceId: string; at: string; clientEventId: string; reason?: string | null }
  | { type: 'snoozed'; doseOccurrenceId: string; at: string; clientEventId: string; minutes: number };

export function newClientEventId(): string {
  // Long enough for the server's minimum, and unique per action per device.
  return `evt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * The queue, decrypted.
 *
 * Order is preserved exactly: the value is one JSON array, so encryption is
 * applied to the whole list rather than per entry and there is no reordering
 * to get wrong. Every field a replay depends on — clientEventId, the action
 * type, doseOccurrenceId, the `at` timestamp, snooze minutes — round-trips
 * unchanged, because nothing is transformed on the way in or out.
 *
 * Unreadable ciphertext returns an empty queue rather than throwing: a patient
 * opening the app must not meet a crash because a cache entry was corrupted.
 * The consequence — unsent actions lost — is the documented key-loss behaviour,
 * and it is bounded by the fact that anything the server already accepted is
 * not in here.
 */
export async function readQueue(): Promise<QueuedAction[]> {
  const owner = captureOwner();
  if (!owner) return [];
  const actions = await readQueueFor(owner.userId);
  return isCurrentOwner(owner) ? actions : [];
}

async function readQueueFor(userId: string): Promise<QueuedAction[]> {
  let raw: string | null;
  try {
    raw = await readSlot(QUEUE_SLOT, userId);
  } catch {
    return [];
  }
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as QueuedAction[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Persist the queue, or fail loudly.
 *
 * There is deliberately no plaintext fallback. A dose confirmation that cannot
 * be stored securely is reported to the caller so the UI can tell the patient
 * it did not save — which is recoverable — rather than written in the clear,
 * which silently reinstates the vulnerability on exactly the devices where the
 * secure path is broken.
 */
async function writeQueue(actions: QueuedAction[], owner: QueueOwner): Promise<void> {
  requireCurrentOwner(owner);
  const result = await writeSlot(QUEUE_SLOT, owner.userId, JSON.stringify(actions));
  requireCurrentOwner(owner);
  if (!result.ok) throw new QueuePersistFailed(result.reason);
}

export async function enqueue(action: QueuedAction): Promise<void> {
  const owner = captureOwner();
  if (!owner) throw new QueuePersistFailed('signed out');
  await mutateQueue(owner, async () => {
    const queue = await readQueueFor(owner.userId);
    requireCurrentOwner(owner);
    // Guard against a double tap producing two entries for one intent.
    if (queue.some((a) => a.clientEventId === action.clientEventId)) return;
    // Match the sync API's 500-action bound without silently discarding an
    // older, unsent dose confirmation. The caller already handles this error.
    if (queue.length >= 500) throw new QueuePersistFailed('queue full');
    queue.push(action);
    await writeQueue(queue, owner);
  });
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
  const owner = captureOwner();
  if (!owner) return { attempted: 0, applied: 0, replayed: 0, failed: 0, offline: false };
  const queue = await mutateQueue(owner, () => readQueueFor(owner.userId));
  requireCurrentOwner(owner);
  if (queue.length === 0) return { attempted: 0, applied: 0, replayed: 0, failed: 0, offline: false };

  try {
    const res = await api.post<{
      results: Array<{ clientEventId: string; ok: boolean; error?: string; replay?: boolean }>;
      applied: number; replayed: number; failed: number;
    }>('/v1/doses/sync', { deviceId, actions: queue });

    const permanent = new Set(['not_found', 'forbidden', 'dose_already_resolved', 'validation_failed', 'dose_not_actionable']);
    const sentIds = new Set(queue.map((a) => a.clientEventId));
    const settled = new Set(
      res.results.filter((r) => sentIds.has(r.clientEventId) && (r.ok || permanent.has(r.error ?? '')))
        .map((r) => r.clientEventId),
    );
    await mutateQueue(owner, async () => {
      // The request's snapshot is not the current queue: a patient can tap
      // another dose while the network is in flight. Remove only acknowledged
      // actions from a fresh read, under the same lock used by enqueue.
      const current = await readQueueFor(owner.userId);
      await writeQueue(current.filter((a) => !settled.has(a.clientEventId)), owner);
    });

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

type CachedScheduleEnvelope = {
  version: 2;
  schedules: CachedSchedule[];
};

function decodeCachedSchedules(raw: string | null): CachedSchedule[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as CachedSchedule | CachedScheduleEnvelope;
    if (
      typeof parsed === 'object'
      && parsed !== null
      && 'version' in parsed
      && parsed.version === 2
      && 'schedules' in parsed
      && Array.isArray(parsed.schedules)
    ) {
      return parsed.schedules;
    }
    // Backward compatibility: releases before the multi-profile fix stored one
    // CachedSchedule directly in the encrypted slot. Keep that profile usable
    // offline and promote it to the v2 envelope on the next successful write.
    if (
      typeof parsed === 'object'
      && parsed !== null
      && 'profileId' in parsed
      && typeof parsed.profileId === 'string'
      && 'doses' in parsed
      && Array.isArray(parsed.doses)
    ) {
      return [parsed as CachedSchedule];
    }
  } catch {
    // A schedule cache is a disposable server snapshot. Corruption costs a
    // refresh, not a dose action, so fail closed and rebuild when online.
  }
  return [];
}

/**
 * Serialize schedule-cache read/modify/write operations per signed-in account.
 *
 * Multiple profile loads can overlap (for example a fast profile switch). A
 * versioned envelope alone would still lose one profile if both writers read
 * the same old value and committed independently. This lock covers local I/O
 * only; no network request is held behind it. Stale account generations are
 * discarded before they can write medication data after a logout/account swap.
 */
function mutateScheduleCache(owner: QueueOwner, operation: () => Promise<void>): Promise<void> {
  const previous = scheduleCacheMutations.get(owner.userId) ?? Promise.resolve();
  const result = previous.then(async () => {
    if (!isCurrentOwner(owner)) return;
    await operation();
  });
  // The schedule is a cache, not the dose-action journal. Persistence failure
  // is survivable and keeps the historical best-effort behavior of cacheSchedule.
  const settled = result.then(() => undefined, () => undefined);
  scheduleCacheMutations.set(owner.userId, settled);
  void settled.then(() => {
    if (scheduleCacheMutations.get(owner.userId) === settled) scheduleCacheMutations.delete(owner.userId);
  });
  return settled;
}

/**
 * The prefetch window the server returns is stored so the phone can render
 * Today and schedule its LOCAL notifications with no network at all — which is
 * what keeps reminders working on a plane, in a basement, or on an expired
 * data plan.
 */
export async function cacheSchedule(cache: CachedSchedule): Promise<void> {
  const owner = captureOwner();
  if (!owner) return;
  await mutateScheduleCache(owner, async () => {
    let raw: string | null = null;
    try {
      raw = await readSlot(CACHE_SLOT, owner.userId);
    } catch {
      // Cache corruption/key loss is recoverable: replace it with the fresh
      // server response rather than making a successful Today request fail.
    }
    if (!isCurrentOwner(owner)) return;

    const schedules = decodeCachedSchedules(raw).filter((entry) => entry.profileId !== cache.profileId);
    schedules.push(cache);
    const envelope: CachedScheduleEnvelope = { version: 2, schedules };
    await writeSlot(CACHE_SLOT, owner.userId, JSON.stringify(envelope));
  });
}

export async function readCachedSchedule(profileId: string): Promise<CachedSchedule | null> {
  const owner = captureOwner();
  if (!owner) return null;
  let raw: string | null;
  try {
    raw = await readSlot(CACHE_SLOT, owner.userId);
  } catch {
    return null;
  }
  if (!isCurrentOwner(owner) || !raw) return null;
  const cached = decodeCachedSchedules(raw).find((entry) => entry.profileId === profileId) ?? null;
  return isCurrentOwner(owner) ? cached : null;
}

/**
 * Forget everything cached on this device.
 *
 * Sweeps by prefix, so it removes caches belonging to accounts that are not
 * the current one — which is the case that matters, because the id of a
 * previous user is exactly what the current session does not have.
 */
export async function purgeLocalCaches(userId: string | null): Promise<void> {
  if (userId) {
    await clearSlot(QUEUE_SLOT, userId);
    await clearSlot(CACHE_SLOT, userId);
  }
  await purgeAllSlots(ALL_SLOTS);
  // The low-stock snooze lives in the same encrypted store but keeps its own
  // module, because it also has to sweep the pre-encryption per-medication keys
  // that were never account-scoped at all.
  await purgeSnoozes(userId);
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
