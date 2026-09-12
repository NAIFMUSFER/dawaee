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
let aliceDoseId: string;
let bobDoseId: string;
let aliceEventId: string;
let bobEventId: string;

interface Attempt {
  rowCount: number;
  errorCode: string | null;
  constraint: string | null;
  error: string | null;
}

async function asAliceRollback(sql: string, params: unknown[]): Promise<Attempt> {
  const client = await appPool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1,$2,true)', ['app.user_id', alice.userId]);
    const result = await client.query(sql, params);
    await client.query('ROLLBACK');
    return { rowCount: result.rowCount ?? 0, errorCode: null, constraint: null, error: null };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    const e = err as Error & { code?: string; constraint?: string };
    return { rowCount: 0, errorCode: e.code ?? null, constraint: e.constraint ?? null, error: e.message };
  } finally {
    client.release();
  }
}

async function seedDose(user: TestUser, label: string): Promise<{ medicationId: string; doseId: string; eventId: string }> {
  const { rows: medications } = await ownerPool.query<{ id: string }>(
    `INSERT INTO medications (patient_profile_id, name, form, start_date, created_by)
     VALUES ($1,$2,'tablet','2026-09-01',$3)
     RETURNING id`,
    [user.profileId, `${label} medication`, user.userId],
  );
  const medicationId = medications[0]!.id;

  const { rows: schedules } = await ownerPool.query<{ id: string }>(
    `INSERT INTO medication_schedules
       (medication_id, patient_profile_id, rule_kind, rule, dose_quantity, dose_unit,
        timezone, start_date, late_after_minutes, missed_after_minutes, created_by)
     VALUES ($1,$2,'fixed_times',$3::jsonb,1,'tablet','Asia/Riyadh','2026-09-01',15,120,$4)
     RETURNING id`,
    [medicationId, user.profileId, JSON.stringify({ kind: 'fixed_times', times: ['09:00'] }), user.userId],
  );

  const { rows: doses } = await ownerPool.query<{ id: string }>(
    `INSERT INTO dose_occurrences
       (schedule_id, medication_id, patient_profile_id, scheduled_at,
        scheduled_local_date, scheduled_local_time, scheduled_timezone,
        dose_quantity, dose_unit, status)
     VALUES ($1,$2,$3,$4,'2026-09-20','09:00','Asia/Riyadh',1,'tablet','upcoming')
     RETURNING id`,
    [schedules[0]!.id, medicationId, user.profileId,
     label === 'Alice' ? '2026-09-20T06:00:00Z' : '2026-09-20T06:01:00Z'],
  );
  const doseId = doses[0]!.id;

  const { rows: events } = await ownerPool.query<{ id: string }>(
    `INSERT INTO dose_events (dose_occurrence_id, patient_profile_id, type, actor_user_id)
     VALUES ($1,$2,'taken',$3)
     RETURNING id`,
    [doseId, user.profileId, user.userId],
  );

  return { medicationId, doseId, eventId: events[0]!.id };
}

beforeAll(async () => {
  resetDatabase();
  h = await startHarness();
  appPool = new pg.Pool({ connectionString: 'postgres://dawaee_app:devpass@127.0.0.1:5433/dawaee_test', max: 2 });
  ownerPool = new pg.Pool({ connectionString: 'postgres://postgres:postgres@127.0.0.1:5433/dawaee_test', max: 2 });

  alice = await signIn(h, '+966500099961');
  bob = await signIn(h, '+966500099962');

  const aliceSeed = await seedDose(alice, 'Alice');
  const bobSeed = await seedDose(bob, 'Bob');
  aliceMedicationId = aliceSeed.medicationId;
  aliceDoseId = aliceSeed.doseId;
  aliceEventId = aliceSeed.eventId;
  bobMedicationId = bobSeed.medicationId;
  bobDoseId = bobSeed.doseId;
  bobEventId = bobSeed.eventId;
}, 120_000);

afterAll(async () => {
  await appPool.end();
  await ownerPool.end();
  await h.close();
});

describe('stock transaction clinical graph integrity', () => {
  it('does not let Alice attach her stock ledger row to Bob dose occurrence', async () => {
    const attempt = await asAliceRollback(
      `INSERT INTO stock_transactions
         (medication_id, patient_profile_id, delta, reason, dose_occurrence_id,
          balance_after, actor_user_id)
       VALUES ($1,$2,-1,'dose_taken',$3,9,$4)`,
      [aliceMedicationId, alice.profileId, bobDoseId, alice.userId],
    );

    expect(attempt.errorCode, attempt.error ?? 'cross-patient dose edge unexpectedly succeeded').toBe('23514');
    expect(attempt.constraint).toBe('stock_transaction_dose_graph_match');
  });

  it('does not let Alice bind her dose movement to Bob append-only event', async () => {
    const attempt = await asAliceRollback(
      `INSERT INTO stock_transactions
         (medication_id, patient_profile_id, delta, reason, dose_occurrence_id, dose_event_id,
          balance_after, actor_user_id)
       VALUES ($1,$2,-1,'dose_taken',$3,$4,9,$5)`,
      [aliceMedicationId, alice.profileId, aliceDoseId, bobEventId, alice.userId],
    );

    expect(attempt.errorCode, attempt.error ?? 'cross-patient event edge unexpectedly succeeded').toBe('23514');
    expect(attempt.constraint).toBe('stock_transaction_event_graph_match');
  });

  it('still allows one aligned stock movement for Alice dose/event graph', async () => {
    const attempt = await asAliceRollback(
      `INSERT INTO stock_transactions
         (medication_id, patient_profile_id, delta, reason, dose_occurrence_id, dose_event_id,
          balance_after, actor_user_id)
       VALUES ($1,$2,-1,'dose_taken',$3,$4,9,$5)`,
      [aliceMedicationId, alice.profileId, aliceDoseId, aliceEventId, alice.userId],
    );

    expect(attempt.error, attempt.error ?? '').toBeNull();
    expect(attempt.rowCount).toBe(1);
  });

  it('keeps the foreign medication itself isolated by the existing profile guard', async () => {
    const attempt = await asAliceRollback(
      `INSERT INTO stock_transactions
         (medication_id, patient_profile_id, delta, reason, balance_after, actor_user_id)
       VALUES ($1,$2,-1,'manual_correction',9,$3)`,
      [bobMedicationId, alice.profileId, alice.userId],
    );

    expect(attempt.error).not.toBeNull();
  });
});
