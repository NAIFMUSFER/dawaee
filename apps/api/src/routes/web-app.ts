import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';

/**
 * Serves the web build of the app from the API's own origin.
 *
 * Not a convenience. A browser build hosted anywhere else has to reach the API
 * cross-origin, and the two places this app would otherwise live — a published
 * artifact page, or any static host — sit behind a Content Security Policy that
 * forbids `fetch` to another origin outright. The request never leaves the
 * page, so no amount of CORS configuration on this side can help. Same origin
 * removes the problem rather than negotiating with it, and removes preflight
 * round-trips on every call as a side effect.
 *
 * The bundle is a single self-contained HTML file with its JavaScript and
 * images inlined, so this is one route and one file rather than a static
 * server. Regenerate it with `scripts/build-web.sh`.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const CANDIDATES = [
  join(HERE, '../../public/index.html'),   // running from dist/
  join(HERE, '../../../public/index.html'),
];

async function locateBundle(): Promise<string | null> {
  for (const path of CANDIDATES) {
    try {
      const s = await stat(path);
      if (s.isFile()) return path;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

/**
 * The Content Security Policy for the app document.
 *
 * The API's own policy is `default-src 'none'`, which is right for a JSON
 * endpoint and fatal for a page: it would block the bundle's own inline
 * script and the document would render blank with no request failing and
 * nothing in the server log. So the page carries its own policy, and it is
 * built from hashes of the exact scripts in the file rather than from
 * `'unsafe-inline'` — the content is fixed at build time, so there is no
 * reason to accept any other script.
 *
 * `style-src` is the one place `'unsafe-inline'` remains: React Native Web
 * injects its stylesheet at runtime, and a hash cannot cover text the page
 * has not written yet. `connect-src 'self'` is the same-origin rule this
 * whole arrangement exists to satisfy, stated as a policy rather than a hope.
 */
function buildCsp(html: string): string {
  const hashes = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(
    (m) => `'sha256-${createHash('sha256').update(m[1] ?? '', 'utf8').digest('base64')}'`,
  );
  return [
    "default-src 'none'",
    // 'self' covers the lazily-loaded chunks, which are served from this
    // origin under their build-time hashed names.
    `script-src 'self' ${hashes.join(' ')}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "manifest-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ].join('; ');
}

let csp = '';

export async function registerWebAppRoutes(app: FastifyInstance): Promise<void> {
  const bundlePath = await locateBundle();

  if (!bundlePath) {
    // An API-only deployment is a legitimate configuration; say so plainly
    // rather than serving a 404 that looks like a broken build.
    app.log.info('no web bundle found; serving the API only');
    return;
  }

  bundle = await readFile(bundlePath);
  csp = buildCsp(bundle.toString('utf8'));

  app.get('/', async (_req, reply) => sendWebBundle(reply));
  app.get('/app', async (_req, reply) => sendWebBundle(reply));

  await registerChunks(app, dirname(bundlePath));
}

/**
 * The lazily-imported JavaScript chunks Metro emits alongside the entry bundle.
 *
 * Read into memory once at boot from a fixed directory and served by exact
 * name — never by joining a request path onto a directory, which is how a
 * static handler becomes a path-traversal bug. A name that is not in the map
 * is simply not a route.
 *
 * The names carry a content hash, so a chunk that exists is immutable and can
 * be cached hard; only the document that names them must revalidate.
 */
async function registerChunks(app: FastifyInstance, publicDir: string): Promise<void> {
  const dir = join(publicDir, '_expo/static/js/web');
  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith('.js'));
  } catch {
    return; // a build with nothing lazily loaded
  }

  for (const name of names) {
    const body = await readFile(join(dir, name));
    app.get(`/_expo/static/js/web/${name}`, async (_req, reply) =>
      reply
        .type('application/javascript; charset=utf-8')
        .header('cache-control', 'public, max-age=31536000, immutable')
        .send(body),
    );
  }
  app.log.info({ count: names.length }, 'serving lazily-loaded web chunks');
}

/**
 * The loaded bundle, or null on an API-only deployment.
 *
 * Read by the not-found handler rather than registered as a second one:
 * expo-router uses history paths, so refreshing on /today must return this
 * same document instead of a 404, and Fastify permits only one such handler.
 */
let bundle: Buffer | null = null;

export function hasWebBundle(): boolean {
  return bundle !== null;
}

export function sendWebBundle(reply: import('fastify').FastifyReply): import('fastify').FastifyReply {
  return reply
    .type('text/html; charset=utf-8')
    // Replaces the API-wide `default-src 'none'`, which would leave the page
    // blank. See buildCsp.
    .header('content-security-policy', csp)
    // The filename never changes, so this must not be cached hard: a patient
    // left holding a stale build would keep talking to an older API.
    .header('cache-control', 'no-cache')
    .send(bundle);
}
