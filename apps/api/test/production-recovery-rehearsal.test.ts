import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pool, PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';
import { createRecoveryHarness } from '../../../scripts/release-recovery-harness.mjs';
import { loadConfig } from '../src/config.js';
import { checkSchemaContract, requiredMigrations } from '../src/lib/schema-contract.js';
import { buildProviders, LocalStorageProvider } from '../src/providers/index.js';
import { confirmDose, undoDose } from '../src/services/dose-service.js';
import { createWorkerContext } from '../../worker/src/context.js';
import { housekeepingJob } from '../../worker/src/jobs/housekeeping.js';

const user = 'a1000000-0000-4000-8000-000000000001';
const profile = 'a2000000-0000-4000-8000-000000000001';
const medication = 'a3000000-0000-4000-8000-000000000001';
const schedule = 'a4000000-0000-4000-8000-000000000001';
const oldDose = 'a5000000-0000-4000-8000-000000000001';
const nextDose = 'a5000000-0000-4000-8000-000000000002';
const referencedKey = 'recovery/referenced.jpg';
const abandonedKey = 'recovery/abandoned.jpg';

// All rows and bytes are synthetic. No production export is read by this suite.
const fixture = `
  INSERT INTO users(id,phone_e164,display_name)
    VALUES ('${user}','+966500000199','Before backup');
  INSERT INTO patient_profiles(id,owner_user_id,display_name,timezone,home_timezone,is_self)
    VALUES ('${profile}','${user}','Recovery fixture','Etc/UTC','Etc/UTC',true);
  INSERT INTO stored_objects(object_key,owner_user_id,patient_profile_id,purpose,
      content_type,byte_size,scan_status,created_at)
    VALUES ('${referencedKey}','${user}','${profile}','medication_image','image/jpeg',4,'clean',now()-interval '48 hours'),
           ('${abandonedKey}','${user}','${profile}','medication_image','image/jpeg',4,'clean',now()-interval '48 hours');
  INSERT INTO medications(id,patient_profile_id,name,form,image_key,start_date,created_by)
    VALUES ('${medication}','${profile}','Recovery fixture','tablet','${referencedKey}',current_date-1,'${user}');
  INSERT INTO medication_stock(medication_id,patient_profile_id,unit,initial_quantity,remaining_quantity)
    VALUES ('${medication}','${profile}','tablet',30,29);
  INSERT INTO medication_schedules(id,medication_id,patient_profile_id,rule_kind,rule,
      dose_quantity,dose_unit,timezone,start_date,created_by)
    VALUES ('${schedule}','${medication}','${profile}','fixed_times',
      '{"kind":"fixed_times","times":["08:00"]}',1,'tablet','Etc/UTC',current_date-1,'${user}');
  INSERT INTO dose_occurrences(id,schedule_id,medication_id,patient_profile_id,scheduled_at,
      scheduled_local_date,scheduled_local_time,scheduled_timezone,dose_quantity,dose_unit,
      status,confirmed_at,confirmed_by_user_id,confirmation_method,client_event_id)
    VALUES ('${oldDose}','${schedule}','${medication}','${profile}',now()-interval '1 hour',
      (now()-interval '1 hour')::date,(now()-interval '1 hour')::time,'Etc/UTC',1,'tablet',
      'taken',now()-interval '59 minutes','${user}','app','baseline-take');
  INSERT INTO dose_occurrences(id,schedule_id,medication_id,patient_profile_id,scheduled_at,
      scheduled_local_date,scheduled_local_time,scheduled_timezone,dose_quantity,dose_unit)
    VALUES ('${nextDose}','${schedule}','${medication}','${profile}',now(),
      current_date,localtime,'Etc/UTC',1,'tablet');
  INSERT INTO dose_events(dose_occurrence_id,patient_profile_id,type,actor_user_id,method)
    VALUES ('${oldDose}','${profile}','taken','${user}','app');
  INSERT INTO stock_transactions(medication_id,patient_profile_id,delta,reason,
      dose_occurrence_id,balance_after,actor_user_id)
    VALUES ('${medication}','${profile}',-1,'dose_taken','${oldDose}',29,'${user}');
`;

// Statement contracts from the recorded live API 4cf23531dfaa5cc7c3790b473f8b4ff9f88d9f72
// and worker 0338ddefc475d23cccecf13d5ede0f32d2007fb0. EXPLAIN has no ANALYZE:
// it checks planning/privileges only and does not execute the old binaries.
const legacyStock = `EXPLAIN INSERT INTO stock_transactions
  (medication_id,patient_profile_id,delta,reason,dose_occurrence_id,balance_after,actor_user_id)
  VALUES ($1,$2,$3,'dose_taken',$4,$5,$6)
  ON CONFLICT (dose_occurrence_id,reason) WHERE dose_occurrence_id IS NOT NULL DO NOTHING`;
const legacyCleanup = `EXPLAIN DELETE FROM stored_objects
  WHERE uploaded_at IS NULL AND created_at < now()-interval '24 hours'`;

async function transaction<T>(pool: Pool, fn: (tx: PoolClient) => Promise<T>, userId?: string) {
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN');
    if (userId) await tx.query("SELECT set_config('app.user_id',$1,true)", [userId]);
    const result = await fn(tx);
    await tx.query('COMMIT');
    return result;
  } catch (error) {
    await tx.query('ROLLBACK');
    throw error;
  } finally { tx.release(); }
}

async function planOnly(pool: Pool, sql: string, values: unknown[] = []) {
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN READ ONLY');
    await tx.query("SELECT set_config('app.user_id',$1,true)", [user]);
    await tx.query(sql, values);
  } finally {
    await tx.query('ROLLBACK');
    tx.release();
  }
}

describe('production-shaped backup and recovery', () => {
  it('restores baseline data and permissions, upgrades actual services, and demonstrates the write-loss boundary', async () => {
    // CI's normal db-reset step has already prepared the roles. The harness
    // refuses missing/unexpected roles; it never changes a shared role/password.
    const h = await createRecoveryHarness();
    const pools: Pool[] = [];
    const connect = (db: string, role: string) => {
      const p: Pool = h.pool(db, role);
      pools.push(p);
      return p;
    };
    const storageDir = mkdtempSync(join(tmpdir(), 'dawaee-recovery-objects-'));
    try {
      const { source, upgrade, recovered } = h.names;
      await h.create(source);
      h.migrate(source, true);
      await h.query(source, 'postgres', fixture);
      const baseline = await h.snapshot(source);
      expect(baseline.data.find(t => t.table === 'public.schema_migrations')?.count).toBe(34);
      const parameters = [medication, profile, -1, nextDose, 28, user];
      await planOnly(connect(source, 'dawaee_app'), legacyStock, parameters);
      await planOnly(connect(source, 'dawaee_worker'), legacyCleanup);

      const cfg = { ...loadConfig(), STORAGE_LOCAL_DIR: storageDir };
      const storage = new LocalStorageProvider(cfg);
      await storage.putObject(referencedKey, Buffer.from('keep'));
      await storage.putObject(abandonedKey, Buffer.from('gone'));
      const backup = await h.backup();
      expect(backup.bytes).toBeGreaterThan(0);
      expect(backup.sha256).toMatch(/^[a-f0-9]{64}$/);
      // Explicitly show a write after the backup point is not recoverable from
      // that archive. Production must freeze writers or accept/reconcile RPO.
      await h.query(source, 'postgres', "UPDATE users SET display_name='After backup' WHERE id=$1", [user]);

      await h.create(upgrade);
      const upgradeRestore = await h.restore(upgrade);
      expect(await h.snapshot(upgrade)).toEqual(baseline);
      h.migrate(upgrade);
      const app = connect(upgrade, 'dawaee_app');
      const worker = connect(upgrade, 'dawaee_worker');
      const contract = await checkSchemaContract(app);
      expect(contract).toMatchObject({ ok: true, required: h.targetCount, applied: h.targetCount,
        revision: h.targetLatest, missing: [], mismatched: [] });
      const ledger = await h.query(upgrade, 'postgres',
        'SELECT filename,checksum FROM schema_migrations ORDER BY filename');
      expect(ledger.rows).toEqual(requiredMigrations());
      const beforeNoop = await h.snapshot(upgrade);
      expect(h.migrate(upgrade)).toContain('no pending migrations');
      expect(await h.snapshot(upgrade)).toEqual(beforeNoop);

      // Ordinary runtime connections exercise the actual current service/job.
      const input = { doseId: nextDose, userId: user, actorRole: 'patient' as const,
        method: 'app' as const, clientEventId: 'recovery-take-1', now: new Date() };
      const first = await transaction(app, tx => confirmDose(tx, input), user);
      expect(first).toMatchObject({ idempotentReplay: false, stock: { remainingQuantity: 28 } });
      await transaction(app, tx => undoDose(tx, { doseId: nextDose, userId: user, now: new Date() }), user);
      expect((await h.query(upgrade, 'postgres', 'SELECT remaining_quantity::int AS n FROM medication_stock')).rows)
        .toEqual([{ n: 29 }]);
      const repeat = await transaction(app, tx => confirmDose(tx,
        { ...input, clientEventId: 'recovery-take-2', now: new Date() }), user);
      expect(repeat).toMatchObject({ idempotentReplay: false, stock: { remainingQuantity: 28 } });
      const replay = await transaction(app, tx => confirmDose(tx, input), user);
      expect(replay.idempotentReplay).toBe(true);
      const movements = await h.query(upgrade, 'postgres', `
        SELECT count(*)::int AS moves,count(dose_event_id)::int AS linked,
          count(DISTINCT dose_event_id)::int AS distinct_events,sum(delta)::int AS delta
        FROM stock_transactions`);
      expect(movements.rows).toEqual([{ moves: 4, linked: 3, distinct_events: 3, delta: -2 }]);
      expect((await h.query(upgrade, 'postgres', 'SELECT remaining_quantity::int AS n FROM medication_stock')).rows)
        .toEqual([{ n: 28 }]);
      expect((await h.query(upgrade, 'postgres', 'SELECT count(*)::int AS n FROM dose_events')).rows)
        .toEqual([{ n: 4 }]);

      const providers = { ...buildProviders(cfg), storage };
      const ctx = createWorkerContext({ pool: worker, providers, config: cfg });
      const cleaned = await transaction(worker, tx => housekeepingJob(ctx, tx));
      expect(cleaned.failures).toEqual([]);
      expect(cleaned.itemsProcessed).toBe(1);
      expect((await h.query(upgrade, 'postgres', 'SELECT object_key FROM stored_objects')).rows)
        .toEqual([{ object_key: referencedKey }]);
      expect(await storage.getObject(referencedKey)).toEqual(Buffer.from('keep'));
      await expect(storage.getObject(abandonedKey)).rejects.toMatchObject({ code: 'ENOENT' });
      const boundary = await h.query(upgrade, 'postgres', `
        SELECT rolname,rolsuper,rolbypassrls,
          pg_has_role(rolname,'dawaee_migrator','MEMBER') AS owner_member
        FROM pg_roles WHERE rolname IN ('dawaee_app','dawaee_worker') ORDER BY rolname`);
      expect(boundary.rows).toEqual(['dawaee_app', 'dawaee_worker'].map(rolname =>
        ({ rolname, rolsuper: false, rolbypassrls: false, owner_member: false })));

      // These failures are release compatibility checks in disposable synthetic
      // databases. Do not re-add the old index or broaden worker grants to pass.
      await expect(planOnly(app, legacyStock, parameters)).rejects.toMatchObject({ code: '42P10' });
      await expect(planOnly(worker, legacyCleanup)).rejects.toMatchObject({ code: '42501' });

      await h.create(recovered);
      const recoveryRestore = await h.restore(recovered);
      // Compare before running migrations or maintenance that might hide a
      // restore defect: rows, ledger, sequence state, ACLs, policies and DDL.
      expect(await h.snapshot(recovered)).toEqual(baseline);
      const recoveredApp = connect(recovered, 'dawaee_app');
      await planOnly(recoveredApp, legacyStock, parameters);
      await planOnly(connect(recovered, 'dawaee_worker'), legacyCleanup);
      expect(await checkSchemaContract(recoveredApp)).toMatchObject({ ok: false, applied: 34,
        missing: requiredMigrations().filter(m => Number(m.filename.slice(0, 4)) > 33
          && Number(m.filename.slice(0, 4)) !== 47).map(m => m.filename), mismatched: [] });
      expect((await h.query(recovered, 'postgres', 'SELECT display_name FROM users WHERE id=$1', [user])).rows)
        .toEqual([{ display_name: 'Before backup' }]);
      expect((await h.query(source, 'postgres', 'SELECT display_name FROM users WHERE id=$1', [user])).rows)
        .toEqual([{ display_name: 'After backup' }]);
      expect((await h.query(recovered, 'postgres', 'SELECT remaining_quantity::int AS n FROM medication_stock')).rows)
        .toEqual([{ n: 29 }]);
      // PostgreSQL restored the ticket, not the deleted object bytes. A real
      // recovery needs a separately verified object-store backup/version plan.
      expect((await h.query(recovered, 'postgres', 'SELECT count(*)::int AS n FROM stored_objects')).rows)
        .toEqual([{ n: 2 }]);
      await expect(storage.getObject(abandonedKey)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(h.restore(recovered)).rejects.toThrow('refusing to overwrite a populated target');
      await expect(h.restore(source)).rejects.toThrow('refusing to restore over the source');
      console.info('SYNTHETIC RECOVERY REHEARSAL PASSED', JSON.stringify({
        baselineMigrations: 34, upgradedMigrations: h.targetCount, backup,
        upgradeRestore, recoveryRestore, productionBackup: false,
        oldBinaryExecution: false, objectBytesRestored: false, postBackupWritesRecovered: false,
      }));
    } finally {
      await Promise.all(pools.map(p => p.end()));
      rmSync(storageDir, { recursive: true, force: true });
      await h.cleanup();
    }
  }, 180_000);
});
