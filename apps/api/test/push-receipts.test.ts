import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeaders, resetDatabase, signIn, startHarness, type Harness } from './harness.js';

let h: Harness;
let db: pg.Pool;
let clock: Date;

beforeAll(async () => {
  resetDatabase();
  h = await startHarness();
  h.push.reset();
  db = new pg.Pool({ connectionString: 'postgres://postgres:postgres@127.0.0.1:5433/dawaee_test' });
  clock = new Date(Date.now() + 60_000);
  h.setWorkerNow(clock);
});

afterAll(async () => {
  await db.end();
  await h.close();
});

async function queuePush(phone: string, deviceId: string, dedupe: string) {
  const user = await signIn(h, phone, deviceId);
  const token = `ExponentPushToken[${dedupe}]`;
  const registered = await h.app.inject({
    method: 'POST',
    url: '/v1/devices/push-token',
    headers: authHeaders(user),
    payload: { token, platform: 'ios', deviceId },
  });
  expect(registered.statusCode, registered.body).toBe(200);

  // A patient dose push must have an actionable clinical occurrence at send
  // time. Finish its ladder in the fixture so tick() cannot enqueue extra
  // reminders while this suite isolates ticket/receipt reconciliation.
  const scheduledAt = new Date(Math.floor(clock.getTime() / 60_000) * 60_000);
  const dose = await db.query<{ id: string; medication_id: string }>(
    `WITH medication AS (
       INSERT INTO medications(patient_profile_id,name,form,start_date,created_by)
       VALUES($1,'Receipt test medicine','tablet',($3::timestamptz AT TIME ZONE 'UTC')::date,$2) RETURNING id
     ), schedule AS (
       INSERT INTO medication_schedules(medication_id,patient_profile_id,rule_kind,rule,dose_quantity,dose_unit,
         timezone,start_date,created_by,materialized_through)
       SELECT id,$1,'fixed_times',jsonb_build_object('kind','fixed_times','times',
         jsonb_build_array(to_char($3::timestamptz AT TIME ZONE 'UTC','HH24:MI'))),1,'tablet',
         'UTC',($3::timestamptz AT TIME ZONE 'UTC')::date,$2,$3::timestamptz+interval '14 days'
       FROM medication RETURNING id,medication_id
     )
     INSERT INTO dose_occurrences(schedule_id,medication_id,patient_profile_id,scheduled_at,
       scheduled_local_date,scheduled_local_time,scheduled_timezone,dose_quantity,dose_unit,status,escalation_stage,notified_at)
     SELECT id,medication_id,$1,$3,($3::timestamptz AT TIME ZONE 'UTC')::date,
       ($3::timestamptz AT TIME ZONE 'UTC')::time,'UTC',1,'tablet','pending_confirmation',8,$3
     FROM schedule RETURNING id,medication_id`, [user.profileId, user.userId, scheduledAt],
  );

  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO notification_deliveries
       (patient_profile_id, recipient_user_id, kind, channel, title, body, payload, dedupe_key, next_attempt_at,
        dose_occurrence_id,medication_id)
     VALUES ($1, $2, 'dose_reminder', 'push', 'Receipt test', 'Synthetic body',
       jsonb_build_object('doseId',$4::text,'actions',jsonb_build_array('taken','snooze','skip')),
       $3, '1970-01-01T00:00:00Z',$4::uuid,$5::uuid)
     RETURNING id`,
    [user.profileId, user.userId, dedupe, dose.rows[0]!.id, dose.rows[0]!.medication_id],
  );
  return { user, token, deliveryId: rows[0]!.id };
}

async function advance(minutes: number) {
  clock = new Date(clock.getTime() + minutes * 60_000);
  h.setWorkerNow(clock);
  return h.tick();
}

describe('push receipt reconciliation', () => {
  it('does not call a provider ticket delivered until a later affirmative receipt arrives', async () => {
    const queued = await queuePush('+966500009401', 'receipt-ok-device', 'receipt-ok');
    await h.tick();

    const sent = await db.query<{
      status: string; delivered_at: Date | null;
      provider_receipts: Array<{ providerMessageId: string; pushTokenId: string }>;
    }>('SELECT status, delivered_at, provider_receipts FROM notification_deliveries WHERE id = $1', [queued.deliveryId]);
    expect(sent.rows[0]?.status).toBe('sent');
    expect(sent.rows[0]?.delivered_at).toBeNull();
    expect(sent.rows[0]?.provider_receipts).toHaveLength(1);
    expect(sent.rows[0]?.provider_receipts[0]?.providerMessageId).toBe('mock-push-1');

    await advance(16);
    const delivered = await db.query<{ status: string; delivered_at: Date | null }>(
      'SELECT status, delivered_at FROM notification_deliveries WHERE id = $1',
      [queued.deliveryId],
    );
    expect(delivered.rows[0]?.status).toBe('delivered');
    expect(delivered.rows[0]?.delivered_at).not.toBeNull();
  });

  it('fails a terminal receipt and retires exactly the endpoint reported DeviceNotRegistered', async () => {
    const queued = await queuePush('+966500009402', 'receipt-dead-device', 'receipt-dead');
    await h.tick();

    const sent = await db.query<{
      provider_receipts: Array<{ providerMessageId: string; pushTokenId: string }>;
    }>('SELECT provider_receipts FROM notification_deliveries WHERE id = $1', [queued.deliveryId]);
    const ticket = sent.rows[0]?.provider_receipts[0];
    expect(ticket?.providerMessageId).toBe('mock-push-2');
    h.push.receiptErrors.set(ticket!.providerMessageId, 'DeviceNotRegistered');

    await advance(16);
    const failed = await db.query<{ status: string; delivered_at: Date | null; error_code: string | null }>(
      'SELECT status, delivered_at, error_code FROM notification_deliveries WHERE id = $1',
      [queued.deliveryId],
    );
    expect(failed.rows[0]).toMatchObject({ status: 'failed', delivered_at: null, error_code: 'push_receipt_failed' });

    const endpoint = await db.query<{ active: boolean }>(
      'SELECT active FROM push_tokens WHERE id = $1 AND user_id = $2',
      [ticket!.pushTokenId, queued.user.userId],
    );
    expect(endpoint.rows[0]?.active).toBe(false);
  });

  it('does not let a stale DeviceNotRegistered receipt deactivate a fresh token that reused the same endpoint row', async () => {
    const deviceId = 'receipt-rotated-device';
    const queued = await queuePush('+966500009403', deviceId, 'receipt-rotated-old');
    await h.tick();

    const sent = await db.query<{
      provider_receipts: Array<{ providerMessageId: string; pushTokenId: string }>;
    }>('SELECT provider_receipts FROM notification_deliveries WHERE id = $1', [queued.deliveryId]);
    const ticket = sent.rows[0]?.provider_receipts[0];
    expect(ticket?.providerMessageId).toBeTruthy();
    expect(ticket?.pushTokenId).toBeTruthy();

    const freshToken = 'ExponentPushToken[receipt-rotated-fresh]';
    const reregistered = await h.app.inject({
      method: 'POST',
      url: '/v1/devices/push-token',
      headers: authHeaders(queued.user),
      payload: { token: freshToken, platform: 'ios', deviceId },
    });
    expect(reregistered.statusCode, reregistered.body).toBe(200);

    const beforeReceipt = await db.query<{ token: string; active: boolean }>(
      'SELECT token, active FROM push_tokens WHERE id = $1 AND user_id = $2',
      [ticket!.pushTokenId, queued.user.userId],
    );
    expect(beforeReceipt.rows[0]).toEqual({ token: freshToken, active: true });

    // The receipt belongs to the old provider token. Its internal row id is
    // intentionally stable across re-registration, so id-only invalidation
    // would silence the newly registered token instead of the stale one.
    h.push.receiptErrors.set(ticket!.providerMessageId, 'DeviceNotRegistered');
    await advance(16);

    const afterReceipt = await db.query<{ token: string; active: boolean }>(
      'SELECT token, active FROM push_tokens WHERE id = $1 AND user_id = $2',
      [ticket!.pushTokenId, queued.user.userId],
    );
    expect(afterReceipt.rows[0]).toEqual({ token: freshToken, active: true });
  });
});
