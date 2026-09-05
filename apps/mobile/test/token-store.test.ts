import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Session tokens, which used to sit in AsyncStorage.
 *
 * On Android that is an unencrypted SQLite database inside the app sandbox;
 * on iOS an unencrypted plist. Both are readable from an ADB backup, from a
 * rooted or jailbroken device, and from a forensic image of a phone that is
 * merely powered off. What was sitting there was a long-lived refresh token —
 * enough to mint access to the account indefinitely — so a lost phone was a
 * lost account, and for this app an account is somebody's medication list.
 */

const ROOT = resolve(import.meta.dirname, '../../..');

/** Stands in for AsyncStorage: plain, inspectable, and shared by every test. */
const async_ = new Map<string, string>();
/** Stands in for the keychain. */
const secure = new Map<string, string>();

let secureFails: 'no' | 'read' | 'write' = 'no';
let platform = 'ios';

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (k: string) => async_.get(k) ?? null,
    setItem: async (k: string, v: string) => { async_.set(k, v); },
    removeItem: async (k: string) => { async_.delete(k); },
    multiRemove: async (keys: string[]) => { for (const k of keys) async_.delete(k); },
    multiSet: async (pairs: [string, string][]) => { for (const [k, v] of pairs) async_.set(k, v); },
  },
}));

vi.mock('react-native', () => ({ Platform: { get OS() { return platform; } } }));

vi.mock('expo-secure-store', () => ({
  getItemAsync: async (k: string) => {
    if (secureFails === 'read') throw new Error('keychain unavailable');
    return secure.get(k) ?? null;
  },
  setItemAsync: async (k: string, v: string) => {
    if (secureFails === 'write') throw new Error('keychain unavailable');
    secure.set(k, v);
  },
  deleteItemAsync: async (k: string) => { secure.delete(k); },
}));

const store = await import('../src/api/token-store.js');

const LEGACY_ACCESS = 'dawaee.accessToken';
const LEGACY_REFRESH = 'dawaee.refreshToken';
const SECURE_KEY = 'dawaee.session.v1';

beforeEach(() => {
  async_.clear();
  secure.clear();
  secureFails = 'no';
  platform = 'ios';
});

const legacy = (a: string, r: string) => {
  async_.set(LEGACY_ACCESS, a);
  async_.set(LEGACY_REFRESH, r);
};

describe('nothing writes a token to AsyncStorage any more', () => {
  it('puts a new session in the keychain and nowhere else', async () => {
    await store.writeSession({ accessToken: 'A1', refreshToken: 'R1' });
    expect(secure.get(SECURE_KEY)).toContain('A1');
    expect([...async_.keys()]).toEqual([]);
  });

  /**
   * The structural half. A future edit that reintroduces
   * `AsyncStorage.setItem('dawaee.accessToken', …)` anywhere in the app would
   * pass every behavioural test above, because it would simply be a second
   * copy nobody reads.
   */
  it('has no AsyncStorage token write left anywhere in the app', () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.tsx?$/.test(entry)) files.push(full);
      }
    };
    walk(join(ROOT, 'apps/mobile/src'));
    walk(join(ROOT, 'apps/mobile/app'));

    const offenders: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      // token-store.ts is the one file allowed to name the legacy keys, and it
      // only ever removes them.
      const isStore = file.endsWith('token-store.ts');
      for (const key of ['accessToken', 'refreshToken']) {
        const re = new RegExp(`AsyncStorage\\.(setItem|multiSet)[^\\n]*${key}`);
        if (re.test(src)) offenders.push(`${file} writes ${key}`);
      }
      if (!isStore && /dawaee\.(access|refresh)Token/.test(src)) {
        offenders.push(`${file} names a legacy token key`);
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('leaves the device id in AsyncStorage, because it is not a credential', () => {
    const client = readFileSync(join(ROOT, 'apps/mobile/src/api/client.ts'), 'utf8');
    expect(client).toContain("const DEVICE_KEY = 'dawaee.deviceId'");
    expect(client).toContain('AsyncStorage.setItem(DEVICE_KEY');
  });
});

describe('a session left behind by the old build is moved once and destroyed', () => {
  it('adopts the legacy pair and wipes it', async () => {
    legacy('OLD_A', 'OLD_R');
    const got = await store.readSession();
    expect(got).toEqual({ accessToken: 'OLD_A', refreshToken: 'OLD_R' });
    expect(secure.get(SECURE_KEY)).toContain('OLD_R');
    expect(async_.has(LEGACY_ACCESS)).toBe(false);
    expect(async_.has(LEGACY_REFRESH)).toBe(false);
  });

  it('is idempotent — a second run finds nothing to do', async () => {
    legacy('OLD_A', 'OLD_R');
    await store.readSession();
    const again = await store.readSession();
    expect(again).toEqual({ accessToken: 'OLD_A', refreshToken: 'OLD_R' });
    expect([...async_.keys()]).toEqual([]);
  });

  /**
   * The downgrade this ordering exists to prevent. After any refresh the
   * keychain holds the current pair and the AsyncStorage copy is a fossil of
   * whatever was valid before the upgrade — and the server has since
   * invalidated it by rotation. Writing the fossil over the current pair would
   * sign the user out on their next launch, for no reason they could see.
   */
  it('never lets an older legacy token overwrite a newer keychain one', async () => {
    secure.set(SECURE_KEY, JSON.stringify({ accessToken: 'NEW_A', refreshToken: 'NEW_R' }));
    legacy('STALE_A', 'STALE_R');

    const got = await store.readSession();
    expect(got).toEqual({ accessToken: 'NEW_A', refreshToken: 'NEW_R' });
    expect(secure.get(SECURE_KEY)).not.toContain('STALE');
    // ...and the fossil is destroyed on the way past.
    expect([...async_.keys()]).toEqual([]);
  });

  /**
   * Crash safety, both windows. Write-before-delete means a death between the
   * two leaves the token in both places, which the next launch resolves. The
   * reverse order would leave it in neither.
   */
  it('recovers when the process died between the write and the delete', async () => {
    // Exactly that state: present in both.
    secure.set(SECURE_KEY, JSON.stringify({ accessToken: 'A', refreshToken: 'R' }));
    legacy('A', 'R');

    const got = await store.readSession();
    expect(got).toEqual({ accessToken: 'A', refreshToken: 'R' });
    expect([...async_.keys()], 'the leftover is cleaned up').toEqual([]);
  });

  it('keeps the legacy copy when the secure write fails, rather than losing it', async () => {
    legacy('OLD_A', 'OLD_R');
    secureFails = 'write';

    // Fail closed: no session is reported, so the app asks for a password...
    expect(await store.readSession()).toBeNull();
    // ...and the tokens have NOT been destroyed on the way to nowhere.
    expect(async_.get(LEGACY_REFRESH)).toBe('OLD_R');
    expect(secure.size).toBe(0);
  });

  it('does not resurrect a plaintext token when the keychain is unreadable', async () => {
    legacy('OLD_A', 'OLD_R');
    secureFails = 'read';
    expect(await store.readSession()).toBeNull();
    expect(secure.size).toBe(0);
  });

  it('clears a half-written legacy pair instead of keeping one token for nothing', async () => {
    async_.set(LEGACY_REFRESH, 'ORPHAN');
    expect(await store.readSession()).toBeNull();
    expect(async_.has(LEGACY_REFRESH)).toBe(false);
  });

  it('treats a corrupt keychain entry as signed out rather than crashing', async () => {
    secure.set(SECURE_KEY, '{not json');
    expect(await store.readSession()).toBeNull();
  });

  it('rejects an entry missing half the pair', async () => {
    secure.set(SECURE_KEY, JSON.stringify({ accessToken: 'A' }));
    expect(await store.readSession()).toBeNull();
  });
});

describe('the pair is written and read as one value', () => {
  /**
   * Two keys would mean two writes, and a kill between them leaves a new
   * access token beside a stale refresh token — which after a rotation is one
   * the server has already invalidated. One key makes the pair atomic at the
   * platform's level.
   */
  it('stores both tokens under a single key', async () => {
    await store.writeSession({ accessToken: 'A1', refreshToken: 'R1' });
    expect([...secure.keys()]).toEqual([SECURE_KEY]);
    const parsed = JSON.parse(secure.get(SECURE_KEY)!);
    expect(parsed).toEqual({ accessToken: 'A1', refreshToken: 'R1' });
  });

  it('replaces the whole pair on rotation, leaving no half of the old one', async () => {
    await store.writeSession({ accessToken: 'A1', refreshToken: 'R1' });
    await store.writeSession({ accessToken: 'A2', refreshToken: 'R2' });
    const raw = secure.get(SECURE_KEY)!;
    expect(raw).not.toContain('A1');
    expect(raw).not.toContain('R1');
    expect(JSON.parse(raw)).toEqual({ accessToken: 'A2', refreshToken: 'R2' });
  });

  it('makes the client persist through the store, never through AsyncStorage', () => {
    const client = readFileSync(join(ROOT, 'apps/mobile/src/api/client.ts'), 'utf8');
    expect(client).toContain('await writeSession(tokens)');
    expect(client).toContain('await readSession()');
    expect(client).toContain('await clearStoredSession()');
  });

  /**
   * If persisting a rotated pair fails, whatever is on disk still names the
   * refresh token the server just invalidated. Leaving it produces a launch
   * days later that 401s and signs the user out for no visible reason; the
   * client clears instead, so the next launch is a clean sign-in.
   */
  it('clears storage when a rotated pair cannot be persisted', () => {
    const client = readFileSync(join(ROOT, 'apps/mobile/src/api/client.ts'), 'utf8');
    const refresh = client.slice(client.indexOf('async function refreshAccessToken'));
    const attempt = refresh.indexOf('await storeSession(body)');
    expect(attempt).toBeGreaterThan(-1);
    expect(refresh.slice(attempt, attempt + 900)).toContain('clearStoredSession');
  });
});

describe('signing out leaves nothing behind', () => {
  it('removes the keychain entry and both legacy keys', async () => {
    await store.writeSession({ accessToken: 'A1', refreshToken: 'R1' });
    legacy('OLD_A', 'OLD_R'); // a device that upgraded but never launched since

    await store.clearStoredSession();

    expect(secure.size).toBe(0);
    expect([...async_.keys()]).toEqual([]);
  });

  it('still clears the legacy keys when the keychain is empty', async () => {
    legacy('OLD_A', 'OLD_R');
    await store.clearStoredSession();
    expect([...async_.keys()]).toEqual([]);
  });
});

describe('failure is closed, never quietly downgraded', () => {
  it('throws rather than writing the token somewhere weaker', async () => {
    secureFails = 'write';
    await expect(store.writeSession({ accessToken: 'A', refreshToken: 'R' })).rejects.toThrow(
      store.TokenStoreUnavailable,
    );
    expect([...async_.keys()], 'no consolation copy').toEqual([]);
  });

  /**
   * Negative control for the rule itself. The error a failed write raises must
   * not carry the value — error messages reach crash reporters, `console` in a
   * dev build, and any handler that renders `err.message` on screen.
   */
  it('never puts a token value in the error it throws', async () => {
    secureFails = 'write';
    const err = await store
      .writeSession({ accessToken: 'SECRET_ACCESS', refreshToken: 'SECRET_REFRESH' })
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toContain('SECRET');
    expect(JSON.stringify(err, Object.getOwnPropertyNames(err))).not.toContain('SECRET');
  });

  it('has no console call anywhere in the auth path', () => {
    for (const f of ['src/api/token-store.ts', 'src/api/client.ts', 'src/state/app-store.tsx']) {
      const src = readFileSync(join(ROOT, 'apps/mobile', f), 'utf8');
      expect(src, `${f} logs`).not.toMatch(/console\.(log|warn|error|debug|info)\(/);
    }
  });
});

describe('the browser is handled on purpose, not by accident', () => {
  it('does not persist a token in a browser at all', async () => {
    platform = 'web';
    await store.writeSession({ accessToken: 'A1', refreshToken: 'R1' });
    expect(secure.size, 'no keychain on web').toBe(0);
    expect([...async_.keys()], 'and no localStorage copy either').toEqual([]);
  });

  it('reports that a web session does not survive a reload', () => {
    platform = 'web';
    expect(store.persistsAcrossRestart()).toBe(false);
    platform = 'ios';
    expect(store.persistsAcrossRestart()).toBe(true);
  });

  it('still destroys legacy browser copies the old build left behind', async () => {
    platform = 'web';
    legacy('OLD_A', 'OLD_R');
    expect(await store.readSession()).toBeNull();
    expect([...async_.keys()]).toEqual([]);
  });
});
