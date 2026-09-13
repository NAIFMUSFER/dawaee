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
const DEPENDENT_PROFILE = 'eeeeeeee-5555-4555-8555-eeeeeeeeeeee';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

function schedule(profileId: string, medicationName: string) {
  return {
    profileId,
    cachedAt: '2026-09-09T04:00:00.000Z',
    timezone: 'Asia/Riyadh',
    doses: [{
      id: `${profileId}-dose`,
      scheduledAt: '2026-09-09T05:00:00.000Z',
      scheduledLocalTime: '08:00',
      scheduledLocalDate: '2026-09-09',
      medicationName,
      doseQuantity: 1,
      doseUnit: 'tablet',
      foodInstruction: 'no_preference',
      status: 'upcoming',
    }],
  };
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

    resume.resolve(JSON.stringify(schedule(ALICE_PROFILE, 'SYNTHETIC-ALICE-ONLY')));

    await expect(pending).resolves.toBeNull();
  });

  it('keeps each accessible profile schedule instead of replacing the previous profile cache', async () => {
    let encryptedSlot: string | null = null;
    io.read.mockImplementation(async () => encryptedSlot);
    io.write.mockImplementation(async (_slot, _userId, value: string) => {
      encryptedSlot = value;
      return { ok: true };
    });

    const self = schedule(ALICE_PROFILE, 'SELF-MEDICATION');
    const dependent = schedule(DEPENDENT_PROFILE, 'DEPENDENT-MEDICATION');

    await storage.cacheSchedule(self);
    await storage.cacheSchedule(dependent);

    await expect(storage.readCachedSchedule(ALICE_PROFILE)).resolves.toEqual(self);
    await expect(storage.readCachedSchedule(DEPENDENT_PROFILE)).resolves.toEqual(dependent);
  });

  it('serializes overlapping profile-cache writes so neither profile is lost', async () => {
    let encryptedSlot: string | null = null;
    const firstWriteStarted = deferred<void>();
    const releaseFirstWrite = deferred<void>();
    let writes = 0;

    io.read.mockImplementation(async () => encryptedSlot);
    io.write.mockImplementation(async (_slot, _userId, value: string) => {
      writes++;
      if (writes === 1) {
        firstWriteStarted.resolve();
        await releaseFirstWrite.promise;
      }
      encryptedSlot = value;
      return { ok: true };
    });

    const self = schedule(ALICE_PROFILE, 'SELF-MEDICATION');
    const dependent = schedule(DEPENDENT_PROFILE, 'DEPENDENT-MEDICATION');

    const first = storage.cacheSchedule(self);
    await firstWriteStarted.promise;
    const second = storage.cacheSchedule(dependent);
    releaseFirstWrite.resolve();
    await Promise.all([first, second]);

    await expect(storage.readCachedSchedule(ALICE_PROFILE)).resolves.toEqual(self);
    await expect(storage.readCachedSchedule(DEPENDENT_PROFILE)).resolves.toEqual(dependent);
  });
});
