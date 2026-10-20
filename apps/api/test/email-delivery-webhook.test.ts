import Fastify from 'fastify';
import { Webhook } from 'svix';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const io = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../src/lib/db.js', () => ({ withTransaction: (fn: (tx: unknown) => unknown) => fn({ query: io.query }) }));
import { registerEmailDeliveryWebhook } from '../src/routes/email-delivery-webhook.js';
import { resetConfigCache } from '../src/config.js';

const secret = `whsec_${Buffer.from('synthetic webhook signing key 321!').toString('base64')}`;
const messageId = '01a15513-67b9-7220-8924-a8a19ed6a9e7';
const originalEnv = { ...process.env };
let app: ReturnType<typeof Fastify>;
const event = (type = 'email.delivery_delayed', from = 'TADAWEE <accounts@example.test>') => ({
  type, created_at: new Date().toISOString(), data: { email_id: messageId, from,
    to: ['private@example.test'], subject: 'private subject', text: 'private code 123456' },
});
const headers = (body: string, date = new Date(), id = 'msg_synthetic') => ({
  'content-type': 'application/json', 'svix-id': id,
  'svix-timestamp': String(Math.floor(date.getTime() / 1000)),
  'svix-signature': new Webhook(secret).sign(id, date, body),
});
beforeEach(async () => {
  vi.resetAllMocks(); io.query.mockResolvedValue({ rows: [{ inserted: true }] });
  process.env.RESEND_WEBHOOK_SECRET = secret; resetConfigCache();
  app = Fastify(); await app.register(registerEmailDeliveryWebhook);
  // Parser changes must not affect existing authentication endpoints.
  app.post('/ordinary-json', async req => ({ value: (req.body as { value: string }).value }));
  await app.ready();
});
afterEach(async () => { await app.close(); process.env = { ...originalEnv }; resetConfigCache(); });
describe('signed delivery events', () => {
  it('verifies exact bytes and retains only operational metadata', async () => {
    const body = JSON.stringify(event(), null, 2);
    const res = await app.inject({ method: 'POST', url: '/v1/webhooks/account-email', headers: headers(body), payload: body });
    expect(res.statusCode).toBe(200); expect(res.headers['cache-control']).toBe('no-store');
    expect(io.query.mock.calls[0]?.[1]).toEqual(['msg_synthetic', messageId, 'email.delivery_delayed', JSON.parse(body).created_at]);
    expect(JSON.stringify(io.query.mock.calls)).not.toMatch(/private|123456|accounts@/);
    const normal = await app.inject({ method: 'POST', url: '/ordinary-json', payload: { value: 'ok' } });
    expect(normal.json()).toEqual({ value: 'ok' });
  });
  it('rejects tampered, unsigned and stale events without database access', async () => {
    const body = JSON.stringify(event());
    for (const h of [{ 'content-type': 'application/json' }, headers(body + ' '), headers(body, new Date(Date.now() - 600_000))]) {
      expect((await app.inject({ method: 'POST', url: '/v1/webhooks/account-email', payload: body, headers: h })).statusCode).toBe(400);
    }
    expect(io.query).not.toHaveBeenCalled();
  });
  it('ignores other projects and unsubscribed event types', async () => {
    for (const e of [event('email.sent', 'other@unrelated.test'), event('contact.created')]) {
      const body = JSON.stringify(e);
      expect((await app.inject({ method: 'POST', url: '/v1/webhooks/account-email', payload: body, headers: headers(body) })).statusCode).toBe(200);
    }
    expect(io.query).not.toHaveBeenCalled();
  });
  it('does not acknowledge failed durable writes and accepts duplicate receipts', async () => {
    const body = JSON.stringify(event());
    io.query.mockRejectedValueOnce(new Error('database unavailable'));
    expect((await app.inject({ method: 'POST', url: '/v1/webhooks/account-email', payload: body, headers: headers(body) })).statusCode).toBe(500);
    io.query.mockResolvedValue({ rows: [{ inserted: false }] });
    expect((await app.inject({ method: 'POST', url: '/v1/webhooks/account-email', payload: body, headers: headers(body) })).statusCode).toBe(200);
  });
  it('fails closed without a configured signing secret', async () => {
    delete process.env.RESEND_WEBHOOK_SECRET; resetConfigCache();
    const body = JSON.stringify(event());
    expect((await app.inject({ method: 'POST', url: '/v1/webhooks/account-email', payload: body, headers: headers(body) })).statusCode).toBe(503);
    expect(io.query).not.toHaveBeenCalled();
  });
});
