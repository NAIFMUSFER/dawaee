import type { FastifyInstance } from 'fastify';
import { getPool } from '../lib/db.js';
import { checkSchemaContract, requiredSchemaRevision } from '../lib/schema-contract.js';
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
 * WHERE THE COMMIT COMES FROM, IN ORDER
 *
 *   1. RENDER_GIT_COMMIT — Render sets this on every service it runs, from the
 *      commit it actually built. P18 found `/version` would report `unknown` in
 *      production because `render.yaml` passes no build arguments; asking the
 *      platform for what it already knows is better than asking an operator to
 *      maintain a value by hand, and it cannot go stale.
 *   2. GIT_COMMIT — the Dockerfile build argument, for anywhere that is not
 *      Render.
 *   3. `unknown` — a build that was told nothing says so, rather than inventing
 *      a SHA. A version endpoint that guesses is worse than one that admits it
 *      does not know.
 *
 * Both inputs are validated as hex before being echoed, so an arbitrary
 * environment value cannot be reflected through an unauthenticated endpoint.
 * Nothing else about the environment is exposed: no environment name, no
 * provider wiring, no feature flags, no dependency versions. `/health/ready`
 * already reports which integrations are mocked and is the right place for it.
 *
 * `schema` is the migration this build requires, which is a property of the
 * artefact and not of the database it happens to be pointed at.
 */
const COMMIT_PATTERN = /^[0-9a-f]{7,40}$/i;

export function buildIdentity(): { commit: string; version: string; builtAt: string; schema: string } {
  const candidates = [process.env.RENDER_GIT_COMMIT, process.env.GIT_COMMIT];
  const commit = candidates
    .map((c) => c?.trim())
    .find((c): c is string => Boolean(c) && COMMIT_PATTERN.test(c!));
  let schema = 'unknown';
  try {
    schema = requiredSchemaRevision();
  } catch {
    // A build that cannot find its own migrations still reports its commit.
  }
  return {
    commit: commit ?? 'unknown',
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

    // Reachable is not the same as usable. `SELECT 1` succeeded against
    // production's schema while every authentication request returned 500,
    // because the functions this build calls did not exist yet. Readiness now
    // asks the ledger whether the schema this build was written against is
    // actually applied. Startup refuses outright in that state, so in practice
    // this catches a database that moved BACKWARDS under a running instance —
    // a restore, a failover to a stale replica.
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
