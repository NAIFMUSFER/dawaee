#!/usr/bin/env node
/**
 * Explicit opt-in entrypoint for the ONE managed audit preview, never production.
 *   node scripts/audit-preview-start.mjs          # read-only preflight
 *   node scripts/audit-preview-start.mjs --apply  # migrate, verify, start API
 *   node scripts/audit-preview-start.mjs --self-test
 *
 * Reuses migrate.sh without changing its ledger, checksums, RLS or grants.
 * No reset/seed is run. Unknown partial schemas are refused before migration.
 * The owner connection is closed and owner credentials are NOT passed to the API.
 * Without supplied audit role passwords, fresh passwords are generated on each
 * start. This preview must not share runtime roles with any other service.
 * It uses mock providers and synthetic data; success is not release approval.
 */
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVICE = 'srv-daipkbuk1f9s73952trg';
const ORIGIN = 'https://dawaee-audit-preview.onrender.com';
const DB_HOST = 'dpg-daipq80jo6nc73fsmhhg-a';
const DB_NAME = 'dawaee_audit_db';
const DB_OWNER = 'dawaee_audit_db_user';
const runFile = promisify(execFile);
const refuse = (code) => { throw new Error(code); };

export function validateTarget(env) {
  if (env.RENDER_SERVICE_ID !== SERVICE || env.RENDER_EXTERNAL_URL !== ORIGIN) refuse('AUDIT_SERVICE_MISMATCH');
  if (env.NODE_ENV !== 'test') refuse('AUDIT_TEST_ENV_REQUIRED');
  let url;
  try { url = new URL(env.DATABASE_URL); } catch { refuse('AUDIT_DATABASE_URL_INVALID'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)
      || url.hostname !== DB_HOST || (url.port && url.port !== '5432')
      || url.pathname !== `/${DB_NAME}` || url.username !== DB_OWNER
      || !url.password || url.search || url.hash) refuse('AUDIT_DATABASE_TARGET_MISMATCH');
  // Preserve the existing internal-network TLS selection. Never accept an
  // external host or silently downgrade a verified connection.
  const tls = env.DATABASE_SSL ?? 'false';
  if (!['false', 'true'].includes(tls)) refuse('AUDIT_TLS_MODE_REFUSED');
  if ((env.JWT_SECRET?.length ?? 0) < 48 || (env.IP_HASH_SALT?.length ?? 0) < 16) refuse('AUDIT_SECRETS_REQUIRED');
  if (env.MIGRATION_SET_ROLE || env.NODE_OPTIONS) refuse('AUDIT_UNEXPECTED_STARTUP_OVERRIDE');
  return url;
}

export function validateOwner(row) {
  if (!row || row.db !== DB_NAME || row.role !== DB_OWNER || row.owner !== DB_OWNER
      || row.super !== false || row.bypass !== false || row.create_role !== true
      || Number(row.version) < 170000 || Number(row.version) >= 180000) refuse('AUDIT_DATABASE_IDENTITY_UNSAFE');
}

export function validateSchemaState(ledgerRows, otherTables) {
  if (!Number.isInteger(ledgerRows) || ledgerRows < 0 || !Number.isInteger(otherTables) || otherTables < 0) refuse('AUDIT_SCHEMA_STATE_INVALID');
  if (ledgerRows === 0 && otherTables !== 0) refuse('AUDIT_PARTIAL_SCHEMA_REQUIRES_REVIEW');
}

export function runtimeEnvironment(env, ownerUrl, appPassword) {
  // An allowlist, not a denylist: DATABASE_URL, PG credentials, migration
  // passwords and any unrelated platform secrets cannot leak to the API child.
  const child = {};
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'PORT', 'HOST', 'LANG', 'TZ',
    'JWT_SECRET', 'JWT_ISSUER', 'IP_HASH_SALT', 'DATABASE_CA_CERT', 'DATABASE_CA_CERT_FILE',
    'RENDER_SERVICE_ID', 'RENDER_GIT_COMMIT', 'RENDER_EXTERNAL_URL', 'BUILD_TIME']) {
    if (env[key] !== undefined) child[key] = env[key];
  }
  const url = new URL(ownerUrl);
  url.username = 'dawaee_app';
  url.password = appPassword;
  return {
    ...child, DATABASE_URL: url.toString(), DATABASE_SSL: env.DATABASE_SSL ?? 'false',
    DATABASE_POOL_MAX: '3', NODE_ENV: 'test', OTP_DEBUG_ECHO: 'false',
    PUSH_PROVIDER: 'mock', OCR_PROVIDER: 'mock', STORAGE_PROVIDER: 'local',
    PASSWORD_LOGIN_ENABLED: 'true', LOG_LEVEL: 'info', PUBLIC_APP_URL: ORIGIN,
    CORS_ORIGINS: ORIGIN, TRUST_CF_CONNECTING_IP: 'true', TRUST_PROXY_HOPS: '1',
    GIT_COMMIT: env.RENDER_GIT_COMMIT ?? '',
  };
}

export async function bootstrap(env, apply = false) {
  const ownerUrl = validateTarget(env); // before imports, connections or writes
  const { default: pg } = await import('pg');
  const { databaseTlsOptions } = await import('../apps/api/dist/lib/db-tls.js');
  const ssl = databaseTlsOptions({ ...env, DATABASE_SSL: env.DATABASE_SSL ?? 'false' });
  const owner = new pg.Client({ connectionString: ownerUrl.toString(), ssl, connectionTimeoutMillis: 10000 });
  let locked = false;
  try {
    await owner.connect();
    const { rows } = await owner.query(`SELECT current_database() AS db, current_user AS role,
      pg_get_userbyid(d.datdba) AS owner, r.rolsuper AS super, r.rolbypassrls AS bypass,
      r.rolcreaterole AS create_role, current_setting('server_version_num')::int AS version
      FROM pg_database d JOIN pg_roles r ON r.rolname = current_user
      WHERE d.datname = current_database()`);
    validateOwner(rows[0]);
    // Serialize only this preview's setup. A second start fails, not races.
    if (apply) {
      const result = await owner.query('SELECT pg_try_advisory_lock(741209, 17) AS locked');
      locked = result.rows[0]?.locked === true;
      if (!locked) refuse('AUDIT_BOOTSTRAP_ALREADY_RUNNING');
    }
    const shape = await owner.query(`SELECT to_regclass('public.schema_migrations') IS NOT NULL AS ledger,
      (SELECT count(*)::int FROM pg_tables WHERE schemaname IN ('public','app')
       AND tablename <> 'schema_migrations') AS tables`);
    const ledgerRows = shape.rows[0].ledger
      ? Number((await owner.query('SELECT count(*) FROM public.schema_migrations')).rows[0].count) : 0;
    validateSchemaState(ledgerRows, shape.rows[0].tables);
    if (!apply) {
      console.log(`AUDIT_PREVIEW_PREFLIGHT_OK migrations=${ledgerRows}; no migration applied`);
      return null;
    }
    await runFile('psql', ['--version'], { cwd: ROOT, timeout: 10000 });
    const appPassword = env.DAWAEE_APP_PASSWORD || randomBytes(32).toString('hex');
    const workerPassword = env.DAWAEE_WORKER_PASSWORD || randomBytes(32).toString('hex');
    // Consistent TLS behaviour between libpq migration and the Node pools.
    const migrationEnv = {
      PATH: env.PATH, HOME: env.HOME, DATABASE_URL: ownerUrl.toString(),
      DAWAEE_APP_PASSWORD: appPassword, DAWAEE_WORKER_PASSWORD: workerPassword,
      PGSSLMODE: ssl === false ? 'disable' : 'verify-full', PGCONNECT_TIMEOUT: '10',
      PSQLRC: '/dev/null',
    };
    // Inline CAs would need a protected temporary file for libpq. Refuse that
    // unsupported setup here instead of silently ignoring the trust anchor.
    if (ssl && env.DATABASE_CA_CERT) refuse('AUDIT_INLINE_CA_REQUIRES_OPERATOR_SETUP');
    if (ssl && env.DATABASE_CA_CERT_FILE) migrationEnv.PGSSLROOTCERT = env.DATABASE_CA_CERT_FILE;
    else if (ssl) migrationEnv.PGSSLROOTCERT = '/etc/ssl/certs/ca-certificates.crt';
    try {
      await runFile('bash', ['scripts/migrate.sh'], { cwd: ROOT, env: migrationEnv,
        timeout: 300000, maxBuffer: 4 * 1024 * 1024 });
    } catch {
      // Do not print execFile's Error object: it retains child env/stdout/stderr.
      refuse('AUDIT_MIGRATION_FAILED_REVIEW_REQUIRED');
    }
    const expected = new Map();
    for (const file of (await readdir(resolve(ROOT, 'db/migrations'))).filter(f => f.endsWith('.sql')).sort()) {
      expected.set(file, createHash('md5').update(await readFile(resolve(ROOT, 'db/migrations', file))).digest('hex'));
    }
    const ledger = await owner.query('SELECT filename, checksum FROM public.schema_migrations');
    if (ledger.rows.length !== expected.size || ledger.rows.some(r => expected.get(r.filename) !== r.checksum)) refuse('AUDIT_LEDGER_VERIFICATION_FAILED');
    const runtime = runtimeEnvironment(env, ownerUrl, appPassword);
    const app = new pg.Client({ connectionString: runtime.DATABASE_URL, ssl, connectionTimeoutMillis: 10000 });
    try {
      await app.connect();
      const check = await app.query(`SELECT current_user AS role, r.rolsuper AS super,
        r.rolbypassrls AS bypass, r.rolcreaterole AS create_role, r.rolcreatedb AS create_db,
        pg_has_role(current_user, $1, 'MEMBER') AS owner_member
        FROM pg_roles r WHERE r.rolname = current_user`, [DB_OWNER]);
      assert.deepEqual(check.rows, [{ role: 'dawaee_app', super: false, bypass: false,
        create_role: false, create_db: false, owner_member: false }]);
    } finally { await app.end(); }
    console.log(`AUDIT_PREVIEW_SCHEMA_READY migrations=${expected.size} runtime=dawaee_app; synthetic data only; NOT_RELEASE_APPROVAL`);
    return runtime;
  } finally {
    if (locked) await owner.query('SELECT pg_advisory_unlock(741209, 17)').catch(() => undefined);
    await owner.end().catch(() => undefined);
  }
}

export function selfTest() {
  let count = 0;
  const env = { RENDER_SERVICE_ID: SERVICE, RENDER_EXTERNAL_URL: ORIGIN, NODE_ENV: 'test',
    DATABASE_URL: `postgresql://${DB_OWNER}:synthetic-test-password@${DB_HOST}/${DB_NAME}`,
    JWT_SECRET: 'synthetic-not-a-secret'.repeat(3), IP_HASH_SALT: 'synthetic-salt-for-test' };
  assert.equal(validateTarget(env).hostname, DB_HOST); count++;
  const reject = (patch) => { assert.throws(() => validateTarget({ ...env, ...patch })); count++; };
  for (const NODE_ENV of ['production', 'development', undefined]) reject({ NODE_ENV });
  for (const RENDER_SERVICE_ID of ['srv-dad9mvf10e5c73dva9vg', 'another-service', undefined]) reject({ RENDER_SERVICE_ID });
  reject({ RENDER_EXTERNAL_URL: 'https://dawaee-api.onrender.com' });
  for (const DATABASE_URL of [undefined, '', 'not-a-url',
    env.DATABASE_URL.replace(DB_HOST, '127.0.0.1:1'),
    env.DATABASE_URL.replace(DB_HOST, 'production.example'),
    env.DATABASE_URL.replace(DB_NAME, 'postgres'),
    env.DATABASE_URL.replace(DB_OWNER, 'dawaee_app'),
    `${env.DATABASE_URL}?options=-crole=postgres`, `${env.DATABASE_URL}#unexpected`,
    env.DATABASE_URL.replace(DB_HOST, `${DB_HOST}.attacker.invalid`)]) reject({ DATABASE_URL });
  reject({ DATABASE_SSL: 'no-verify' }); reject({ NODE_OPTIONS: '--import=unexpected.mjs' });
  reject({ MIGRATION_SET_ROLE: 'postgres' }); reject({ JWT_SECRET: 'short' });
  reject({ IP_HASH_SALT: 'short' });
  const row = { db: DB_NAME, role: DB_OWNER, owner: DB_OWNER, super: false, bypass: false, create_role: true, version: 170010 };
  validateOwner(row); count++;
  for (const patch of [{ super: true }, { bypass: true }, { create_role: false }, { role: 'postgres' }, { db: 'production' }, { owner: 'postgres' }, { version: 160000 }]) {
    assert.throws(() => validateOwner({ ...row, ...patch })); count++;
  }
  validateSchemaState(0, 0); count++; validateSchemaState(74, 40); count++;
  assert.throws(() => validateSchemaState(0, 1)); count++;
  assert.throws(() => validateSchemaState(-1, 0)); count++;
  const child = runtimeEnvironment({ ...env, DATABASE_ROLE_PASSWORD: 'owner-password',
    DAWAEE_APP_PASSWORD: 'extra-secret', PGPASSWORD: 'another-secret', RENDER_API_KEY: 'never-copy' }, validateTarget(env), 'random-app-password');
  assert.equal(new URL(child.DATABASE_URL).username, 'dawaee_app'); count++;
  assert.equal(new URL(child.DATABASE_URL).password, 'random-app-password'); count++;
  for (const key of ['DATABASE_ROLE_PASSWORD', 'DAWAEE_APP_PASSWORD', 'PGPASSWORD', 'RENDER_API_KEY', 'NODE_OPTIONS']) {
    assert.equal(child[key], undefined); count++;
  }
  assert.equal(child.OTP_DEBUG_ECHO, 'false'); count++;
  assert.equal(child.PUSH_PROVIDER, 'mock'); count++;
  console.log(`AUDIT_PREVIEW_GUARDS: ${count} assertions passed (no database connection)`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const mode = process.argv.slice(2);
    if (mode.length > 1 || (mode.length && !['--apply', '--self-test'].includes(mode[0]))) refuse('AUDIT_ARGUMENT_INVALID');
    if (mode[0] === '--self-test') selfTest();
    else {
      const runtime = await bootstrap(process.env, mode[0] === '--apply');
      if (runtime) {
        const child = spawn(process.execPath, ['apps/api/dist/index.js'], { cwd: ROOT, env: runtime, stdio: 'inherit' });
        for (const sig of ['SIGTERM', 'SIGINT']) process.once(sig, () => child.kill(sig));
        child.once('error', () => { console.error('AUDIT_API_START_FAILED'); process.exitCode = 1; });
        child.once('exit', code => { process.exitCode = code ?? 1; });
      }
    }
  } catch (error) {
    const code = /^AUDIT_[A-Z_]+$/.test(error?.message ?? '') ? error.message : 'AUDIT_BOOTSTRAP_FAILED';
    console.error(code); process.exitCode = 1;
  }
}
