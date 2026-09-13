#!/usr/bin/env node
/**
 * Build the browser bundle only for the isolated Render audit preview.
 *
 * The canonical production image already builds the same-origin web artefact in
 * Docker's dedicated `web` stage. The native-node preview does not use that
 * Dockerfile, so its ordinary `npm run build` previously produced API/worker
 * JavaScript only and the running server logged "no web bundle found".
 *
 * This hook is intentionally inert everywhere except the exact audit preview
 * service. It runs during Render's build phase, never during application
 * startup, so a free-instance wake does not reinstall Expo dependencies.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PREVIEW_SERVICE = 'srv-daipkbuk1f9s73952trg';
const PREVIEW_ORIGIN = 'https://dawaee-audit-preview.onrender.com';

export function previewDecision(env) {
  if (env.RENDER_SERVICE_ID !== PREVIEW_SERVICE) return 'skip';
  if (env.RENDER_EXTERNAL_URL && env.RENDER_EXTERNAL_URL !== PREVIEW_ORIGIN) {
    throw new Error('AUDIT_PREVIEW_WEB_ORIGIN_MISMATCH');
  }
  return 'build';
}

function buildEnvironment(env) {
  const out = {};
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'CI', 'NODE_ENV',
    'NPM_CONFIG_CACHE', 'npm_config_cache']) {
    if (env[key] !== undefined) out[key] = env[key];
  }
  out.API_URL = '';
  return out;
}

function requireCommand(command, args = ['--version']) {
  const check = spawnSync(command, args, { cwd: ROOT, encoding: 'utf8', env: buildEnvironment(process.env) });
  if (check.status !== 0) throw new Error(`AUDIT_PREVIEW_WEB_MISSING_${command.toUpperCase()}`);
}

export function selfTest() {
  let assertions = 0;
  assert.equal(previewDecision({}), 'skip'); assertions++;
  assert.equal(previewDecision({ RENDER_SERVICE_ID: 'srv-dad9mvf10e5c73dva9vg' }), 'skip'); assertions++;
  assert.equal(previewDecision({ RENDER_SERVICE_ID: PREVIEW_SERVICE }), 'build'); assertions++;
  assert.equal(previewDecision({ RENDER_SERVICE_ID: PREVIEW_SERVICE, RENDER_EXTERNAL_URL: PREVIEW_ORIGIN }), 'build'); assertions++;
  assert.throws(
    () => previewDecision({ RENDER_SERVICE_ID: PREVIEW_SERVICE, RENDER_EXTERNAL_URL: 'https://dawaee-api.onrender.com' }),
    /AUDIT_PREVIEW_WEB_ORIGIN_MISMATCH/,
  ); assertions++;
  const env = buildEnvironment({ PATH: '/bin', HOME: '/tmp', DATABASE_URL: 'must-not-copy', JWT_SECRET: 'must-not-copy' });
  assert.equal(env.PATH, '/bin'); assertions++;
  assert.equal(env.HOME, '/tmp'); assertions++;
  assert.equal(env.API_URL, ''); assertions++;
  assert.equal('DATABASE_URL' in env, false); assertions++;
  assert.equal('JWT_SECRET' in env, false); assertions++;
  console.log(`AUDIT_PREVIEW_WEB_GUARDS: ${assertions} assertions passed`);
}

async function main() {
  if (process.argv.includes('--self-test')) {
    selfTest();
    return;
  }

  if (previewDecision(process.env) === 'skip') {
    console.log('AUDIT_PREVIEW_WEB_BUILD_SKIPPED');
    return;
  }

  requireCommand('bash');
  requireCommand('python3');

  const run = spawnSync('bash', ['scripts/build-web.sh'], {
    cwd: ROOT,
    env: buildEnvironment(process.env),
    stdio: 'inherit',
  });
  if (run.status !== 0) throw new Error('AUDIT_PREVIEW_WEB_BUILD_FAILED');

  const document = resolve(ROOT, 'apps/api/public/index.html');
  const sidecar = `${document}.script-sha256`;
  if (!existsSync(document) || !existsSync(sidecar)) {
    throw new Error('AUDIT_PREVIEW_WEB_OUTPUT_MISSING');
  }
  console.log('AUDIT_PREVIEW_WEB_READY same-origin bundle generated');
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : 'AUDIT_PREVIEW_WEB_BUILD_FAILED';
  console.error(/^AUDIT_PREVIEW_WEB_[A-Z0-9_]+$/.test(message) ? message : 'AUDIT_PREVIEW_WEB_BUILD_FAILED');
  process.exit(1);
});
