import { beforeEach, describe, expect, it, vi } from 'vitest';
const io = vi.hoisted(() => ({
  secure: new Map<string, string>(), disk: new Map<string, string>(),
  readGate: null as Promise<void> | null, writeGate: null as Promise<void> | null,
  reads: 0, writes: 0, migrationFault: '' as '' | 'dropped' | 'corrupt' | 'read-failed',
}));
vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
vi.mock('expo-secure-store', () => ({
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 4,
  getItemAsync: async (key: string) => {
    io.reads++;
    const value = io.secure.get(key) ?? null;
    if (io.readGate) await io.readGate;
    return value;
  },
  setItemAsync: async (key: string, value: string) => {
    io.writes++;
    if (io.writeGate) await io.writeGate;
    io.secure.set(key, value);
  },
  deleteItemAsync: async (key: string) => { io.secure.delete(key); },
}));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: {
  getItem: async (key: string) => {
    if (io.migrationFault === 'read-failed' && key.endsWith('.enc.v1') && io.disk.has(key)) throw new Error('synthetic read failure');
    return io.disk.get(key) ?? null;
  },
  setItem: async (key: string, value: string) => {
    if (io.migrationFault === 'dropped') return;
    io.disk.set(key, io.migrationFault === 'corrupt' ? '{broken' : value);
  },
  removeItem: async (key: string) => { io.disk.delete(key); },
  multiRemove: async (keys: string[]) => { keys.forEach(key => io.disk.delete(key)); },
  getAllKeys: async () => [...io.disk.keys()],
} }));
vi.mock('expo-crypto', async () => {
  const { randomBytes } = await import('node:crypto');
  return { getRandomBytes: (n: number) => new Uint8Array(randomBytes(n)) };
});
import { destroyCacheKey, getOrCreateCacheKey, peekCacheKey, resetCacheKey } from '../src/storage/cache-key.js';
import { readSlot, writeSlot } from '../src/storage/secure-cache.js';
const user = 'cache-owner-fixture';
const slot = { plaintextKey: 'synthetic.queue' };
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}
beforeEach(() => {
  io.secure.clear(); io.disk.clear(); io.readGate = io.writeGate = null;
  io.reads = io.writes = 0; io.migrationFault = '';
});
describe('N3: key creation and destruction are ordered per account', () => {
  it('keeps both concurrent first-use encrypted slots readable with the persisted key', async () => {
    const pause = gate(); io.readGate = pause.promise;
    const first = writeSlot(slot, user, 'pending-dose-A');
    const secondSlot = { plaintextKey: 'synthetic.today' };
    const second = writeSlot(secondSlot, user, 'schedule-B');
    await vi.waitFor(() => expect(io.reads).toBeGreaterThan(0));
    pause.resolve(); io.readGate = null;
    expect(await Promise.all([first, second])).toEqual([{ ok: true }, { ok: true }]);
    expect(io.writes).toBe(1);
    expect(await readSlot(slot, user)).toBe('pending-dose-A');
    expect(await readSlot(secondSlot, user)).toBe('schedule-B');
  });
  it('does not resurrect a key when logout races its first secure write', async () => {
    const pause = gate(); io.writeGate = pause.promise;
    const creating = getOrCreateCacheKey(user);
    await vi.waitFor(() => expect(io.writes).toBe(1));
    const deleting = destroyCacheKey(user);
    pause.resolve(); io.writeGate = null;
    await Promise.all([creating, deleting]);
    expect(await peekCacheKey(user)).toBeNull();
  });
  it('orders deliberate key reset before a later cache writer', async () => {
    await getOrCreateCacheKey(user);
    const pause = gate(); io.writeGate = pause.promise;
    const resetting = resetCacheKey(user);
    await vi.waitFor(() => expect(io.writes).toBe(2));
    const writing = writeSlot(slot, user, 'post-reset-value');
    pause.resolve(); io.writeGate = null;
    await resetting;
    expect(await writing).toEqual({ ok: true });
    expect(await readSlot(slot, user)).toBe('post-reset-value');
  });
});
describe('N4: migration verifies persisted bytes before removing its only plaintext copy', () => {
  it.each(['dropped', 'corrupt', 'read-failed'] as const)('retains queued actions after an apparent write with %s storage', async fault => {
    io.disk.set(slot.plaintextKey, 'pending-dose-A'); io.migrationFault = fault;
    expect(await readSlot(slot, user)).toBe('pending-dose-A');
    expect(io.disk.get(slot.plaintextKey)).toBe('pending-dose-A');
  });
  it('removes the predecessor only after successfully reading and decrypting persisted bytes', async () => {
    io.disk.set(slot.plaintextKey, 'pending-dose-A');
    expect(await readSlot(slot, user)).toBe('pending-dose-A');
    expect(io.disk.has(slot.plaintextKey)).toBe(false);
    expect(await readSlot(slot, user)).toBe('pending-dose-A');
  });
});
