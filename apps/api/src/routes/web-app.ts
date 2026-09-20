import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import type { Config } from '../config.js';

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
 * The entry bundle is a single self-contained HTML file with its JavaScript and
 * images inlined. The build also emits the SHA-256 of the exact inline script
 * body as a tiny sidecar, so the server can construct CSP without reparsing
 * executable HTML. Regenerate both with `scripts/build-web.sh`.
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

function checkedScriptHash(raw: string): string {
  const hash = raw.trim();
  const decoded = Buffer.from(hash, 'base64');
  if (decoded.length !== 32 || decoded.toString('base64') !== hash) {
    throw new Error('invalid web bundle script SHA-256 sidecar');
  }
  return hash;
}

/** The Content Security Policy for the app document. */
export function buildCsp(scriptHash: string, storage?: Pick<Config, 'STORAGE_PROVIDER' | 'STORAGE_ENDPOINT' | 'STORAGE_REGION'>): string {
  // Only the configured private object-store origin may receive signed image
  // requests. Never allow arbitrary HTTPS hosts or interpolate endpoint paths,
  // credentials or query strings into the policy.
  let storageSource = '';
  if (storage && ['s3', 'r2'].includes(storage.STORAGE_PROVIDER)) {
    const endpoint = new URL(storage.STORAGE_ENDPOINT ?? `https://s3.${storage.STORAGE_REGION}.amazonaws.com`);
    if (!['https:', 'http:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) {
      throw new Error('invalid image storage origin');
    }
    storageSource = ` ${endpoint.origin}`;
  }
  return [
    "default-src 'none'",
    `script-src 'self' 'sha256-${scriptHash}'`,
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob:${storageSource}`,
    "font-src 'self' data:",
    // ImagePicker returns local data/blob URIs which fetch converts to bytes.
    `connect-src 'self' data: blob:${storageSource}`,
    "manifest-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ].join('; ');
}

let csp = '';

export async function registerWebAppRoutes(app: FastifyInstance, storage?: Pick<Config, 'STORAGE_PROVIDER' | 'STORAGE_ENDPOINT' | 'STORAGE_REGION'>): Promise<void> {
  const bundlePath = await locateBundle();

  if (!bundlePath) {
    app.log.info('no web bundle found; serving the API only');
    return;
  }

  bundle = await readFile(bundlePath);
  const scriptHash = checkedScriptHash(
    await readFile(`${bundlePath}.script-sha256`, 'utf8'),
  );
  csp = buildCsp(scriptHash, storage);

  app.get('/', async (_req, reply) => sendWebBundle(reply));

  // `/app` used to serve the same document while leaving the browser URL at
  // `/app`. Expo Router then tried to resolve `/app` as an application route
  // and rendered its Unmatched Route screen. Keep old bookmarks working, but
  // canonicalise to the router's real root before the document boots.
  app.get('/app', async (_req, reply) => reply.redirect('/'));

  await registerChunks(app, dirname(bundlePath));
}

async function registerChunks(app: FastifyInstance, publicDir: string): Promise<void> {
  const dir = join(publicDir, '_expo/static/js/web');
  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith('.js'));
  } catch {
    return;
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

let bundle: Buffer | null = null;

export function hasWebBundle(): boolean {
  return bundle !== null;
}

export function sendWebBundle(reply: import('fastify').FastifyReply): import('fastify').FastifyReply {
  return reply
    .type('text/html; charset=utf-8')
    .header('content-security-policy', csp)
    .header('cache-control', 'no-cache')
    .send(bundle);
}
