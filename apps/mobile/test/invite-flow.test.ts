import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Caregiver invitation continuity and storage safety.
 *
 * The token is a single-use bearer capability. It must survive the native
 * sign-in detour without falling back to plaintext AsyncStorage.
 */
const ROOT = resolve(import.meta.dirname, '../../..');
const APP_DIR = join(ROOT, 'apps/mobile/app');
const PENDING_INVITE_SOURCE = join(ROOT, 'apps/mobile/src/storage/pending-invite.ts');

const asyncStore = new Map<string, string>();
const secureStore = new Map<string, string>();
let platform = 'ios';
let secureWriteFails = false;

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (k: string) => asyncStore.get(k) ?? null,
    setItem: async (k: string, v: string) => { asyncStore.set(k, v); },
    removeItem: async (k: string) => { asyncStore.delete(k); },
  },
}));

vi.mock('react-native', () => ({
  Platform: { get OS() { return platform; } },
}));

const AFU_DEVICE_ONLY = Symbol('AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY');
const secureOptions: unknown[] = [];

vi.mock('expo-secure-store', () => ({
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: AFU_DEVICE_ONLY,
  getItemAsync: async (k: string, o?: unknown) => {
    secureOptions.push(o);
    return secureStore.get(k) ?? null;
  },
  setItemAsync: async (k: string, v: string, o?: unknown) => {
    secureOptions.push(o);
    if (secureWriteFails) throw new Error('keystore unavailable');
    secureStore.set(k, v);
  },
  deleteItemAsync: async (k: string, o?: unknown) => {
    secureOptions.push(o);
    secureStore.delete(k);
  },
}));

const { stashPendingInvite, peekPendingInvite, clearPendingInvite, landingAfterAuth } =
  await import('../src/storage/pending-invite.js');

beforeEach(async () => {
  platform = 'ios';
  secureWriteFails = false;
  secureOptions.length = 0;
  asyncStore.clear();
  secureStore.clear();
  await clearPendingInvite();
  secureOptions.length = 0;
});

describe('an invitation survives the sign-in detour without plaintext persistence', () => {
  it('sends someone with a waiting invitation back to it, not to Today', async () => {
    await stashPendingInvite('tok-abc');
    expect(await landingAfterAuth()).toBe('/caregiver/accept');
  });

  it('sends everyone else to Today', async () => {
    expect(await landingAfterAuth()).toBe('/(tabs)/today');
  });

  it('keeps the token across the detour rather than consuming it on read', async () => {
    await stashPendingInvite('tok-abc');
    expect(await peekPendingInvite()).toBe('tok-abc');
    expect(await peekPendingInvite()).toBe('tok-abc');
  });

  it('persists the capability in SecureStore, never AsyncStorage', async () => {
    await stashPendingInvite('tok-secret');
    expect([...secureStore.values()]).toContain('tok-secret');
    expect([...asyncStore.values()]).not.toContain('tok-secret');

    const src = readFileSync(PENDING_INVITE_SOURCE, 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '');
    expect(code).not.toMatch(/AsyncStorage\.setItem\s*\(/);
  });

  it('uses the device-only accessibility class for native persistence', async () => {
    await stashPendingInvite('tok-abc');
    await peekPendingInvite();
    for (const option of secureOptions) {
      expect((option as { keychainAccessible?: unknown })?.keychainAccessible).toBe(AFU_DEVICE_ONLY);
    }
  });

  it('migrates the legacy plaintext key once and deletes it', async () => {
    asyncStore.set('dawaee.pendingInvitationToken', 'legacy-token');
    expect(await peekPendingInvite()).toBe('legacy-token');
    expect([...secureStore.values()]).toContain('legacy-token');
    expect(asyncStore.has('dawaee.pendingInvitationToken')).toBe(false);
  });

  it('does not fall back to plaintext when SecureStore cannot write', async () => {
    secureWriteFails = true;
    await stashPendingInvite('memory-only-token');
    expect(await peekPendingInvite()).toBe('memory-only-token');
    expect([...asyncStore.values()]).not.toContain('memory-only-token');
    expect([...secureStore.values()]).not.toContain('memory-only-token');
  });

  it('is memory-only on web and clears any legacy browser copy', async () => {
    platform = 'web';
    asyncStore.set('dawaee.pendingInvitationToken', 'old-browser-token');
    await stashPendingInvite('web-token');
    expect(await peekPendingInvite()).toBe('web-token');
    expect(asyncStore.size).toBe(0);
    expect(secureStore.size).toBe(0);
  });

  it('forgets a token once it is used up', async () => {
    await stashPendingInvite('tok-abc');
    await clearPendingInvite();
    expect(await peekPendingInvite()).toBeNull();
    expect(await landingAfterAuth()).toBe('/(tabs)/today');
    expect(asyncStore.size).toBe(0);
    expect(secureStore.size).toBe(0);
  });
});

/**
 * Nothing may navigate to a screen that does not exist. The one-time-code
 * screens were deleted because no channel can deliver a code; a link left
 * pointing at them is a dead end that renders as a blank "unmatched route".
 */
describe('every internal navigation target exists', () => {
  const screens = (dir: string, prefix = ''): string[] => {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        out.push(...screens(full, `${prefix}/${entry}`));
        continue;
      }
      if (!entry.endsWith('.tsx') || entry.startsWith('_')) continue;
      out.push(`${prefix}/${entry.replace(/\.tsx$/, '')}`);
    }
    return out;
  };

  const files = (dir: string): string[] => {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) out.push(...files(full));
      else if (/\.tsx?$/.test(entry)) out.push(full);
    }
    return out;
  };

  it('routes only to screens that are still there', () => {
    const existing = new Set(screens(APP_DIR));
    const dead: string[] = [];

    for (const file of [...files(APP_DIR), ...files(join(ROOT, 'apps/mobile/src'))]) {
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(/router\.(?:push|replace)\(\s*'(\/[^'`$]*)'/g)) {
        const target = (m[1] ?? '').split('?')[0] ?? '';
        if (target === '/' || target === '') continue;
        const matches = [...existing].some(
          (screen) => screen === target || screen.replace(/\/index$/, '') === target,
        );
        if (!matches) dead.push(`${relative(ROOT, file)} → ${target}`);
      }
    }

    expect(dead, `these navigate to screens that do not exist:\n${dead.join('\n')}`).toEqual([]);
  });

  it('has actually deleted the code screens, so nothing can drift back to them', () => {
    const all = screens(APP_DIR);
    expect(all).not.toContain('/(auth)/phone');
    expect(all).not.toContain('/(auth)/otp');
  });
});
