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
export function registerHealthRoutes(app: FastifyInstance, providers: Providers): void {
  app.get('/health', async () => ({ status: 'ok', service: 'dawaee-api', time: new Date().toISOString() }));

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
      sms: providers.sms.name,
      whatsapp: providers.whatsapp.name,
      push: providers.push.name,
      ocr: providers.ocr.name,
      storage: providers.storage.name,
    };
    const mocked = Object.entries(integrations)
      .filter(([, name]) => name === 'mock' || name === 'local')
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
