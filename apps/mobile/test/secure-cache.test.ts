import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The local medication cache, which was plain text.
 *
 * `dawaee.offlineQueue` held dose confirmations and `dawaee.todayCache` held
 * the medication name, quantity, unit and time for every dose of the day — in
 * an AsyncStorage database that is an unencrypted SQLite file on Android and an
 * unencrypted plist on iOS. Readable from an ADB backup, a rooted handset or a
 * forensic image, and enough to infer a diagnosis.
 */

const ROOT = resolve(import.meta.dirname, '../../..');

const async_ = new Map<string, string>();
const secure = new Map<string, string>();
let platform = 'ios';
let secureFails: 'no' | 'read' | 'write' = 'no';
let asyncWriteFails = false;
let asyncDeleteFails = false;

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (k: string) => async_.get(k) ?? null,
    setItem: async (k: string, v: string) => {
      if (asyncWriteFails) throw new Error('disk full');
      async_.set(k, v);
    },
    removeItem: async (k: string) => {
      if (asyncDeleteFails) throw new Error('unavailable');
      async_.delete(k);
    },
    multiRemove: async (keys: string[]) => {
      if (asyncDeleteFails) throw new Error('unavailable');
      for (const k of keys) async_.delete(k);
    },
    getAllKeys: async () => [...async_.keys()],
  },
}));

vi.mock('react-native', () => ({
  Platform: { get OS() { return platform; } },
  NativeModules: {},
}));

/**
 * The queue imports the API client for `flushQueue`, which drags in
 * expo-constants and the whole Expo module runtime. Nothing here exercises the
 * network, so it is stubbed — the subject is what reaches disk.
 */
vi.mock('../src/api/client.js', () => ({
  api: { post: async () => ({ results: [], applied: 0, replayed: 0, failed: 0 }) },
  NetworkError: class NetworkError extends Error {},
}));

const AFU_DEVICE_ONLY = Symbol('AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY');
const secureOptions: unknown[] = [];

vi.mock('expo-secure-store', () => ({
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: AFU_DEVICE_ONLY,
  getItemAsync: async (k: string, o?: unknown) => {
    secureOptions.push(o);
    if (secureFails === 'read') throw new Error('keystore invalidated');
    return secure.get(k) ?? null;
  },
  setItemAsync: async (k: string, v: string, o?: unknown) => {
    secureOptions.push(o);
    if (secureFails === 'write') throw new Error('keystore unavailable');
    secure.set(k, v);
  },
  deleteItemAsync: async (k: string, o?: unknown) => {
    secureOptions.push(o);
    secure.delete(k);
  },
}));

// Real randomness, not a stub — nonce uniqueness is one of the properties
// under test, and a mocked CSPRNG would prove nothing about it.
vi.mock('expo-crypto', async () => {
  const nodeCrypto = await import('node:crypto');
  return { getRandomBytes: (n: number) => new Uint8Array(nodeCrypto.randomBytes(n)) };
});

const crypto_ = await import('../src/storage/crypto.js');
const keys = await import('../src/storage/cache-key.js');
const cache = await import('../src/storage/secure-cache.js');
const queue = await import('../src/storage/offline-queue.js');
const snooze = await import('../src/storage/low-stock-snooze.js');

const ALICE = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const BOB = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const QUEUE_PLAIN = 'dawaee.offlineQueue';
const CACHE_PLAIN = 'dawaee.todayCache';
const SLOT = { plaintextKey: QUEUE_PLAIN };

beforeEach(() => {
  async_.clear();
  secure.clear();
  secureOptions.length = 0;
  platform = 'ios';
  secureFails = 'no';
  asyncWriteFails = false;
  asyncDeleteFails = false;
  queue.setCacheOwner(ALICE);
});

const encName = (plain: string, user: string) => `${plain}.${user}.enc.v1`;
const allValues = () => JSON.stringify([...async_.values()]);

// ─────────────────────────────────────────────────────────── crypto layer

describe('the primitive is an authenticated one, used correctly', () => {
  it('round-trips a value', () => {
    const key = crypto_.generateKey();
    const env = crypto_.seal('Metformin 500 mg', key, 1);
    expect(crypto_.open(env, key, 1)).toBe('Metformin 500 mg');
  });

  it('produces a versioned, self-describing envelope', () => {
    const env = crypto_.seal('x', crypto_.generateKey(), 1);
    expect(env).toMatchObject({ v: 1, alg: 'AES-256-GCM', k: 1 });
    expect(typeof env.n).toBe('string');
    expect(typeof env.c).toBe('string');
    expect(crypto_.fromBase64(env.n)).toHaveLength(crypto_.NONCE_BYTES);
  });

  it('uses a 256-bit key and a 96-bit nonce', () => {
    expect(crypto_.KEY_BYTES).toBe(32);
    expect(crypto_.NONCE_BYTES).toBe(12);
    expect(crypto_.generateKey()).toHaveLength(32);
  });

  it('never leaks plaintext into the ciphertext', () => {
    const env = crypto_.seal('Metformin', crypto_.generateKey(), 1);
    expect(JSON.stringify(env)).not.toContain('Metformin');
  });

  /**
   * Nonce reuse under one key in GCM does not merely leak the XOR of two
   * plaintexts — it lets an attacker forge the authentication tag for that key.
   * A fresh CSPRNG nonce per message is the only thing preventing it.
   */
  it('draws a fresh nonce for every message', () => {
    const key = crypto_.generateKey();
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) seen.add(crypto_.seal('same plaintext', key, 1).n);
    expect(seen.size).toBe(2000);
  });

  it('is not deterministic — identical input gives different ciphertext', () => {
    const key = crypto_.generateKey();
    expect(crypto_.seal('same', key, 1).c).not.toBe(crypto_.seal('same', key, 1).c);
  });

  it('generates keys that differ', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) seen.add(crypto_.toBase64(crypto_.generateKey()));
    expect(seen.size).toBe(500);
  });

  it('rejects a tampered authentication tag', () => {
    const key = crypto_.generateKey();
    const env = crypto_.seal('Warfarin 5 mg', key, 1);
    const bytes = crypto_.fromBase64(env.c);
    bytes[bytes.length - 1]! ^= 0x01; // flip one bit of the tag
    expect(() => crypto_.open({ ...env, c: crypto_.toBase64(bytes) }, key, 1))
      .toThrow(crypto_.DecryptionFailed);
  });

  it('rejects tampered ciphertext body', () => {
    const key = crypto_.generateKey();
    const env = crypto_.seal('Warfarin 5 mg', key, 1);
    const bytes = crypto_.fromBase64(env.c);
    bytes[0]! ^= 0xff;
    expect(() => crypto_.open({ ...env, c: crypto_.toBase64(bytes) }, key, 1)).toThrow();
  });

  it('rejects a wrong key', () => {
    const env = crypto_.seal('x', crypto_.generateKey(), 1);
    expect(() => crypto_.open(env, crypto_.generateKey(), 1)).toThrow(crypto_.DecryptionFailed);
  });

  it('rejects an unknown envelope version', () => {
    const key = crypto_.generateKey();
    const env = crypto_.seal('x', key, 1);
    expect(() => crypto_.open({ ...env, v: 2 }, key, 1)).toThrow(/version/);
  });

  it('rejects an unexpected algorithm rather than guessing', () => {
    const key = crypto_.generateKey();
    const env = crypto_.seal('x', key, 1);
    expect(() => crypto_.open({ ...env, alg: 'AES-256-CBC' }, key, 1)).toThrow(/algorithm/);
  });

  it('rejects ciphertext written under a different key generation', () => {
    const key = crypto_.generateKey();
    expect(() => crypto_.open(crypto_.seal('x', key, 1), key, 2)).toThrow(/key/);
  });

  it('rejects a malformed envelope', () => {
    const key = crypto_.generateKey();
    for (const bad of [null, {}, { v: 1, alg: 'AES-256-GCM', k: 1, n: 'x' }, 'string']) {
      expect(() => crypto_.open(bad, key, 1)).toThrow(crypto_.DecryptionFailed);
    }
  });

  /** Errors reach crash reporters. None of them may carry PHI or key material. */
  it('never puts plaintext, key or medication names in an error', () => {
    const key = crypto_.generateKey();
    const env = crypto_.seal('Olanzapine 10 mg', key, 1);
    const err = (() => {
      try { crypto_.open(env, crypto_.generateKey(), 1); return null; } catch (e) { return e as Error; }
    })();
    const dumped = JSON.stringify(err, Object.getOwnPropertyNames(err));
    expect(dumped).not.toContain('Olanzapine');
    expect(dumped).not.toContain(crypto_.toBase64(key));
    expect(dumped).not.toContain(env.c);
  });

  it('forbids the primitives the design rules out', () => {
    const src = readFileSync(join(ROOT, 'apps/mobile/src/storage/crypto.ts'), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '');
    for (const banned of ['cbc', 'ecb', 'ctr(', 'createCipheriv']) {
      expect(code.toLowerCase(), banned).not.toContain(banned);
    }
    expect(code).toContain('gcm(');
  });
});

// ────────────────────────────────────────────────────────── key management

describe('the key is generated well and stored where a key belongs', () => {
  it('creates a 256-bit key on first use and keeps it', async () => {
    const first = await keys.getOrCreateCacheKey(ALICE);
    expect(first).toHaveLength(32);
    const second = await keys.getOrCreateCacheKey(ALICE);
    expect(crypto_.toBase64(second!)).toBe(crypto_.toBase64(first!));
  });

  it('never writes the key to AsyncStorage', async () => {
    await keys.getOrCreateCacheKey(ALICE);
    expect([...async_.keys()]).toEqual([]);
    expect(secure.size).toBe(1);
  });

  it('is not derived from the device or user id', async () => {
    const k = await keys.getOrCreateCacheKey(ALICE);
    expect(crypto_.toBase64(k!)).not.toContain(ALICE);
    const src = readFileSync(join(ROOT, 'apps/mobile/src/storage/cache-key.ts'), 'utf8');
    expect(src).toContain('generateKey()');
    expect(src).not.toMatch(/deviceId|getDeviceId/);
  });

  it('gives each account its own key', async () => {
    const a = await keys.getOrCreateCacheKey(ALICE);
    const b = await keys.getOrCreateCacheKey(BOB);
    expect(crypto_.toBase64(a!)).not.toBe(crypto_.toBase64(b!));
    expect(secure.size).toBe(2);
  });

  it('states the accessibility class on every keychain call', async () => {
    await keys.getOrCreateCacheKey(ALICE);
    await keys.destroyCacheKey(ALICE);
    expect(secureOptions.length).toBeGreaterThan(1);
    for (const o of secureOptions) {
      expect((o as { keychainAccessible?: unknown })?.keychainAccessible).toBe(AFU_DEVICE_ONLY);
    }
  });

  /**
   * The headless notification handler writes to the queue with nobody present.
   * requireAuthentication would make that impossible. App Lock is the layer
   * that enforces user presence, and it is not weakened here.
   */
  it('does not require biometric authentication for the key', async () => {
    await keys.getOrCreateCacheKey(ALICE);
    const src = readFileSync(join(ROOT, 'apps/mobile/src/storage/cache-key.ts'), 'utf8');
    expect(src).not.toMatch(/requireAuthentication:\s*true/);
    for (const o of secureOptions) expect(o).not.toHaveProperty('requireAuthentication');
  });

  it('refuses an identifier that could escape the key namespace', async () => {
    await expect(keys.getOrCreateCacheKey('../../other')).rejects.toThrow(keys.CacheKeyUnavailable);
  });

  it('does not silently mint a replacement when the store is unreadable', async () => {
    await keys.getOrCreateCacheKey(ALICE);
    secureFails = 'read';
    await expect(keys.getOrCreateCacheKey(ALICE)).rejects.toThrow(/unreadable/);
  });

  it('reports a failed key write rather than continuing', async () => {
    secureFails = 'write';
    await expect(keys.getOrCreateCacheKey(ALICE)).rejects.toThrow(/write failed/);
  });

  it('has no key at all on web', async () => {
    platform = 'web';
    expect(await keys.getOrCreateCacheKey(ALICE)).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────── persistence

describe('what lands on disk is ciphertext', () => {
  it('stores an encrypted envelope, not the value', async () => {
    const r = await cache.writeSlot(SLOT, ALICE, JSON.stringify([{ medicationName: 'Metformin' }]));
    expect(r.ok).toBe(true);
    expect(allValues()).not.toContain('Metformin');
    const env = JSON.parse(async_.get(encName(QUEUE_PLAIN, ALICE))!);
    expect(env.alg).toBe('AES-256-GCM');
  });

  it('reads back what it wrote, across a simulated restart', async () => {
    await cache.writeSlot(SLOT, ALICE, 'payload-1');
    // A restart keeps disk and keychain, loses memory. Both mocks persist.
    expect(await cache.readSlot(SLOT, ALICE)).toBe('payload-1');
  });

  it('survives many sequential writes', async () => {
    for (let i = 0; i < 50; i++) await cache.writeSlot(SLOT, ALICE, `payload-${i}`);
    expect(await cache.readSlot(SLOT, ALICE)).toBe('payload-49');
  });

  it('refuses to persist when there is no key, and writes nothing', async () => {
    secureFails = 'write';
    const r = await cache.writeSlot(SLOT, ALICE, 'secret');
    expect(r).toEqual({ ok: false, reason: 'no-key' });
    expect(allValues()).not.toContain('secret');
  });

  /**
   * The fail-closed rule, asserted directly rather than inferred: the legacy
   * plaintext key must never be WRITTEN, under any failure, on any platform.
   * A fallback there would silently reinstate the vulnerability on exactly the
   * devices where the secure path is broken.
   */
  it('never writes the plaintext key, whatever fails', async () => {
    const attempts: Array<() => Promise<unknown>> = [
      () => cache.writeSlot(SLOT, ALICE, 'phi-1'),
      async () => { secureFails = 'write'; return cache.writeSlot(SLOT, ALICE, 'phi-2'); },
      async () => { secureFails = 'read'; return cache.writeSlot(SLOT, ALICE, 'phi-3'); },
      async () => { secureFails = 'no'; platform = 'web'; return cache.writeSlot(SLOT, ALICE, 'phi-4'); },
    ];
    for (const attempt of attempts) {
      await attempt().catch(() => undefined);
      expect(async_.has(QUEUE_PLAIN), 'plaintext key written').toBe(false);
      expect(async_.has(CACHE_PLAIN)).toBe(false);
    }
    expect(allValues()).not.toContain('phi-');
  });

  it('reports a failed ciphertext write without falling back to plaintext', async () => {
    await keys.getOrCreateCacheKey(ALICE);
    asyncWriteFails = true;
    const r = await cache.writeSlot(SLOT, ALICE, 'secret');
    expect(r).toEqual({ ok: false, reason: 'write' });
    expect(allValues()).not.toContain('secret');
  });

  it('raises on corrupt ciphertext instead of returning something', async () => {
    await cache.writeSlot(SLOT, ALICE, 'payload');
    const name = encName(QUEUE_PLAIN, ALICE);
    const env = JSON.parse(async_.get(name)!);
    const bytes = crypto_.fromBase64(env.c);
    bytes[bytes.length - 1]! ^= 0x01;
    async_.set(name, JSON.stringify({ ...env, c: crypto_.toBase64(bytes) }));
    await expect(cache.readSlot(SLOT, ALICE)).rejects.toThrow(crypto_.DecryptionFailed);
  });

  it('raises when the key is gone but the ciphertext is not', async () => {
    await cache.writeSlot(SLOT, ALICE, 'payload');
    secure.clear(); // key lost: reinstall, Keystore invalidation, restore
    await expect(cache.readSlot(SLOT, ALICE)).rejects.toThrow(crypto_.DecryptionFailed);
  });

  it('recovers by itself once a temporarily unreadable store works again', async () => {
    await cache.writeSlot(SLOT, ALICE, 'payload');
    secureFails = 'read';
    await expect(cache.readSlot(SLOT, ALICE)).rejects.toThrow(keys.CacheKeyUnavailable);
    secureFails = 'no';
    expect(await cache.readSlot(SLOT, ALICE)).toBe('payload');
  });
});

// ──────────────────────────────────────────────────────────────── migration

describe('plaintext left by an older build is migrated safely', () => {
  it('adopts it, encrypts it, and destroys the plaintext', async () => {
    async_.set(QUEUE_PLAIN, '[{"type":"taken"}]');
    expect(await cache.readSlot(SLOT, ALICE)).toBe('[{"type":"taken"}]');
    expect(async_.has(QUEUE_PLAIN)).toBe(false);
    expect(async_.has(encName(QUEUE_PLAIN, ALICE))).toBe(true);
  });

  it('is idempotent', async () => {
    async_.set(QUEUE_PLAIN, 'value');
    await cache.readSlot(SLOT, ALICE);
    expect(await cache.readSlot(SLOT, ALICE)).toBe('value');
    expect([...async_.keys()]).toEqual([encName(QUEUE_PLAIN, ALICE)]);
  });

  it('returns null when nothing is stored at all', async () => {
    expect(await cache.readSlot(SLOT, ALICE)).toBeNull();
  });

  /**
   * The core no-downgrade rule. Encrypted is authoritative whenever it exists
   * and decrypts; stale plaintext must never win, because it would resurrect
   * a dose the patient already changed.
   */
  it('prefers NEW ciphertext over STALE plaintext, and deletes the stale copy', async () => {
    await cache.writeSlot(SLOT, ALICE, 'NEW');
    async_.set(QUEUE_PLAIN, 'STALE');
    expect(await cache.readSlot(SLOT, ALICE)).toBe('NEW');
    expect(async_.has(QUEUE_PLAIN)).toBe(false);
  });

  /**
   * Plaintext is never deleted before ciphertext is written AND read back.
   * A crash in the window leaves both, which the next launch resolves — the
   * reverse order has a window where the only copy of a dose confirmation is
   * gone.
   */
  it('keeps the plaintext when the ciphertext write fails', async () => {
    async_.set(QUEUE_PLAIN, 'only-copy');
    await keys.getOrCreateCacheKey(ALICE);
    asyncWriteFails = true;
    expect(await cache.readSlot(SLOT, ALICE)).toBe('only-copy');
    expect(async_.get(QUEUE_PLAIN), 'the only copy survives').toBe('only-copy');
  });

  it('keeps the plaintext when no key can be made', async () => {
    async_.set(QUEUE_PLAIN, 'only-copy');
    secureFails = 'write';
    await expect(cache.readSlot(SLOT, ALICE)).rejects.toThrow();
    expect(async_.get(QUEUE_PLAIN)).toBe('only-copy');
  });

  it('resumes an interrupted migration on the next launch', async () => {
    async_.set(QUEUE_PLAIN, 'value');
    await keys.getOrCreateCacheKey(ALICE);
    asyncWriteFails = true;
    await cache.readSlot(SLOT, ALICE);          // interrupted
    expect(async_.has(encName(QUEUE_PLAIN, ALICE))).toBe(false);

    asyncWriteFails = false;
    expect(await cache.readSlot(SLOT, ALICE)).toBe('value');   // resumed
    expect(async_.has(QUEUE_PLAIN)).toBe(false);
  });

  it('cleans up the leftover when the process died after the write', async () => {
    // Exactly that state: valid ciphertext AND the plaintext still present.
    await cache.writeSlot(SLOT, ALICE, 'value');
    async_.set(QUEUE_PLAIN, 'value');
    expect(await cache.readSlot(SLOT, ALICE)).toBe('value');
    expect(async_.has(QUEUE_PLAIN)).toBe(false);
  });

  it('stays correct when plaintext deletion keeps failing', async () => {
    await cache.writeSlot(SLOT, ALICE, 'NEW');
    async_.set(QUEUE_PLAIN, 'STALE');
    asyncDeleteFails = true;
    for (let i = 0; i < 5; i++) expect(await cache.readSlot(SLOT, ALICE)).toBe('NEW');
    expect(async_.get(QUEUE_PLAIN), 'still there, still ignored').toBe('STALE');
  });

  it('does not let corrupt ciphertext promote the plaintext', async () => {
    await cache.writeSlot(SLOT, ALICE, 'NEW');
    async_.set(QUEUE_PLAIN, 'STALE');
    async_.set(encName(QUEUE_PLAIN, ALICE), '{"v":1,"alg":"AES-256-GCM","k":1,"n":"AAAAAAAAAAAAAAAA","c":"AAAA"}');
    await expect(cache.readSlot(SLOT, ALICE)).rejects.toThrow(crypto_.DecryptionFailed);
  });
});

// ──────────────────────────────────────────────────────── account isolation

describe('two accounts on one phone cannot reach each other', () => {
  it('gives each user a separate ciphertext under a separate key', async () => {
    await cache.writeSlot(SLOT, ALICE, 'alice-meds');
    await cache.writeSlot(SLOT, BOB, 'bob-meds');
    expect(await cache.readSlot(SLOT, ALICE)).toBe('alice-meds');
    expect(await cache.readSlot(SLOT, BOB)).toBe('bob-meds');
  });

  it("cannot open the other account's record even with its ciphertext", async () => {
    await cache.writeSlot(SLOT, ALICE, 'alice-meds');
    const aliceEnvelope = async_.get(encName(QUEUE_PLAIN, ALICE))!;
    // Bob's storage slot is handed Alice's bytes. Bob's key must not open them.
    async_.set(encName(QUEUE_PLAIN, BOB), aliceEnvelope);
    await keys.getOrCreateCacheKey(BOB);
    await expect(cache.readSlot(SLOT, BOB)).rejects.toThrow(crypto_.DecryptionFailed);
  });

  /**
   * The adversarial case the audit asked for, run through the real queue API:
   * A signs in, records doses, signs out; B signs in on the same phone.
   */
  it('User A logout → User B login → nothing of A remains readable', async () => {
    queue.setCacheOwner(ALICE);
    await queue.enqueue({
      type: 'taken', doseOccurrenceId: 'dose-a', at: '2026-09-05T08:00:00Z', clientEventId: 'evt-a',
    });
    await queue.cacheSchedule({
      profileId: 'p-alice', cachedAt: '2026-09-05T00:00:00Z', timezone: 'Asia/Riyadh',
      doses: [{
        id: 'dose-a', scheduledAt: '2026-09-05T08:00:00Z', scheduledLocalTime: '11:00',
        scheduledLocalDate: '2026-09-05', medicationName: 'Sertraline', doseQuantity: 1,
        doseUnit: 'tablet', foodInstruction: 'any', status: 'pending',
      }],
    });
    expect(allValues()).not.toContain('Sertraline');

    // Sign-out, exactly as the app store performs it.
    await queue.purgeLocalCaches(ALICE);
    await keys.destroyCacheKey(ALICE);
    queue.setCacheOwner(null);

    // Bob signs in.
    queue.setCacheOwner(BOB);
    expect(await queue.readQueue()).toEqual([]);
    expect(await queue.readCachedSchedule('p-alice')).toBeNull();
    expect(await queue.queueSize()).toBe(0);
    expect(allValues()).not.toContain('Sertraline');
    expect(allValues()).not.toContain('evt-a');
  });

  it("sweeps a previous user's cache even when their id is unknown", async () => {
    await cache.writeSlot(SLOT, ALICE, 'alice-meds');
    await cache.writeSlot({ plaintextKey: CACHE_PLAIN }, ALICE, 'alice-schedule');
    // The new session has no idea Alice existed.
    await cache.purgeAllSlots([{ plaintextKey: QUEUE_PLAIN }, { plaintextKey: CACHE_PLAIN }]);
    expect([...async_.keys()]).toEqual([]);
  });

  it('reads and writes nothing at all when nobody is signed in', async () => {
    queue.setCacheOwner(null);
    expect(await queue.readQueue()).toEqual([]);
    await expect(queue.enqueue({
      type: 'taken', doseOccurrenceId: 'd', at: 'now', clientEventId: 'e',
    })).rejects.toThrow(queue.QueuePersistFailed);
    expect([...async_.keys()]).toEqual([]);
  });
});

// ───────────────────────────────────────────────────────── queue semantics

describe('the offline queue keeps its meaning through encryption', () => {
  const action = (n: number) => ({
    type: 'taken' as const,
    doseOccurrenceId: `dose-${n}`,
    at: `2026-09-05T0${n}:00:00Z`,
    clientEventId: `evt-${n}`,
  });

  it('preserves order and every field across a restart', async () => {
    for (let i = 1; i <= 5; i++) await queue.enqueue(action(i));
    const read = await queue.readQueue();
    expect(read.map((a) => a.clientEventId)).toEqual(['evt-1', 'evt-2', 'evt-3', 'evt-4', 'evt-5']);
    expect(read[2]).toEqual(action(3));
  });

  it('keeps snooze minutes and skip reasons intact', async () => {
    await queue.enqueue({ type: 'snoozed', doseOccurrenceId: 'd1', at: 't', clientEventId: 'e1', minutes: 15 });
    await queue.enqueue({ type: 'skipped', doseOccurrenceId: 'd2', at: 't', clientEventId: 'e2', reason: 'nausea' });
    const read = await queue.readQueue();
    expect(read[0]).toMatchObject({ minutes: 15 });
    expect(read[1]).toMatchObject({ reason: 'nausea' });
  });

  /**
   * Exactly-once, which is what stops a migration from double-recording a
   * dose. The idempotency key is the client event id, and it must survive
   * encryption, a crash, and a restart unchanged.
   */
  it('offline mutation → crash → restart → decrypt yields exactly one mutation', async () => {
    await queue.enqueue(action(1));
    // "Crash": drop everything in memory. Disk and keychain persist.
    queue.setCacheOwner(null);
    queue.setCacheOwner(ALICE);

    const afterRestart = await queue.readQueue();
    expect(afterRestart).toHaveLength(1);
    expect(afterRestart[0]!.clientEventId).toBe('evt-1');

    // A replayed enqueue of the same intent must not add a second entry.
    await queue.enqueue(action(1));
    expect(await queue.readQueue()).toHaveLength(1);
  });

  it('does not duplicate mutations when migrating a plaintext queue', async () => {
    async_.set(QUEUE_PLAIN, JSON.stringify([action(1), action(2)]));
    const migrated = await queue.readQueue();
    expect(migrated.map((a) => a.clientEventId)).toEqual(['evt-1', 'evt-2']);
    // Read again — the plaintext is gone and nothing was re-added.
    expect((await queue.readQueue()).map((a) => a.clientEventId)).toEqual(['evt-1', 'evt-2']);
  });

  it('generates distinct client event ids', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 5000; i++) seen.add(queue.newClientEventId());
    expect(seen.size).toBe(5000);
  });

  it('tells the caller when a dose action could not be saved', async () => {
    secureFails = 'write';
    await expect(queue.enqueue(action(1))).rejects.toThrow(queue.QueuePersistFailed);
  });

  it('never mentions a medication in a persistence error', async () => {
    await queue.cacheSchedule({
      profileId: 'p', cachedAt: 'now', timezone: 'Asia/Riyadh',
      doses: [{
        id: 'd', scheduledAt: 'now', scheduledLocalTime: '08:00', scheduledLocalDate: '2026-09-05',
        medicationName: 'Clozapine', doseQuantity: 1, doseUnit: 'tablet',
        foodInstruction: 'any', status: 'pending',
      }],
    });
    // Force a genuine key failure: no stored key, and creating one fails.
    secure.clear();
    secureFails = 'write';
    const err = await queue.enqueue(action(1)).catch((e: Error) => e);
    expect(err, 'the write must actually fail').toBeInstanceOf(Error);
    expect(JSON.stringify(err, Object.getOwnPropertyNames(err))).not.toContain('Clozapine');
    expect((err as Error).message).not.toContain('Clozapine');
  });

  /**
   * The queue is capped at 500 entries. At the realistic maximum — a patient on
   * ten medications, four doses each, offline for twelve days — encryption must
   * not be slow enough to make a dose action feel broken.
   */
  it('handles the maximum queue size quickly', async () => {
    const big = Array.from({ length: 500 }, (_, i) => action(i % 9));
    const started = Date.now();
    await cache.writeSlot(SLOT, ALICE, JSON.stringify(big));
    const value = await cache.readSlot(SLOT, ALICE);
    const elapsed = Date.now() - started;
    expect(JSON.parse(value!)).toHaveLength(500);
    expect(elapsed, `encrypt+decrypt of a full queue took ${elapsed}ms`).toBeLessThan(500);
  });
});

// ──────────────────────────────────────────────────────────────────── web

describe('the browser stores no PHI and no key', () => {
  it('persists nothing and keeps no key', async () => {
    platform = 'web';
    const r = await cache.writeSlot(SLOT, ALICE, 'Metformin 500 mg');
    expect(r).toEqual({ ok: false, reason: 'no-key' });
    expect([...async_.keys()]).toEqual([]);
    expect(secure.size).toBe(0);
  });

  it('destroys plaintext an older web build left in localStorage', async () => {
    platform = 'web';
    async_.set(QUEUE_PLAIN, '[{"medicationName":"Metformin"}]');
    expect(await cache.readSlot(SLOT, ALICE)).toBeNull();
    expect([...async_.keys()]).toEqual([]);
  });

  it('does not put a key in browser storage to fake encryption', () => {
    // Strip comments — the file explains why it does NOT use AsyncStorage, and
    // the prohibition is about the code.
    const src = readFileSync(join(ROOT, 'apps/mobile/src/storage/cache-key.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '');
    expect(src).not.toContain('AsyncStorage');
    expect(src).not.toContain('localStorage');
  });
});

// ───────────────────────────────────────────────── structural / no-fallback

describe('nothing writes medication data in the clear any more', () => {
  it('has no AsyncStorage call left in the offline queue', () => {
    const src = readFileSync(join(ROOT, 'apps/mobile/src/storage/offline-queue.ts'), 'utf8');
    expect(src).not.toContain('AsyncStorage');
  });

  it('routes every persistence call through the encrypted store', () => {
    const src = readFileSync(join(ROOT, 'apps/mobile/src/storage/offline-queue.ts'), 'utf8');
    expect(src).toContain('writeSlot(');
    expect(src).toContain('readSlot(');
  });

  it('destroys the cache and the key on sign-out', () => {
    const src = readFileSync(join(ROOT, 'apps/mobile/src/state/app-store.tsx'), 'utf8');
    const start = src.indexOf('signOut: async');
    const out = src.slice(start, src.indexOf('refreshProfiles: loadMe', start));
    expect(out).toContain('purgeLocalCaches');
    expect(out).toContain('destroyCacheKey');
    expect(out).toContain('setCacheOwner(null)');
  });

  it('binds the cache to the account before anything can read it', () => {
    const src = readFileSync(join(ROOT, 'apps/mobile/src/state/app-store.tsx'), 'utf8');
    expect(src.indexOf('setCacheOwner(me.user.id)')).toBeLessThan(src.indexOf('const { restartRequired }'));
  });
});

// ────────────────────────────────────────────────── low-stock snooze (PHI key)

/**
 * `dawaee.lowStockSnoozedUntil.<medicationId>` — one AsyncStorage entry per
 * medication. The stored VALUE was only a date, which is why it survived the
 * first pass, but the KEY was the leak: a directory listing of the storage file
 * told anyone reading it how many medications the person takes and which ones
 * are running out, and the stable id let the same medication be correlated
 * across backups months apart. Encrypting values does not protect key names.
 */
describe('the low-stock snooze no longer names medications in the clear', () => {
  const LEGACY = 'dawaee.lowStockSnoozedUntil.';
  const TODAY = '2026-09-05';
  const MED_A = 'med-11111111-2222-3333-4444-555555555555';
  const MED_B = 'med-99999999-8888-7777-6666-555555555555';

  const keyNames = () => [...async_.keys()].join('|');

  it('stores a snooze with no medication id in any key name', async () => {
    await snooze.setSnooze(ALICE, MED_A, '2026-09-06', TODAY);
    expect(keyNames()).not.toContain(MED_A);
    expect(keyNames()).not.toContain('lowStockSnoozedUntil');
    expect(allValues(), 'and not in the values either').not.toContain(MED_A);
  });

  it('still snoozes the right medication and only that one', async () => {
    await snooze.setSnooze(ALICE, MED_A, '2026-09-06', TODAY);
    expect(await snooze.readSnooze(ALICE, MED_A, TODAY)).toBe('2026-09-06');
    expect(await snooze.readSnooze(ALICE, MED_B, TODAY)).toBeNull();
  });

  it('holds several medications at once', async () => {
    await snooze.setSnooze(ALICE, MED_A, '2026-09-06', TODAY);
    await snooze.setSnooze(ALICE, MED_B, '2026-09-08', TODAY);
    expect(await snooze.readSnoozes(ALICE, TODAY)).toEqual({
      [MED_A]: '2026-09-06', [MED_B]: '2026-09-08',
    });
  });

  it('expires a snooze once its date has passed', async () => {
    await snooze.setSnooze(ALICE, MED_A, '2026-09-06', TODAY);
    expect(await snooze.readSnooze(ALICE, MED_A, '2026-09-06')).toBeNull();
    expect(await snooze.readSnooze(ALICE, MED_A, '2026-09-20')).toBeNull();
  });

  it('drops a snooze when the medication is refilled', async () => {
    await snooze.setSnooze(ALICE, MED_A, '2026-09-06', TODAY);
    await snooze.clearSnooze(ALICE, MED_A, TODAY);
    expect(await snooze.readSnooze(ALICE, MED_A, TODAY)).toBeNull();
  });

  it('migrates a legacy per-medication key and deletes it', async () => {
    async_.set(`${LEGACY}${MED_A}`, '2026-09-06');
    expect(await snooze.readSnooze(ALICE, MED_A, TODAY)).toBe('2026-09-06');
    expect(async_.has(`${LEGACY}${MED_A}`)).toBe(false);
    expect(keyNames()).not.toContain(MED_A);
  });

  it('migrates several legacy keys in one pass', async () => {
    async_.set(`${LEGACY}${MED_A}`, '2026-09-06');
    async_.set(`${LEGACY}${MED_B}`, '2026-09-08');
    expect(await snooze.readSnoozes(ALICE, TODAY)).toEqual({
      [MED_A]: '2026-09-06', [MED_B]: '2026-09-08',
    });
    expect(keyNames()).not.toContain('lowStockSnoozedUntil');
  });

  it('is idempotent', async () => {
    async_.set(`${LEGACY}${MED_A}`, '2026-09-06');
    await snooze.readSnoozes(ALICE, TODAY);
    expect(await snooze.readSnoozes(ALICE, TODAY)).toEqual({ [MED_A]: '2026-09-06' });
  });

  it('enumerates only the Dawaee prefix, leaving other keys alone', async () => {
    async_.set(`${LEGACY}${MED_A}`, '2026-09-06');
    async_.set('some.other.library.key', 'not ours');
    async_.set('dawaee.deviceId', 'dev-abc');
    await snooze.readSnoozes(ALICE, TODAY);
    expect(async_.get('some.other.library.key')).toBe('not ours');
    expect(async_.get('dawaee.deviceId')).toBe('dev-abc');
  });

  /**
   * A refill cancels a snooze. If the stale legacy key could overwrite the
   * encrypted state, that cancelled snooze would come back and suppress a
   * warning about a medication that had genuinely run out.
   */
  it('never lets a stale legacy key override newer encrypted state', async () => {
    await snooze.setSnooze(ALICE, MED_A, '2026-09-30', TODAY);
    async_.set(`${LEGACY}${MED_A}`, '2026-09-06');
    expect(await snooze.readSnooze(ALICE, MED_A, TODAY)).toBe('2026-09-30');
    expect(async_.has(`${LEGACY}${MED_A}`)).toBe(false);
  });

  it('keeps the legacy key when the encrypted write fails', async () => {
    async_.set(`${LEGACY}${MED_A}`, '2026-09-06');
    await keys.getOrCreateCacheKey(ALICE);
    asyncWriteFails = true;
    expect(await snooze.readSnooze(ALICE, MED_A, TODAY)).toBe('2026-09-06');
    expect(async_.get(`${LEGACY}${MED_A}`), 'the only copy survives').toBe('2026-09-06');
  });

  it('stays correct when legacy cleanup keeps failing', async () => {
    await snooze.setSnooze(ALICE, MED_A, '2026-09-30', TODAY);
    async_.set(`${LEGACY}${MED_A}`, '2026-09-06');
    asyncDeleteFails = true;
    for (let i = 0; i < 5; i++) {
      expect(await snooze.readSnooze(ALICE, MED_A, TODAY), `launch ${i}`).toBe('2026-09-30');
    }
    expect(async_.has(`${LEGACY}${MED_A}`), 'still there, still ignored').toBe(true);
  });

  it('keeps two accounts apart', async () => {
    await snooze.setSnooze(ALICE, MED_A, '2026-09-06', TODAY);
    await snooze.setSnooze(BOB, MED_B, '2026-09-08', TODAY);
    expect(await snooze.readSnoozes(ALICE, TODAY)).toEqual({ [MED_A]: '2026-09-06' });
    expect(await snooze.readSnoozes(BOB, TODAY)).toEqual({ [MED_B]: '2026-09-08' });
  });

  it('User A logout → User B login → no trace of A’s medications', async () => {
    await snooze.setSnooze(ALICE, MED_A, '2026-09-30', TODAY);
    async_.set(`${LEGACY}${MED_B}`, '2026-09-09'); // a legacy key from an older build

    await snooze.purgeSnoozes(ALICE);

    expect(await snooze.readSnoozes(BOB, TODAY)).toEqual({});
    expect(keyNames()).not.toContain(MED_A);
    expect(keyNames()).not.toContain(MED_B);
    expect(allValues()).not.toContain(MED_A);
  });

  it('is swept by the sign-out purge along with the other caches', async () => {
    await snooze.setSnooze(ALICE, MED_A, '2026-09-30', TODAY);
    async_.set(`${LEGACY}${MED_B}`, '2026-09-09');
    await queue.purgeLocalCaches(ALICE);
    expect([...async_.keys()]).toEqual([]);
  });

  it('does nothing at all when nobody is signed in', async () => {
    await snooze.setSnooze(null, MED_A, '2026-09-06', TODAY);
    expect(await snooze.readSnoozes(null, TODAY)).toEqual({});
    expect([...async_.keys()]).toEqual([]);
  });

  it('ignores a malformed stored date rather than trusting it', async () => {
    async_.set(`${LEGACY}${MED_A}`, 'not-a-date');
    expect(await snooze.readSnooze(ALICE, MED_A, TODAY)).toBeNull();
  });

  it('leaves no medication id in any AsyncStorage key name, ever', async () => {
    async_.set(`${LEGACY}${MED_A}`, '2026-09-06');
    await snooze.setSnooze(ALICE, MED_B, '2026-09-08', TODAY);
    await snooze.readSnoozes(ALICE, TODAY);
    for (const key of async_.keys()) {
      expect(key, `key ${key}`).not.toMatch(/med-/);
      expect(key).not.toContain('lowStockSnoozedUntil');
    }
  });

  it('has no medication-id key left in the stock screen', () => {
    const src = readFileSync(join(ROOT, 'apps/mobile/app/medication/stock.tsx'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '');
    expect(src).not.toContain('AsyncStorage');
    expect(src).not.toContain('lowStockSnoozedUntil');
  });
});
