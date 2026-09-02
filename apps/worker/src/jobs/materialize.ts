import type { PoolClient } from 'pg';
import { loadSchedulesNeedingMaterialization, materializeSchedule } from '@dawaee/api/services/materializer';
import type { WorkerContext } from '../context.js';

/**
 * Keeps the rolling window of dose rows topped up.
 *
 * Runs frequently and cheaply: schedules whose horizon is still far out are
 * filtered in SQL, so a normal tick touches nothing.
 */
export async function materializeJob(ctx: WorkerContext, client: PoolClient): Promise<{ itemsProcessed: number }> {
  const now = ctx.now();
  const schedules = await loadSchedulesNeedingMaterialization(client, now);
  let created = 0;
  for (const schedule of schedules) {
    const result = await materializeSchedule(client, schedule, now);
    created += result.created;
  }
  if (created > 0) ctx.log.info({ schedules: schedules.length, created }, 'materialized dose occurrences');
  return { itemsProcessed: created };
}
