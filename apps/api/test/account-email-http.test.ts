import Fastify from 'fastify';
import { runInNewContext } from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '@dawaee/shared';
import { ZodError } from 'zod';
const io = vi.hoisted(() => ({ query: vi.fn(), budget: vi.fn(), password: vi.fn(), hash: vi.fn(), recoveredBudget: vi.fn(), audit: vi.fn(), ready: true }));
vi.mock('../src/lib/db.js', () => ({ withTransaction: (fn: any) => fn({ query: io.query }), withUser: (_id: string, fn: any) => fn({ query: io.query }) }));
vi.mock('../src/middleware/context.js', () => ({
  authenticate: async (req: any) => { if (req.headers.authorization !== 'Bearer synthetic') throw AppError.unauthenticated(); req.auth = { userId: 'owner', sessionId: 'session' }; },
  currentUser: (req: any) => req.auth,
}));
vi.mock('../src/auth/rate-budget.js', () => ({ enforceAuthBudget: io.budget }));
vi.mock('../src/lib/password.js', () => ({ verifyPassword: io.password, deriveRecoveryRequestKey: async () => 'request-key' }));
vi.mock('../src/auth/password-service.js', () => ({
  clearRecoveredLoginBudgets: io.recoveredBudget,
  hashNewPassword: io.hash,
  passwordLoginEnabled: () => true,
}));
vi.mock('../src/services/audit-service.js', () => ({ recordAudit: io.audit }));
vi.mock('../src/providers/account-email.js', async importOriginal => ({ ...await importOriginal<any>(), accountEmailReady: () => io.ready }));
import { registerAccountEmailRoutes } from '../src/routes/account-email.js';
import { EMAIL_ACTION_SCRIPT } from '../src/routes/account-email-page.js';
let app: ReturnType<typeof Fastify>;
beforeEach(async () => {
  vi.clearAllMocks(); io.ready = true; io.password.mockResolvedValue(true); io.hash.mockResolvedValue('hashed-password');
  io.query.mockResolvedValue({ rows: [] }); io.budget.mockResolvedValue(undefined);
  app = Fastify();
  app.setErrorHandler((err, _req, reply) => reply.code(err instanceof ZodError ? 400 : (err as any).statusCode ?? (err as any).status ?? 500).send({ error: 'request rejected' }));
  registerAccountEmailRoutes(app); await app.ready();
});
afterEach(async () => { await app.close(); });
const request = (url: string, payload: any, authenticated = false) => app.inject({ method: 'POST', url, payload, headers: authenticated ? { authorization: 'Bearer synthetic' } : {} });
describe('email route boundary (SQL separately tested with PostgreSQL)', () => {
  it('does not disclose account existence or return a bearer token', async () => {
    for (const email of ['Known@Example.com', 'unknown@example.com']) {
      const result = await request('/v1/auth/password/recovery/request', { email });
      expect(result.statusCode).toBe(202); expect(result.json()).toEqual({ accepted: true, retryAfterSeconds: 60 });
      const args = io.query.mock.calls.at(-1)![1]; expect(args[0]).toBe(email.toLowerCase()); expect(args[1]).toMatch(/^[a-f0-9]{64}$/);
      expect(args[2]).not.toContain(email.toLowerCase()); expect(result.headers['cache-control']).toBe('no-store');
    }
  });
  it('rejects injected identity, old phone requests and unsupported purposes before database access', async () => {
    for (const payload of [{ email: 'a@example.com', userId: 'victim' }, { phone: '+966500000001' }]) {
      expect((await request('/v1/auth/password/recovery/request', payload)).statusCode).toBe(400);
    }
    expect((await request('/v1/auth/email/complete', { token: 'a'.repeat(43), purpose: 'invite' })).statusCode).toBe(400);
    expect(io.query).not.toHaveBeenCalled();
  });
  it('fails closed when sending is unavailable or budget is exhausted', async () => {
    io.ready = false; expect((await request('/v1/auth/password/recovery/request', { email: 'a@example.com' })).statusCode).toBe(503);
    io.ready = true; io.budget.mockRejectedValue(new AppError('rate_limited', 429, 'limited'));
    expect((await request('/v1/auth/password/recovery/request', { email: 'a@example.com' })).statusCode).toBe(429);
    expect(io.query).not.toHaveBeenCalled();
  });
  it('requires authentication and current password to bind an email', async () => {
    expect((await request('/v1/auth/email/request', { email: 'a@example.com', currentPassword: 'wrong' })).statusCode).toBe(401);
    io.query.mockResolvedValue({ rows: [{ password_hash: 'stored-hash' }] }); io.password.mockResolvedValue(false);
    expect((await request('/v1/auth/email/request', { email: 'a@example.com', currentPassword: 'wrong' }, true)).statusCode).toBe(401);
    expect(io.query).toHaveBeenCalledTimes(1);
  });
  it('binds verification to the authenticated user, live session and checked credential hash', async () => {
    io.query.mockResolvedValueOnce({ rows: [{ password_hash: 'stored-hash' }] }).mockResolvedValueOnce({ rows: [{ accepted: true }] });
    expect((await request('/v1/auth/email/request', { email: 'A@Example.com', currentPassword: 'current' }, true)).statusCode).toBe(202);
    expect(io.query.mock.calls[1]![1]).toEqual(['owner', 'session', 'a@example.com', expect.stringMatching(/^[a-f0-9]{64}$/), 'stored-hash', expect.any(String)]);
  });
  it('allows issued links to finish during a mail outage but does not acknowledge rejected tokens', async () => {
    io.ready = false; io.query.mockResolvedValueOnce({ rows: [{ user_id: null }] }).mockResolvedValueOnce({ rows: [{ user_id: 'owner' }] });
    const payload = { token: 'a'.repeat(43), purpose: 'verify' };
    expect((await request('/v1/auth/email/complete', payload)).statusCode).toBe(403); expect(io.audit).not.toHaveBeenCalled();
    const result = await request('/v1/auth/email/complete', payload);
    expect(result.statusCode).toBe(200); expect(result.json()).toEqual({ updated: true }); expect(io.audit).toHaveBeenCalledOnce();
    expect(io.recoveredBudget).not.toHaveBeenCalled();
  });
  it('clears login denial state only after an accepted password-reset token', async () => {
    io.query.mockResolvedValueOnce({ rows: [{ user_id: null }] }).mockResolvedValueOnce({ rows: [{ user_id: 'owner' }] });
    const payload = { token: 'b'.repeat(43), purpose: 'reset', newPassword: 'Replacement password 4382!' };
    expect((await request('/v1/auth/email/complete', payload)).statusCode).toBe(403);
    expect(io.recoveredBudget).not.toHaveBeenCalled();
    expect((await request('/v1/auth/email/complete', payload)).statusCode).toBe(200);
    expect(io.recoveredBudget).toHaveBeenCalledOnce();
    expect(io.recoveredBudget.mock.calls[0]![1]).toBe('owner');
  });
  it('creates a verified account only from the registration form fields', async () => {
    io.query.mockResolvedValueOnce({ rows: [{ user_id: 'new-owner' }] });
    const payload = { token: 'c'.repeat(43), purpose: 'register', displayName: 'Mailbox Owner', newPassword: 'Synthetic registration 4382!' };
    const result = await request('/v1/auth/email/complete', payload);
    expect(result.statusCode).toBe(200);
    expect(io.hash).toHaveBeenCalledWith(payload.newPassword, 'ar');
    expect(io.query.mock.calls[0]![0]).toContain('complete_email_registration');
    expect(io.query.mock.calls[0]![1]).toEqual([expect.stringMatching(/^[a-f0-9]{64}$/), payload.displayName, 'hashed-password']);
    expect(io.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'auth.register', actorUserId: 'new-owner' }));
  });
  it('serves a no-store, no-referrer page with a hash-bound script and no database action', async () => {
    const response = await app.inject('/account-email');
    expect(response.statusCode).toBe(200); expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(response.headers['content-security-policy']).toContain("script-src 'sha256-");
    expect(response.headers['content-security-policy']).toContain("connect-src 'self'"); expect(io.query).not.toHaveBeenCalled();
  });
});
function form(purpose: string) {
  const nodes: Record<string, any> = {};
  const fetch = vi.fn(async () => ({ ok: true, json: async () => ({ updated: true }) }));
  const history = { replaceState: vi.fn() };
  const document = { documentElement: {}, getElementById: (id: string) => nodes[id] ??= { value: '', addEventListener(_event: string, handler: any) { this.submit = handler; } } };
  runInNewContext(EMAIL_ACTION_SCRIPT, { document, history, location: { pathname: '/account-email', hash: `#token=${'a'.repeat(43)}&purpose=${purpose}&lang=en` }, URLSearchParams, AbortSignal, fetch });
  return { nodes, fetch, history };
}
describe('email action form', () => {
  it('clears the fragment without automatically consuming the link', async () => {
    const h = form('verify'); expect(h.fetch).not.toHaveBeenCalled(); expect(h.history.replaceState).toHaveBeenCalledWith(null, '', '/account-email');
    await h.nodes.form.submit({ preventDefault() {} }); expect(h.fetch).toHaveBeenCalledOnce();
    expect(h.nodes.form.hidden).toBe(true); await h.nodes.form.submit({ preventDefault() {} }); expect(h.fetch).toHaveBeenCalledOnce();
  });
  it('requires matching passwords and clears them only after server confirmation', async () => {
    const h = form('reset'); h.nodes.password.value = 'Synthetic-password1'; h.nodes.confirm.value = 'different';
    await h.nodes.form.submit({ preventDefault() {} }); expect(h.fetch).not.toHaveBeenCalled();
    h.nodes.confirm.value = h.nodes.password.value; await h.nodes.form.submit({ preventDefault() {} });
    expect(h.fetch.mock.calls[0]![0]).toBe('/v1/auth/email/complete'); expect(h.nodes.password.value).toBe(''); expect(h.nodes.confirm.value).toBe('');
  });
  it('requires the mailbox holder to choose the registration name and password', async () => {
    const h = form('register'); h.nodes['display-name'].value = 'Mailbox Owner';
    h.nodes.password.value = h.nodes.confirm.value = 'Synthetic-password1';
    await h.nodes.form.submit({ preventDefault() {} });
    const body=JSON.parse(h.fetch.mock.calls[0]![1].body);
    expect(body).toEqual({token:'a'.repeat(43),purpose:'register',displayName:'Mailbox Owner',newPassword:'Synthetic-password1'});
    expect(h.nodes['display-name'].value).toBe(''); expect(h.nodes.password.value).toBe('');
  });
});
