import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeaders, resetDatabase, signIn, startHarness, type Harness, type TestUser } from './harness.js';

/**
 * Account erasure.
 *
 * The privacy screen offered this from the beginning, behind a two-step
 * confirmation, and called `/v1/me/deletion-request` — a route that did not
 * exist. Every attempt failed against a real server and only appeared to work
 * in the preview build, whose stub answered success. A promised erasure right
 * that silently cannot be exercised is worse than one never offered.
 */
let h: Harness;
let user: TestUser;

beforeAll(async () => {
  resetDatabase();
  h = await startHarness();
  user = await signIn(h, '0577000001');
});
afterAll(async () => { await h.close(); });

/**
 * Each call comes from its own address. Deletion is rate limited per caller —
 * correctly — and without this the fourth `it` in the file starts failing
 * because of what the first three did, which reads as a bug in whatever that
 * fourth test was actually checking.
 */
let caller = 0;
const fromNewAddress = () => `10.7.${Math.floor(caller / 250)}.${(caller++ % 250) + 1}`;

const request = (payload: unknown, as: TestUser = user) =>
  h.app.inject({
    method: 'POST', url: '/v1/me/deletion-request',
    headers: authHeaders(as), payload, remoteAddress: fromNewAddress(),
  });

describe('requesting account deletion', () => {
  it('records the request and says when it takes effect', async () => {
    const res = await request({ confirm: true });
    expect(res.statusCode).toBe(200);
    expect(res.json().requested).toBe(true);
    expect(Date.parse(res.json().requestedAt)).not.toBeNaN();
    expect(Date.parse(res.json().scheduledFor)).toBeGreaterThan(Date.parse(res.json().requestedAt));
  });

  /**
   * Someone unsure whether the first request registered will press it again.
   * Answering "no" to that, or quietly restarting the clock, both mishandle a
   * person trying to exercise a right.
   */
  it('is idempotent, and does not restart the clock', async () => {
    const first = await request({ confirm: true });
    const second = await request({ confirm: true });
    expect(second.statusCode).toBe(200);
    expect(second.json().requestedAt).toBe(first.json().requestedAt);
  });

  it('refuses a request that does not explicitly confirm', async () => {
    for (const payload of [{}, { confirm: false }]) {
      const res = await request(payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
  });

  it('refuses an unauthenticated request', async () => {
    const res = await h.app.inject({
      method: 'POST', url: '/v1/me/deletion-request', payload: { confirm: true },
      remoteAddress: fromNewAddress(),
    });
    expect(res.statusCode).toBe(401);
  });

  /**
   * Continuing to send medication reminders to someone who has asked to be
   * erased is the most visible possible way to ignore the request.
   */
  it('silences every device the account had registered', async () => {
    const other = await signIn(h, '0577000002');
    await h.app.inject({
      method: 'POST', url: '/v1/devices/push-token', headers: authHeaders(other),
      payload: { token: 'ExponentPushToken[to-be-erased]', platform: 'ios', deviceId: 'erase-device-1' },
    });

    await request({ confirm: true }, other);

    const { rows } = await h.worker.pool.query<{ active: boolean }>(
      'SELECT active FROM push_tokens WHERE user_id = $1', [other.userId],
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.active)).toBe(false);
  });
});
