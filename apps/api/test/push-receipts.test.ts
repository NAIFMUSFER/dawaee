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

  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO notification_deliveries
       (recipient_user_id, kind, channel, title, body, payload, dedupe_key, next_attempt_at)
     VALUES ($1, 'dose_reminder', 'push', 'Receipt test', 'Synthetic body', '{}'::jsonb, $2, '1970-01-01T00:00:00Z')
     RETURNING id`,
    [user.userId, dedupe],
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
});
