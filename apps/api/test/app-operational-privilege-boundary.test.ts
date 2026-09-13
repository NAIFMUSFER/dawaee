import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetDatabase } from './harness.js';

/**
 * Boundary for public tables that intentionally have no RLS.
 *
 * Clinical/user tables rely on FORCE RLS. Public tables without RLS must be an
 * explicit operational allowlist, and the HTTP runtime role must be read-only
 * on that state unless a later route proves a narrower write requirement.
 */

let owner: pg.Pool;
let app: pg.Pool;

const conn = (role: 'postgres' | 'dawaee_app', password: string) => new pg.Pool({
  connectionString: `postgres://${role}:${password}@127.0.0.1:5433/dawaee_test`,
  max: 2,
});

const APP_OPERATIONAL_MANIFEST: Record<string, string[]> = {
  job_runs: ['SELECT'],
  provider_webhook_events: ['SELECT'],
  schema_migrations: ['SELECT'],
};

beforeAll(() => {
  resetDatabase();
  owner = conn('postgres', 'postgres');
  app = conn('dawaee_app', 'devpass');
});

afterAll(async () => {
  await app.end();
  await owner.end();
});

async function grants() {
  const { rows } = await owner.query<{ table_name: string; privs: string }>(
    `SELECT table_name,
            string_agg(DISTINCT privilege_type, ',' ORDER BY privilege_type) AS privs
       FROM information_schema.role_table_grants
      WHERE grantee='dawaee_app'
        AND table_schema='public'
        AND table_name = ANY($1::text[])
      GROUP BY table_name`,
    [Object.keys(APP_OPERATIONAL_MANIFEST)],
  );
  return Object.fromEntries(rows.map((row) => [row.table_name, row.privs.split(',')]));
}

async function nonRlsPublicTables() {
  const { rows } = await owner.query<{ table_name: string }>(
    `SELECT c.relname AS table_name
       FROM pg_class c
       JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public'
        AND c.relkind='r'
        AND NOT c.relrowsecurity
      ORDER BY c.relname`,
  );
  return rows.map((row) => row.table_name);
}

describe('the HTTP runtime role is read-only on non-RLS operational state', () => {
  it('has no unexpected public base table outside the reviewed non-RLS allowlist', async () => {
    expect(await nonRlsPublicTables()).toEqual(Object.keys(APP_OPERATIONAL_MANIFEST).sort());
  });

  it('holds exactly SELECT on the migration ledger, job history and webhook inbox', async () => {
    const actual = await grants();
    for (const [table, expected] of Object.entries(APP_OPERATIONAL_MANIFEST)) {
      expect(actual[table]?.sort(), `dawaee_app operational grants drifted on ${table}`)
        .toEqual([...expected].sort());
    }
  });

  it('can still perform the reads required by readiness and admin routes', async () => {
    await expect(app.query('SELECT filename FROM schema_migrations ORDER BY filename DESC LIMIT 1'))
      .resolves.toMatchObject({ rowCount: 1 });
    await expect(app.query('SELECT job_name FROM job_runs ORDER BY started_at DESC LIMIT 1'))
      .resolves.toMatchObject({ rows: expect.any(Array) });
    await expect(app.query('SELECT id FROM provider_webhook_events ORDER BY received_at DESC LIMIT 1'))
      .resolves.toMatchObject({ rows: expect.any(Array) });
  });

  it('cannot forge a migration ledger row even inside a transaction that is rolled back', async () => {
    const client = await app.connect();
    try {
      await client.query('BEGIN');
      const err = await client
        .query("INSERT INTO schema_migrations(filename, checksum) VALUES ('9999_red_probe.sql','red-probe')")
        .then(() => null)
        .catch((e: Error) => e.message);
      await client.query('ROLLBACK');
      expect(err, 'dawaee_app can forge the migration ledger').toMatch(/permission denied/i);
    } finally {
      client.release();
    }
  });

  it('cannot fabricate worker success or delete webhook evidence', async () => {
    const insertJob = await app
      .query("INSERT INTO job_runs(job_name, succeeded) VALUES ('red-probe', true)")
      .then(() => null)
      .catch((e: Error) => e.message);
    expect(insertJob, 'dawaee_app can fabricate job_runs').toMatch(/permission denied/i);

    const deleteWebhook = await app
      .query('DELETE FROM provider_webhook_events WHERE false')
      .then(() => null)
      .catch((e: Error) => e.message);
    expect(deleteWebhook, 'dawaee_app can delete provider webhook evidence').toMatch(/permission denied/i);
  });
});
