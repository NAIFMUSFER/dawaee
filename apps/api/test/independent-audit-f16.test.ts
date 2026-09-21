import type { PGlite } from '@electric-sql/pglite';
import type pg from 'pg';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorkerContext, runJob } from '../../worker/src/context.js';
import { materializeJob } from '../../worker/src/jobs/materialize.js';
import { housekeepingJob } from '../../worker/src/jobs/housekeeping.js';
import { auditClient, auditTransaction, createAuditDatabase } from './independent-audit-db.js';

let db: PGlite;
const now = new Date('2026-09-21T06:00:00Z');
const owner = (sql: string, values: unknown[] = []) => auditTransaction(db, 'dawaee_migrator', tx => tx.query(sql, values));
beforeAll(async () => { db = await createAuditDatabase(); }, 60_000);
afterAll(async () => { await db?.close(); });

async function seedSchedule(malformed: boolean) {
  const user = randomUUID(), profile = randomUUID(), medication = randomUUID(), schedule = randomUUID();
  await owner('INSERT INTO users(id,email,display_name) VALUES($1,$2,$3)', [user, `${user}@example.test`, 'Synthetic audit']);
  await owner('INSERT INTO patient_profiles(id,owner_user_id,display_name,is_self) VALUES($1,$2,$3,true)', [profile, user, 'Synthetic profile']);
  await owner(`INSERT INTO medications(id,patient_profile_id,name,form,start_date,created_by)
    VALUES($1,$2,'Synthetic medicine','tablet','2026-09-21',$3)`, [medication, profile, user]);
  // This corrupted historical row satisfies every shipped DB constraint. No
  // constraint/trigger is disabled. The public API would reject this rule.
  await owner(`INSERT INTO medication_schedules(id,medication_id,patient_profile_id,rule_kind,rule,
    dose_quantity,dose_unit,timezone,start_date,created_by,materialized_through)
    VALUES($1,$2,$3,'fixed_times',$4,1,'tablet','Asia/Riyadh','2026-09-21',$5,$6)`,
  [schedule, medication, profile, malformed ? { kind: 'fixed_times', times: [null] } : { kind: 'fixed_times', times: ['09:00'] }, user,
    malformed ? new Date('2026-09-22T00:00:00Z') : null]);
  return schedule;
}

describe('F16: a corrupt schedule must not roll back another patient materialization', () => {
  it('counterexample: housekeeping preserves later work after a real SQL error in its first step', async () => {
    await owner(`INSERT INTO auth_rate_buckets(scope,key_hash,window_start,count)
      VALUES('audit-housekeeping',$1,now()-interval '2 days',1)`, ['0'.repeat(64)]);
    const client = auditClient(db), realQuery = client.query.bind(client);
    client.query = (async (sql: string, values: unknown[] = []) => {
      if (sql === 'SELECT app.purge_expired_otp(24)') return realQuery('SELECT 1 / 0');
      return realQuery(sql, values);
    }) as typeof client.query;
    const pool = { connect: async () => client, query: client.query.bind(client) } as unknown as pg.Pool;
    const ctx = createWorkerContext({ pool, now: () => now });
    await db.exec('SET ROLE dawaee_worker');
    try { await runJob(ctx, 'housekeeping', tx => housekeepingJob(ctx, tx)); }
    finally { await db.exec('RESET ROLE'); }
    expect((await owner("SELECT count(*)::int AS count FROM auth_rate_buckets WHERE scope='audit-housekeeping'")).rows[0].count).toBe(0);
    const run = (await owner("SELECT succeeded,items_processed,metadata FROM job_runs WHERE job_name='housekeeping' ORDER BY id DESC LIMIT 1")).rows[0];
    expect(run.succeeded).toBe(false);
    expect(run.items_processed).toBeGreaterThan(0);
    expect(run.metadata.failedSteps).toEqual([{ step: 'otp', error: expect.stringContaining('22012') }]);
  });

  it('keeps good work and records a partial failure when a later persisted rule is malformed', async () => {
    const good = await seedSchedule(false);
    const bad = await seedSchedule(true);
    // ORDER BY materialized_through NULLS FIRST puts the good row first. Prove
    // actual progress precedes the exception, not merely zero work at selection.
    let goodInserts = 0;
    const client = auditClient(db);
    const realQuery = client.query.bind(client);
    client.query = (async (sql: string, values: unknown[] = []) => {
      const result = await realQuery(sql, values);
      if (sql.includes('INSERT INTO dose_occurrences')) goodInserts += result.rowCount ?? 0;
      return result;
    }) as typeof client.query;
    const pool = { connect: async () => client, query: client.query.bind(client) } as unknown as pg.Pool;
    const ctx = createWorkerContext({ pool, now: () => now });
    await db.exec('SET ROLE dawaee_worker');
    try { await runJob(ctx, 'materialize', tx => materializeJob(ctx, tx)); }
    finally { await db.exec('RESET ROLE'); }
    expect(goodInserts, 'positive control: healthy work actually ran before the bad item').toBeGreaterThan(0);
    const stored = await owner('SELECT count(*)::int AS count FROM dose_occurrences WHERE schedule_id=$1', [good]);
    const badStored = await owner('SELECT count(*)::int AS count FROM dose_occurrences WHERE schedule_id=$1', [bad]);
    const run = (await owner("SELECT succeeded,items_processed,metadata FROM job_runs WHERE job_name='materialize' ORDER BY id DESC LIMIT 1")).rows[0];
    console.info('F16 isolation measurements', JSON.stringify({ insertedBeforeFailure: goodInserts,
      committedHealthyDoses: stored.rows[0].count, committedCorruptDoses: badStored.rows[0].count,
      jobSucceeded: run.succeeded, recordedItems: run.items_processed }));
    expect.soft(badStored.rows[0].count).toBe(0);
    expect.soft(run.succeeded).toBe(false);
    expect.soft(stored.rows[0].count, 'F16: healthy patient doses were rolled back by the corrupt row').toBe(goodInserts);
    expect.soft(run.items_processed).toBe(goodInserts);
    expect.soft(run.metadata.failedSteps).toHaveLength(1);
  });
});
