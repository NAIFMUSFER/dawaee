import { serializeLoggedError } from '@dawaee/shared';
import { loadConfig } from './config.js';
import { buildServer } from './server.js';
import { closePool, getPool } from './lib/db.js';
import { assertSchemaContract } from './lib/schema-contract.js';
import { logStartupFailure } from './lib/startup-diagnostics.js';

async function main(): Promise<void> {
  const cfg = loadConfig();

  // The deploy safety gate, before anything binds a port.
  //
  // P18 measured this build against production's actual schema (0019): it came
  // up, answered /health and /health/ready with 200, and returned 500 to every
  // authentication request. Render would have marked it live and sent traffic
  // to it. An API that cannot serve its own auth plane must not be a healthy
  // instance — it must not be an instance.
  //
  // Retried only for an unreachable database. A database that is reachable and
  // behind cannot be fixed by waiting.
  const schema = await assertSchemaContract(getPool(), {
    attempts: 5,
    delayMs: 2000,

    onRetry: (attempt, err) => console.warn(
      { attempt, err: serializeLoggedError(err) }, 'database not reachable yet',
    ),
  });

  const { app } = await buildServer();
  app.log.info(
    { revision: schema.revision, required: schema.required, applied: schema.applied },
    'schema contract satisfied',
  );

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'shutting down');
    // Stop accepting new work, let in-flight requests finish, then release
    // the pool — a medication confirmation must not be lost to a deploy.
    await app.close().catch((err) => app.log.error({ err }, 'error while closing server'));
    await closePool().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    app.log.error({ err: reason }, 'unhandled promise rejection');
  });

  await app.listen({ port: cfg.PORT, host: cfg.HOST });
  app.log.info({ port: cfg.PORT, env: cfg.NODE_ENV }, 'dawaee api listening');
}

main().catch((err) => {
  logStartupFailure(err);
  process.exit(1);
});
