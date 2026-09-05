import type { PoolClient } from 'pg';
import type { WorkerContext } from '../context.js';

/**
 * One retention step, isolated from the others.
 *
 * P8-2 is the reason this exists. Housekeeping was a straight run of statements
 * in one transaction, and the worker lacked DELETE on the first table it
 * touched — so every run since the job was written raised "permission denied"
 * on statement three and abandoned everything after it. Sessions, webhook
 * events, job runs, orphaned uploads and ninety-day-old notification bodies
 * were all never purged, for the life of the deployment, because one unrelated
 * step could not run.
 *
 * The grants are fixed, but the shape that turned one fault into total silence
 * is the part worth removing. These retention classes have nothing to do with
 * each other: a failure trimming webhook events is not a reason to keep
 * notification bodies containing medication names past their retention. So each
 * step runs in its own savepoint and a failure rolls back only that step.
 *
 * Not silently, though — the whole point of P8-2 is that a broken cleanup went
 * unnoticed. Every failure is logged with the step name, and the job returns
 * them so `runJob` records a non-empty failure list in `job_runs` rather than a
 * clean success. A step that cannot run must be visible to an operator without
 * anyone thinking to look.
 */
export interface StepOutcome {
  removed: number;
  failures: Array<{ step: string; error: string }>;
}

export async function runStep(
  ctx: WorkerContext,
  client: PoolClient,
  outcome: StepOutcome,
  step: string,
  fn: () => Promise<number>,
): Promise<void> {
  // A savepoint rather than a separate connection: the job already holds one
  // transaction and its advisory lock, and taking a second connection per step
  // would multiply pool usage for work that is not time-critical.
  await client.query(`SAVEPOINT ${step}`);
  try {
    outcome.removed += await fn();
    await client.query(`RELEASE SAVEPOINT ${step}`);
  } catch (err) {
    await client.query(`ROLLBACK TO SAVEPOINT ${step}`).catch(() => undefined);
    const message = (err as Error).message;
    outcome.failures.push({ step, error: message });
    // Named, so an operator reading logs knows WHICH retention class stopped
    // rather than that "housekeeping failed".
    ctx.log.error({ step, err: message }, 'housekeeping step failed; continuing with the rest');
  }
}
