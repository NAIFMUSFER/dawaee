import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { QueuedAction } from '../src/storage/offline-queue.js';

// Native encryption has its own integration suite. These tests control only
// the async storage/HTTP boundaries so lost updates are deterministic, not
// timing-dependent. No real patient data, network or production writes.
const io = vi.hoisted(() => ({
  disk: new Map<string, string>(),
  read: vi.fn(),
  write: vi.fn(),
  post: vi.fn(),
}));
vi.mock('../src/api/client.js', () => ({
  api: { post: io.post },
  NetworkError: class NetworkError extends Error {},
}));
vi.mock('../src/storage/secure-cache.js', () => ({
  readSlot: io.read,
  writeSlot: io.write,
  clearSlot: vi.fn(),
  purgeAllSlots: vi.fn(),
}));
vi.mock('../src/storage/low-stock-snooze.js', () => ({
  LOW_STOCK_SLOT: { plaintextKey: 'test.snooze' },
  purgeSnoozes: vi.fn(),
}));

const ALICE = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const BOB = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const key = (user: string) => `${user}/dawaee.offlineQueue`;
const stored = (user = ALICE): QueuedAction[] => JSON.parse(io.disk.get(key(user)) ?? '[]');
const action = (n: number): QueuedAction => ({
  type: 'taken',
  doseOccurrenceId: `cccccccc-3333-4333-8333-${String(n).padStart(12, '0')}`,
  at: '2026-09-09T02:00:00Z',
  clientEventId: `event-${String(n).padStart(8, '0')}`,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
function response(actions: QueuedAction[], error?: string) {
  return {
    results: actions.map((a) => ({ clientEventId: a.clientEventId, ok: !error, error })),
    applied: error ? 0 : actions.length,
    replayed: 0,
    failed: error ? actions.length : 0,
  };
}
let queue: typeof import('../src/storage/offline-queue.js');
beforeEach(async () => {
  vi.resetModules();
  io.disk.clear();
  io.read.mockReset().mockImplementation(async (slot: { plaintextKey: string }, user: string) =>
    io.disk.get(`${user}/${slot.plaintextKey}`) ?? null);
  io.write.mockReset().mockImplementation(async (slot: { plaintextKey: string }, user: string, raw: string) => {
    io.disk.set(`${user}/${slot.plaintextKey}`, raw);
    return { ok: true };
  });
  io.post.mockReset();
  queue = await import('../src/storage/offline-queue.js');
  queue.setCacheOwner(ALICE);
});

describe('offline queue: atomic updates and account-bound acknowledgements', () => {
  it('preserves simultaneous distinct dose actions', async () => {
    await Promise.all([queue.enqueue(action(1)), queue.enqueue(action(2)), queue.enqueue(action(3))]);
    expect(stored()).toEqual([action(1), action(2), action(3)]);
  });

  it('deduplicates concurrent copies of the same client intent', async () => {
    await Promise.all([queue.enqueue(action(1)), queue.enqueue(action(1))]);
    expect(stored()).toEqual([action(1)]);
  });

  it('does not erase an action added while the sync request is in flight', async () => {
    await queue.enqueue(action(1));
    const sent = deferred<void>();
    const reply = deferred<ReturnType<typeof response>>();
    io.post.mockImplementation(async () => { sent.resolve(); return reply.promise; });
    const flushing = queue.flushQueue('device-a');
    await sent.promise;
    // Must complete before the HTTP response: a network wait cannot hold the
    // local mutation lock and block a patient's next confirmation.
    await queue.enqueue(action(2));
    reply.resolve(response([action(1)]));
    await expect(flushing).resolves.toMatchObject({ applied: 1, attempted: 1 });
    expect(stored()).toEqual([action(2)]);
  });

  it('never writes a late response for Alice into Bob\'s queue', async () => {
    await queue.enqueue(action(1));
    const sent = deferred<void>();
    const reply = deferred<ReturnType<typeof response>>();
    io.post.mockImplementation(async () => { sent.resolve(); return reply.promise; });
    const flushing = queue.flushQueue('device-a').catch((err: unknown) => err);
    await sent.promise;
    queue.setCacheOwner(BOB);
    await queue.enqueue(action(2));
    reply.resolve(response([action(1)], 'internal_error'));
    expect(await flushing).toMatchObject({ reason: 'account changed' });
    expect(stored(BOB)).toEqual([action(2)]);
    expect(stored(ALICE)).toEqual([action(1)]);
  });

  it('rejects an enqueue whose storage read crosses an account switch', async () => {
    await queue.enqueue(action(1));
    const reading = deferred<void>();
    const resume = deferred<void>();
    io.read.mockImplementationOnce(async () => {
      const snapshot = io.disk.get(key(ALICE));
      reading.resolve();
      await resume.promise;
      return snapshot;
    });
    const saving = queue.enqueue(action(2)).catch((err: unknown) => err);
    await reading.promise;
    queue.setCacheOwner(BOB);
    await queue.enqueue(action(3));
    resume.resolve();
    expect(await saving).toMatchObject({ reason: 'account changed' });
    expect(stored(ALICE)).toEqual([action(1)]);
    expect(stored(BOB)).toEqual([action(3)]);
  });

  it('does not return a stale queue read to the next account', async () => {
    await queue.enqueue(action(1));
    const reading = deferred<void>();
    const resume = deferred<void>();
    io.read.mockImplementationOnce(async () => {
      const snapshot = io.disk.get(key(ALICE));
      reading.resolve();
      await resume.promise;
      return snapshot;
    });
    const pending = queue.readQueue();
    await reading.promise;
    queue.setCacheOwner(BOB);
    resume.resolve();
    expect(await pending).toEqual([]);
  });

  it('invalidates old work even after logout and login to the same account', async () => {
    await queue.enqueue(action(1));
    const sent = deferred<void>();
    const reply = deferred<ReturnType<typeof response>>();
    io.post.mockImplementation(async () => { sent.resolve(); return reply.promise; });
    const flushing = queue.flushQueue('device-a').catch((err: unknown) => err);
    await sent.promise;
    queue.setCacheOwner(null);
    queue.setCacheOwner(ALICE);
    reply.resolve(response([action(1)]));
    expect(await flushing).toMatchObject({ reason: 'account changed' });
    expect(stored()).toEqual([action(1)]);
  });

  it('does not invalidate a flush when loadMe rebinds the same account', async () => {
    await queue.enqueue(action(1));
    io.post.mockImplementation(async () => {
      queue.setCacheOwner(ALICE);
      return response([action(1)]);
    });
    await expect(queue.flushQueue('device-a')).resolves.toMatchObject({ applied: 1 });
    expect(stored()).toEqual([]);
  });

  it('cannot reintroduce a settled action through an older parallel response', async () => {
    await queue.enqueue(action(1));
    const firstSent = deferred<void>();
    const secondSent = deferred<void>();
    const firstReply = deferred<ReturnType<typeof response>>();
    const secondReply = deferred<ReturnType<typeof response>>();
    io.post.mockImplementationOnce(async () => { firstSent.resolve(); return firstReply.promise; });
    io.post.mockImplementationOnce(async () => { secondSent.resolve(); return secondReply.promise; });
    const first = queue.flushQueue('device-a');
    await firstSent.promise;
    const second = queue.flushQueue('device-a');
    await secondSent.promise;
    secondReply.resolve(response([action(1)]));
    await second;
    await queue.enqueue(action(2));
    firstReply.resolve(response([action(1)], 'internal_error'));
    await first;
    expect(stored()).toEqual([action(2)]);
  });

  it('removes permanent failures but retains retryable and newly queued actions', async () => {
    await queue.enqueue(action(1));
    await queue.enqueue(action(2));
    io.post.mockImplementation(async () => {
      await queue.enqueue(action(3));
      return {
        results: [
          { clientEventId: action(1).clientEventId, ok: false, error: 'forbidden' },
          { clientEventId: action(2).clientEventId, ok: false, error: 'internal_error' },
        ],
        applied: 0, replayed: 0, failed: 2,
      };
    });
    await queue.flushQueue('device-a');
    expect(stored()).toEqual([action(2), action(3)]);
  });

  it('ignores acknowledgements for actions that were not sent in that batch', async () => {
    await queue.enqueue(action(1));
    io.post.mockImplementation(async () => {
      await queue.enqueue(action(2));
      return response([action(1), action(2)]);
    });
    await queue.flushQueue('device-a');
    expect(stored()).toEqual([action(2)]);
  });

  it('retains all actions on network failure', async () => {
    await queue.enqueue(action(1));
    const { NetworkError } = await import('../src/api/client.js');
    io.post.mockRejectedValue(new NetworkError());
    await expect(queue.flushQueue('device-a')).resolves.toMatchObject({ offline: true, attempted: 1 });
    expect(stored()).toEqual([action(1)]);
  });

  it('recovers the mutation lock after a secure write fails', async () => {
    io.write.mockResolvedValueOnce({ ok: false, reason: 'disk full' });
    await expect(queue.enqueue(action(1))).rejects.toMatchObject({ reason: 'disk full' });
    await queue.enqueue(action(2));
    expect(stored()).toEqual([action(2)]);
  });

  it('rejects capacity overflow without deleting any unsent action', async () => {
    const full = Array.from({ length: 500 }, (_, i) => action(i));
    io.disk.set(key(ALICE), JSON.stringify(full));
    await expect(queue.enqueue(action(500))).rejects.toMatchObject({ reason: 'queue full' });
    expect(stored()).toEqual(full);
    // Retrying an already-persisted intent is still a success at capacity.
    await expect(queue.enqueue(action(0))).resolves.toBeUndefined();
    expect(stored()).toEqual(full);
  });

  it('does not persist dose actions with no signed-in cache owner', async () => {
    queue.setCacheOwner(null);
    await expect(queue.enqueue(action(1))).rejects.toMatchObject({ reason: 'signed out' });
    expect(io.write).not.toHaveBeenCalled();
    expect(await queue.readQueue()).toEqual([]);
  });
});
