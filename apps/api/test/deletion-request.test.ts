import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeaders, resetDatabase, signIn, startHarness, TEST_PASSWORD, type Harness, type TestUser } from './harness.js';

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
  it('is idempotent after fresh authentication, and does not restart the clock', async () => {
    const original = await h.worker.pool.query('SELECT deletion_requested_at FROM users WHERE id=$1',[user.userId]);
    const login = await h.app.inject({ method:'POST',url:'/v1/auth/login', remoteAddress:fromNewAddress(),
      payload:{identifier:user.phone,password:TEST_PASSWORD,deviceId:'deletion-retry-device'} });
    expect(login.statusCode,login.body).toBe(200);
    user = { ...user, token:login.json().accessToken,refreshToken:login.json().refreshToken };
    const second = await request({ confirm: true });
    expect(second.statusCode).toBe(200);
    expect(second.json().requestedAt).toBe(new Date(original.rows[0].deletion_requested_at).toISOString());
  });

  it('refuses a request that does not explicitly confirm', async () => {
    const active = await signIn(h, '0577000003');
    for (const payload of [{}, { confirm: false }]) {
      const res = await request(payload, active);
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
    const deviceId = 'erase-device-1';
    const other = await signIn(h, '0577000002', deviceId);
    const registration = await h.app.inject({
      method: 'POST', url: '/v1/devices/push-token', headers: authHeaders(other),
      payload: { token: 'ExponentPushToken[to-be-erased]', platform: 'ios', deviceId },
    });
    expect(registration.statusCode, registration.body).toBe(200);

    await request({ confirm: true }, other);

    const { rows } = await h.worker.pool.query<{ active: boolean }>(
      'SELECT active FROM push_tokens WHERE user_id = $1', [other.userId],
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.active)).toBe(false);
  });
});


describe('deletion grace and session recovery', () => {
  it('revokes access/refresh on all devices, and fresh sign-in does not silently cancel deletion', async () => {
    const a = await signIn(h,'0577000004','erase-a');
    const b = await signIn(h,'0577000004','erase-b');
    const deletion = await request({confirm:true},a);
    expect(deletion.statusCode,deletion.body).toBe(200);
    for (const u of [a,b]) {
      expect((await h.app.inject({method:'GET',url:'/v1/me',headers:authHeaders(u)})).statusCode).toBe(401);
      expect((await h.app.inject({method:'POST',url:'/v1/auth/refresh',payload:{refreshToken:u.refreshToken},remoteAddress:fromNewAddress()})).statusCode).toBe(401);
    }
    const login = await h.app.inject({method:'POST',url:'/v1/auth/login',remoteAddress:fromNewAddress(),payload:{identifier:a.phone,password:TEST_PASSWORD,deviceId:'fresh-recovery'}});
    expect(login.statusCode,login.body).toBe(200);
    const headers = {authorization:`Bearer ${login.json().accessToken}`};
    const me = await h.app.inject({method:'GET',url:'/v1/me',headers});
    expect(me.json().user.deletionScheduledFor).toBe(deletion.json().scheduledFor);
    expect((await h.app.inject({method:'GET',url:`/v1/today?profileId=${a.profileId}`,headers})).statusCode).toBe(403);
    const cancelled = await h.app.inject({method:'POST',url:'/v1/me/deletion-cancel',headers,payload:{confirm:true},remoteAddress:fromNewAddress()});
    expect(cancelled.statusCode,cancelled.body).toBe(200);
    expect((await h.app.inject({method:'GET',url:'/v1/me',headers})).json().user.deletionScheduledFor).toBeNull();
    expect((await h.app.inject({method:'GET',url:`/v1/today?profileId=${a.profileId}`,headers})).statusCode).toBe(200);
  });
});
