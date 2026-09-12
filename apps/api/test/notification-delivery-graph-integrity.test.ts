import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetDatabase, signIn, startHarness, type Harness, type TestUser } from './harness.js';

let h: Harness;
let owner: pg.Pool;
let worker: pg.Pool;
let alice: TestUser;
let bob: TestUser;
let bobMedicationId: string;
let bobScheduleId: string;
let bobDoseId: string;
let seq = 0;

async function attempt(sql: string, params: unknown[]) {
  const client = await worker.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(sql, params);
    await client.query('ROLLBACK');
    return { rowCount: result.rowCount ?? 0, errorCode: null as string | null, constraint: null as string | null, error: null as string | null };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    const e = err as Error & { code?: string; constraint?: string };
    return { rowCount: 0, errorCode: e.code ?? null, constraint: e.constraint ?? null, error: e.message };
  } finally {
    client.release();
  }
}

beforeAll(async () => {
  resetDatabase();
  h = await startHarness();
  owner = new pg.Pool({ connectionString: 'postgres://postgres:postgres@127.0.0.1:5433/dawaee_test', max: 2 });
  worker = new pg.Pool({ connectionString: 'postgres://dawaee_worker:devpass@127.0.0.1:5433/dawaee_test', max: 2 });

  alice = await signIn(h, '+966500099951');
  bob = await signIn(h, '+966500099952');

  const { rows: meds } = await owner.query<{ id: string }>(
    `INSERT INTO medications (patient_profile_id, name, form, start_date, created_by)
     VALUES ($1,'Bob private medication','tablet','2026-09-01',$2)
     RETURNING id`,
    [bob.profileId, bob.userId],
  );
  bobMedicationId = meds[0]!.id;

  const { rows: schedules } = await owner.query<{ id: string }>(
    `INSERT INTO medication_schedules
       (medication_id, patient_profile_id, rule_kind, rule, dose_quantity, dose_unit,
        timezone, start_date, late_after_minutes, missed_after_minutes, created_by)
     VALUES ($1,$2,'fixed_times',$3::jsonb,1,'tablet','Asia/Riyadh','2026-09-01',15,120,$4)
     RETURNING id`,
    [bobMedicationId, bob.profileId, JSON.stringify({ kind: 'fixed_times', times: ['09:00'] }), bob.userId],
  );
  bobScheduleId = schedules[0]!.id;

  const { rows: doses } = await owner.query<{ id: string }>(
    `INSERT INTO dose_occurrences
       (schedule_id, medication_id, patient_profile_id, scheduled_at,
        scheduled_local_date, scheduled_local_time, scheduled_timezone,
        dose_quantity, dose_unit, status)
     VALUES ($1,$2,$3,'2026-09-20T06:00:00Z','2026-09-20','09:00','Asia/Riyadh',1,'tablet','upcoming')
     RETURNING id`,
    [bobScheduleId, bobMedicationId, bob.profileId],
  );
  bobDoseId = doses[0]!.id;
}, 120_000);

afterAll(async () => {
  await worker.end();
  await owner.end();
  await h.close();
});

describe('notification delivery clinical graph integrity', () => {
  it('does not let the worker queue Bob dose data under Alice profile/recipient', async () => {
    const result = await attempt(
      `INSERT INTO notification_deliveries
         (patient_profile_id, recipient_user_id, kind, channel,
          dose_occurrence_id, medication_id, locale, title, body, payload,
          dedupe_key, scheduled_for, next_attempt_at)
       VALUES ($1,$2,'dose_reminder','push',$3,$4,'en','Reminder','private',$5::jsonb,$6,now(),now())`,
      [
        alice.profileId,
        alice.userId,
        bobDoseId,
        bobMedicationId,
        JSON.stringify({ doseId: bobDoseId, medicationId: bobMedicationId, medicationName: 'Bob private medication' }),
        `red-cross-dose-${Date.now()}-${seq++}`,
      ],
    );

    expect(result.errorCode, result.error ?? 'mismatched delivery unexpectedly queued').toBe('23514');
    expect(result.constraint).toBe('notification_delivery_dose_profile_match');
  });

  it('does not let a low-stock delivery attach Bob medication to Alice profile', async () => {
    const result = await attempt(
      `INSERT INTO notification_deliveries
         (patient_profile_id, recipient_user_id, kind, channel,
          medication_id, locale, title, body, payload,
          dedupe_key, scheduled_for, next_attempt_at)
       VALUES ($1,$2,'low_stock','push',$3,'en','Low stock','private',$4::jsonb,$5,now(),now())`,
      [
        alice.profileId,
        alice.userId,
        bobMedicationId,
        JSON.stringify({ medicationId: bobMedicationId, medicationName: 'Bob private medication' }),
        `red-cross-med-${Date.now()}-${seq++}`,
      ],
    );

    expect(result.errorCode, result.error ?? 'mismatched medication delivery unexpectedly queued').toBe('23514');
    expect(result.constraint).toBe('notification_delivery_medication_profile_match');
  });

  it('does not let a relationship-less Bob delivery target Alice as recipient', async () => {
    const result = await attempt(
      `INSERT INTO notification_deliveries
         (patient_profile_id, recipient_user_id, kind, channel,
          dose_occurrence_id, medication_id, locale, title, body, payload,
          dedupe_key, scheduled_for, next_attempt_at)
       VALUES ($1,$2,'dose_reminder','push',$3,$4,'en','Reminder','private',$5::jsonb,$6,now(),now())`,
      [
        bob.profileId,
        alice.userId,
        bobDoseId,
        bobMedicationId,
        JSON.stringify({ doseId: bobDoseId, medicationId: bobMedicationId, medicationName: 'Bob private medication' }),
        `red-cross-recipient-${Date.now()}-${seq++}`,
      ],
    );

    expect(result.errorCode, result.error ?? 'cross-user patient delivery unexpectedly queued').toBe('23514');
    expect(result.constraint).toBe('notification_delivery_patient_recipient_match');
  });
});
