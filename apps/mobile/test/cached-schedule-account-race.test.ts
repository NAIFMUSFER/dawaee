import { beforeEach, describe, expect, it, vi } from 'vitest';

const io = vi.hoisted(() => ({
  read: vi.fn(),
  write: vi.fn(),
}));

vi.mock('../src/api/client.js', () => ({
  api: { post: vi.fn() },
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
const ALICE_PROFILE = 'cccccccc-3333-4333-8333-cccccccccccc';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

let storage: typeof import('../src/storage/offline-queue.js');

beforeEach(async () => {
  vi.resetModules();
  io.read.mockReset();
  io.write.mockReset().mockResolvedValue({ ok: true });
  storage = await import('../src/storage/offline-queue.js');
  storage.setCacheOwner(ALICE);
});

describe('cached schedule is bound to the account that started the read', () => {
  it('does not return Alice medication data after the device switches to Bob', async () => {
    const started = deferred<void>();
    const resume = deferred<string | null>();
    io.read.mockImplementationOnce(async () => {
      started.resolve();
      return resume.promise;
    });

    const pending = storage.readCachedSchedule(ALICE_PROFILE);
    await started.promise;
    storage.setCacheOwner(BOB);

    resume.resolve(JSON.stringify({
      profileId: ALICE_PROFILE,
      cachedAt: '2026-09-09T04:00:00.000Z',
      timezone: 'Asia/Riyadh',
      doses: [{
        id: 'dddddddd-4444-4444-8444-dddddddddddd',
        scheduledAt: '2026-09-09T05:00:00.000Z',
        scheduledLocalTime: '08:00',
        scheduledLocalDate: '2026-09-09',
        medicationName: 'SYNTHETIC-ALICE-ONLY',
        doseQuantity: 1,
        doseUnit: 'tablet',
        foodInstruction: 'no_preference',
        status: 'upcoming',
      }],
    }));

    await expect(pending).resolves.toBeNull();
  });
});
