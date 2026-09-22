import { runJob, type WorkerContext } from './context.js';
import { housekeepingJob } from './jobs/housekeeping.js';

/** Run once on startup, then hourly; a skipped advisory lock is not a run. */
export function createHousekeepingSchedule(ctx: WorkerContext): () => Promise<void> {
  let lastRunAt: number | null = null;
  let pending: Promise<void> | null = null;

  return async () => {
    if (pending) return pending;
    const now = ctx.now().getTime();
    if (lastRunAt !== null && now >= lastRunAt && now - lastRunAt < 60 * 60_000) return;

    pending = (async () => {
      const outcome = await runJob(ctx, 'housekeeping', client => housekeepingJob(ctx, client));
      if (outcome.ran) lastRunAt = now;
    })();
    try { await pending; } finally { pending = null; }
  };
}
