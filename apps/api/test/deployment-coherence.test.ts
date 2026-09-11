import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assessWorkerHeartbeat, runtimeCommit } from '../src/lib/deployment-coherence.js';

const NOW = new Date('2026-09-09T00:00:00.000Z');
const API = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const WORKER = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const ROOT = resolve(import.meta.dirname, '../../..');

describe('P20 deployment coherence: API readiness includes the worker release', () => {
  it('accepts a fresh successful heartbeat from the same commit', () => {
    expect(assessWorkerHeartbeat({
      apiCommit: API,
      heartbeat: { startedAt: new Date(NOW.getTime() - 60_000), succeeded: true, buildCommit: API },
      now: NOW,
    }).ok).toBe(true);
  });

  it('refuses the exact production drift this audit found: current API, older worker', () => {
    const check = assessWorkerHeartbeat({
      apiCommit: API,
      heartbeat: { startedAt: new Date(NOW.getTime() - 10_000), succeeded: true, buildCommit: WORKER },
      now: NOW,
    });
    expect(check.ok).toBe(false);
    expect(check.detail).toMatch(/commit mismatch/i);
  });

  it('refuses a worker too old to be considered alive', () => {
    const check = assessWorkerHeartbeat({
      apiCommit: API,
      heartbeat: { startedAt: new Date(NOW.getTime() - 181_000), succeeded: true, buildCommit: API },
      now: NOW,
    });
    expect(check.ok).toBe(false);
    expect(check.detail).toMatch(/stale/i);
  });

  it('refuses a failed reminder run even if it is fresh and from the same build', () => {
    const check = assessWorkerHeartbeat({
      apiCommit: API,
      heartbeat: { startedAt: NOW, succeeded: false, buildCommit: API },
      now: NOW,
    });
    expect(check.ok).toBe(false);
    expect(check.detail).toMatch(/failed/i);
  });

  it('refuses a pre-fix worker that records no build identity', () => {
    expect(assessWorkerHeartbeat({
      apiCommit: API,
      heartbeat: { startedAt: NOW, succeeded: true, buildCommit: null },
      now: NOW,
    }).ok).toBe(false);
  });

  it('uses Render build identity first and rejects arbitrary reflected values', () => {
    expect(runtimeCommit({ RENDER_GIT_COMMIT: API, GIT_COMMIT: WORKER })).toBe(API);
    expect(runtimeCommit({ RENDER_GIT_COMMIT: '<script>', GIT_COMMIT: 'refs/heads/main' })).toBe('unknown');
  });

  it('the worker persists its build identity and production readiness reads every critical job', () => {
    const worker = readFileSync(resolve(ROOT, 'apps/worker/src/context.ts'), 'utf8');
    const health = readFileSync(resolve(ROOT, 'apps/api/src/routes/health.ts'), 'utf8');
    expect(worker).toContain('buildCommit = runtimeCommit()');
    expect(worker).toContain('JSON.stringify({ buildCommit })');
    expect(health).toContain("const REQUIRED_WORKER_JOBS = ['materialize', 'reminders', 'dispatch']");
    expect(health).toContain("metadata->>'buildCommit'");
    expect(health).toContain('checks.worker = failures.length === 0');
  });

  it('runtime authenticates with the same worker secret that pre-deploy writes to Postgres', () => {
    const worker = readFileSync(resolve(ROOT, 'apps/worker/src/context.ts'), 'utf8');
    const migrate = readFileSync(resolve(ROOT, 'scripts/migrate.sh'), 'utf8');
    expect(migrate).toContain("ALTER ROLE dawaee_worker WITH PASSWORD '${DAWAEE_WORKER_PASSWORD");
    expect(worker).toContain('process.env.DAWAEE_WORKER_PASSWORD');
    expect(worker.indexOf('process.env.DAWAEE_WORKER_PASSWORD'))
      .toBeLessThan(worker.indexOf('config.DATABASE_ROLE_PASSWORD'));
  });

  it('production API compute cannot be configured to spin down between medication requests', () => {
    const blueprint = readFileSync(resolve(ROOT, 'render.yaml'), 'utf8');
    const apiSection = blueprint.split('name: dawaee-api')[1]?.split('name: dawaee-worker')[0] ?? '';
    expect(apiSection, 'dawaee-api is missing from render.yaml').not.toBe('');
    expect(apiSection, 'the medication API must not use sleeping free compute').not.toMatch(/\bplan:\s*free\b/);
    expect(apiSection, 'the production API should use the same always-on Starter class as the worker').toMatch(/\bplan:\s*starter\b/);
  });
});