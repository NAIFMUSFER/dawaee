import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const COMMIT = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const h = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock('../src/lib/db.js', () => ({
  getPool: () => ({ query: h.query }),
}));

vi.mock('../src/lib/schema-contract.js', () => ({
  requiredSchemaRevision: () => '0048_admin_operational_read_model.sql',
  checkSchemaContract: vi.fn(async () => ({
    ok: true,
    revision: '0048_admin_operational_read_model.sql',
    missing: [],
    mismatched: [],
  })),
}));

vi.mock('../src/config.js', () => ({
  loadConfig: () => ({ NODE_ENV: 'production' }),
}));

import { registerHealthRoutes } from '../src/routes/health.js';

let app: ReturnType<typeof Fastify>;

describe('production readiness covers every per-tick safety-critical worker prerequisite', () => {
  beforeAll(async () => {
    vi.stubEnv('RENDER_GIT_COMMIT', COMMIT);
    h.query.mockImplementation(async (sqlLike: unknown) => {
      const sql = String(sqlLike);
      if (sql.includes('SELECT 1')) return { rows: [{ ok: 1 }] };
      if (sql.includes('FROM job_runs')) {
        // Exact production failure shape observed on 2026-09-11: reminder work can
        // still complete while rolling-horizon materialization independently
        // records SQLSTATE 42501. Returning both rows makes this test fail if
        // readiness inspects only rows[0] / reminders and silently ignores the
        // materializer failure.
        return {
          rows: [
            { job_name: 'reminders', started_at: new Date(), succeeded: true, build_commit: COMMIT },
            { job_name: 'materialize', started_at: new Date(), succeeded: false, build_commit: COMMIT },
          ],
        };
      }
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

  afterAll(async () => {
    vi.unstubAllEnvs();
    await app.close();
  });

  it('returns 503 when materialize failed even though reminders is fresh and successful', async () => {
    const response = await app.inject({ method: 'GET', url: '/health/ready' });

    expect(response.statusCode, response.body).toBe(503);
    const body = response.json<{ checks: Record<string, { ok: boolean; detail?: string }> }>();
    expect(body.checks.worker?.ok).toBe(false);
    expect(body.checks.worker?.detail).toMatch(/materialize/i);
  });
});
