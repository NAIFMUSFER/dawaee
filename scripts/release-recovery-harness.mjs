// Disposable PostgreSQL recovery rehearsal used by Vitest. This is not a
// production backup/restore command: targets are generated locally, never input.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OWNER = 'dawaee_migrator';
const ROLES = ['postgres', OWNER, 'dawaee_app', 'dawaee_worker'];
const digest = (value) => createHash('sha256').update(value).digest('hex');
const ident = (value) => `"${value.replaceAll('"', '""')}"`;

export function validateRecoveryEnvironment(env) {
  assert.equal(env.NODE_ENV, 'test', 'recovery rehearsal requires NODE_ENV=test');
  assert.equal(env.PGHOST ?? '127.0.0.1', '127.0.0.1', 'recovery rehearsal requires loopback PostgreSQL');
  assert.equal(String(env.PGPORT ?? '5433'), '5433', 'recovery rehearsal requires the dedicated test port');
  assert.equal(env.PGUSER ?? 'postgres', 'postgres', 'recovery rehearsal requires the test administrator');
  assert.equal(env.DAWAEE_MIGRATOR_ROLE ?? OWNER, OWNER, 'unexpected rehearsal owner');
}

export async function createRecoveryHarness(env = process.env) {
  validateRecoveryEnvironment(env); // before files, processes or connections
  const passwords = {
    postgres: env.PGPASSWORD ?? 'postgres',
    [OWNER]: env.DAWAEE_MIGRATOR_PASSWORD ?? 'migratorpw',
    dawaee_app: env.DAWAEE_APP_PASSWORD ?? 'devpass',
    dawaee_worker: env.DAWAEE_WORKER_PASSWORD ?? 'devpass',
  };
  const prefix = `dawaee_recovery_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const names = { source: `${prefix}_source`, upgrade: `${prefix}_upgrade`, recovered: `${prefix}_recovered` };
  const targets = new Set(Object.values(names));
  const created = new Set();
  const config = (database, user) => {
    assert.ok(ROLES.includes(user), 'unexpected rehearsal role');
    assert.ok(database === 'postgres' || targets.has(database), 'unowned rehearsal target');
    return { host: '127.0.0.1', port: 5433, database, user, password: passwords[user],
      ssl: false, connectionTimeoutMillis: 5000, statement_timeout: 15_000 };
  };
  const pool = (database, user = 'postgres') => {
    assert.ok(targets.has(database) && created.has(database), 'target was not created by this rehearsal');
    return new pg.Pool({ ...config(database, user), max: 1 });
  };
  const query = async (database, user, sql, values = []) => {
    const client = new pg.Client(config(database, user));
    try { await client.connect(); return await client.query(sql, values); }
    finally { await client.end(); }
  };

  // A loopback tunnel alone is not isolation. Refuse an administrative database
  // containing application tables, and require the established CI role model.
  const { rows: topology } = await query('postgres', 'postgres', `
    SELECT current_database() AS db, current_user AS role,
      current_setting('server_version_num')::int AS version,
      (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname IN ('public','app') AND c.relkind IN ('r','p','v','m','f')) AS application_relations,
      (SELECT json_agg(json_build_object('role',rolname,'super',rolsuper,'bypass',rolbypassrls)
        ORDER BY rolname) FROM pg_roles
        WHERE rolname IN ('dawaee_migrator','dawaee_app','dawaee_worker')) AS roles`);
  const t = topology[0];
  assert.equal(t.db, 'postgres');
  assert.equal(t.role, 'postgres');
  assert.ok(t.version >= 160000 && t.version < 180000, 'rehearsal requires PostgreSQL 16 or 17');
  assert.equal(t.application_relations, 0, 'administrative database is not an empty test control database');
  assert.deepEqual(t.roles, [
    { role: 'dawaee_app', super: false, bypass: false },
    { role: OWNER, super: false, bypass: false },
    { role: 'dawaee_worker', super: false, bypass: false },
  ], 'prepare the ordinary CI roles before the rehearsal');

  const temporary = mkdtempSync(join(tmpdir(), 'dawaee-recovery-'));
  const baseline = join(temporary, 'baseline');
  for (const path of ['scripts', 'db/migrations', 'db/maintenance']) mkdirSync(join(baseline, path), { recursive: true });
  copyFileSync(join(ROOT, 'scripts/migrate.sh'), join(baseline, 'scripts/migrate.sh'));
  for (const file of readdirSync(join(ROOT, 'db/maintenance'))) {
    if (file.endsWith('.sql')) copyFileSync(join(ROOT, 'db/maintenance', file), join(baseline, 'db/maintenance', file));
  }
  const files = readdirSync(join(ROOT, 'db/migrations')).filter(f => /^\d{4}_.*\.sql$/.test(f)).sort();
  const baselineFiles = files.filter(f => Number(f.slice(0, 4)) <= 33 || Number(f.slice(0, 4)) === 47);
  assert.equal(baselineFiles.length, 34, 'review the recorded production baseline before changing it');
  for (const file of baselineFiles) copyFileSync(join(ROOT, 'db/migrations', file), join(baseline, 'db/migrations', file));

  const childEnv = (role) => ({
    PATH: env.PATH, LANG: 'C.UTF-8', NODE_ENV: 'test',
    PGHOST: '127.0.0.1', PGPORT: '5433', PGUSER: role, PGPASSWORD: passwords[role],
    PGSSLMODE: 'disable', PGCONNECT_TIMEOUT: '5', PSQLRC: '/dev/null',
    // No role/password rotation in a rehearsal; CI already bootstrapped roles.
    DAWAEE_APP_PASSWORD: '', DAWAEE_WORKER_PASSWORD: '',
  });
  const run = (command, args, role = 'postgres', extra = {}) => execFileSync(command, args, {
    cwd: ROOT, encoding: 'utf8', timeout: 90_000, maxBuffer: 4 * 1024 * 1024,
    env: { ...childEnv(role), ...extra }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const connection = (database) => `postgres://${OWNER}@127.0.0.1:5433/${database}`;
  const archive = join(temporary, 'baseline.dump');
  let archiveDigest;
  const create = async (database) => {
    assert.ok(targets.has(database) && !created.has(database), 'refusing to reuse a target');
    await query('postgres', 'postgres', `CREATE DATABASE ${ident(database)} OWNER ${OWNER} TEMPLATE template0`);
    created.add(database); // cleanup may drop only databases this call created
  };
  const migrate = (database, fromBaseline = false) => {
    assert.ok(created.has(database), 'unowned migration target');
    return run('bash', [join(fromBaseline ? baseline : ROOT, 'scripts/migrate.sh')], OWNER,
      { DATABASE_URL: connection(database) });
  };
  const snapshot = async (database) => {
    assert.ok(created.has(database), 'unowned snapshot target');
    const { rows: tables } = await query(database, 'postgres', `
      SELECT schemaname, tablename FROM pg_tables WHERE schemaname IN ('public','app') ORDER BY 1,2`);
    const data = [];
    for (const table of tables) {
      const { rows } = await query(database, 'postgres', `SELECT to_jsonb(t)::text AS value
        FROM ${ident(table.schemaname)}.${ident(table.tablename)} t ORDER BY to_jsonb(t)::text`);
      data.push({ table: `${table.schemaname}.${table.tablename}`, count: rows.length,
        sha256: digest(JSON.stringify(rows)) });
    }
    const { rows: sequences } = await query(database, 'postgres', `
      SELECT schemaname, sequencename FROM pg_sequences WHERE schemaname IN ('public','app') ORDER BY 1,2`);
    const sequenceState = [];
    for (const s of sequences) {
      const { rows } = await query(database, 'postgres', `SELECT last_value::text, is_called
        FROM ${ident(s.schemaname)}.${ident(s.sequencename)}`);
      sequenceState.push({ name: `${s.schemaname}.${s.sequencename}`, ...rows[0] });
    }
    const { rows: security } = await query(database, 'postgres', `
      SELECT c.relname, pg_get_userbyid(c.relowner) AS owner, c.relrowsecurity AS rls,
        c.relforcerowsecurity AS forced,
        ARRAY(SELECT grantor::regrole::text||':'||grantee::regrole::text||':'||privilege_type||':'||is_grantable
          FROM aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) ORDER BY 1) AS grants
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind='r' ORDER BY c.relname`);
    const { rows: policies } = await query(database, 'postgres', `
      SELECT schemaname,tablename,policyname,permissive,roles::text,cmd,qual,with_check
      FROM pg_policies WHERE schemaname IN ('public','app') ORDER BY 1,2,3`);
    const { rows: routines } = await query(database, 'postgres', `
      SELECT p.oid::regprocedure::text AS signature, pg_get_userbyid(p.proowner) AS owner,
        p.prosecdef AS definer, pg_get_functiondef(p.oid) AS definition,
        ARRAY(SELECT grantor::regrole::text||':'||grantee::regrole::text||':'||privilege_type||':'||is_grantable
          FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) ORDER BY 1) AS grants
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='app' ORDER BY 1`);
    const { rows: indexes } = await query(database, 'postgres', `
      SELECT schemaname,tablename,indexname,indexdef FROM pg_indexes
      WHERE schemaname IN ('public','app') ORDER BY 1,2,3`);
    const { rows: constraints } = await query(database, 'postgres', `
      SELECT c.conrelid::regclass::text AS relation,c.conname,c.convalidated,
        pg_get_constraintdef(c.oid) AS definition
      FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace
      WHERE n.nspname IN ('public','app') ORDER BY 1,2`);
    return { data, sequences: sequenceState, security, policies, routines, indexes, constraints };
  };
  return {
    names, pool, query, create, migrate, snapshot, targetCount: files.length, targetLatest: files.at(-1),
    async backup() {
      assert.ok(created.has(names.source), 'source was not created by this rehearsal');
      const started = performance.now();
      run('pg_dump', ['--format=custom', '--dbname', names.source, '--file', archive]);
      archiveDigest = digest(readFileSync(archive));
      return { sha256: archiveDigest, bytes: readFileSync(archive).length, milliseconds: Math.round(performance.now()-started) };
    },
    async restore(database) {
      assert.equal(created.has(database), true, 'create a fresh rehearsal target first');
      assert.notEqual(database, names.source, 'refusing to restore over the source');
      const { rows } = await query(database, 'postgres', `SELECT count(*)::int AS n FROM pg_tables
        WHERE schemaname IN ('public','app')`);
      assert.equal(rows[0].n, 0, 'refusing to overwrite a populated target');
      assert.ok(archiveDigest, 'no backup has been created');
      assert.equal(digest(readFileSync(archive)), archiveDigest, 'backup digest changed');
      const started = performance.now();
      // Preserve ACLs and policy grantees. Objects are restored by their ordinary
      // owner; no superuser/BYPASSRLS grant or disabled-trigger option is used.
      run('pg_restore', ['--exit-on-error', '--single-transaction', '--no-owner',
        '--dbname', database, archive], OWNER);
      return { milliseconds: Math.round(performance.now()-started) };
    },
    async cleanup() {
      const failures = [];
      for (const database of created) {
        try { await query('postgres', 'postgres', `DROP DATABASE ${ident(database)} WITH (FORCE)`); }
        catch (error) { failures.push(error); }
      }
      rmSync(temporary, { recursive: true, force: true });
      if (failures.length) throw new AggregateError(failures, 'recovery rehearsal cleanup failed');
    },
  };
}
