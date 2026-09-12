import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetDatabase, signIn, startHarness, type Harness, type TestUser } from './harness.js';

let h: Harness;
let appPool: pg.Pool;
let ownerPool: pg.Pool;
let alice: TestUser;
let bob: TestUser;
let aliceMedicationId: string;
let bobMedicationId: string;
let dependentMedicationId: string;
let aliceScheduleId: string;
let bobScheduleId: string;
let dependentProfileId: string;

interface Attempt {
  rowCount: number;
  errorCode: string | null;
  constraint: string | null;
  error: string | null;
}

async function asAliceRollback(sql: string, params: unknown[] = []): Promise<Attempt> {
  const client = await appPool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1,$2,true)', ['app.user_id', alice.userId]);
    const result = await client.query(sql, params);
    await client.query('ROLLBACK');
    return { rowCount: result.rowCount ?? 0, errorCode: null, constraint: null, error: null };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    const pgError = err as Error & { code?: string; constraint?: string };
    return {
      rowCount: 0,
      errorCode: pgError.code ?? null,
      constraint: pgError.constraint ?? null,
      error: pgError.message,
    };
  } finally {
    client.release();
  }
}

async function createMedication(profileId: string, userId: string, name: string): Promise<string> {
  const { rows } = await ownerPool.query<{ id: string }>(
    `INSERT INTO medications (patient_profile_id, name, form, start_date, created_by)
     VALUES ($1,$2,'tablet','2026-09-01',$3)
     RETURNING id`,
    [profileId, name, userId],
  );
  return rows[0]!.id;
}

async function createSchedule(profileId: string, medicationId: string, userId: string): Promise<string> {
  const { rows } = await ownerPool.query<{ id: string }>(
    `INSERT INTO medication_schedules
       (medication_id, patient_profile_id, rule_kind, rule, dose_quantity, dose_unit,
        timezone, start_date, late_after_minutes, missed_after_minutes, created_by)
     VALUES ($1,$2,'fixed_times',$3::jsonb,1,'tablet','Asia/Riyadh','2026-09-01',15,120,$4)
     RETURNING id`,
    [medicationId, profileId, JSON.stringify({ kind: 'fixed_times', times: ['09:00'] }), userId],
  );
  return rows[0]!.id;
}

beforeAll(async () => {
  resetDatabase();
  h = await startHarness();
  appPool = new pg.Pool({
    connectionString: 'postgres://dawaee_app:devpass@127.0.0.1:5433/dawaee_test',
    max: 2,
  });
  ownerPool = new pg.Pool({
    connectionString: 'postgres://postgres:postgres@127.0.0.1:5433/dawaee_test',
    max: 2,
  });

  alice = await signIn(h, '+966500099941');
  bob = await signIn(h, '+966500099942');

  const { rows: dependentProfiles } = await ownerPool.query<{ id: string }>(
    `INSERT INTO patient_profiles (owner_user_id, display_name, is_self)
     VALUES ($1,'Alice dependent',false)
     RETURNING id`,
    [alice.userId],
  );
  dependentProfileId = dependentProfiles[0]!.id;

  aliceMedicationId = await createMedication(alice.profileId, alice.userId, 'Alice medication');
  bobMedicationId = await createMedication(bob.profileId, bob.userId, 'Bob medication');
  dependentMedicationId = await createMedication(dependentProfileId, alice.userId, 'Dependent medication');
  aliceScheduleId = await createSchedule(alice.profileId, aliceMedicationId, alice.userId);
  bobScheduleId = await createSchedule(bob.profileId, bobMedicationId, bob.userId);
});

afterAll(async () => {
  await appPool.end();
  await ownerPool.end();
  await h.close();
});

describe('dose occurrence / schedule graph integrity', () => {
  it('does not let an allowed Alice dose reference Bob\'s schedule id', async () => {
    const attempt = await asAliceRollback(
      `INSERT INTO dose_occurrences
         (schedule_id, medication_id, patient_profile_id, scheduled_at,
          scheduled_local_date, scheduled_local_time, scheduled_timezone,
          dose_quantity, dose_unit, status)
       VALUES ($1,$2,$3,'2026-09-20T06:00:00Z','2026-09-20','09:00','Asia/Riyadh',1,'tablet','upcoming')`,
      [bobScheduleId, aliceMedicationId, alice.profileId],
    );

    expect(attempt.errorCode, attempt.error ?? 'cross-patient schedule edge unexpectedly succeeded').toBe('23514');
    expect(attempt.constraint).toBe('dose_schedule_graph_match');
  });

  it('does not let one owner reparent a schedule away from already-linked dose history', async () => {
    const { rows: seeded } = await ownerPool.query<{ id: string }>(
      `INSERT INTO dose_occurrences
         (schedule_id, medication_id, patient_profile_id, scheduled_at,
          scheduled_local_date, scheduled_local_time, scheduled_timezone,
          dose_quantity, dose_unit, status)
       VALUES ($1,$2,$3,'2026-09-21T06:00:00Z','2026-09-21','09:00','Asia/Riyadh',1,'tablet','upcoming')
       RETURNING id`,
      [aliceScheduleId, aliceMedicationId, alice.profileId],
    );
    expect(seeded).toHaveLength(1);

    const attempt = await asAliceRollback(
      `UPDATE medication_schedules
          SET medication_id=$2, patient_profile_id=$3
        WHERE id=$1`,
      [aliceScheduleId, dependentMedicationId, dependentProfileId],
    );

    expect(attempt.errorCode, attempt.error ?? 'schedule reparent unexpectedly succeeded').toBe('23514');
    expect(attempt.constraint).toBe('schedule_parent_immutable');
  });

  it('still allows a dose whose schedule, medication and profile all agree', async () => {
    const attempt = await asAliceRollback(
      `INSERT INTO dose_occurrences
         (schedule_id, medication_id, patient_profile_id, scheduled_at,
          scheduled_local_date, scheduled_local_time, scheduled_timezone,
          dose_quantity, dose_unit, status)
       VALUES ($1,$2,$3,'2026-09-22T06:00:00Z','2026-09-22','09:00','Asia/Riyadh',1,'tablet','upcoming')`,
      [aliceScheduleId, aliceMedicationId, alice.profileId],
    );

    expect(attempt.error, attempt.error ?? '').toBeNull();
    expect(attempt.rowCount).toBe(1);
  });
});
