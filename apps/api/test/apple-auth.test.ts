import type { PGlite } from '@electric-sql/pglite';
import type { PoolClient } from 'pg';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { auditTransaction, createAuditDatabase } from './independent-audit-db.js';
vi.mock('../src/lib/db.js', async original => ({
  ...await original<typeof import('../src/lib/db.js')>(),
  withTransaction: (fn: (tx: PoolClient) => Promise<unknown>) => auditTransaction(db, 'dawaee_app', fn),
  withUser: (uid: string, fn: (tx: PoolClient) => Promise<unknown>) => auditTransaction(db, 'dawaee_app', fn, uid),
  withUserReadOnly: (uid: string, fn: (tx: PoolClient) => Promise<unknown>) => auditTransaction(db, 'dawaee_app', fn, uid, true),
}));
vi.mock('../src/auth/apple-token.js', async original => ({
  ...await original<typeof import('../src/auth/apple-token.js')>(),
  appleAuthAvailable: () => true,
  exchangeAppleCode: vi.fn(), revokeAppleAuthorization: vi.fn(),
}));
import { registerAppleAuthRoutes } from '../src/routes/apple-auth.js';
import { registerProfileRoutes } from '../src/routes/profiles.js';
import { registerErrorHandler } from '../src/middleware/error-handler.js';
import { exchangeAppleCode, AppleProofInvalid, AppleProviderUnavailable, revokeAppleAuthorization } from '../src/auth/apple-token.js';
import { hashPassword } from '../src/lib/password.js';
let db: PGlite;
const http = Fastify();
const owner = (sql: string, args: unknown[] = []) => auditTransaction(db, 'dawaee_migrator', tx => tx.query(sql, args));
beforeAll(async () => { db = await createAuditDatabase(); registerErrorHandler(http);
  registerAppleAuthRoutes(http); registerProfileRoutes(http); await http.ready(); }, 60_000);
afterAll(async () => { await http.close(); await db?.close(); });
let hash: string;
const resolve = async (sub: string, email: string | null) => {
  hash ??= await hashPassword('Synthetic Apple fixture 921!');
  return auditTransaction(db, 'dawaee_app', tx => tx.query('SELECT * FROM app.resolve_apple_account($1,$2,$3,$4,$5)',
    [sub, email, 'Apple fixture', hash, 'en']));
};

describe('Apple account isolation on real SQL under restricted roles', () => {
  it('supports private relay, stable subjects, optional phone and no automatic email linking', async () => {
    const made = (await resolve('apple-sql-subject', 'sql@privaterelay.appleid.com')).rows[0];
    expect(made.created).toBe(true);
    expect((await resolve('apple-sql-subject', null)).rows[0]).toMatchObject({ user_id: made.user_id, created: false });
    expect((await resolve('foreign-subject', 'sql@privaterelay.appleid.com')).rows[0].user_id).toBeNull();
    expect((await resolve('subject-without-email', null)).rows[0].user_id).toBeNull();
    expect((await owner('SELECT phone_e164 FROM users WHERE id=$1', [made.user_id])).rows[0].phone_e164).toBeNull();
    expect((await owner('SELECT count(*)::int AS n FROM user_email_verifications WHERE user_id=$1', [made.user_id])).rows[0].n).toBe(1);
    const scoped = await auditTransaction(db, 'dawaee_app', tx => tx.query('SELECT app.apple_subject_for_user($1) AS subject', [made.user_id]), made.user_id);
    expect(scoped.rows[0].subject).toBe('apple-sql-subject');
    const other = (await resolve('apple-other', 'other@privaterelay.appleid.com')).rows[0];
    const foreign = await auditTransaction(db, 'dawaee_app', tx => tx.query('SELECT app.apple_subject_for_user($1) AS subject', [made.user_id]), other.user_id);
    expect(foreign.rows[0].subject).toBeNull();
    const linked = await auditTransaction(db, 'dawaee_app', tx => tx.query('SELECT app.attach_apple_account_phone($1,$2) AS linked', [made.user_id, '+966500092293']), made.user_id);
    expect(linked.rows[0].linked).toBe(true);
    const refused = await auditTransaction(db, 'dawaee_app', tx => tx.query('SELECT app.attach_apple_account_phone($1,$2) AS linked', [made.user_id, '+966500092292']), other.user_id);
    expect(refused.rows[0].linked).toBe(false);
    await owner('UPDATE users SET disabled_at=now() WHERE id=$1', [made.user_id]);
    expect((await resolve('apple-sql-subject', null)).rows[0].user_id).toBeNull();
  });

  it('refuses direct identity-table access and worker execution of account resolvers', async () => {
    await expect(auditTransaction(db, 'dawaee_app', tx => tx.query('SELECT * FROM apple_auth_identities'))).rejects.toThrow(/permission denied/);
    await expect(auditTransaction(db, 'dawaee_worker', tx => tx.query('SELECT app.apple_subject_for_user($1)', ['00000000-0000-4000-8000-000000000001']))).rejects.toThrow(/permission denied/);
  });

  it('issues real API sessions only after provider proof and revokes Apple before scheduling deletion', async () => {
    const provider = vi.mocked(exchangeAppleCode);
    provider.mockResolvedValue({ subject: 'apple-route-subject', email: 'route@privaterelay.appleid.com', refreshToken: 'synthetic-discarded-provider-token' });
    const login = await http.inject({ method: 'POST', url: '/v1/auth/apple', remoteAddress: '198.18.91.1',
      payload: { authorizationCode: 'synthetic-one-use-code', rawNonce: 'a1'.repeat(32), deviceId: 'apple-route-device', locale: 'en' } });
    expect(login.statusCode, login.body).toBe(200);
    expect(login.body).not.toContain('synthetic-discarded-provider-token');
    const headers = { authorization: `Bearer ${login.json().accessToken}` };
    const me = await http.inject({ method: 'GET', url: '/v1/me', headers });
    expect(me.statusCode, me.body).toBe(200);
    expect(me.json().user).toMatchObject({ appleAccount: true, emailVerified: true, phoneE164: null });
    expect(me.body).not.toContain('apple-route-subject');
    const del = (payload: Record<string, unknown>) => http.inject({ method: 'POST', url: '/v1/me/deletion-request', headers,
      remoteAddress: '198.18.91.2', payload });
    expect((await del({ confirm: true })).statusCode).toBe(401);
    const proof = { authorizationCode: 'synthetic-delete-code', rawNonce: 'a1'.repeat(32) };
    const revoke = vi.mocked(revokeAppleAuthorization);
    revoke.mockRejectedValueOnce(new AppleProofInvalid());
    expect((await del({ confirm: true, appleProof: proof })).statusCode).toBe(401);
    revoke.mockRejectedValueOnce(new AppleProviderUnavailable());
    expect((await del({ confirm: true, appleProof: proof })).statusCode).toBe(503);
    expect((await owner('SELECT deletion_requested_at FROM users WHERE id=$1', [me.json().user.id])).rows[0].deletion_requested_at).toBeNull();
    revoke.mockResolvedValueOnce(undefined);
    const deleted = await del({ confirm: true, appleProof: proof });
    expect(deleted.statusCode, deleted.body).toBe(200);
    expect(revoke).toHaveBeenLastCalledWith(proof, 'apple-route-subject');
    expect((await http.inject({ method: 'GET', url: '/v1/me', headers })).statusCode).toBe(401);
    // A new Apple sign-in reaches the existing fourteen-day recovery flow.
    const again = (await resolve('apple-route-subject', null)).rows[0];
    expect(again.user_id).toBe(me.json().user.id);
    await owner("UPDATE users SET deletion_requested_at=now()-interval '15 days' WHERE id=$1", [again.user_id]);
    expect((await resolve('apple-route-subject', null)).rows[0].user_id).toBeNull();
  });
});
