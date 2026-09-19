import Fastify from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const COMMIT = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const h = vi.hoisted(() => ({ query: vi.fn(), env: 'production', workerRequired: false }));
vi.mock('../src/lib/db.js', () => ({ getPool: () => ({ query: h.query }) }));
vi.mock('../src/lib/schema-contract.js', () => ({
  requiredSchemaRevision: () => '0049_caregiver_digest_permission_revocation.sql',
  checkSchemaContract: vi.fn(async () => ({ ok: true, revision: '0049_caregiver_digest_permission_revocation.sql', missing: [], mismatched: [] })),
}));
vi.mock('../src/config.js', () => ({ loadConfig: () => ({ NODE_ENV: h.env, WORKER_READINESS_REQUIRED: h.workerRequired }) }));
import { registerHealthRoutes } from '../src/routes/health.js';

let app: ReturnType<typeof Fastify>;
let workerRows: Array<{ job_name: string; started_at: Date; succeeded: boolean; build_commit: string }> = [];

function expectPublicReady(bodyText: string): void {
  const body = JSON.parse(bodyText) as Record<string, unknown>;
  expect(body.status).toBe('ready');
  expect(typeof body.time).toBe('string');
  expect(Object.keys(body).sort()).toEqual(['status', 'time']);
}
function expectPublicWorkerFailure(bodyText: string): void {
  const body = JSON.parse(bodyText) as Record<string, unknown>;
  expect(body.status).toBe('degraded');
  expect(body.failedChecks).toEqual(['worker']);
  expect(typeof body.time).toBe('string');
  expect(Object.keys(body).sort()).toEqual(['failedChecks', 'status', 'time']);
  for (const marker of ['materialize', 'dispatch', 'mark-missed', 'stock-alerts', 'digests', COMMIT, 'commit mismatch']) {
    expect(bodyText).not.toContain(marker);
  }
}

describe('production readiness covers reminders and account erasure', () => {
  beforeAll(async () => {
    vi.stubEnv('RENDER_GIT_COMMIT', COMMIT);
    h.query.mockImplementation(async (sqlLike: unknown) => {
      const sql = String(sqlLike);
      if (sql.includes('SELECT 1')) return { rows: [{ ok: 1 }] };
      if (sql.includes('FROM job_runs')) return { rows: workerRows };
      throw new Error(`unexpected readiness query: ${sql}`);
    });
    app = Fastify();
    registerHealthRoutes(app, { push: { name: 'expo' }, ocr: { name: 'google_vision' }, storage: { name: 's3' } } as never);
    await app.ready();
  });

  beforeEach(() => {
    h.env = 'production';
    h.workerRequired = false;
    workerRows = [
      { job_name: 'materialize', started_at: new Date(), succeeded: true, build_commit: COMMIT },
      { job_name: 'reminders', started_at: new Date(), succeeded: true, build_commit: COMMIT },
      { job_name: 'dispatch', started_at: new Date(), succeeded: true, build_commit: COMMIT },
      { job_name: 'mark-missed', started_at: new Date(), succeeded: true, build_commit: COMMIT },
      { job_name: 'stock-alerts', started_at: new Date(), succeeded: true, build_commit: COMMIT },
      { job_name: 'digests', started_at: new Date(), succeeded: true, build_commit: COMMIT },
      { job_name: 'housekeeping', started_at: new Date(), succeeded: true, build_commit: COMMIT },
    ];
  });
  afterAll(async () => { vi.unstubAllEnvs(); await app.close(); });

  it.each(['materialize', 'dispatch', 'mark-missed', 'stock-alerts', 'digests', 'housekeeping'])(
    'returns 503 when %s is the only failed prerequisite',
    async (jobName) => {
      workerRows = workerRows.map((row) => row.job_name === jobName ? { ...row, succeeded: false } : row);
      const response = await app.inject({ method: 'GET', url: '/health/ready' });
      expect(response.statusCode, response.body).toBe(503);
      expectPublicWorkerFailure(response.body);
    },
  );

  it('does not report ready when cleanup has never run after a worker restart', async () => {
    workerRows = workerRows.filter(row => row.job_name !== 'housekeeping');
    const response = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(503);
    expectPublicWorkerFailure(response.body);
    expect(response.body).not.toContain('housekeeping');
    const live = await app.inject({ method: 'GET', url: '/health' });
    expect(live.statusCode).toBe(200);
    expect(live.json().status).toBe('ok');
  });

  it('accepts a successful hourly cleanup while per-minute reminder jobs stay fresh', async () => {
    workerRows = workerRows.map(row => row.job_name === 'housekeeping'
      ? { ...row, started_at: new Date(Date.now() - 65 * 60_000) } : row);
    const response = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(200);
    expectPublicReady(response.body);
  });

  it('rejects cleanup that stopped running while reminders still succeed', async () => {
    workerRows = workerRows.map(row => row.job_name === 'housekeeping'
      ? { ...row, started_at: new Date(Date.now() - 121 * 60_000) } : row);
    const response = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(503);
    expectPublicWorkerFailure(response.body);
  });

  it('requires cleanup from the same release as the API', async () => {
    workerRows = workerRows.map(row => row.job_name === 'housekeeping'
      ? { ...row, build_commit: 'b'.repeat(40) } : row);
    const response = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(503);
    expectPublicWorkerFailure(response.body);
  });

  it('requires current successful worker jobs in an opted-in non-production preview', async () => {
    h.env = 'development';
    h.workerRequired = true;
    const ready = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(ready.statusCode).toBe(200);
    expectPublicReady(ready.body);
    workerRows = [];
    const missing = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(missing.statusCode).toBe(503);
    expectPublicWorkerFailure(missing.body);
  });

  it('rejects a preview worker from a different commit without disclosing the commit', async () => {
    h.env = 'development';
    h.workerRequired = true;
    workerRows = workerRows.map(row => ({ ...row, build_commit: 'b'.repeat(40) }));
    const response = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(503);
    expectPublicWorkerFailure(response.body);
    expect(response.body).not.toContain('b'.repeat(40));
  });

  it('does not require a worker for ordinary development servers', async () => {
    h.env = 'development';
    workerRows = [];
    const response = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(200);
    expectPublicReady(response.body);
  });
});
