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
});
