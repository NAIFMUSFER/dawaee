import type { PoolClient } from 'pg';
import { sanitizeOperationalError } from '@dawaee/shared';
import { loadSchedulesNeedingMaterialization, materializeSchedule } from '@dawaee/api/services/materializer';
import type { JobFailure, WorkerContext } from '../context.js';

/**
 * Keeps the rolling window of dose rows topped up.
 *
 * Runs frequently and cheaply: schedules whose horizon is still far out are
 * filtered in SQL, so a normal tick touches nothing.
 */
export async function materializeJob(ctx: WorkerContext, client: PoolClient): Promise<{ itemsProcessed: number; failures: JobFailure[] }> {
  const now = ctx.now();
  const schedules = await loadSchedulesNeedingMaterialization(client, now);
  let created = 0;
  const failures: JobFailure[] = [];
  for (const schedule of schedules) {
    await client.query('SAVEPOINT materialize_schedule');
    try {
      const result = await materializeSchedule(client, schedule, now);
      await client.query('RELEASE SAVEPOINT materialize_schedule');
      created += result.created;
    } catch (err) {
      // SQL errors abort the transaction until rollback to the savepoint.
      // Keep this schedule's doses and horizon atomic while preserving other
      // patients' work. A failed rollback remains a fatal job error.
      await client.query('ROLLBACK TO SAVEPOINT materialize_schedule');
      await client.query('RELEASE SAVEPOINT materialize_schedule');
      failures.push({ step: 'schedule', error: sanitizeOperationalError(err) });
    }
  }
  if (created > 0) ctx.log.info({ schedules: schedules.length, created }, 'materialized dose occurrences');
  return { itemsProcessed: created, failures };
}
