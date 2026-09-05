import pg from 'pg';
import pino from 'pino';
import { loadConfig, type Config } from '@dawaee/api/config';
import { withRole } from '@dawaee/api/lib/db';
import { databaseTlsOptions } from '@dawaee/api/lib/db-tls';
import { buildProviders, type Providers } from '@dawaee/api/providers';

/**
 * Worker runtime context.
 *
 * The worker connects as `dawaee_worker`, a SEPARATE database role that
 * bypasses row-level security because its jobs legitimately span every
 * patient. That role is never used to serve an HTTP request, so a bug in a
 * route can never borrow its reach.
 */
export interface WorkerContext {
  pool: pg.Pool;
  providers: Providers;
  log: pino.Logger;
  config: Config;
  now: () => Date;
}

export function createWorkerContext(overrides?: Partial<WorkerContext>): WorkerContext {
  const config = overrides?.config ?? loadConfig();
  const log =
    overrides?.log ??
    pino({
      level: config.LOG_LEVEL,
      base: { service: 'dawaee-worker', env: config.NODE_ENV },
      // Same redaction posture as the API: job logs must not carry medication
      // names or phone numbers into an aggregator.
      redact: {
        paths: ['medication', 'medicationName', 'phone', 'phoneE164', 'to', '*.medicationName', '*.phoneE164'],
        censor: '[redacted]',
      },
    });

  const pool =
    overrides?.pool ??
    new pg.Pool({
      connectionString: withRole(
        process.env.WORKER_DATABASE_URL ?? config.DATABASE_URL,
        process.env.WORKER_DATABASE_ROLE ?? config.DATABASE_ROLE,
        process.env.WORKER_DATABASE_PASSWORD ?? config.DATABASE_ROLE_PASSWORD,
      ),
      max: 5,
      idleTimeoutMillis: 30_000,
      statement_timeout: 30_000,
      // The SAME policy object the API uses, from the same function. The
      // worker holds the same credentials and reads the same medication rows,
      // so a weaker connection here would simply move the vulnerability rather
      // than remove it — and two copies of the rule is how that happens.
      ssl: databaseTlsOptions(config),
    });

  return {
    pool,
    providers: overrides?.providers ?? buildProviders(config),
    log,
    config,
    now: overrides?.now ?? (() => new Date()),
  };
}

/**
 * Runs a job under an advisory lock and records the outcome, so two worker
 * instances never process the same tick and the admin panel can answer "did
 * the reminder job run?" without touching medical rows.
 */
export async function runJob<T>(
  ctx: WorkerContext,
  jobName: string,
  fn: (client: pg.PoolClient) => Promise<{ itemsProcessed: number; result?: T }>,
): Promise<{ ran: boolean; itemsProcessed: number; result?: T }> {
  const client = await ctx.pool.connect();
  const startedAt = new Date();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ locked: boolean }>('SELECT app.try_job_lock($1) AS locked', [jobName]);
    if (!rows[0]?.locked) {
      await client.query('ROLLBACK');
      ctx.log.debug({ job: jobName }, 'job already running elsewhere; skipping tick');
      return { ran: false, itemsProcessed: 0 };
    }

    const outcome = await fn(client);
    await client.query(
      `INSERT INTO job_runs (job_name, started_at, finished_at, succeeded, items_processed)
       VALUES ($1,$2,now(),true,$3)`,
      [jobName, startedAt, outcome.itemsProcessed],
    );
    await client.query('COMMIT');
    if (outcome.itemsProcessed > 0) {
      ctx.log.info({ job: jobName, items: outcome.itemsProcessed }, 'job completed');
    }
    return { ran: true, ...outcome };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    ctx.log.error({ job: jobName, err: (err as Error).message }, 'job failed');
    // Recorded on its own connection so the failure survives the rollback.
    await ctx.pool
      .query(
        `INSERT INTO job_runs (job_name, started_at, finished_at, succeeded, error_message)
         VALUES ($1,$2,now(),false,$3)`,
        [jobName, startedAt, (err as Error).message.slice(0, 500)],
      )
      .catch(() => undefined);
    return { ran: true, itemsProcessed: 0 };
  } finally {
    client.release();
  }
}
