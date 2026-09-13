import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetDatabase, signIn, startHarness, type Harness } from './harness.js';

let h: Harness;
let owner: pg.Pool;

beforeAll(async () => {
  resetDatabase();
  h = await startHarness();
  owner = new pg.Pool({ connectionString: 'postgres://postgres:postgres@127.0.0.1:5433/dawaee_test' });
});

afterAll(async () => {
  await owner.end();
  await h.close();
});

describe('push receipt claim crash recovery', () => {
  it('reclaims a receipt batch left in checking after the claim lease goes stale', async () => {
    const user = await signIn(h, '+966500009302', 'push-receipt-claim-recovery');
    const t0 = new Date('2026-09-13T12:00:00.000Z');

    const inserted = await owner.query<{ id: string }>(
      `INSERT INTO notification_deliveries
         (patient_profile_id, recipient_user_id, kind, channel, locale, title, body, payload,
          status, scheduled_for, sent_at, provider, provider_message_id, provider_receipts,
          receipt_state, receipt_next_check_at, receipt_first_sent_at, dedupe_key)
       VALUES
         ($1, $2, 'dose_reminder', 'push', 'en', 'Reminder', 'Body', '{}'::jsonb,
          'sent', $3, $3, 'mock', 'mock-recovery-ticket',
          jsonb_build_array(jsonb_build_object('ticketId', 'mock-recovery-ticket', 'pushTokenId', gen_random_uuid()::text)),
          'pending', $3, $3, 'push-receipt-claim-recovery')
       RETURNING id`,
      [user.profileId, user.userId, t0],
    );
    const deliveryId = inserted.rows[0]!.id;

    const firstClaim = await h.worker.pool.query<{ id: string }>(
      'SELECT id FROM app.claim_push_receipts($1, 10)',
      [t0],
    );
    expect(firstClaim.rows.map((row) => row.id)).toEqual([deliveryId]);

    const tooEarly = await h.worker.pool.query<{ id: string }>(
      'SELECT id FROM app.claim_push_receipts($1, 10)',
      [new Date(t0.getTime() + 4 * 60_000)],
    );
    expect(tooEarly.rows).toEqual([]);

    const reclaimed = await h.worker.pool.query<{ id: string }>(
      'SELECT id FROM app.claim_push_receipts($1, 10)',
      [new Date(t0.getTime() + 6 * 60_000)],
    );
    expect(reclaimed.rows.map((row) => row.id)).toEqual([deliveryId]);

    const state = await owner.query<{ receipt_state: string; receipt_checked_at: Date }>(
      'SELECT receipt_state, receipt_checked_at FROM notification_deliveries WHERE id = $1',
      [deliveryId],
    );
    expect(state.rows[0]?.receipt_state).toBe('checking');
    expect(state.rows[0]?.receipt_checked_at.toISOString()).toBe(new Date(t0.getTime() + 6 * 60_000).toISOString());
  });
});
