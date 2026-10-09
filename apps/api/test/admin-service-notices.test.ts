import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeaders, resetDatabase, signIn, startHarness, TEST_PASSWORD, type Harness, type TestUser } from './harness.js';

let h: Harness;
let owner: pg.Pool;
let admin: TestUser;
let patient: TestUser;
let adminAccess: string;
const headers = () => ({ authorization: `Bearer ${adminAccess}` });
const draft = (audience = 'self') => ({ id: randomUUID(), title: 'تحديث من تداوي',
  body: 'تحسينات جديدة لخدمة التذكير.', locale: 'ar', audience });

beforeAll(async () => {
  resetDatabase(); h = await startHarness();
  owner = new pg.Pool({ connectionString: 'postgres://postgres:postgres@127.0.0.1:5433/dawaee_test' });
  admin = await signIn(h, '+966500087701', 'notice-admin-phone');
  patient = await signIn(h, '+966500087702', 'notice-patient-phone');
  await owner.query('UPDATE users SET is_admin=true WHERE id=$1', [admin.userId]);
  const login = await h.app.inject({ method: 'POST', url: '/v1/auth/login',
    payload: { identifier: admin.phone, password: TEST_PASSWORD, deviceId: 'notice-console' } });
  expect(login.statusCode, login.body).toBe(200); adminAccess = login.json().accessToken;
  for (const [user, device] of [[admin, 'notice-admin-phone'], [patient, 'notice-patient-phone']] as const) {
    const response = await h.app.inject({ method: 'POST', url: '/v1/devices/push-token', headers: authHeaders(user),
      payload: { deviceId: device, platform: 'ios', token: `ExponentPushToken[${device}]` } });
    expect(response.statusCode, response.body).toBe(200);
  }
});
afterAll(async () => { await owner.end(); await h.close(); });

async function preview(body: ReturnType<typeof draft>) {
  const response = await h.app.inject({ method: 'POST', url: '/v1/admin/service-notices/preview', headers: headers(), payload: body });
  expect(response.statusCode, response.body).toBe(200); return response.json().notice;
}
async function send(id: string) {
  return h.app.inject({ method: 'POST', url: `/v1/admin/service-notices/${id}/send`, headers: headers(), payload: { confirm: true } });
}

describe('admin service notices reuse push without changing the mobile app', () => {
  it('refuses ordinary accounts and unauthenticated requests', async () => {
    for (const authorization of [undefined, authHeaders(patient).authorization]) {
      const response = await h.app.inject({ method: 'POST', url: '/v1/admin/service-notices/preview',
        headers: authorization ? { authorization } : {}, payload: draft() });
      expect(response.statusCode).toBe(authorization ? 403 : 401);
    }
  });
  it('renders a public login shell with strict CSP and no embedded recipient data', async () => {
    const response = await h.app.inject({ method: 'GET', url: '/admin/notifications' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['content-security-policy']).toContain("script-src 'sha256-");
    expect(response.body).not.toContain(patient.userId);
    expect(response.body).not.toContain('localStorage.');
  });
  it('previews without sending, deduplicates concurrent submit and reaches the existing push provider', async () => {
    const body = draft(); const before = h.push.sent.length;
    const notice = await preview(body);
    expect(notice.eligible_count).toBe(1);
    expect(notice).not.toHaveProperty('recipient_ids');
    expect(h.push.sent).toHaveLength(before);
    const results = await Promise.all([send(body.id),send(body.id)]);
    expect(results.map(r => r.statusCode)).toEqual([200,200]);
    expect(results.map(r => r.json().notice.queued_count)).toEqual([1,1]);
    const rows = await owner.query('SELECT kind,channel,title,body FROM notification_deliveries WHERE dedupe_key LIKE $1', [`service-notice:${body.id}:%`]);
    expect(rows.rows).toEqual([{ kind: 'system', channel: 'push', title: body.title, body: body.body }]);
    await h.tick();
    const delivered = h.push.sent.filter(m => m.title===body.title);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({ token: 'ExponentPushToken[notice-admin-phone]', body: body.body, priority: 'default' });
    expect(delivered[0]!.categoryId).toBeUndefined();
    expect(delivered[0]!.data.kind).toBe('system');
    expect(delivered[0]!.data.actions).toBe('[]');
  });
  it('requires explicit confirmation, freezes content, and never adds later registrations to a draft', async () => {
    const body = draft('all'); await preview(body);
    const changed = await h.app.inject({ method: 'POST', url: '/v1/admin/service-notices/preview', headers: headers(), payload: { ...body, title: 'changed' } });
    expect(changed.statusCode).toBeGreaterThanOrEqual(400);
    const missing = await h.app.inject({ method: 'POST', url: `/v1/admin/service-notices/${body.id}/send`, headers: headers(), payload: {} });
    expect(missing.statusCode).toBe(400);
    // Logging out between preview and submit must remove that recipient.
    await h.app.inject({ method: 'POST', url: '/v1/auth/logout', headers: authHeaders(patient) });
    const result = await send(body.id);
    expect(result.statusCode,result.body).toBe(200);
    expect(result.json().notice.queued_count).toBe(1);
    const recipients = await owner.query('SELECT recipient_user_id FROM notification_deliveries WHERE dedupe_key LIKE $1',[`service-notice:${body.id}:%`]);
    expect(recipients.rows).toEqual([{ recipient_user_id: admin.userId }]);
  });
  it('honours removal of the admin role for already-issued tokens', async () => {
    await owner.query('UPDATE users SET is_admin=false WHERE id=$1',[admin.userId]);
    const response = await h.app.inject({ method: 'POST', url: '/v1/admin/service-notices/preview', headers: headers(), payload: draft() });
    expect(response.statusCode).toBe(403);
  });
});
