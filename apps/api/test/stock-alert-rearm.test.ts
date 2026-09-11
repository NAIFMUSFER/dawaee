import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeaders, resetDatabase, signIn, startHarness, type Harness } from './harness.js';

let h: Harness;
let owner: pg.Pool;

const at = (dayOffset: number) => new Date(Date.UTC(2026, 5, 10 + dayOffset, 5, 0, 0)); // 08:00 Asia/Riyadh

beforeAll(async () => {
  resetDatabase();
  h = await startHarness();
  owner = new pg.Pool({
    connectionString: 'postgres://postgres:postgres@127.0.0.1:5433/dawaee_test',
    max: 2,
  });
}, 120_000);

afterAll(async () => {
  await owner.end();
  await h.close();
});

describe('low-stock notification rearming', () => {
  it('does not re-notify a continuously low medication without a refill', async () => {
    const user = await signIn(h, '+966500004041');
    h.setNow(at(0));

    const created = await h.app.inject({
      method: 'POST',
      url: '/v1/medications',
      headers: authHeaders(user),
      payload: {
        patientProfileId: user.profileId,
        name: 'StockNoNag',
        form: 'tablet',
        strengthValue: 10,
        strengthUnit: 'mg',
        foodInstruction: 'no_preference',
        startDate: '2026-06-10',
        schedule: {
          rule: { kind: 'fixed_times', times: ['09:00'] },
          doseQuantity: 1,
          doseUnit: 'tablet',
          startDate: '2026-06-10',
          lateAfterMinutes: 15,
          missedAfterMinutes: 60,
        },
        stock: { trackingEnabled: true, initialQuantity: 2, unit: 'tablet' },
      },
    });
    expect(created.statusCode, created.body).toBe(200);
    const medicationId = created.json<{ medication: { id: string } }>().medication.id;

    await h.tick();
    const first = await owner.query<{ n: string }>(
      `SELECT count(*) AS n
         FROM notification_deliveries
        WHERE patient_profile_id = $1
          AND medication_id = $2
          AND kind::text = 'low_stock'`,
      [user.profileId, medicationId],
    );
    expect(Number(first.rows[0]!.n), 'the first low-stock threshold crossing did not alert exactly once').toBe(1);

    // No dose action and, crucially, no refill occurred. The same continuously
    // low stock condition must stay muted until the refill path explicitly
    // clears low_stock_notified_at and rearms the threshold.
    h.setNow(at(4));
    await h.tick();

    const afterFourDays = await owner.query<{ n: string }>(
      `SELECT count(*) AS n
         FROM notification_deliveries
        WHERE patient_profile_id = $1
          AND medication_id = $2
          AND kind::text = 'low_stock'`,
      [user.profileId, medicationId],
    );
    expect(
      Number(afterFourDays.rows[0]!.n),
      'low-stock alert repeated after three days even though no refill rearmed it',
    ).toBe(1);
  });
});
