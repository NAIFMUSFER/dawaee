import type { FastifyInstance } from 'fastify';
import { getPool } from '../lib/db.js';
import { checkSchemaContract, requiredSchemaRevision } from '../lib/schema-contract.js';
import { assessWorkerHeartbeat, runtimeCommit } from '../lib/deployment-coherence.js';
import { loadConfig } from '../config.js';
import type { Providers } from '../providers/index.js';

export function buildIdentity(): { commit: string; version: string; builtAt: string; schema: string } {
  let schema = 'unknown';
  try { schema = requiredSchemaRevision(); } catch { /* build identity still reports the commit */ }
  return {
    commit: runtimeCommit(),
    version: process.env.APP_VERSION?.trim() || 'unknown',
    builtAt: process.env.BUILD_TIME?.trim() || 'unknown',
    schema,
  };
}

export type IntegrationReadiness = {
  integrations: { push: string; ocr: string; storage: string };
  mockedIntegrations: string[];
  check: { ok: boolean; detail?: string };
};

export function assessIntegrationReadiness(providers: Providers, isProduction: boolean): IntegrationReadiness {
  const integrations = { push: providers.push.name, ocr: providers.ocr.name, storage: providers.storage.name };
  const mockedIntegrations = Object.entries(integrations)
    .filter(([, name]) => name === 'mock' || name === 'local' || name === 'unconfigured')
    .map(([key]) => key);
  if (!isProduction) {
    return { integrations, mockedIntegrations,
      check: { ok: true, detail: mockedIntegrations.length ? `development providers: ${mockedIntegrations.join(', ')}` : 'configured' } };
  }
  return { integrations, mockedIntegrations,
    check: mockedIntegrations.length === 0
      ? { ok: true, detail: 'configured' }
      : { ok: false, detail: `unavailable or non-production providers: ${mockedIntegrations.join(', ')}` } };
}

const REQUIRED_WORKER_JOBS = [
  'materialize', 'reminders', 'dispatch', 'mark-missed', 'stock-alerts', 'digests',
] as const;

export function registerHealthRoutes(app: FastifyInstance, providers: Providers): void {
  app.get('/health', async () => ({ status: 'ok', service: 'dawaee-api', time: new Date().toISOString() }));
  app.get('/version', async () => ({ service: 'dawaee-api', ...buildIdentity() }));

  app.get('/health/ready', async (_req, reply) => {
    const cfg = loadConfig();
    const checks: Record<string, { ok: boolean; detail?: string }> = {};

    try {
      const start = Date.now();
      await getPool().query('SELECT 1');
      checks.database = { ok: true, detail: `${Date.now() - start}ms` };
    } catch {
      checks.database = { ok: false, detail: 'unreachable' };
    }

    if (checks.database.ok) {
      try {
        const schema = await checkSchemaContract(getPool());
        checks.schema = schema.ok ? { ok: true, detail: schema.revision } : {
          ok: false,
          detail: [
            schema.missing.length ? `not applied: ${schema.missing.join(', ')}` : '',
            schema.mismatched.length ? `checksum differs: ${schema.mismatched.join(', ')}` : '',
          ].filter(Boolean).join('; '),
        };
      } catch {
        checks.schema = { ok: false, detail: 'unverifiable' };
      }
    }

    if (checks.database.ok && (cfg.NODE_ENV === 'production' || cfg.WORKER_READINESS_REQUIRED)) {
      try {
        const { rows } = await getPool().query<{
          job_name: string; started_at: Date; succeeded: boolean; build_commit: string | null;
        }>(
          `SELECT DISTINCT ON (job_name)
                  job_name, started_at, succeeded, metadata->>'buildCommit' AS build_commit
             FROM job_runs
            WHERE job_name = ANY($1::text[])
            ORDER BY job_name, started_at DESC`,
          [REQUIRED_WORKER_JOBS],
        );
        const failures: string[] = [];
        const apiCommit = runtimeCommit();
        for (const jobName of REQUIRED_WORKER_JOBS) {
          const row = rows.find((candidate) => candidate.job_name === jobName);
          const result = assessWorkerHeartbeat({ apiCommit, heartbeat: row ? {
            startedAt: row.started_at, succeeded: row.succeeded, buildCommit: row.build_commit,
          } : null });
          if (!result.ok) failures.push(`${jobName}: ${result.detail ?? 'unhealthy'}`);
        }
        checks.worker = failures.length === 0
          ? { ok: true, detail: 'materialize, reminders, dispatch, mark-missed, stock-alerts, and digests healthy' }
          : { ok: false, detail: failures.join('; ') };
      } catch {
        checks.worker = { ok: false, detail: 'unverifiable' };
      }
    }

    const integrationReadiness = assessIntegrationReadiness(providers, cfg.NODE_ENV === 'production');
    if (cfg.NODE_ENV === 'production') checks.integrations = integrationReadiness.check;
    const failedChecks = Object.entries(checks).filter(([, check]) => !check.ok).map(([name]) => name);
    const healthy = failedChecks.length === 0;
    const time = new Date().toISOString();

    // Runtime-recovery and integration harnesses execute only under NODE_ENV=test
    // on owned CI resources. Preserve detailed evidence there so they can prove
    // exact schema/provider/worker behavior. Development and production remain
    // on the same minimal unauthenticated surface used by real health probes.
    if (cfg.NODE_ENV === 'test') {
      return reply.status(healthy ? 200 : 503).send({
        status: healthy ? 'ready' : 'degraded', env: cfg.NODE_ENV, checks,
        integrations: integrationReadiness.integrations,
        mockedIntegrations: integrationReadiness.mockedIntegrations, time,
      });
    }

    return reply.status(healthy ? 200 : 503).send({
      status: healthy ? 'ready' : 'degraded',
      ...(failedChecks.length > 0 ? { failedChecks } : {}),
      time,
    });
  });
}
