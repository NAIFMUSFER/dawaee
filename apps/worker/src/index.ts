import { createWorkerContext, runJob, type WorkerContext } from './context.js';
import { materializeJob } from './jobs/materialize.js';
import { reminderJob } from './jobs/reminders.js';
import { dispatchJob } from './jobs/dispatcher.js';
import { markMissedJob } from './jobs/mark-missed.js';
import { stockAlertJob } from './jobs/stock-alerts.js';
import { digestJob } from './jobs/digests.js';
import { housekeepingJob } from './jobs/housekeeping.js';

/**
 * The background worker.
 *
 * One process, a fixed tick, and jobs ordered so each one's output is ready
 * for the next: materialize → escalate → dispatch → reconcile. Every job takes
 * an advisory lock, so running several worker instances is safe and gives
 * redundancy rather than duplicate messages.
 */

export interface TickResult {
  materialized: number;
  remindersEnqueued: number;
  dispatched: number;
  markedMissed: number;
  stockAlerts: number;
  digests: number;
  housekeeping: number;
}

export async function runTick(ctx: WorkerContext, opts?: { includeSlowJobs?: boolean }): Promise<TickResult> {
  const slow = opts?.includeSlowJobs ?? true;

  const materialized = await runJob(ctx, 'materialize', (c) => materializeJob(ctx, c));
  const reminders = await runJob(ctx, 'reminders', (c) => reminderJob(ctx, c));
  const dispatched = await runJob(ctx, 'dispatch', (c) => dispatchJob(ctx, c));
  const missed = await runJob(ctx, 'mark-missed', (c) => markMissedJob(ctx, c));
  const stock = slow ? await runJob(ctx, 'stock-alerts', (c) => stockAlertJob(ctx, c)) : { itemsProcessed: 0 };
  const digests = slow ? await runJob(ctx, 'digests', (c) => digestJob(ctx, c)) : { itemsProcessed: 0 };

  return {
    materialized: materialized.itemsProcessed,
    remindersEnqueued: reminders.itemsProcessed,
    dispatched: dispatched.itemsProcessed,
    markedMissed: missed.itemsProcessed,
    stockAlerts: stock.itemsProcessed,
    digests: digests.itemsProcessed,
    housekeeping: 0,
  };
}

async function main(): Promise<void> {
  const ctx = createWorkerContext();
  const tickSeconds = Number(process.env.WORKER_TICK_SECONDS ?? 60);
  let stopping = false;
  let inFlight: Promise<unknown> = Promise.resolve();

  ctx.log.info(
    {
      tickSeconds,
      providers: { push: ctx.providers.push.name },
    },
    'dawaee worker started',
  );

  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    ctx.log.info({ signal }, 'worker shutting down; waiting for the current tick');
    await inFlight.catch(() => undefined);
    await ctx.pool.end().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  // Housekeeping is hourly, not per-tick: it scans large tables and nothing
  // time-critical depends on it.
  let ticksSinceHousekeeping = 0;
  const housekeepingEveryTicks = Math.max(1, Math.round(3600 / tickSeconds));

  const loop = async () => {
    if (stopping) return;
    inFlight = (async () => {
      try {
        const result = await runTick(ctx);
        if (Object.values(result).some((v) => v > 0)) ctx.log.info(result, 'tick completed');
        if (++ticksSinceHousekeeping >= housekeepingEveryTicks) {
          ticksSinceHousekeeping = 0;
          await runJob(ctx, 'housekeeping', (c) => housekeepingJob(ctx, c));
        }
      } catch (err) {
        // A failed tick must never stop the loop: the next one retries, and
        // medication reminders keep flowing.
        ctx.log.error({ err: (err as Error).message }, 'tick failed');
      }
    })();
    await inFlight;
  };

  await loop();

  // The interval is deliberately NOT unref'd: it is the handle that keeps this
  // process alive. It used to be unref'd, with a never-settling promise standing
  // in as the keep-alive — but an unsettled promise is not a handle, so the only
  // thing holding the event loop open was whatever sockets the database pool
  // happened to be keeping. That works right up until the moment it matters:
  // when the database is unreachable the pool holds nothing, Node finds an empty
  // event loop, and the worker exits ZERO — no error, no stack, indistinguishable
  // from a clean shutdown. In production it looked like an instance restarting
  // for no reason, with backoff, while reminders silently stopped going out.
  // A medication reminder that fails must fail loudly and keep retrying.
  setInterval(() => void loop(), tickSeconds * 1000);
}

if (process.env.WORKER_ENABLED !== 'false' && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
     
    console.error('fatal worker error:', err);
    process.exit(1);
  });
}

export { createWorkerContext, runJob } from './context.js';
export * from './jobs/materialize.js';
export * from './jobs/reminders.js';
export * from './jobs/dispatcher.js';
export * from './jobs/mark-missed.js';
export * from './jobs/stock-alerts.js';
export * from './jobs/digests.js';
export * from './jobs/housekeeping.js';
