import Fastify from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ query: vi.fn(), schema: vi.fn() }));
vi.mock('../src/lib/db.js', () => ({ getPool: () => ({ query: h.query }) }));
vi.mock('../src/lib/schema-contract.js', () => ({
  requiredSchemaRevision: () => '0070_dose_schedule_graph_integrity.sql',
  checkSchemaContract: h.schema,
}));
vi.mock('../src/config.js', () => ({ loadConfig: () => ({ NODE_ENV: 'production',
  ACCOUNT_EMAIL_PROVIDER: 'resend', ACCOUNT_EMAIL_SENDER_VERIFIED: true,
  RESEND_API_KEY: 'synthetic-readiness-key', ACCOUNT_EMAIL_FROM: 'accounts@example.test',
  ACCOUNT_EMAIL_BASE_URL: 'https://accounts.example.test',
}) }) );

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
const JOBS = ['materialize', 'reminders', 'dispatch', 'push-receipts', 'mark-missed', 'stock-alerts', 'digests', 'housekeeping'];
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

function expectMinimalReadinessSurface(
  responseBody: string,
  expectedStatus: 'ready' | 'degraded',
  failedChecks: string[] = [],
): void {
  const body = JSON.parse(responseBody) as Record<string, unknown>;
  expect(body.status).toBe(expectedStatus);
  expect(typeof body.time).toBe('string');

  const expectedKeys = failedChecks.length > 0
    ? ['failedChecks', 'status', 'time']
    : ['status', 'time'];
  expect(Object.keys(body).sort()).toEqual(expectedKeys);
  if (failedChecks.length > 0) expect(body.failedChecks).toEqual(failedChecks);

  // Readiness is intentionally public, so it must not double as an operational
  // inventory endpoint. Exact migration ids, provider names, release identity,
  // timings, worker details and environment are useful to an operator but also
  // fingerprint the deployment for an unauthenticated caller.
  for (const forbidden of [
    'checks', 'env', 'integrations', 'mockedIntegrations',
    'expo', 'google_vision', 's3', COMMIT,
    '0070_dose_schedule_graph_integrity.sql',
  ]) {
    expect(responseBody).not.toContain(forbidden);
  }
}

async function expectPrivateFailure(phase: Phase): Promise<void> {
  // No Authorization header: readiness is intentionally public.
  const response = await app.inject({ method: 'GET', url: '/health/ready' });
  expect(response.statusCode).toBe(503);
  expectMinimalReadinessSurface(response.body, 'degraded', [phase]);
  for (const marker of PRIVATE_MARKERS) expect(response.body).not.toContain(marker);
}

describe('public readiness exposes health, not private diagnostics', () => {
  it.each(PHASES)('redacts Error messages and internal check detail from the %s failure', async (phase) => {
    failCheck(phase, new Error(PRIVATE_ERROR));
    await expectPrivateFailure(phase);
  });

  it.each(PHASES)('fails closed for non-Error failures from the %s check', async (phase) => {
    failCheck(phase, { message: PRIVATE_ERROR });
    await expectPrivateFailure(phase);
  });

  it('reports only minimal public readiness when every required check and integration is healthy', async () => {
    const response = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode, response.body).toBe(200);
    expectMinimalReadinessSurface(response.body, 'ready');
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
