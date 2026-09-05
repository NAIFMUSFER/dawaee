import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The caregiver invitation, which was broken in three places at once — each
 * one hidden behind the previous.
 *
 *  1. `/invite/<token>` had no screen at all, so the link dead-ended on
 *     "Unmatched Route". Fixed earlier; pinned by links-resolve.test.ts.
 *  2. With that fixed, the recipient reached the accept screen and its
 *     "sign in" button sent them to the one-time-code screen — a path whose
 *     request endpoint refuses, because no channel can deliver a code. Found
 *     by opening a real invitation on a real phone.
 *  3. And underneath both: the token was stashed before the sign-in detour and
 *     nothing ever read it back. Even signing in correctly landed the person on
 *     Today with the invitation sitting in storage forever.
 *
 * Each of those made the care circle impossible to form, which means every
 * escalation past the patient had nobody to reach.
 */
const ROOT = resolve(import.meta.dirname, '../../..');
const APP_DIR = join(ROOT, 'apps/mobile/app');

const store = new Map<string, string>();
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (k: string) => store.get(k) ?? null,
    setItem: async (k: string, v: string) => { store.set(k, v); },
    removeItem: async (k: string) => { store.delete(k); },
  },
}));

const { stashPendingInvite, peekPendingInvite, clearPendingInvite, landingAfterAuth } =
  await import('../src/storage/pending-invite.js');

beforeEach(() => store.clear());

describe('an invitation survives the sign-in detour', () => {
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

  /**
   * A spent token must be forgotten. Otherwise it follows the person back to
   * the same dead end after every future sign-in.
   */
  it('forgets a token once it is used up', async () => {
    await stashPendingInvite('tok-abc');
    await clearPendingInvite();
    expect(await peekPendingInvite()).toBeNull();
    expect(await landingAfterAuth()).toBe('/(tabs)/today');
  });
});

/**
 * Nothing may navigate to a screen that does not exist. The one-time-code
 * screens were deleted because no channel can deliver a code; a link left
 * pointing at them is a dead end that renders as a blank "unmatched route",
 * which is exactly how the invitation failure looked to the person holding it.
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
      // Literal router targets only; templated ones carry an id we cannot check.
      for (const m of src.matchAll(/router\.(?:push|replace)\(\s*'(\/[^'`$]*)'/g)) {
        // A query string is arguments, not a different screen.
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
