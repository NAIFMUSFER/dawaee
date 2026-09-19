import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { readFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { WorkerContext } from '../src/context.js';
import { reminderJob } from '../src/jobs/reminders.js';
import { dispatchJob } from '../src/jobs/dispatcher.js';
import { digestJob } from '../src/jobs/digests.js';
import { stockAlertJob } from '../src/jobs/stock-alerts.js';
import { housekeepingJob } from '../src/jobs/housekeeping.js';

// Real SQL, migrations and worker privileges on one isolated PostgreSQL/WASM
// connection. Provider acceptance is captured; this cannot prove APNs delivery
// or separate-connection race behaviour, which retain their own test gates.
let db: PGlite;
let now = new Date('2026-09-19T06:00:00Z');
let afterClaim: (() => Promise<void>) | undefined;
const sent: Array<{ data: Record<string, string>; body: string }> = [];
const client = {
  async query(sql: string, args?: unknown[]) {
    const result = await db.query(sql, args);
    if (sql === 'COMMIT' && afterClaim) {
      const hook = afterClaim; afterClaim = undefined; await hook();
    }
    return { rows: result.rows, rowCount: result.affectedRows };
  }, release() {},
} as unknown as PoolClient;
const ctx = {
  pool: { connect: async () => client, query: client.query.bind(client) },
  providers: {
    push: { name: 'captured', send: async (messages: typeof sent) => {
      sent.push(...messages); return messages.map(() => ({ ok: true, providerMessageId: randomUUID() }));
    } }, storage: { deleteObject: async () => {} },
  },
  log: { info() {}, warn() {}, error() {} }, now: () => now,
} as unknown as WorkerContext;

async function owner(sql: string, args: unknown[] = []) {
  return db.transaction(async tx => {
    await tx.exec('SET LOCAL ROLE dawaee_migrator');
    return tx.query(sql, args);
  });
}
beforeAll(async () => {
  db = await PGlite.create({ extensions: { pgcrypto, pg_trgm, btree_gist } });
  await db.exec(`CREATE ROLE dawaee_migrator CREATEDB CREATEROLE NOSUPERUSER NOBYPASSRLS;
    CREATE ROLE dawaee_app; CREATE ROLE dawaee_worker;
    GRANT dawaee_app TO dawaee_migrator WITH ADMIN TRUE, INHERIT FALSE, SET FALSE;
    GRANT dawaee_worker TO dawaee_migrator WITH ADMIN TRUE, INHERIT FALSE, SET FALSE;
    ALTER DATABASE postgres OWNER TO dawaee_migrator;
    ALTER SCHEMA public OWNER TO dawaee_migrator;
    SET ROLE dawaee_migrator;
    CREATE TABLE schema_migrations(filename text PRIMARY KEY, checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now());`);
  await db.exec(await readFile('db/maintenance/definer_policies.sql', 'utf8'));
  for (const file of (await readdir('db/migrations')).filter(f => f.endsWith('.sql')).sort()) {
    await db.exec(await readFile(`db/migrations/${file}`, 'utf8'));
  }
  await db.exec(await readFile('db/maintenance/definer_policies.sql', 'utf8'));
  await db.exec('SET ROLE dawaee_worker');
}, 60_000);
afterAll(async () => { await db?.close(); });
beforeEach(async () => {
  now = new Date('2026-09-19T06:00:00Z'); sent.length = 0; afterClaim = undefined;
  await owner('DELETE FROM users');
});

async function fixture(name = 'Medicine') {
  const user = randomUUID(), profile = randomUUID(), medication = randomUUID();
  const schedule = randomUUID(), dose = randomUUID(), session = randomUUID();
  await owner("INSERT INTO users(id,email,display_name,locale) VALUES($1,$2,'Patient','en')", [user, `${user}@example.test`]);
  await owner("INSERT INTO patient_profiles(id,owner_user_id,display_name,is_self) VALUES($1,$2,'Patient',true)", [profile, user]);
  await owner('INSERT INTO user_preferences(user_id,show_medication_in_notifications) VALUES($1,true)', [user]);
  await owner("INSERT INTO auth_sessions(id,user_id,refresh_token_hash,device_id,expires_at) VALUES($1,$2,$3,$4,now()+interval '1 day')",
    [session, user, randomUUID(), 'test-device']);
  await owner("INSERT INTO push_tokens(user_id,token,platform,device_id,session_id) VALUES($1,$2,'ios','test-device',$3)",
    [user, `ExponentPushToken[${user}]`, session]);
  await owner("INSERT INTO medications(id,patient_profile_id,name,form,start_date,created_by) VALUES($1,$2,$3,'tablet','2026-01-01',$4)",
    [medication, profile, name, user]);
  await owner(`INSERT INTO medication_schedules(id,medication_id,patient_profile_id,rule_kind,rule,dose_quantity,dose_unit,start_date,created_by)
    VALUES($1,$2,$3,'fixed_times','{"kind":"fixed_times","times":["09:00"]}',1,'tablet','2026-01-01',$4)`,
  [schedule, medication, profile, user]);
  await owner(`INSERT INTO dose_occurrences(id,schedule_id,medication_id,patient_profile_id,scheduled_at,
    scheduled_local_date,scheduled_local_time,scheduled_timezone,dose_quantity,dose_unit)
    VALUES($1,$2,$3,$4,$5,'2026-09-19','09:00','Asia/Riyadh',1,'tablet')`, [dose, schedule, medication, profile, now]);
  await owner(`INSERT INTO escalation_policies(patient_profile_id,stages) VALUES($1,$2)`,
    [profile, JSON.stringify([{ afterMinutes: 0, target: 'patient', channels: ['push'] }])]);
  return { user, profile, medication, schedule, dose };
}
async function queued() { return (await owner('SELECT * FROM notification_deliveries ORDER BY created_at,id')).rows as any[]; }

describe('worker reminders use the current clinical and reminder intent state', () => {
  it('delivers the expired snooze to the patient before resuming the due caregiver stage on the next tick', async () => {
    const f = await fixture(), caregiver = randomUUID(), relationship = randomUUID(), session = randomUUID();
    await owner("INSERT INTO users(id,email,display_name) VALUES($1,$2,'Nurse')", [caregiver, `${caregiver}@example.test`]);
    await owner('INSERT INTO user_email_verifications(user_id,email) SELECT id,email FROM users WHERE id=$1', [caregiver]);
    await owner("INSERT INTO auth_sessions(id,user_id,refresh_token_hash,device_id,expires_at) VALUES($1,$2,$3,'caregiver-device',now()+interval '1 day')",
      [session, caregiver, randomUUID()]);
    await owner("INSERT INTO push_tokens(user_id,token,platform,device_id,session_id) VALUES($1,$2,'ios','caregiver-device',$3)",
      [caregiver, `ExponentPushToken[${caregiver}]`, session]);
    await owner(`INSERT INTO caregiver_relationships(id,patient_profile_id,caregiver_user_id,invited_email,invited_name,role,status,permissions,invited_by_user_id)
      VALUES($1,$2,$3,$4,'Nurse','nurse','active',ARRAY['receive_notifications'],$5)`,
    [relationship, f.profile, caregiver, `${caregiver}@example.test`, f.user]);
    await owner(`INSERT INTO caregiver_notification_rules(relationship_id,patient_profile_id,mode,channel,enabled)
      VALUES($1,$2,'missed_only','push',true)`, [relationship, f.profile]);
    await owner('UPDATE escalation_policies SET stages=$2 WHERE patient_profile_id=$1', [f.profile, JSON.stringify([
      { afterMinutes: 0, target: 'patient', channels: ['push'] },
      { afterMinutes: 10, target: 'patient', channels: ['push'] },
      { afterMinutes: 60, target: 'primary_caregiver', channels: ['push'] },
    ])]);
    await reminderJob(ctx, client); await dispatchJob(ctx, client);
    expect(sent).toHaveLength(1);
    const intent = randomUUID();
    await owner("UPDATE dose_occurrences SET status='snoozed',snoozed_until=$2,client_event_id=$3,snooze_count=1 WHERE id=$1",
      [f.dose, new Date('2026-09-19T07:00:00Z'), intent]);
    now = new Date('2026-09-19T06:30:00Z');
    await reminderJob(ctx, client); await dispatchJob(ctx, client); expect(sent).toHaveLength(1);
    now = new Date('2026-09-19T07:10:00Z');
    await reminderJob(ctx, client); await dispatchJob(ctx, client);
    expect(sent).toHaveLength(2); expect(sent[1]!.data.intentId).toBe(intent);
    now = new Date('2026-09-19T07:11:00Z');
    await reminderJob(ctx, client); await dispatchJob(ctx, client);
    expect(sent).toHaveLength(3); expect(sent[2]!.data.kind).toBe('escalation');
    now = new Date('2026-09-19T07:12:00Z');
    await reminderJob(ctx, client); await dispatchJob(ctx, client); expect(sent).toHaveLength(3);
  });

  it('sends an independent snooze once after the ordinary ladder completed', async () => {
    const f = await fixture();
    await reminderJob(ctx, client); await dispatchJob(ctx, client);
    const intent = randomUUID();
    const until = new Date('2026-09-19T06:15:00Z');
    await owner(`UPDATE dose_occurrences SET status='snoozed',snoozed_until=$2,client_event_id=$3,
      snooze_count=1,escalation_completed_at=$4 WHERE id=$1`, [f.dose, until, intent, now]);
    now = new Date('2026-09-19T06:14:00Z');
    await reminderJob(ctx, client); expect((await queued()).length).toBe(1);
    now = until;
    await reminderJob(ctx, client); await reminderJob(ctx, client);
    await dispatchJob(ctx, client);
    expect(sent).toHaveLength(2);
    expect(sent[1]!.data).toMatchObject({ doseId: f.dose, intentId: intent, expectedSnoozedUntil: until.toISOString() });
    expect((await queued()).filter(row => row.payload.reason === 'snooze')).toHaveLength(1);
    expect((await owner('SELECT scheduled_at FROM dose_occurrences WHERE id=$1', [f.dose])).rows[0]).toEqual({ scheduled_at: new Date('2026-09-19T06:00:00Z') });
  });

  it.each(['taken', 'skipped', 'paused', 'disabled-policy', 'newer-snooze'])(
    'suppresses queued patient actions after %s before calling the provider', async change => {
      const f = await fixture(); await reminderJob(ctx, client);
      if (change === 'taken') await owner("UPDATE dose_occurrences SET status='taken',confirmed_at=$2,confirmation_method='app' WHERE id=$1", [f.dose, now]);
      if (change === 'skipped') await owner("UPDATE dose_occurrences SET status='skipped' WHERE id=$1", [f.dose]);
      if (change === 'paused') await owner("UPDATE medications SET status='paused' WHERE id=$1", [f.medication]);
      if (change === 'disabled-policy') await owner('UPDATE escalation_policies SET enabled=false WHERE patient_profile_id=$1', [f.profile]);
      if (change === 'newer-snooze') {
        await owner("UPDATE dose_occurrences SET status='snoozed',snoozed_until=$2,client_event_id=$3 WHERE id=$1",
          [f.dose, new Date('2026-09-19T06:10:00Z'), randomUUID()]);
        now = new Date('2026-09-19T06:11:00Z'); // even after expiry, the previous intent is stale
      }
      await dispatchJob(ctx, client);
      expect(sent).toHaveLength(0); expect((await queued())[0].status).toBe('skipped');
    });

  it('prunes a confirmed member of a grouped push and keeps navigation without quick confirmation', async () => {
    const f = await fixture('First'); const extra = randomUUID(), schedule = randomUUID(), dose = randomUUID();
    await owner("INSERT INTO medications(id,patient_profile_id,name,form,start_date,created_by) VALUES($1,$2,'Second','tablet','2026-01-01',$3)", [extra, f.profile, f.user]);
    await owner(`INSERT INTO medication_schedules(id,medication_id,patient_profile_id,rule_kind,rule,dose_quantity,dose_unit,start_date,created_by)
      SELECT $1,$2,patient_profile_id,rule_kind,rule,dose_quantity,dose_unit,start_date,created_by FROM medication_schedules WHERE id=$3`, [schedule, extra, f.schedule]);
    await owner(`INSERT INTO dose_occurrences(id,schedule_id,medication_id,patient_profile_id,scheduled_at,scheduled_local_date,scheduled_local_time,scheduled_timezone,dose_quantity,dose_unit)
      SELECT $1,$2,$3,patient_profile_id,scheduled_at,scheduled_local_date,scheduled_local_time,scheduled_timezone,dose_quantity,dose_unit FROM dose_occurrences WHERE id=$4`, [dose, schedule, extra, f.dose]);
    await reminderJob(ctx, client);
    expect(await queued()).toHaveLength(1);
    await owner("UPDATE dose_occurrences SET status='taken',confirmed_at=$2,confirmation_method='app' WHERE id=$1", [f.dose, now]);
    await dispatchJob(ctx, client);
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0]!.data.doseIds!)).toEqual([dose]);
    expect(sent[0]!.data.actions).toBe('[]');
    expect(sent[0]!.body).not.toContain('First'); expect(sent[0]!.body).toContain('Second');
  });

  it('rechecks a confirmation arriving after claim commit and before provider preparation', async () => {
    const f = await fixture(); await reminderJob(ctx, client);
    afterClaim = async () => { await owner("UPDATE dose_occurrences SET status='taken',confirmed_at=$2,confirmation_method='app' WHERE id=$1", [f.dose, now]); };
    await dispatchJob(ctx, client);
    expect(sent).toHaveLength(0); expect((await queued())[0].status).toBe('skipped');
  });

  it('requeues an expired claim without sending, then delivers under a fresh lease', async () => {
    await fixture(); await reminderJob(ctx, client);
    afterClaim = async () => { now = new Date('2026-09-19T06:03:00Z'); };
    await dispatchJob(ctx, client);
    expect(sent).toHaveLength(0);
    expect((await queued())[0]).toMatchObject({ status: 'queued', attempts: 0, lease_token: null });
    await dispatchJob(ctx, client);
    expect(sent).toHaveLength(1); expect((await queued())[0].status).toBe('sent');
  });

  it('visits an eligible later dose beyond 1000 still-open completed ladders', async () => {
    const f = await fixture();
    await owner(`INSERT INTO dose_occurrences(schedule_id,medication_id,patient_profile_id,scheduled_at,
      scheduled_local_date,scheduled_local_time,scheduled_timezone,dose_quantity,dose_unit,escalation_completed_at,escalation_stage)
      SELECT $1,$2,$3,$4::timestamptz - make_interval(secs => n), '2026-09-19','08:59','Asia/Riyadh',1,'tablet',$4,1
      FROM generate_series(1,1000) n`, [f.schedule, f.medication, f.profile, now]);
    await reminderJob(ctx, client);
    expect((await queued()).some(row => row.dose_occurrence_id === f.dose)).toBe(true);
  });
});

describe('nonurgent delivery lifecycle', () => {
  it('defers quiet stock alerts without consuming transport attempts, then sends on wake', async () => {
    const f = await fixture();
    await owner("INSERT INTO medication_stock(medication_id,patient_profile_id,unit,remaining_quantity) VALUES($1,$2,'tablet',2)", [f.medication, f.profile]);
    await owner("UPDATE user_preferences SET quiet_hours_start='08:00',quiet_hours_end='10:00' WHERE user_id=$1", [f.user]);
    await stockAlertJob(ctx, client); await dispatchJob(ctx, client);
    expect(sent).toHaveLength(0);
    expect((await queued())[0]).toMatchObject({ status: 'queued', attempts: 0, next_attempt_at: new Date('2026-09-19T07:00:00Z') });
    now = new Date('2026-09-19T07:00:00Z'); await dispatchJob(ctx, client); expect(sent).toHaveLength(1);
  });

  it('does not renag the same low stock after three days and rearms within the same day after refill', async () => {
    const f = await fixture();
    await owner("INSERT INTO medication_stock(medication_id,patient_profile_id,unit,remaining_quantity) VALUES($1,$2,'tablet',2)", [f.medication, f.profile]);
    await stockAlertJob(ctx, client);
    now = new Date('2026-09-23T06:00:00Z'); await stockAlertJob(ctx, client); expect(await queued()).toHaveLength(1);
    now = new Date('2026-09-19T06:01:00Z');
    await owner('UPDATE medication_stock SET low_stock_notified_at=NULL,remaining_quantity=3,last_refill_at=$2 WHERE medication_id=$1', [f.medication, now]);
    await stockAlertJob(ctx, client); expect(await queued()).toHaveLength(2);
  });

  it('suppresses an old low-stock alert if a refill resolved it during quiet hours', async () => {
    const f = await fixture();
    await owner("INSERT INTO medication_stock(medication_id,patient_profile_id,unit,remaining_quantity) VALUES($1,$2,'tablet',2)", [f.medication, f.profile]);
    await owner("UPDATE user_preferences SET quiet_hours_start='08:00',quiet_hours_end='10:00' WHERE user_id=$1", [f.user]);
    await stockAlertJob(ctx, client); await dispatchJob(ctx, client);
    await owner('UPDATE medication_stock SET remaining_quantity=30,low_stock_notified_at=NULL WHERE medication_id=$1', [f.medication]);
    now = new Date('2026-09-19T07:00:00Z'); await dispatchJob(ctx, client);
    expect(sent).toHaveLength(0); expect((await queued())[0].status).toBe('skipped');
  });

  it('uses the current quantity if an already queued low-stock condition still applies', async () => {
    const f = await fixture();
    await owner("INSERT INTO medication_stock(medication_id,patient_profile_id,unit,remaining_quantity) VALUES($1,$2,'tablet',2)", [f.medication, f.profile]);
    await stockAlertJob(ctx, client);
    await owner('UPDATE medication_stock SET remaining_quantity=1 WHERE medication_id=$1', [f.medication]);
    await dispatchJob(ctx, client);
    expect(sent).toHaveLength(1); expect(sent[0]!.body).toContain('1 tablet');
    expect(sent[0]!.body).not.toContain('2 tablet');
  });

  it('catches up one latest daily digest for a verified email nurse after the minute is missed', async () => {
    const f = await fixture(), caregiver = randomUUID(), relationship = randomUUID();
    await owner("INSERT INTO users(id,email,display_name) VALUES($1,$2,'Nurse')", [caregiver, `${caregiver}@example.test`]);
    await owner('INSERT INTO user_email_verifications(user_id,email) SELECT id,email FROM users WHERE id=$1', [caregiver]);
    await owner(`INSERT INTO caregiver_relationships(id,patient_profile_id,caregiver_user_id,invited_email,invited_name,role,status,permissions,invited_by_user_id)
      VALUES($1,$2,$3,$4,'Nurse','nurse','active',ARRAY['receive_notifications','view_schedule','view_adherence'],$5)`,
    [relationship, f.profile, caregiver, `${caregiver}@example.test`, f.user]);
    await owner(`INSERT INTO caregiver_notification_rules(relationship_id,patient_profile_id,mode,channel,summary_time,updated_at)
      VALUES($1,$2,'daily_summary','push','09:00','2026-09-01')`, [relationship, f.profile]);
    await owner("UPDATE dose_occurrences SET scheduled_at=scheduled_at-interval '1 day',scheduled_local_date='2026-09-18',status='missed' WHERE id=$1", [f.dose]);
    now = new Date('2026-09-19T06:01:00Z');
    await digestJob(ctx, client); await digestJob(ctx, client);
    expect(await queued()).toHaveLength(1);
    expect((await queued())[0]).toMatchObject({ kind: 'daily_summary', recipient_user_id: caregiver, payload: { periodDate: '2026-09-19', missed: 1 } });
  });

  it('removes old failed and expired deliveries while retaining live retries', async () => {
    const f = await fixture();
    for (const status of ['failed', 'expired', 'queued', 'sending']) await owner(`INSERT INTO notification_deliveries(recipient_user_id,patient_profile_id,kind,channel,status,dedupe_key,scheduled_for,next_attempt_at,created_at)
      VALUES($1,$4,'system','push',$2,$3,now(),now(),now()-interval '91 days')`, [f.user, status, randomUUID(), f.profile]);
    await owner(`INSERT INTO notification_deliveries(recipient_user_id,patient_profile_id,kind,channel,status,dedupe_key,scheduled_for,next_attempt_at)
      VALUES($1,$2,'system','push','failed',$3,now(),now())`, [f.user, f.profile, randomUUID()]);
    expect((await client.query("SELECT count(*)::int AS count FROM notification_deliveries WHERE created_at < now()-interval '90 days'")).rows).toEqual([{ count: 4 }]);
    await db.exec('BEGIN');
    const result = await housekeepingJob(ctx, client); await db.exec('COMMIT');
    expect(result.failures).toEqual([]);
    expect((await queued()).map(row => row.status).sort()).toEqual(['failed', 'queued', 'sending']);
    // Even an accidentally broad worker DELETE cannot remove the protected rows.
    expect((await client.query('DELETE FROM notification_deliveries')).rowCount).toBe(0);
  });
});
