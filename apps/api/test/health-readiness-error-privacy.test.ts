import Fastify from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ query: vi.fn(), schema: vi.fn() }));
vi.mock('../src/lib/db.js', () => ({ getPool: () => ({ query: h.query }) }));
vi.mock('../src/lib/schema-contract.js', () => ({
  requiredSchemaRevision: () => '0070_dose_schedule_graph_integrity.sql',
  checkSchemaContract: h.schema,
}));
vi.mock('../src/config.js', () => ({ loadConfig: () => ({ NODE_ENV: 'production' }) }) );

import { registerHealthRoutes } from '../src/routes/health.js';

const COMMIT = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
// Synthetic markers only: no real account, medication or credential is used.
const PRIVATE_MARKERS = [
  'readiness-private-marker',
  '11111111-1111-4111-8111-111111111111',
  'PRIVATE_MEDICATION_NOTE',
  'internal.db.invalid',
];
const PRIVATE_ERROR = PRIVATE_MARKERS.join('; ');
const JOBS = ['materialize', 'reminders', 'dispatch', 'mark-missed', 'stock-alerts', 'digests'];
const PHASES = ['database', 'schema', 'worker'] as const;
type Phase = typeof PHASES[number];
let app: ReturnType<typeof Fastify>;

beforeAll(async () => {
  vi.stubEnv('RENDER_GIT_COMMIT', COMMIT);
  app = Fastify();
  registerHealthRoutes(app, {
    push: { name: 'expo' },
    ocr: { name: 'google_vision' },
    storage: { name: 's3' },
  } as never);
  await app.ready();
});

beforeEach(() => {
  h.schema.mockReset().mockResolvedValue({
    ok: true,
    revision: '0070_dose_schedule_graph_integrity.sql',
    missing: [],
    mismatched: [],
  });
  h.query.mockReset().mockImplementation(async (sqlLike: unknown) => {
    const sql = String(sqlLike);
    if (sql.includes('SELECT 1')) return { rows: [{ ok: 1 }] };
    if (sql.includes('FROM job_runs')) {
      return {
        rows: JOBS.map((job_name) => ({
          job_name, started_at: new Date(), succeeded: true, build_commit: COMMIT,
        })),
      };
    }
    throw new Error('Unexpected readiness fixture query');
  });
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await app.close();
});

function failCheck(phase: Phase, error: unknown): void {
  if (phase === 'schema') {
    h.schema.mockRejectedValueOnce(error);
  } else if (phase === 'database') {
    h.query.mockRejectedValueOnce(error);
  } else {
    h.query.mockImplementation(async (sqlLike: unknown) => {
      if (String(sqlLike).includes('SELECT 1')) return { rows: [{ ok: 1 }] };
      throw error;
    });
  }
}

async function expectPrivateFailure(phase: Phase): Promise<void> {
  // No Authorization header: readiness is intentionally public.
  const response = await app.inject({ method: 'GET', url: '/health/ready' });
  expect(response.statusCode).toBe(503);
  const body = response.json<{ status: string; checks: Record<string, { ok: boolean; detail: string }> }>();
  expect(body.status).toBe('degraded');
  expect(body.checks[phase]).toEqual({
    ok: false, detail: phase === 'database' ? 'unreachable' : 'unverifiable',
  });
  for (const marker of PRIVATE_MARKERS) expect(response.body).not.toContain(marker);
}

describe('public readiness exposes health, not private exception text', () => {
  it.each(PHASES)('redacts Error messages from the %s check without reporting READY', async (phase) => {
    failCheck(phase, new Error(PRIVATE_ERROR));
    await expectPrivateFailure(phase);
  });

  it.each(PHASES)('fails closed for non-Error failures from the %s check', async (phase) => {
    failCheck(phase, { message: PRIVATE_ERROR });
    await expectPrivateFailure(phase);
  });

  it('still reports ready when every required check and integration is healthy', async () => {
    const response = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json<{ status: string; checks: Record<string, { ok: boolean }> }>();
    expect(body.status).toBe('ready');
    expect(Object.keys(body.checks).sort()).toEqual(['database', 'integrations', 'schema', 'worker']);
    expect(Object.values(body.checks).every((check) => check.ok)).toBe(true);
  });

  it('keeps process liveness separate from database readiness', async () => {
    failCheck('database', new Error(PRIVATE_ERROR));
    await expectPrivateFailure('database');
    const live = await app.inject({ method: 'GET', url: '/health' });
    expect(live.statusCode).toBe(200);
    expect(live.json().status).toBe('ok');
    for (const marker of PRIVATE_MARKERS) expect(live.body).not.toContain(marker);
  });
});
