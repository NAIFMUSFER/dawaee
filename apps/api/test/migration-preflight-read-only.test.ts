import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetDatabase } from './harness.js';

// Only the repository's disposable integration database. No environment-supplied
// production URL can redirect these fixtures or the migration subprocess.
const root = resolve(import.meta.dirname, '../../..');
const ownerUrl = `postgres://dawaee_migrator:${process.env.DAWAEE_MIGRATOR_PASSWORD ?? 'migratorpw'}@127.0.0.1:5433/dawaee_test`;
const pool = new pg.Pool({ connectionString: ownerUrl, max: 1 });

function preflight(url = ownerUrl, extraEnv: Record<string, string> = {}) {
  return spawnSync('bash', ['scripts/migrate.sh', '--preflight-only'], {
    cwd: root, encoding: 'utf8', timeout: 20_000,
    env: {
      ...process.env, DATABASE_URL: url, MIGRATION_SET_ROLE: '',
      DAWAEE_APP_PASSWORD: '', DAWAEE_WORKER_PASSWORD: '',
      PGOPTIONS: '-c default_transaction_read_only=on', ...extraEnv,
    },
  });
}

async function catalogue() {
  const { rows } = await pool.query(`
    SELECT kind, identity, version FROM (
      SELECT 'namespace' AS kind, n.oid::text AS identity, n.xmin::text AS version
        FROM pg_namespace n WHERE n.nspname IN ('public','app')
      UNION ALL
      SELECT 'routine', p.oid::text, p.xmin::text FROM pg_proc p
        JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='app'
      UNION ALL
      SELECT 'policy', p.oid::text, p.xmin::text FROM pg_policy p
        JOIN pg_class c ON c.oid=p.polrelid JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public'
    ) objects ORDER BY kind, identity`);
  return rows;
}

beforeAll(() => resetDatabase(), 120_000);
afterAll(async () => {
  await pool.query('DROP TABLE IF EXISTS public.preflight_read_only_probe');
  await pool.end();
});

describe('migration preflight on real PostgreSQL', () => {
  it('leaves existing function and policy catalogue versions unchanged', async () => {
    const before = await catalogue();
    const result = preflight();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('no database changes were made');
    expect(await catalogue()).toEqual(before);
  });

  it('reports a missing owner policy without creating it', async () => {
    await pool.query(`CREATE TABLE public.preflight_read_only_probe (id integer);
      ALTER TABLE public.preflight_read_only_probe ENABLE ROW LEVEL SECURITY;
      ALTER TABLE public.preflight_read_only_probe FORCE ROW LEVEL SECURITY`);
    try {
      const before = await catalogue();
      const result = preflight();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('1 missing definer policies');
      expect(await catalogue()).toEqual(before);
    } finally {
      await pool.query('DROP TABLE public.preflight_read_only_probe');
    }
  });

  it('refuses disabled RLS without modifying the fixture or other policies', async () => {
    await pool.query(`CREATE TABLE public.preflight_read_only_probe (id integer);
      ALTER TABLE public.preflight_read_only_probe FORCE ROW LEVEL SECURITY`);
    try {
      const before = await catalogue();
      const result = preflight();
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('FORCE RLS is set while RLS is disabled');
      expect(await catalogue()).toEqual(before);
    } finally {
      await pool.query('DROP TABLE public.preflight_read_only_probe');
    }
  });

  it('refuses runtime-role inspection without changing the schema', async () => {
    const before = await catalogue();
    const result = preflight('postgres://dawaee_app:devpass@127.0.0.1:5433/dawaee_test');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("runtime role 'dawaee_app'");
    expect(await catalogue()).toEqual(before);
  });
});
