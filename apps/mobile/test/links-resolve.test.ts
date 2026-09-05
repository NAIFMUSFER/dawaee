import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every link the server hands out must land on a screen that exists.
 *
 * Two did not, for the entire life of the project, and both failed at the
 * worst possible moment:
 *
 *  - `/invite/<token>`, built by the caregiver invitation route, had no
 *    screen. The family member who received the invitation reached
 *    "Unmatched Route", so the care circle could not be formed at all — and
 *    every escalation past the patient therefore had nobody to reach.
 *  - `/e/<token>`, encoded into the emergency QR, had no screen. A paramedic
 *    scanning an unconscious patient's card got a blank error instead of
 *    blood type, allergies and contacts.
 *
 * Neither is visible from the server side: the route builds a correct-looking
 * URL, and nothing checks that the other half exists. So this test reads the
 * URLs the API actually constructs and asserts expo-router has a file for
 * each — from both directions, so a screen renamed or a URL changed breaks
 * here rather than in someone's hands.
 */
const ROOT = resolve(import.meta.dirname, '../../..');
const APP_DIR = join(ROOT, 'apps/mobile/app');

/** Every route expo-router will serve, as a matchable pattern. */
function routePatterns(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      // A (group) directory does not appear in the URL.
      const segment = entry.startsWith('(') && entry.endsWith(')') ? '' : `/${entry}`;
      out.push(...routePatterns(full, prefix + segment));
      continue;
    }
    if (!entry.endsWith('.tsx') || entry.startsWith('_')) continue;
    const name = entry.replace(/\.tsx$/, '');
    if (name === 'index') { out.push(prefix || '/'); continue; }
    out.push(`${prefix}/${name}`);
  }
  return out;
}

const ROUTES = routePatterns(APP_DIR);

/** Turns `/invite/[token]` into a regex that matches `/invite/anything`. */
const matcher = (pattern: string) =>
  new RegExp(`^${pattern.replace(/\[[^\]]+\]/g, '[^/]+').replace(/\//g, '\\/')}$`);

const resolves = (path: string) => ROUTES.some((r) => matcher(r).test(path));

/**
 * The paths the API builds from PUBLIC_APP_URL, read out of the source rather
 * than restated here — a URL changed in the route must break this test.
 */
function publicPathsBuiltByTheApi(): Array<{ file: string; path: string }> {
  const found: Array<{ file: string; path: string }> = [];
  const dir = join(ROOT, 'apps/api/src/routes');
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith('.ts')) continue;
    const src = readFileSync(join(dir, entry), 'utf8');
    for (const m of src.matchAll(/PUBLIC_APP_URL\}(\/[A-Za-z0-9\-_/]*)/g)) {
      found.push({ file: relative(ROOT, join(dir, entry)), path: m[1] ?? '' });
    }
  }
  return found;
}

describe('links the server hands out', () => {
  it('finds the paths the API builds, so this test cannot pass vacuously', () => {
    const paths = publicPathsBuiltByTheApi();
    expect(paths.length).toBeGreaterThan(0);
  });

  it('every one of them resolves to a screen', () => {
    for (const { file, path } of publicPathsBuiltByTheApi()) {
      // `${PUBLIC_APP_URL}/invite/` + token — the trailing segment is the value.
      const withToken = path.endsWith('/') ? `${path}TOKEN` : path;
      expect(resolves(withToken), `${file} builds ${withToken}, which no screen serves`).toBe(true);
    }
  });

  it('serves the two links whose absence broke invitations and the emergency card', () => {
    expect(resolves('/invite/abc123')).toBe(true);
    expect(resolves('/e/abc123')).toBe(true);
  });

  it('still does not pretend to serve a path nobody defined', () => {
    expect(resolves('/definitely-not-a-screen')).toBe(false);
  });
});
