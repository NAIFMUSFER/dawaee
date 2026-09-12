import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { resetDatabase, startHarness, type Harness } from './harness.js';

/**
 * The web app is served from the API's own origin.
 *
 * Not a preference. The published-artifact host the app first lived on runs
 * every page under a Content Security Policy that forbids `fetch` to another
 * origin, so the sign-up request never left the browser and no CORS setting on
 * this side could have helped. Serving both from one host removes the problem.
 *
 * These tests pin the two halves of that decision, because breaking either one
 * is silent: an API path that starts answering with HTML would hand a JSON
 * client an unparseable body, and an app path that stops answering with HTML
 * would make every refresh on /today a 404.
 *
 * The document is generated before the harness starts. Production uses this
 * same build script in Docker; testing a checked-in generated snapshot instead
 * can make a green test prove code that production never executes.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const PUBLIC = join(ROOT, 'apps/api/public');
let h: Harness;

beforeAll(async () => {
  execFileSync('bash', [join(ROOT, 'scripts/build-web.sh')], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: 240_000,
  });
  resetDatabase();
  h = await startHarness();
}, 250_000);

afterAll(async () => {
  await h.close();
});

const html = (r: { headers: Record<string, unknown> }) =>
  String(r.headers['content-type'] ?? '').includes('text/html');

describe('serving the web app', () => {
  it('answers the root with the app document', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(html(res)).toBe(true);
    expect(res.body).toContain('<!doctype html>');
  });

  it('answers a client-side route with the same document, so a refresh works', async () => {
    const root = await h.app.inject({ method: 'GET', url: '/' });
    const deep = await h.app.inject({
      method: 'GET',
      url: '/today',
      headers: { accept: 'text/html,application/xhtml+xml' },
    });
    expect(deep.statusCode).toBe(200);
    expect(html(deep)).toBe(true);
    expect(deep.body).toBe(root.body);
  });

  it('never serves the document for an API path, even to a browser', async () => {
    for (const url of ['/v1/nope', '/v1/auth/nope', '/health/nope']) {
      const res = await h.app.inject({
        method: 'GET',
        url,
        headers: { accept: 'text/html,application/xhtml+xml' },
      });
      expect(res.statusCode, url).toBe(404);
      expect(html(res), url).toBe(false);
      expect(res.json().error.code, url).toBe('not_found');
    }
  });

  it('never serves the document to a caller asking for JSON', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/today',
      headers: { accept: 'application/json' },
    });
    expect(res.statusCode).toBe(404);
    expect(html(res)).toBe(false);
  });

  it('does not answer a non-GET with the document', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/today',
      headers: { accept: 'text/html' },
      payload: {},
    });
    expect(res.statusCode).toBe(404);
    expect(html(res)).toBe(false);
  });

  it('asks browsers to revalidate, so a deploy is not stuck behind a cached build', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/' });
    expect(String(res.headers['cache-control'])).toContain('no-cache');
  });

  it('uses the build-emitted hash for the exact inline script CSP', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/' });
    const hash = readFileSync(join(PUBLIC, 'index.html.script-sha256'), 'utf8').trim();
    const csp = String(res.headers['content-security-policy'] ?? '');
    expect(csp).toContain(`script-src 'self' 'sha256-${hash}'`);
    expect(csp).not.toContain("'unsafe-eval'");
  });

  it('ships a build that talks to its own origin rather than a baked-in host', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/' });
    // The client resolves an empty EXPO_PUBLIC_API_URL to window.location.origin.
    // If that inlining ever regresses, the build silently points at localhost.
    expect(res.body).toContain('window.location.origin');
  });
});
