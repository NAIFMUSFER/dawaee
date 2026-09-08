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
 * that the safety-critical worker is alive on the same release as the API.
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
     * `reminders` is used as the heartbeat because it runs every worker tick and
     * is the safety-critical path. New workers stamp every job_run with their
     * build commit. A pre-fix worker therefore fails closed as "identity
     * unavailable" instead of being mistaken for the current release.
     */
    if (checks.database.ok && cfg.NODE_ENV === 'production') {
      try {
        const { rows } = await getPool().query<{
          started_at: Date;
          succeeded: boolean;
          build_commit: string | null;
        }>(
          `SELECT started_at, succeeded, metadata->>'buildCommit' AS build_commit
             FROM job_runs
            WHERE job_name = 'reminders'
            ORDER BY started_at DESC
            LIMIT 1`,
        );
        const row = rows[0];
        const worker = assessWorkerHeartbeat({
          apiCommit: runtimeCommit(),
          heartbeat: row ? {
            startedAt: row.started_at,
            succeeded: row.succeeded,
            buildCommit: row.build_commit,
          } : null,
        });
        checks.worker = worker;
      } catch (err) {
        checks.worker = { ok: false, detail: err instanceof Error ? err.message : 'unverifiable' };
      }
    }

    const integrations = {
      push: providers.push.name,
      ocr: providers.ocr.name,
      storage: providers.storage.name,
    };
    const mocked = Object.entries(integrations)
      .filter(([, name]) => name === 'mock' || name === 'local' || name === 'unconfigured')
      .map(([k]) => k);

    const healthy = Object.values(checks).every((c) => c.ok);
    return reply.status(healthy ? 200 : 503).send({
      status: healthy ? 'ready' : 'degraded',
      env: cfg.NODE_ENV,
      checks,
      integrations,
      mockedIntegrations: mocked,
      time: new Date().toISOString(),
    });
  });
}
