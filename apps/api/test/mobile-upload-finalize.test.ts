import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ user: '11111111-1111-4111-8111-111111111111', query: vi.fn(), authenticate: vi.fn() }));
vi.mock('../src/lib/db.js', async (original) => ({
  ...await original<typeof import('../src/lib/db.js')>(),
  withUser: async (_id: string, run: (tx: unknown) => unknown) => run({ query: h.query }),
  withUserReadOnly: async (_id: string, run: (tx: unknown) => unknown) => run({ query: h.query }),
}));
vi.mock('../src/middleware/context.js', async (original) => ({
  ...await original<typeof import('../src/middleware/context.js')>(),
  authenticate: h.authenticate, currentUser: () => ({ userId: h.user }),
}));
import { buildServer } from '../src/server.js';
import { AppError } from '@dawaee/shared';
const image = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(24)]);
let server: Awaited<ReturnType<typeof buildServer>>;
let row: { object_key: string; owner_user_id: string; content_type: string; byte_size: number; uploaded_at: Date | null; scan_status: string } | undefined;
beforeAll(async () => { server = await buildServer(); await server.app.ready(); });
afterAll(async () => { await server.app.close(); });
beforeEach(() => {
  vi.restoreAllMocks(); h.authenticate.mockReset().mockResolvedValue(undefined);
  row = { object_key: 'synthetic-image', owner_user_id: h.user, content_type: 'image/png', byte_size: image.length, uploaded_at: null, scan_status: 'pending' };
  h.query.mockReset().mockImplementation(async (sql: string) => {
    if (sql.includes('SELECT')) return { rows: row ? [{ ...row }] : [] };
    if (sql.includes("SET uploaded_at")) { if (row) { row.uploaded_at = new Date(); row.scan_status = 'clean'; } return { rowCount: 1 }; }
    if (sql.includes("SET scan_status")) { if (row) row.scan_status = 'rejected'; return { rowCount: 1 }; }
    return { rows: [], rowCount: 1 };
  });
  vi.spyOn(server.providers.storage, 'getObject').mockResolvedValue(image);
  vi.spyOn(server.providers.storage, 'deleteObject').mockResolvedValue(undefined);
});
const finalize = () => server.app.inject({ method: 'POST', url: '/v1/uploads/finalize', payload: { objectKey: 'synthetic-image' } });
describe('installed Android upload finalization contract', () => {
  it('verifies stored bytes and allows an idempotent retry', async () => {
    const first = await finalize(); expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toEqual({ ok: true, objectKey: 'synthetic-image' });
    expect(row?.scan_status).toBe('clean');
    expect((await finalize()).statusCode).toBe(200);
    expect(server.providers.storage.getObject).toHaveBeenCalledTimes(1);
    expect(server.providers.storage.getObject).toHaveBeenCalledWith('synthetic-image', image.length);
  });
  it('requires authentication', async () => {
    h.authenticate.mockRejectedValue(new AppError('unauthorized', 401, 'Sign in required'));
    expect((await finalize()).statusCode).toBe(401);
    expect(server.providers.storage.getObject).not.toHaveBeenCalled();
  });
  it.each(['missing', 'different-owner', 'rejected'])('rejects %s uploads before storage access', async (kind) => {
    if (kind === 'missing') row = undefined;
    else if (kind === 'different-owner') row!.owner_user_id = 'another-owner';
    else row!.scan_status = 'rejected';
    expect((await finalize()).statusCode).toBe(404);
    expect(server.providers.storage.getObject).not.toHaveBeenCalled();
  });
  it('does not finalize mismatched content', async () => {
    vi.mocked(server.providers.storage.getObject).mockResolvedValue(Buffer.alloc(image.length));
    expect((await finalize()).statusCode).toBe(400);
    expect(row?.scan_status).toBe('rejected');
  });
  it('keeps a temporarily unavailable upload pending for retry', async () => {
    vi.mocked(server.providers.storage.getObject).mockRejectedValue(new Error('unavailable'));
    expect((await finalize()).statusCode).toBe(503);
    expect(row?.uploaded_at).toBeNull();
    expect(server.providers.storage.deleteObject).not.toHaveBeenCalled();
  });
  it('rejects malformed object metadata', async () => {
    const res = await server.app.inject({ method: 'POST', url: '/v1/uploads/finalize', payload: {} });
    expect(res.statusCode).toBe(400); expect(server.providers.storage.getObject).not.toHaveBeenCalled();
  });
});
