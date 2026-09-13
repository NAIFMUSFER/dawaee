import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every link the server hands out must land on a screen that exists.
 *
 * Two capability link families are pinned here:
 *
 *  - `/invite#<token>`, built by the caregiver invitation route, must land on
 *    the fixed `/invite` screen. The bearer lives in the URL fragment so it is
 *    not sent in the HTTP request path/query or ordinary access logs. The old
 *    `/invite/<token>` route remains only for already-issued links.
 *  - `/e#<token>`, encoded into the emergency QR, must land on the fixed `/e`
 *    screen. Its bearer uses the same fragment-only transport boundary.
 *
 * Neither is visible from the server side alone: a route can build a
 * correct-looking URL while expo-router has no matching screen. This test
 * therefore reads the URLs the API actually constructs and asserts that the
 * path portion resolves in the mobile/web router.
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

/** Match Expo Router's single-segment `[param]` convention without compiling
 * repository-derived route text into a regular expression. Static segments are
 * compared literally, including characters that are regexp metacharacters. */
function matchesRoutePattern(pattern: string, path: string): boolean {
  // Preserve empty segments: this is an exact-path assertion, not URL
  // normalization. Dropping them invents root, relative and extra-slash matches.
  const expected = pattern.split('/');
  const actual = path.split('/');
  if (expected.length !== actual.length) return false;
  return expected.every((segment, index) => {
    const dynamic = segment.startsWith('[') && segment.endsWith(']') && segment.length > 2;
    return dynamic ? (actual[index]?.length ?? 0) > 0 : segment === actual[index];
  });
}

const resolves = (path: string) => ROUTES.some((route) => matchesRoutePattern(route, path));

/**
 * The paths the API builds from PUBLIC_APP_URL, read out of the source rather
 * than restated here — a URL changed in the route must break this test.
 * Fragments are intentionally excluded because routing depends on pathname;
 * the capability-transport suites separately pin fragment handling.
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
      expect(resolves(path), `${file} builds ${path}, which no screen serves`).toBe(true);
    }
  });

  it('matches dynamic segments but keeps static route text literal', () => {
    expect(matchesRoutePattern('/invite/[token]', '/invite/a+b')).toBe(true);
    expect(matchesRoutePattern('/literal.+', '/literal.+')).toBe(true);
    expect(matchesRoutePattern('/literal.+', '/literalXYZ')).toBe(false);
    expect(matchesRoutePattern('/invite/[token]', '/invite/')).toBe(false);
  });

  it('serves fixed fragment-entry paths and legacy caregiver links', () => {
    expect(resolves('/invite')).toBe(true);
    expect(resolves('/e')).toBe(true);
    // Keep the old caregiver route only so already-issued invitation links do
    // not break. New links are pinned to fragment transport elsewhere.
    expect(resolves('/invite/abc123')).toBe(true);
    // The old emergency path-token transport must stay absent.
    expect(resolves('/e/abc123')).toBe(false);
  });

  it('still does not pretend to serve a path nobody defined', () => {
    expect(resolves('/definitely-not-a-screen')).toBe(false);
  });
});

// Test the assertion itself: regexp metacharacters in literal filenames must
// neither invent a route nor prevent the actual literal route from matching.
describe('route matcher literal and parameter boundaries', () => {
  const literals: Array<[string, string]> = [
    ['/reports/v1.0', '/reports/v1X0'],
    ['/reports/a+b', '/reports/aaab'],
    ['/reports/a(b)', '/reports/ab'],
    ['/reports/a|b', 'b'],
    ['/reports/price$', '/reports/price'],
    ['/reports/a^b', '/reports/ab'],
    ['/reports/a{2}', '/reports/aa'],
    ['/reports/a?b', '/reports/b'],
    ['/reports/a\\b', '/reports/ab'],
    ['/e', '/e\n'],
  ];
  for (const [literal, lookalike] of literals) {
    it(`matches only the literal route ${JSON.stringify(literal)}`, () => {
      expect(matchesRoutePattern(literal, literal)).toBe(true);
      expect(matchesRoutePattern(literal, lookalike)).toBe(false);
    });
  }
  const boundaries: Array<[string, string, boolean]> = [
    ['/', '/', true],
    ['/', '', false],
    ['/', '//', false],
    ['/invite/[token]', '/invite/TOKEN', true],
    ['/invite/[token]', '/invite/', false],
    ['/invite/[token]', 'invite/TOKEN', false],
    ['/invite/[token]', '/invite//TOKEN', false],
    ['/invite/[token]', '/invite/TOKEN/extra', false],
    ['/invite/[token]', '/other/TOKEN', false],
    ['/medication/[id]', '/medication/abc-123', true],
    ['/reports/v1.0/[id]', '/reports/v1.0/abc', true],
    ['/reports/v1.0/[id]', '/reports/v1X0/abc', false],
    ['/e', '/e/SECRET', false],
    ['/reports/index', '/reports/index/', false],
  ];
  for (const [pattern, path, expected] of boundaries) {
    it(`matches ${pattern} against ${JSON.stringify(path)}: ${expected}`, () => {
      expect(matchesRoutePattern(pattern, path)).toBe(expected);
    });
  }
});
