import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetDatabase } from './harness.js';
import { createWorkerContext, runJob, type WorkerContext } from '../../worker/src/context.js';
import { materializeJob } from '../../worker/src/jobs/materialize.js';

let owner: pg.Pool;
let ctx: WorkerContext;
const now = new Date('2026-09-21T06:00:00Z');
beforeAll(async () => {
  resetDatabase();
  owner = new pg.Pool({ connectionString: 'postgres://postgres:postgres@127.0.0.1:5433/dawaee_test', max: 2 });
  ctx = createWorkerContext({ now: () => now });
});
afterAll(async () => { await ctx?.pool.end(); await owner?.end(); });

async function seed(horizon: Date | null) {
  const user = randomUUID(), profile = randomUUID(), medication = randomUUID(), schedule = randomUUID();
  await owner.query('INSERT INTO users(id,email,display_name) VALUES($1,$2,$3)', [user, `${user}@example.test`, 'Synthetic isolation']);
  await owner.query('INSERT INTO patient_profiles(id,owner_user_id,display_name,is_self) VALUES($1,$2,$3,true)', [profile, user, 'Synthetic self']);
  await owner.query(`INSERT INTO medications(id,patient_profile_id,name,form,start_date,created_by)
    VALUES($1,$2,'Synthetic medication','tablet','2026-09-21',$3)`, [medication, profile, user]);
  await owner.query(`INSERT INTO medication_schedules(id,medication_id,patient_profile_id,rule_kind,rule,
    dose_quantity,dose_unit,timezone,start_date,created_by,materialized_through)
    VALUES($1,$2,$3,'fixed_times',$4,1,'tablet','Asia/Riyadh','2026-09-21',$5,$6)`,
  [schedule, medication, profile, { kind: 'fixed_times', times: ['09:00'] }, user, horizon]);
  return schedule;
}

describe('native PostgreSQL worker row isolation', () => {
  it('commits healthy patients on either side of an aborted SQL statement and preserves retryability', async () => {
    const earlier = await seed(null);
    const broken = await seed(new Date('2026-09-20T00:00:00Z'));
    const later = await seed(new Date('2026-09-21T00:00:00Z'));
    const inserted: string[] = [];
    const outcome = await runJob(ctx, 'materialize', async client => {
      const query = client.query.bind(client);
      const wrapped = { query: async (sql: string, values: unknown[] = []) => {
        if (sql.startsWith('UPDATE medication_schedules SET materialized_through') && values[0] === broken) {
          return query('SELECT 1 / 0');
        }
        const result = await query(sql, values);
        if (sql.includes('INSERT INTO dose_occurrences') && result.rowCount) inserted.push((values[0] as string[])[0]!);
        return result;
      } } as unknown as pg.PoolClient;
      return materializeJob(ctx, wrapped);
    });
    expect(inserted).toEqual([earlier, broken, later]);
    expect(outcome.itemsProcessed).toBe(28);
    const rows = (await owner.query('SELECT schedule_id,count(*)::int AS n FROM dose_occurrences GROUP BY schedule_id')).rows;
    expect(rows.find(row => row.schedule_id === earlier)?.n).toBe(14);
    expect(rows.find(row => row.schedule_id === broken)).toBeUndefined();
    expect(rows.find(row => row.schedule_id === later)?.n).toBe(14);
    const record = (await owner.query("SELECT succeeded,items_processed,metadata FROM job_runs WHERE job_name='materialize' ORDER BY id DESC LIMIT 1")).rows[0];
    expect(record.succeeded).toBe(false);
    expect(record.items_processed).toBe(28);
    expect(record.metadata.failedSteps).toEqual([{ step: 'schedule', error: expect.stringContaining('22012') }]);
    // With the synthetic failure gone, the same row remains eligible, while
    // already committed healthy doses are neither duplicated nor cancelled.
    expect((await runJob(ctx, 'materialize', tx => materializeJob(ctx, tx))).itemsProcessed).toBe(14);
    const recovered = (await owner.query('SELECT schedule_id,count(*)::int AS n FROM dose_occurrences GROUP BY schedule_id')).rows;
    expect(recovered).toHaveLength(3);
    expect(recovered.every(row => row.n === 14)).toBe(true);
  });
});
