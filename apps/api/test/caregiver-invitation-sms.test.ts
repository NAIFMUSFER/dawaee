import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError, ERROR_CODES } from '@dawaee/shared';

const boundary = vi.hoisted(() => ({
  authenticate: vi.fn(), owner: vi.fn(), budget: vi.fn(), audit: vi.fn(), query: vi.fn(),
  events: [] as string[], inTransaction: false, failCommit: false,
}));
vi.mock('../src/middleware/context.js', () => ({
  authenticate: boundary.authenticate, currentUser: () => ({ userId: 'synthetic-owner' }),
}));
vi.mock('../src/services/access-service.js', () => ({ requireProfileOwner: boundary.owner }));
vi.mock('../src/services/audit-service.js', () => ({ recordAudit: boundary.audit }));
vi.mock('../src/auth/rate-budget.js', () => ({ enforceAuthBudget: boundary.budget }));
vi.mock('../src/lib/db.js', () => ({
  withUserReadOnly: async (_id: string, run: (tx: unknown) => Promise<unknown>) => {
    boundary.inTransaction = true;
    try { return await run({ query: boundary.query }); }
    finally { boundary.inTransaction = false; }
  },
  withUser: async (_id: string, run: (tx: unknown) => Promise<unknown>) => {
    boundary.inTransaction = true;
    try {
      const result = await run({ query: boundary.query });
      if (boundary.failCommit) throw new Error('synthetic commit failure');
      boundary.events.push('committed');
      return result;
    } finally { boundary.inTransaction = false; }
  },
}));
import { registerCaregiverRoutes } from '../src/routes/caregivers.js';
import type { InvitationSmsStatus } from '../src/providers/invitation-sms.js';
import { resetConfigCache } from '../src/config.js';

const payload = {
  patientProfileId: '11111111-2222-4333-8444-555555555555', invitedName: 'Synthetic caregiver',
  invitedPhone: '0500000001', role: 'son', permissions: ['view_schedule'], channel: 'sms',
};
let app: FastifyInstance;
let send: ReturnType<typeof vi.fn>;
function setup(ready = true, status: InvitationSmsStatus = 'accepted') {
  app = Fastify();
  send = vi.fn(async () => { boundary.events.push('sent'); return status; });
  registerCaregiverRoutes(app, { ready, send });
}
beforeEach(() => {
  vi.resetAllMocks(); resetConfigCache(); boundary.events = []; boundary.inTransaction = false; boundary.failCommit = false;
  boundary.owner.mockResolvedValue({ profileDisplayName: 'SYNTHETIC_PATIENT_NAME' });
  boundary.budget.mockImplementation(async () => {
    expect(boundary.inTransaction, 'budgeting must not borrow connections while holding another').toBe(false);
  });
  boundary.query.mockResolvedValue({ rows: [{ id: 'synthetic-relationship', invitation_expires_at: '2026-10-01T00:00:00Z' }] });
});
afterEach(async () => { await app?.close(); resetConfigCache(); });

describe('caregiver SMS route boundaries (no external SMS/database)', () => {
  it('sends only after commit, with normalized phone and no patient name; stores only the token hash', async () => {
    setup();
    const response = await app.inject({ method: 'POST', url: '/v1/caregivers/invite', payload });
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json();
    expect(body.delivery).toEqual({ channel: 'sms', status: 'accepted' });
    expect(boundary.events).toEqual(['committed', 'sent']);
    expect(boundary.owner).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toBe('+966500000001');
    expect(send.mock.calls[0]?.[1]).toContain(body.invitationLink);
    expect(send.mock.calls[0]?.[1]).not.toContain('SYNTHETIC_PATIENT_NAME');
    expect(new URL(body.invitationLink).search).toBe('');
    const token = body.invitationLink.split('/').at(-1);
    expect(token.length).toBeGreaterThan(20);
    expect(JSON.stringify(boundary.query.mock.calls)).not.toContain(token);
    const ruleWrite = boundary.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO caregiver_notification_rules'));
    expect(ruleWrite?.[0]).toContain("'push'");
    expect(boundary.budget).toHaveBeenCalledWith({ identifier: { scope: 'invite-sms:phone', value: '+966500000001' } });
    expect(boundary.budget).toHaveBeenCalledWith({ identifier: { scope: 'invite-sms:global', value: 'caregiver-invitations' } });
  });

  it.each(['link', 'qr'])('never sends for an explicit %s invitation', async (channel) => {
    setup();
    const response = await app.inject({ method: 'POST', url: '/v1/caregivers/invite', payload: { ...payload, channel } });
    expect(response.statusCode).toBe(200); expect(response.json().delivery).toBeUndefined();
    expect(send).not.toHaveBeenCalled(); expect(boundary.budget).not.toHaveBeenCalled();
  });

  it.each(['failed', 'unknown', 'unavailable'] as const)('retains the created QR/link when provider result is %s', async (status) => {
    setup(status !== 'unavailable', status);
    const response = await app.inject({ method: 'POST', url: '/v1/caregivers/invite', payload });
    expect(response.statusCode).toBe(200); expect(response.json().delivery.status).toBe(status);
    expect(response.json().invitationLink).toContain('/invite#/invite/');
    expect(send).toHaveBeenCalledTimes(status === 'unavailable' ? 0 : 1);
  });

  it('requires ownership before consuming paid budgets or creating an invitation', async () => {
    setup(); boundary.owner.mockRejectedValue(AppError.forbidden());
    expect((await app.inject({ method: 'POST', url: '/v1/caregivers/invite', payload })).statusCode).toBe(403);
    expect(send).not.toHaveBeenCalled(); expect(boundary.query).not.toHaveBeenCalled(); expect(boundary.budget).not.toHaveBeenCalled();
  });

  it('rechecks ownership after budgets, before writing or sending', async () => {
    setup(); boundary.owner.mockResolvedValueOnce({}).mockRejectedValueOnce(AppError.forbidden());
    expect((await app.inject({ method: 'POST', url: '/v1/caregivers/invite', payload })).statusCode).toBe(403);
    expect(send).not.toHaveBeenCalled(); expect(boundary.query).not.toHaveBeenCalled();
  });

  it('does not send an invitation whose transaction failed', async () => {
    setup(); boundary.failCommit = true;
    expect((await app.inject({ method: 'POST', url: '/v1/caregivers/invite', payload })).statusCode).toBe(500);
    expect(send).not.toHaveBeenCalled();
  });

  it('rejects unsupported destinations before budgeting or writing', async () => {
    setup();
    expect((await app.inject({ method: 'POST', url: '/v1/caregivers/invite', payload: { ...payload, invitedPhone: '+12025550123' } })).statusCode).toBe(400);
    expect(send).not.toHaveBeenCalled(); expect(boundary.query).not.toHaveBeenCalled(); expect(boundary.budget).not.toHaveBeenCalled();
  });

  it('stops a rate-limited attempt before creating or sending anything', async () => {
    setup(); boundary.budget.mockRejectedValue(new AppError(ERROR_CODES.RATE_LIMITED, 429, 'Synthetic limit'));
    expect((await app.inject({ method: 'POST', url: '/v1/caregivers/invite', payload })).statusCode).toBe(429);
    expect(send).not.toHaveBeenCalled(); expect(boundary.query).not.toHaveBeenCalled();
  });

  it('authenticates capability discovery and invitation creation', async () => {
    setup();
    expect((await app.inject('/v1/caregivers/delivery-options')).json()).toEqual({ smsAvailable: true });
    boundary.authenticate.mockRejectedValue(AppError.unauthenticated());
    expect((await app.inject('/v1/caregivers/delivery-options')).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/v1/caregivers/invite', payload })).statusCode).toBe(401);
    expect(send).not.toHaveBeenCalled(); expect(boundary.owner).not.toHaveBeenCalled();
  });
});
