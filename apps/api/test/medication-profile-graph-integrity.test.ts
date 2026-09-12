import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetDatabase, signIn, startHarness, type Harness, type TestUser } from './harness.js';

let h: Harness;
let appPool: pg.Pool;
let ownerPool: pg.Pool;
let alice: TestUser;
let primaryMedicationId: string;
let dependentProfileId: string;
let dependentMedicationId: string;

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
  alice = await signIn(h, '+966500099931');

  const { rows: profiles } = await ownerPool.query<{ id: string }>(
    `INSERT INTO patient_profiles (owner_user_id, display_name, is_self)
     VALUES ($1, 'Dependent profile', false)
     RETURNING id`,
    [alice.userId],
  );
  dependentProfileId = profiles[0]!.id;

  const { rows: primaryMeds } = await ownerPool.query<{ id: string }>(
    `INSERT INTO medications (patient_profile_id, name, form, start_date, created_by)
     VALUES ($1, 'Primary profile medicine', 'tablet', '2026-09-01', $2)
     RETURNING id`,
    [alice.profileId, alice.userId],
  );
  primaryMedicationId = primaryMeds[0]!.id;

  const { rows: dependentMeds } = await ownerPool.query<{ id: string }>(
    `INSERT INTO medications (patient_profile_id, name, form, start_date, created_by)
     VALUES ($1, 'Dependent profile medicine', 'tablet', '2026-09-01', $2)
     RETURNING id`,
    [dependentProfileId, alice.userId],
  );
  dependentMedicationId = dependentMeds[0]!.id;

  // Seed a real child row so moving the medication would immediately break the
  // profile invariant that the original child-table triggers claim to enforce.
  await ownerPool.query(
    `INSERT INTO medication_schedules
       (medication_id, patient_profile_id, rule_kind, rule, dose_quantity, dose_unit,
        start_date, late_after_minutes, missed_after_minutes, created_by)
     VALUES ($1,$2,'fixed_times',$3::jsonb,1,'tablet','2026-09-01',15,120,$4)`,
    [dependentMedicationId, dependentProfileId, JSON.stringify({ kind: 'fixed_times', times: ['09:00'] }), alice.userId],
  );
});

afterAll(async () => {
  await appPool.end();
  await ownerPool.end();
  await h.close();
});

describe('patient-profile graph integrity at the database boundary', () => {
  it('does not let the runtime role move a medication away from its existing child rows', async () => {
    const attempt = await asAliceRollback(
      'UPDATE medications SET patient_profile_id = $2 WHERE id = $1',
      [dependentMedicationId, alice.profileId],
    );

    expect(attempt.errorCode, attempt.error ?? 'cross-profile UPDATE unexpectedly succeeded').toBe('23514');
    expect(attempt.constraint).toBe('medication_patient_profile_immutable');
  });

  it('does not let an escalation policy pair one profile with another profile\'s medication', async () => {
    const attempt = await asAliceRollback(
      `INSERT INTO escalation_policies (patient_profile_id, medication_id, enabled, stages)
       VALUES ($1,$2,true,'[]'::jsonb)`,
      [alice.profileId, dependentMedicationId],
    );

    expect(attempt.errorCode, attempt.error ?? 'cross-profile escalation policy unexpectedly succeeded').toBe('23514');
    expect(attempt.constraint).toBe('escalation_policy_medication_profile_match');
  });

  it('still lets the owner create a medication-specific escalation policy inside one profile', async () => {
    const attempt = await asAliceRollback(
      `INSERT INTO escalation_policies (patient_profile_id, medication_id, enabled, stages)
       VALUES ($1,$2,true,'[]'::jsonb)`,
      [alice.profileId, primaryMedicationId],
    );

    expect(attempt.error, attempt.error ?? '').toBeNull();
    expect(attempt.rowCount).toBe(1);
  });
});
