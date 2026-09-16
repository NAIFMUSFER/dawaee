import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetDatabase } from './harness.js';

const root = resolve(import.meta.dirname, '../../..');
// Disposable integration database only; never accepts a deployment URL.
const url = `postgres://dawaee_migrator:${process.env.DAWAEE_MIGRATOR_PASSWORD ?? 'migratorpw'}@127.0.0.1:5433/dawaee_test`;
const pool = new pg.Pool({ connectionString: url, max: 1 });
const file = '0078_push_receipt_token_generation.sql';
const legacy = 'ec497f38ff1917c25496d7b5e60b26c9';
function migrate() {
  return spawnSync('bash', ['scripts/migrate.sh'], {
    cwd: root, encoding: 'utf8', timeout: 60000,
    env: { ...process.env, DATABASE_URL: url, MIGRATION_SET_ROLE: '',
      DAWAEE_APP_PASSWORD: '', DAWAEE_WORKER_PASSWORD: '' },
  });
}
beforeAll(() => resetDatabase(), 120000);
afterAll(() => pool.end());

describe('upgrade from shipped 0078 on real PostgreSQL', () => {
  it('preserves the historical ledger and converges through 0085, including repeat deployment', async () => {
    await pool.query(readFileSync(resolve(root, 'db/history/0078_push_receipt_token_generation.original.sql'), 'utf8'));
    await pool.query('UPDATE schema_migrations SET checksum=$1 WHERE filename=$2', [legacy, file]);
    await pool.query("DELETE FROM schema_migrations WHERE filename='0085_push_receipt_portable_hash.sql'");
    const before = (await pool.query('SELECT * FROM schema_migrations WHERE filename=$1', [file])).rows;
    const run = migrate();
    expect(run.status, run.stderr).toBe(0);
    expect((await pool.query('SELECT * FROM schema_migrations WHERE filename=$1', [file])).rows).toEqual(before);
    const definition = (await pool.query("SELECT pg_get_functiondef('app.deactivate_push_endpoint(uuid,uuid,text)'::regprocedure) AS body")).rows[0].body;
    expect(definition).toContain('pg_catalog.sha256');
    expect(definition).toContain('p_token_fingerprint');
    const grants = (await pool.query(`SELECT
      has_function_privilege('dawaee_worker','app.deactivate_push_endpoint(uuid,uuid,text)','EXECUTE') AS worker,
      has_function_privilege('dawaee_app','app.deactivate_push_endpoint(uuid,uuid,text)','EXECUTE') AS app`)).rows[0];
    expect(grants).toEqual({ worker: true, app: false });
    const retry = migrate();
    expect(retry.status, retry.stderr).toBe(0);
    expect(retry.stdout).toContain('no pending migrations');
  }, 120000);

  it('still rejects an unknown checksum without rewriting it', async () => {
    const unknown = '0'.repeat(32);
    await pool.query('UPDATE schema_migrations SET checksum=$1 WHERE filename=$2', [unknown, file]);
    try {
      const run = migrate();
      expect(run.status).not.toBe(0);
      expect(run.stderr).toContain('was already applied but its contents have changed');
      expect((await pool.query('SELECT checksum FROM schema_migrations WHERE filename=$1', [file])).rows[0].checksum).toBe(unknown);
    } finally {
      await pool.query('UPDATE schema_migrations SET checksum=$1 WHERE filename=$2', [legacy, file]);
    }
  }, 120000);
});
