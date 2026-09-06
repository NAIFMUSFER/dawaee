import type { FastifyInstance } from 'fastify';
import { getPool } from '../lib/db.js';
import { loadConfig } from '../config.js';
import type { Providers } from '../providers/index.js';

/**
 * Liveness and readiness.
 *
 * `/health` answers "is the process up" for the platform's health check.
 * `/health/ready` also proves the database is reachable and reports which
 * provider implementation is wired for each integration — an operator must be
 * able to see that WhatsApp is running on the mock without reading the config.
 */
/**
 * Which commit is actually serving.
 *
 * Every phase of this audit has produced a statement of the form "at commit X,
 * this control holds". None of that is worth anything if there is no way to
 * ask a running service which commit it is — and until now there was not, so
 * "the audited code is deployed" was an assumption rather than an observation.
 *
 * Deliberately unauthenticated and deliberately thin. It answers exactly three
 * things and nothing that varies with configuration: no environment name, no
 * provider wiring, no feature flags, no dependency versions. `/health/ready`
 * already reports which integrations are mocked and it is the right place for
 * that; this endpoint exists so an operator, or a later audit, can compare a
 * deployed revision against a git SHA without a login.
 *
 * The values come from build arguments the Dockerfile receives and Render
 * populates. When they are absent — a local run, a build that did not pass
 * them — the endpoint says `unknown` rather than inventing something, because
 * a version endpoint that guesses is worse than one that admits it does not
 * know.
 */
export function buildIdentity(): { commit: string; version: string; builtAt: string } {
  const commit = process.env.GIT_COMMIT?.trim();
  return {
    commit: commit && /^[0-9a-f]{7,40}$/i.test(commit) ? commit : 'unknown',
    version: process.env.APP_VERSION?.trim() || 'unknown',
    builtAt: process.env.BUILD_TIME?.trim() || 'unknown',
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
      // Surfaced loudly rather than hidden: these integrations are not live.
      mockedIntegrations: mocked,
      time: new Date().toISOString(),
    });
  });
}
