import { loadConfig } from './config.js';
import { buildServer } from './server.js';
import { closePool } from './lib/db.js';

async function main(): Promise<void> {
  const cfg = loadConfig();
  const { app } = await buildServer();

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
    app.log.error({ reason }, 'unhandled promise rejection');
  });

  await app.listen({ port: cfg.PORT, host: cfg.HOST });
  app.log.info({ port: cfg.PORT, env: cfg.NODE_ENV }, 'dawaee api listening');
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('fatal startup error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
