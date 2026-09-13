import Fastify from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const COMMIT = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const h = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock('../src/lib/db.js', () => ({
  getPool: () => ({ query: h.query }),
}));

vi.mock('../src/lib/schema-contract.js', () => ({
  requiredSchemaRevision: () => '0049_caregiver_digest_permission_revocation.sql',
  checkSchemaContract: vi.fn(async () => ({
    ok: true,
    revision: '0049_caregiver_digest_permission_revocation.sql',
    missing: [],
    mismatched: [],
  })),
}));

vi.mock('../src/config.js', () => ({
  loadConfig: () => ({ NODE_ENV: 'production' }),
}));

import { registerHealthRoutes } from '../src/routes/health.js';

let app: ReturnType<typeof Fastify>;
let workerRows: Array<{
  job_name: string;
  started_at: Date;
  succeeded: boolean;
  build_commit: string;
}> = [];

describe('production readiness covers every per-tick safety-critical worker prerequisite', () => {
  beforeAll(async () => {
    vi.stubEnv('RENDER_GIT_COMMIT', COMMIT);
    h.query.mockImplementation(async (sqlLike: unknown) => {
      const sql = String(sqlLike);
      if (sql.includes('SELECT 1')) return { rows: [{ ok: 1 }] };
      if (sql.includes('FROM job_runs')) return { rows: workerRows };
      throw new Error(`unexpected readiness query: ${sql}`);
    });

    app = Fastify();
    registerHealthRoutes(app, {
      push: { name: 'expo' },
      ocr: { name: 'google_vision' },
      storage: { name: 's3' },
    } as never);
    await app.ready();
  });

  beforeEach(() => {
    workerRows = [
      { job_name: 'materialize', started_at: new Date(), succeeded: true, build_commit: COMMIT },
      { job_name: 'reminders', started_at: new Date(), succeeded: true, build_commit: COMMIT },
      { job_name: 'dispatch', started_at: new Date(), succeeded: true, build_commit: COMMIT },
      { job_name: 'mark-missed', started_at: new Date(), succeeded: true, build_commit: COMMIT },
      { job_name: 'stock-alerts', started_at: new Date(), succeeded: true, build_commit: COMMIT },
      { job_name: 'digests', started_at: new Date(), succeeded: true, build_commit: COMMIT },
    ];
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await app.close();
  });

  it('returns 503 when materialize failed even though reminders is fresh and successful', async () => {
    workerRows = workerRows.map((row) => row.job_name === 'materialize' ? { ...row, succeeded: false } : row);

    const response = await app.inject({ method: 'GET', url: '/health/ready' });

    expect(response.statusCode, response.body).toBe(503);
    const body = response.json<{ checks: Record<string, { ok: boolean; detail?: string }> }>();
    expect(body.checks.worker?.ok).toBe(false);
    expect(body.checks.worker?.detail).toMatch(/materialize/i);
  });

  it('returns 503 when dispatch failed even though materialize and reminders are healthy', async () => {
    workerRows = workerRows.map((row) => row.job_name === 'dispatch' ? { ...row, succeeded: false } : row);

    const response = await app.inject({ method: 'GET', url: '/health/ready' });

    expect(response.statusCode, response.body).toBe(503);
    const body = response.json<{ checks: Record<string, { ok: boolean; detail?: string }> }>();
    expect(body.checks.worker?.ok).toBe(false);
    expect(body.checks.worker?.detail).toMatch(/dispatch/i);
  });

  it('returns 503 when mark-missed failed even though the delivery pipeline is healthy', async () => {
    workerRows = workerRows.map((row) => row.job_name === 'mark-missed' ? { ...row, succeeded: false } : row);

    const response = await app.inject({ method: 'GET', url: '/health/ready' });

    expect(response.statusCode, response.body).toBe(503);
    const body = response.json<{ checks: Record<string, { ok: boolean; detail?: string }> }>();
    expect(body.checks.worker?.ok).toBe(false);
    expect(body.checks.worker?.detail).toMatch(/mark-missed/i);
  });

  it('returns 503 when stock alerts failed even though dose reminders and dispatch are healthy', async () => {
    workerRows = workerRows.map((row) => row.job_name === 'stock-alerts' ? { ...row, succeeded: false } : row);

    const response = await app.inject({ method: 'GET', url: '/health/ready' });

    expect(response.statusCode, response.body).toBe(503);
    const body = response.json<{ checks: Record<string, { ok: boolean; detail?: string }> }>();
    expect(body.checks.worker?.ok).toBe(false);
    expect(body.checks.worker?.detail).toMatch(/stock-alerts/i);
  });

  it('returns 503 when caregiver digests fail while the rest of the tick stays healthy', async () => {
    workerRows = workerRows.map((row) => row.job_name === 'digests' ? { ...row, succeeded: false } : row);

    const response = await app.inject({ method: 'GET', url: '/health/ready' });

    expect(response.statusCode, response.body).toBe(503);
    const body = response.json<{ checks: Record<string, { ok: boolean; detail?: string }> }>();
    expect(body.checks.worker?.ok).toBe(false);
    expect(body.checks.worker?.detail).toMatch(/digests/i);
  });
});