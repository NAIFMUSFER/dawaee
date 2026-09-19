import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetDatabase } from './harness.js';
import { assertSchemaContract } from '../src/lib/schema-contract.js';

// Dedicated, disposable local CI databases only. No deployment URL is used.
const root = resolve(import.meta.dirname, '../../..');
const base = new URL('postgres://dawaee_migrator@127.0.0.1:5433/dawaee_test');
base.password = process.env.DAWAEE_MIGRATOR_PASSWORD ?? 'migratorpw';
const admin = new pg.Pool({ connectionString: base.toString(), max: 1 });
const databases: string[] = [];

beforeAll(() => resetDatabase(), 120_000);
afterAll(async () => {
  for (const database of databases) await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
  await admin.end();
});

async function fixture(withData: boolean) {
  const database = `dawaee_orphan_${process.pid}_${databases.length}`;
  databases.push(database);
  await admin.query(`CREATE DATABASE "${database}" OWNER dawaee_migrator`);
  const url = new URL(base);
  url.pathname = `/${database}`;
  const pool = new pg.Pool({ connectionString: url.toString(), max: 1 });
  await pool.query('CREATE SCHEMA app; CREATE TABLE public.orphan_probe(id integer)');
  if (withData) await pool.query('INSERT INTO orphan_probe VALUES(7)');
  return { pool, url: url.toString() };
}

function migrate(url: string) {
  return spawnSync('bash', ['scripts/migrate.sh'], {
    cwd: root, encoding: 'utf8', timeout: 60_000,
    env: { ...process.env, DATABASE_URL: url, MIGRATION_SET_ROLE: '',
      DAWAEE_APP_PASSWORD: '', DAWAEE_WORKER_PASSWORD: '' },
  });
}

describe('partial schema adoption through the real migration runner', () => {
  it('restores its definer helper after clearing an empty orphan and completes every migration', async () => {
    const { pool, url } = await fixture(false);
    try {
      const result = migrate(url);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('clearing the partial schema');
      expect((await assertSchemaContract(pool, { attempts: 1 })).ok).toBe(true);
      const retry = migrate(url);
      expect(retry.status, retry.stderr).toBe(0);
      expect(retry.stdout).toContain('no pending migrations');
    } finally { await pool.end(); }
  }, 120_000);

  it('still refuses to clear an orphan containing data', async () => {
    const { pool, url } = await fixture(true);
    try {
      const result = migrate(url);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('1 row(s) but no migration ledger');
      expect((await pool.query('SELECT id FROM orphan_probe')).rows).toEqual([{ id: 7 }]);
      expect((await pool.query("SELECT to_regclass('schema_migrations') AS ledger")).rows)
        .toEqual([{ ledger: null }]);
    } finally { await pool.end(); }
  });
});
