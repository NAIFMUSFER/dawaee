import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetDatabase, signIn, startHarness, type Harness, type TestUser } from './harness.js';

// Only the existing disposable localhost test database is used. The worker and
// application roles never receive fixture-administration privileges.
let h: Harness;
let appPool: pg.Pool;
let fixturePool: pg.Pool;
let alice: TestUser;
let bob: TestUser;
let dependentProfileId: string;
let medicationId: string;
const ORIGINAL_NAME = 'Reparent boundary fixture';

beforeAll(async () => {
  resetDatabase();
  h = await startHarness();
  appPool = new pg.Pool({
    connectionString: 'postgres://dawaee_app:devpass@127.0.0.1:5433/dawaee_test', max: 2,
  });
  fixturePool = new pg.Pool({
    connectionString: 'postgres://postgres:postgres@127.0.0.1:5433/dawaee_test', max: 2,
  });
  alice = await signIn(h, '+966500099961');
  bob = await signIn(h, '+966500099962');
  const profiles = await fixturePool.query<{ id: string }>(
    `INSERT INTO patient_profiles (owner_user_id, display_name, is_self)
     VALUES ($1, 'Reparent dependent fixture', false) RETURNING id`, [alice.userId],
  );
  dependentProfileId = profiles.rows[0]!.id;
  const medications = await fixturePool.query<{ id: string }>(
    `INSERT INTO medications (patient_profile_id, name, form, start_date, created_by)
     VALUES ($1,$2,'tablet','2026-09-01',$3) RETURNING id`,
    [alice.profileId, ORIGINAL_NAME, alice.userId],
  );
  medicationId = medications.rows[0]!.id;
  await fixturePool.query(
    `INSERT INTO medication_schedules
       (medication_id, patient_profile_id, rule_kind, rule, dose_quantity, dose_unit,
        start_date, late_after_minutes, missed_after_minutes, created_by)
     VALUES ($1,$2,'fixed_times',$3::jsonb,1,'tablet','2026-09-01',15,120,$4)`,
    [medicationId, alice.profileId, JSON.stringify({ kind: 'fixed_times', times: ['09:00'] }), alice.userId],
  );
}, 120_000);

afterAll(async () => {
  await appPool?.end();
  await fixturePool?.end();
  await h?.close();
});

async function attemptRuntimeReparent(targetProfileId: string) {
  const client = await appPool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1,$2,true)', ['app.user_id', alice.userId]);
    const visible = await client.query('SELECT id FROM medications WHERE id=$1', [medicationId]);
    expect(visible.rows, 'the test must actually reach the owned medication').toHaveLength(1);
    const result = await client.query(
      'UPDATE medications SET patient_profile_id=$1 WHERE id=$2 RETURNING id',
      [targetProfileId, medicationId],
    );
    return { rowCount: result.rowCount, code: null, constraint: null };
  } catch (error) {
    const pgError = error as Error & { code?: string; constraint?: string };
    return { rowCount: 0, code: pgError.code ?? null, constraint: pgError.constraint ?? null };
  } finally {
    try { await client.query('ROLLBACK'); } finally { client.release(); }
  }
}

async function expectOriginalGraph() {
  const { rows } = await fixturePool.query<{
    name: string; patient_profile_id: string; schedule_profile_id: string;
  }>(
    `SELECT m.name, m.patient_profile_id, s.patient_profile_id AS schedule_profile_id
       FROM medications m JOIN medication_schedules s ON s.medication_id=m.id
      WHERE m.id=$1`, [medicationId],
  );
  expect(rows).toEqual([{
    name: ORIGINAL_NAME, patient_profile_id: alice.profileId, schedule_profile_id: alice.profileId,
  }]);
}

describe('RLS denial and medication graph integrity remain separate boundaries', () => {
  it('uses the restricted app role and the AFTER ROW immutability trigger', async () => {
    const role = await appPool.query<{ role: string; rolsuper: boolean; rolbypassrls: boolean }>(
      `SELECT current_user AS role, rolsuper, rolbypassrls
         FROM pg_roles WHERE rolname=current_user`,
    );
    expect(role.rows).toEqual([{ role: 'dawaee_app', rolsuper: false, rolbypassrls: false }]);
    const guard = await fixturePool.query<{
      row_level: boolean; before_row: boolean; on_update: boolean; rls: boolean; forced: boolean;
    }>(
      `SELECT (t.tgtype::integer & 1) <> 0 AS row_level,
              (t.tgtype::integer & 2) <> 0 AS before_row,
              (t.tgtype::integer & 16) <> 0 AS on_update,
              c.relrowsecurity AS rls, c.relforcerowsecurity AS forced
         FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
        WHERE t.tgrelid='public.medications'::regclass
          AND t.tgname='medication_patient_profile_immutable_guard'
          AND NOT t.tgisinternal AND t.tgenabled='O'`,
    );
    expect(guard.rows).toEqual([{
      row_level: true, before_row: false, on_update: true, rls: true, forced: true,
    }]);
  });

  it('rejects a foreign-account target with RLS SQLSTATE 42501, not a structural check', async () => {
    const result = await attemptRuntimeReparent(bob.profileId);
    expect(result).toEqual({ rowCount: 0, code: '42501', constraint: null });
    await expectOriginalGraph();
  });

  it('rejects a same-owner target with the exact immutable-profile constraint', async () => {
    const result = await attemptRuntimeReparent(dependentProfileId);
    expect(result).toEqual({ rowCount: 0, code: '23514', constraint: 'medication_patient_profile_immutable' });
    await expectOriginalGraph();
  });

  it('rolls back earlier changes when a privileged write reaches the AFTER guard', async () => {
    const client = await fixturePool.connect();
    let failure: { code?: string; constraint?: string } | undefined;
    try {
      await client.query('BEGIN');
      await client.query('UPDATE medications SET name=$1 WHERE id=$2', ['uncommitted fixture name', medicationId]);
      await client.query('UPDATE medications SET patient_profile_id=$1 WHERE id=$2', [dependentProfileId, medicationId]);
    } catch (error) {
      failure = error as { code?: string; constraint?: string };
      // A real exception from the guard must abort the transaction before the
      // explicit cleanup below; manual ROLLBACK alone would not prove this.
      await expect(client.query('SELECT 1')).rejects.toMatchObject({ code: '25P02' });
    } finally {
      try { await client.query('ROLLBACK'); } finally { client.release(); }
    }
    expect(failure?.code).toBe('23514');
    expect(failure?.constraint).toBe('medication_patient_profile_immutable');
    await expectOriginalGraph();
  });

  it('permits an owned update whose patient profile is unchanged', async () => {
    expect(await attemptRuntimeReparent(alice.profileId)).toEqual({ rowCount: 1, code: null, constraint: null });
    await expectOriginalGraph();
  });
});
