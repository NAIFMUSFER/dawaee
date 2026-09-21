import type { PGlite } from '@electric-sql/pglite';
import type { PoolClient } from 'pg';
import Fastify from 'fastify';
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { auditTransaction, createAuditDatabase } from './independent-audit-db.js';

vi.mock('../src/lib/db.js', async original => ({
  ...await original<typeof import('../src/lib/db.js')>(),
  withTransaction: (fn: (tx: PoolClient) => Promise<unknown>) => auditTransaction(db, 'dawaee_app', fn),
}));
import { createSession } from '../src/auth/session-service.js';
import { registerAuthRoutes } from '../src/routes/auth.js';
import { registerErrorHandler } from '../src/middleware/error-handler.js';
import { sha256 } from '../src/lib/crypto.js';

let db: PGlite;
const http = Fastify();
const owner = (sql: string, values: unknown[] = []) => auditTransaction(db, 'dawaee_migrator', tx => tx.query(sql, values));
const nonce = () => randomBytes(32).toString('hex');
const refresh = (refreshToken: string, retryNonce?: string) => http.inject({
  method: 'POST', url: '/v1/auth/refresh', payload: { refreshToken, retryNonce }, remoteAddress: '198.18.62.1',
});
beforeAll(async () => {
  db = await createAuditDatabase(); registerErrorHandler(http); registerAuthRoutes(http); await http.ready();
}, 60_000);
afterAll(async () => { await http.close(); await db?.close(); });

async function rotated() {
  const user = randomUUID();
  await owner('INSERT INTO users(id,email,display_name) VALUES($1,$2,$3)', [user, `${user}@example.test`, 'Synthetic retry']);
  const initial = await auditTransaction(db, 'dawaee_app', tx => createSession(tx, user, { deviceId: 'synthetic-retry-device' }));
  const proof = nonce();
  const response = await refresh(initial.refreshToken, proof);
  expect(response.statusCode).toBe(200);
  const { refreshToken, refreshExpiresAt } = response.json<{ refreshToken: string; refreshExpiresAt: string }>();
  const child = { refreshToken, refreshExpiresAt };
  return { user, initial, proof, child };
}
const age = (id: string) => owner("UPDATE auth_sessions SET revoked_at=now()-interval '2 days' WHERE id=$1", [id]);

describe('durable refresh retry capability', () => {
  it('exposes the definer entrypoint only to the API runtime role', async () => {
    const result = await owner(`SELECT
      has_function_privilege('dawaee_app','app.rotate_session_retry(text,text,text,int,text)','EXECUTE') AS api,
      has_function_privilege('dawaee_worker','app.rotate_session_retry(text,text,text,int,text)','EXECUTE') AS worker`);
    expect(result.rows[0]).toEqual({ api: true, worker: false });
  });
  it('returns the exact live successor after a lost response, without another row or extended expiry', async () => {
    const { user, initial, proof, child } = await rotated();
    await age(initial.sessionId);
    for (let i = 0; i < 3; i++) {
      const retry = await refresh(initial.refreshToken, proof);
      expect(retry.statusCode).toBe(200);
      expect(retry.json()).toMatchObject(child);
    }
    expect((await owner('SELECT count(*)::int AS n FROM auth_sessions WHERE user_id=$1', [user])).rows[0].n).toBe(2);
    const row = (await owner('SELECT refresh_retry_hash FROM auth_sessions WHERE id=$1', [initial.sessionId])).rows[0];
    expect(row.refresh_retry_hash).toBe(sha256(proof));
    expect(row.refresh_retry_hash).not.toBe(proof);
  });

  it.each(['missing', 'wrong'] as const)('keeps the 30-second grace and theft revocation for a %s proof', async kind => {
    const { initial, proof, child } = await rotated();
    const presentedProof = kind === 'missing' ? undefined : nonce();
    expect((await refresh(initial.refreshToken, presentedProof)).statusCode).toBe(409);
    expect((await refresh(initial.refreshToken, proof)).statusCode).toBe(200);
    await age(initial.sessionId);
    expect((await refresh(initial.refreshToken, presentedProof)).statusCode).toBe(401);
    expect((await refresh(initial.refreshToken, proof)).statusCode).toBe(401);
    expect((await owner('SELECT revoked_at FROM auth_sessions WHERE refresh_token_hash=$1', [sha256(child.refreshToken)])).rows[0].revoked_at).not.toBeNull();
  });

  it.each(['revoked', 'expired', 'disabled'] as const)('cannot recover a %s successor', async state => {
    const { user, initial, proof, child } = await rotated();
    await age(initial.sessionId);
    if (state === 'disabled') await owner('UPDATE users SET disabled_at=now() WHERE id=$1', [user]);
    else await owner(`UPDATE auth_sessions SET ${state === 'revoked' ? 'revoked_at' : 'expires_at'}=now()-interval '1 second' WHERE refresh_token_hash=$1`, [sha256(child.refreshToken)]);
    expect((await refresh(initial.refreshToken, proof)).statusCode).toBe(401);
  });

  it('does not resurrect an already rotated successor or expose its descendant', async () => {
    const { initial, proof, child } = await rotated();
    expect((await refresh(child.refreshToken, nonce())).statusCode).toBe(200);
    await age(initial.sessionId);
    expect((await refresh(initial.refreshToken, proof)).statusCode).toBe(401);
  });

  it('cannot attach a new proof to a legacy rotation after the response was lost', async () => {
    const user = randomUUID();
    await owner('INSERT INTO users(id,email,display_name) VALUES($1,$2,$3)', [user, `${user}@example.test`, 'Synthetic legacy']);
    const initial = await auditTransaction(db, 'dawaee_app', tx => createSession(tx, user, { deviceId: 'legacy-device' }));
    expect((await refresh(initial.refreshToken)).statusCode).toBe(200);
    expect((await refresh(initial.refreshToken, nonce())).statusCode).toBe(409);
    await age(initial.sessionId);
    expect((await refresh(initial.refreshToken, nonce())).statusCode).toBe(401);
  });

  it.each(['short', 'A'.repeat(64), 'a'.repeat(65)])('rejects a malformed proof before rotating (%s)', async proof => {
    const { child } = await rotated();
    expect((await refresh(child.refreshToken, proof)).statusCode).toBe(400);
    expect((await owner('SELECT revoked_at FROM auth_sessions WHERE refresh_token_hash=$1', [sha256(child.refreshToken)])).rows[0].revoked_at).toBeNull();
  });
});
