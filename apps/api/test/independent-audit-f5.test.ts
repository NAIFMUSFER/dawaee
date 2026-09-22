import type { PGlite } from '@electric-sql/pglite';
import type { PoolClient } from 'pg';
import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { auditTransaction, createAuditDatabase } from './independent-audit-db.js';

vi.mock('../src/lib/db.js', async original => ({
  ...await original<typeof import('../src/lib/db.js')>(),
  withTransaction: (fn: (tx: PoolClient) => Promise<unknown>) => auditTransaction(db, 'dawaee_app', fn),
  withUser: (uid: string, fn: (tx: PoolClient) => Promise<unknown>) => auditTransaction(db, 'dawaee_app', fn, uid),
}));
import { registerAuthRoutes } from '../src/routes/auth.js';
import { registerAccountEmailRoutes } from '../src/routes/account-email.js';
import { registerErrorHandler } from '../src/middleware/error-handler.js';
import { hashPassword } from '../src/lib/password.js';

let db: PGlite;
const http = Fastify();
const owner = (sql: string, values: unknown[] = []) => auditTransaction(db, 'dawaee_migrator', tx => tx.query(sql, values));
const budgets = async () => (await owner('SELECT scope,sum(count)::int AS hits FROM auth_rate_buckets GROUP BY scope ORDER BY scope')).rows;
beforeAll(async () => {
  db = await createAuditDatabase();
  registerErrorHandler(http); registerAuthRoutes(http); registerAccountEmailRoutes(http);
  await http.ready();
}, 60_000);
afterAll(async () => { await http.close(); await db?.close(); });

describe('F5: measure actual persisted email budgets without provider I/O', () => {
  it('bounds immediate registration resends to the promised recipient cooldown', async () => {
    const email = `f5-register-${randomUUID()}@example.test`;
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) statuses.push((await http.inject({
      method: 'POST', url: '/v1/auth/register', remoteAddress: '198.18.50.1', payload: { email, locale: 'en' },
    })).statusCode);
    const challenges = (await owner('SELECT count(*)::int AS count FROM email_registration_challenges WHERE email=$1', [email])).rows[0].count;
    const observed = await budgets();
    console.info('F5 registration measurements', JSON.stringify({ statuses, challenges, budgets: observed }));
    expect.soft(statuses.filter(status => status === 202)).toHaveLength(1);
    expect.soft(challenges).toBe(1);
    expect.soft(observed.find(row => row.scope === 'email:global')?.hits).toBe(1);
  });

  it('does not spend provider capacity for nonexistent recovery recipients', async () => {
    const before = Number((await budgets()).find(row => row.scope === 'email:global')?.hits ?? 0);
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await http.inject({
      method: 'POST', url: '/v1/auth/password/recovery/request', remoteAddress: `198.18.51.${i + 1}`,
      payload: { email: `f5-absent-${randomUUID()}@example.test` },
    })).statusCode);
    const after = Number((await budgets()).find(row => row.scope === 'email:global')?.hits ?? 0);
    const queued = (await owner("SELECT count(*)::int AS count FROM account_email_challenges WHERE purpose='reset'")).rows[0].count;
    console.info('F5 recovery measurements', JSON.stringify({ statuses, globalBefore: before, globalAfter: after, queued }));
    expect(statuses).toEqual([202, 202, 202, 202, 202, 202]);
    expect(queued).toBe(0);
    expect(after - before, 'F5: accepted no-op recoveries consumed the 100/day sending budget').toBe(0);
  });

  it('rolls back denied mail without replacing a usable reset link or exposing existence', async () => {
    const email = `f5-owner-${randomUUID()}@example.test`;
    const registered = await owner('SELECT * FROM app.register_email_account(NULL,$1,$2,$3,$4)', [email, 'Capacity fixture', await hashPassword('Synthetic fixture password 4921!'), 'en']);
    const uid = registered.rows[0].user_id;
    await owner('INSERT INTO user_email_verifications(user_id,email) VALUES($1,$2)', [uid, email]);
    await owner('SELECT app.request_email_recovery($1,$2,$3)', [email, 'd'.repeat(64), 'prior-encrypted-job']);
    await owner(`WITH boundary AS (
      SELECT key_hash,to_timestamp(floor(extract(epoch FROM now())/86400)*86400) AS start
      FROM auth_rate_buckets WHERE scope='email:global' LIMIT 1
    ) INSERT INTO auth_rate_buckets(scope,key_hash,window_start,count)
      SELECT 'email:global',key_hash,start+make_interval(days=>step),100 FROM boundary CROSS JOIN generate_series(0,1) AS offsets(step)
      ON CONFLICT(scope,key_hash,window_start) DO UPDATE SET count=100`);
    const send = (url: string, recipient: string, ip: string) => http.inject({ method: 'POST', url, remoteAddress: ip, payload: { email: recipient } });
    const known = await send('/v1/auth/password/recovery/request', email, '198.18.52.1');
    const unknown = await send('/v1/auth/password/recovery/request', `f5-absent-${randomUUID()}@example.test`, '198.18.52.2');
    expect(known.statusCode).toBe(202);
    expect({ status: known.statusCode, body: known.body }).toEqual({ status: unknown.statusCode, body: unknown.body });
    const prior = await owner("SELECT token_hash,payload FROM account_email_challenges WHERE user_id=$1 AND purpose='reset'", [uid]);
    expect(prior.rows).toEqual([{ token_hash: 'd'.repeat(64), payload: 'prior-encrypted-job' }]);
    const newEmail = `f5-full-${randomUUID()}@example.test`;
    expect((await send('/v1/auth/register', newEmail, '198.18.52.3')).statusCode).toBe(202);
    expect((await owner('SELECT count(*)::int AS n FROM email_registration_challenges WHERE email=$1', [newEmail])).rows[0].n).toBe(0);
    expect((await owner("SELECT count FROM auth_rate_buckets WHERE scope='email:global'")).rows.every(row => row.count === 100)).toBe(true);
    // The refusal still spends recipient/IP attempt budgets.
    expect((await send('/v1/auth/register', newEmail, '198.18.52.4')).statusCode).toBe(429);
  });

  it('does not grant workers or runtime roles raw access to the private mail queues', async () => {
    await expect(auditTransaction(db, 'dawaee_worker', tx => tx.query('SELECT app.account_email_job_pending($1)', ['d'.repeat(64)]))).rejects.toMatchObject({ code: '42501' });
    for (const table of ['account_email_challenges', 'email_registration_challenges']) {
      await expect(auditTransaction(db, 'dawaee_app', tx => tx.query(`SELECT * FROM ${table}`))).rejects.toMatchObject({ code: '42501' });
    }
  });
});

describe('F4: installed one-step registration clients receive an explicit upgrade refusal', () => {
  it.each([
    { displayName: 'Legacy', password: 'Synthetic legacy password 491!' },
    { phone: '+966500001234', password: 'Synthetic legacy password 491!' },
    { displayName: 'Legacy' },
    { password: 'x'.repeat(100_000) },
  ])('does not enqueue, reserve an identity or spend mail budgets for a legacy shape', async legacy => {
    const email = `f4-${randomUUID()}@example.test`;
    const before = await budgets();
    const result = await http.inject({ method: 'POST', url: '/v1/auth/register', remoteAddress: '198.18.54.1', headers: { 'accept-language': 'en' }, payload: { email, ...legacy } });
    expect(result.statusCode, result.body).toBe(426);
    expect(result.json().error).toMatchObject({ code: 'upgrade_required', message: expect.stringContaining('Update') });
    expect(result.headers['cache-control']).toBe('no-store');
    expect(result.body).not.toContain(email);
    expect(await budgets()).toEqual(before);
    expect((await owner('SELECT count(*)::int AS n FROM email_registration_challenges WHERE email=$1', [email])).rows[0].n).toBe(0);
    expect((await owner('SELECT count(*)::int AS n FROM users WHERE email=$1', [email])).rows[0].n).toBe(0);
  });
  it('also gives phone-only installed clients Arabic update guidance before schema validation', async () => {
    const result = await http.inject({ method: 'POST', url: '/v1/auth/register', payload: { phone: '+966500001234', displayName: 'قديم', password: 'Synthetic legacy password 491!' } });
    expect(result.statusCode).toBe(426);
    expect(result.json().error.message).toContain('حدّث التطبيق');
  });
});
