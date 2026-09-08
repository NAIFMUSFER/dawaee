import pg from 'pg';
import pino from 'pino';
import {
  LOG_REDACTION, OPERATIONAL_ERROR_MAX, sanitizeOperationalError, serializeLoggedError,
} from '@dawaee/shared';
import { loadConfig, type Config } from '@dawaee/api/config';
import { withRole } from '@dawaee/api/lib/db';
import { databaseTlsOptions } from '@dawaee/api/lib/db-tls';
import { runtimeCommit } from '@dawaee/api/lib/deployment-coherence';
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

export function createWorkerLogger(config: Config, destination?: pino.DestinationStream): pino.Logger {
  return pino({
    level: config.LOG_LEVEL,
    base: { service: 'dawaee-worker', env: config.NODE_ENV },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: LOG_REDACTION,
    serializers: { err: serializeLoggedError },
  }, destination as pino.DestinationStream);
}

export function createWorkerContext(overrides?: Partial<WorkerContext>): WorkerContext {
  const config = overrides?.config ?? loadConfig();
  const log = overrides?.log ?? createWorkerLogger(config);

  const pool =
    overrides?.pool ??
    new pg.Pool({
      connectionString: withRole(
        process.env.WORKER_DATABASE_URL ?? config.DATABASE_URL,
        process.env.WORKER_DATABASE_ROLE ?? config.DATABASE_ROLE,
        // `scripts/migrate.sh` sets the `dawaee_worker` database password from
        // DAWAEE_WORKER_PASSWORD on every worker deploy. Runtime used to ignore
        // that variable and authenticate with DATABASE_ROLE_PASSWORD instead.
        // A deploy therefore rotated Postgres to one secret and started the
        // worker with another; production reproduced it as
        // "password authentication failed for user dawaee_worker" on every tick.
        // An explicit WORKER_DATABASE_PASSWORD still wins when an environment
        // intentionally separates the migration and runtime inputs.
        process.env.WORKER_DATABASE_PASSWORD
          ?? process.env.DAWAEE_WORKER_PASSWORD
          ?? config.DATABASE_ROLE_PASSWORD,
      ),
      max: 5,
      idleTimeoutMillis: 30_000,
      statement_timeout: 30_000,
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
 * A job that finished with some of its work failing is NOT a successful run.
 * Every row also carries the worker's validated build commit. The API and worker
 * are deployed independently on Render; without this stamp, /health/ready
 * cannot distinguish a current worker from one still executing an older
 * reminder implementation.
 */
export interface JobFailure {
  step: string;
  error: string;
}

export async function runJob<T>(
  ctx: WorkerContext,
  jobName: string,
  fn: (client: pg.PoolClient) => Promise<{ itemsProcessed: number; result?: T; failures?: JobFailure[] }>,
): Promise<{ ran: boolean; itemsProcessed: number; result?: T }> {
  const client = await ctx.pool.connect();
  const startedAt = new Date();
  const buildCommit = runtimeCommit();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ locked: boolean }>('SELECT app.try_job_lock($1) AS locked', [jobName]);
    if (!rows[0]?.locked) {
      await client.query('ROLLBACK');
      ctx.log.debug({ job: jobName }, 'job already running elsewhere; skipping tick');
      return { ran: false, itemsProcessed: 0 };
    }

    const outcome = await fn(client);
    const failures = outcome.failures ?? [];
    await client.query(
      `INSERT INTO job_runs (job_name, started_at, finished_at, succeeded, items_processed, error_message, metadata)
       VALUES ($1,$2,now(),$3,$4,$5,$6)`,
      [
        jobName, startedAt, failures.length === 0, outcome.itemsProcessed,
        failures.length === 0 ? null
          : `${failures.length} step(s) failed: ${failures.map((f) => f.step).join(', ')}`.slice(0, OPERATIONAL_ERROR_MAX),
        JSON.stringify({
          buildCommit,
          ...(failures.length
            ? { failedSteps: failures.map((f) => ({ step: f.step, error: sanitizeOperationalError(f.error) })) }
            : {}),
        }),
      ],
    );
    await client.query('COMMIT');
    if (failures.length > 0) {
      ctx.log.error(
        { job: jobName, items: outcome.itemsProcessed, failedSteps: failures.map((f) => f.step) },
        'job completed with failed steps; they will be retried on the next tick',
      );
    } else if (outcome.itemsProcessed > 0) {
      ctx.log.info({ job: jobName, items: outcome.itemsProcessed }, 'job completed');
    }
    return { ran: true, ...outcome };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    const safe = sanitizeOperationalError(err);
    ctx.log.error({ job: jobName, err: safe }, 'job failed');
    await ctx.pool
      .query(
        `INSERT INTO job_runs (job_name, started_at, finished_at, succeeded, error_message, metadata)
         VALUES ($1,$2,now(),false,$3,$4)`,
        [jobName, startedAt, safe, JSON.stringify({ buildCommit })],
      )
      .catch(() => undefined);
    return { ran: true, itemsProcessed: 0 };
  } finally {
    client.release();
  }
}
