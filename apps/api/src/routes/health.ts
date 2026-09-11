import type { FastifyInstance } from 'fastify';
import { getPool } from '../lib/db.js';
import { checkSchemaContract, requiredSchemaRevision } from '../lib/schema-contract.js';
import { assessWorkerHeartbeat, runtimeCommit } from '../lib/deployment-coherence.js';
import { loadConfig } from '../config.js';
import type { Providers } from '../providers/index.js';

/**
 * Liveness and readiness.
 *
 * `/health` answers "is the process up" for the platform's health check.
 * `/health/ready` proves the database/schema are usable and, in production,
 * that the safety-critical worker and required external integrations are ready.
 */

/**
 * Which commit is actually serving.
 *
 * Render supplies RENDER_GIT_COMMIT to every service it builds. GIT_COMMIT is
 * the portable fallback. `runtimeCommit` validates both before anything is
 * exposed publicly, so /version is an identity endpoint rather than an
 * environment reflector.
 */
export function buildIdentity(): { commit: string; version: string; builtAt: string; schema: string } {
  let schema = 'unknown';
  try {
    schema = requiredSchemaRevision();
  } catch {
    // A build that cannot find its own migrations still reports its commit.
  }
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

/**
 * Provider names are part of the release contract, not just diagnostics.
 *
 * Production evidence on 2026-09-10 returned HTTP 200 READY while reporting
 * `ocr=mock` and `storage=unconfigured`. That makes a partially configured
 * medication-capture stack indistinguishable from a release that can actually
 * upload and analyse a medicine image. Development/test may intentionally use
 * mocks; production must fail readiness until every required integration is a
 * real configured provider.
 */
export function assessIntegrationReadiness(providers: Providers, isProduction: boolean): IntegrationReadiness {
  const integrations = {
    push: providers.push.name,
    ocr: providers.ocr.name,
    storage: providers.storage.name,
  };
  const mockedIntegrations = Object.entries(integrations)
    .filter(([, name]) => name === 'mock' || name === 'local' || name === 'unconfigured')
    .map(([key]) => key);

  if (!isProduction) {
    return {
      integrations,
      mockedIntegrations,
      check: { ok: true, detail: mockedIntegrations.length ? `development providers: ${mockedIntegrations.join(', ')}` : 'configured' },
    };
  }

  return {
    integrations,
    mockedIntegrations,
    check: mockedIntegrations.length === 0
      ? { ok: true, detail: 'configured' }
      : { ok: false, detail: `unavailable or non-production providers: ${mockedIntegrations.join(', ')}` },
  };
}

const REQUIRED_WORKER_JOBS = ['materialize', 'reminders', 'dispatch', 'mark-missed'] as const;

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
    } catch (err) {
      checks.database = { ok: false, detail: err instanceof Error ? err.message : 'unreachable' };
    }

    // Reachable is not the same as usable. A database can answer SELECT 1 while
    // still missing a function or migration this build requires.
    if (checks.database.ok) {
      try {
        const schema = await checkSchemaContract(getPool());
        checks.schema = schema.ok
          ? { ok: true, detail: schema.revision }
          : {
            ok: false,
            detail: [
              schema.missing.length ? `not applied: ${schema.missing.join(', ')}` : '',
              schema.mismatched.length ? `checksum differs: ${schema.mismatched.join(', ')}` : '',
            ].filter(Boolean).join('; '),
          };
      } catch (err) {
        checks.schema = { ok: false, detail: err instanceof Error ? err.message : 'unverifiable' };
      }
    }

    /**
     * The API and worker are two independent Render services. During this audit
     * production was observed with the API already on the simultaneous-dose
     * safety fix while the worker was still on an older commit. The old
     * readiness endpoint still returned READY because it never asked whether a
     * worker was alive, successful, or running the same release.
     *
     * `materialize`, `reminders`, `dispatch`, and `mark-missed` are required
     * release heartbeats. They run independently on every worker tick, and
     * `runJob` deliberately catches one job's failure so later jobs can
     * continue. Production evidence on 2026-09-11 showed exactly that split for
     * rolling-horizon materialization: it was failing every minute with SQLSTATE
     * 42501 while later reminder work could still run. The same fail-open shape
     * exists for dispatch: reminders can enqueue deliveries successfully while
     * a failed dispatcher sends none. It also exists for missed-dose persistence:
     * a healthy delivery pipeline can coexist with `mark-missed` failing, which
     * leaves the stored clinical history and caregiver-dashboard state stale even
     * though dose lateness can still be derived at read time. Readiness must
     * therefore prove schedule generation, the complete enqueue-to-delivery path,
     * and missed-dose history persistence rather than accepting a partial tick.
     *
     * New workers stamp every job_run with their build commit. A pre-fix worker
     * still fails closed as "identity unavailable" instead of being mistaken
     * for the current release.
     */
    if (checks.database.ok && cfg.NODE_ENV === 'production') {
      try {
        const { rows } = await getPool().query<{
          job_name: string;
          started_at: Date;
          succeeded: boolean;
          build_commit: string | null;
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
          const result = assessWorkerHeartbeat({
            apiCommit,
            heartbeat: row ? {
              startedAt: row.started_at,
              succeeded: row.succeeded,
              buildCommit: row.build_commit,
            } : null,
          });
          if (!result.ok) failures.push(`${jobName}: ${result.detail ?? 'unhealthy'}`);
        }

        checks.worker = failures.length === 0
          ? { ok: true, detail: 'materialize, reminders, dispatch, and mark-missed healthy' }
          : { ok: false, detail: failures.join('; ') };
      } catch (err) {
        checks.worker = { ok: false, detail: err instanceof Error ? err.message : 'unverifiable' };
      }
    }

    const integrationReadiness = assessIntegrationReadiness(providers, cfg.NODE_ENV === 'production');
    if (cfg.NODE_ENV === 'production') checks.integrations = integrationReadiness.check;

    const healthy = Object.values(checks).every((c) => c.ok);
    return reply.status(healthy ? 200 : 503).send({
      status: healthy ? 'ready' : 'degraded',
      env: cfg.NODE_ENV,
      checks,
      integrations: integrationReadiness.integrations,
      mockedIntegrations: integrationReadiness.mockedIntegrations,
      time: new Date().toISOString(),
    });
  });
}
