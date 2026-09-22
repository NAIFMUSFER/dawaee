#!/usr/bin/env node
// Operator-only recovery for the single isolated preview. Not called by normal
// bootstrap: ordinary restarts must still refuse mismatched credentials.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateTarget, validateOwner, validateRuntimeRole } from './audit-preview-start.mjs';

const OWNER = 'dawaee_audit_db_user';
const ROLES = ['dawaee_app', 'dawaee_worker'];
const refuse = code => { throw new Error(code); };

export async function recoverPreviewCredentials(env, apply = false) {
  const ownerUrl = validateTarget(env);
  const passwords = [env.DAWAEE_APP_PASSWORD, env.DAWAEE_WORKER_PASSWORD];
  // Only the fixed credentials provisioned for this preview. Never generate a
  // replacement, take credentials from arguments, or print connection errors.
  if (passwords.some(p => typeof p !== 'string' || !/^[a-f0-9]{64}$/.test(p))) {
    refuse('AUDIT_RECOVERY_PASSWORD_FORMAT');
  }
  const { default: pg } = await import('pg');
  const { databaseTlsOptions } = await import('../apps/api/dist/lib/db-tls.js');
  const ssl = databaseTlsOptions({ ...env, DATABASE_SSL: env.DATABASE_SSL ?? 'false' });
  const owner = new pg.Client({ connectionString: ownerUrl.toString(), ssl, connectionTimeoutMillis: 10000 });
  let transaction = false;
  let locked = false;
  const probe = async (role, password) => {
    const url = new URL(ownerUrl);
    url.username = role; url.password = password;
    const client = new pg.Client({ connectionString: url.toString(), ssl, connectionTimeoutMillis: 10000 });
    try {
      await client.connect();
      const result = await client.query('SELECT current_user AS role');
      if (result.rows[0]?.role !== role) refuse('AUDIT_RECOVERY_IDENTITY_MISMATCH');
      return true;
    } catch (error) {
      if (error?.code === '28P01') return false;
      refuse('AUDIT_RECOVERY_CONNECTION_FAILED');
    } finally { await client.end().catch(() => undefined); }
  };
  try {
    await owner.connect();
    const identity = await owner.query(`SELECT current_database() AS db, current_user AS role,
      pg_get_userbyid(d.datdba) AS owner, r.rolsuper AS super, r.rolbypassrls AS bypass,
      r.rolcreaterole AS create_role, current_setting('server_version_num')::int AS version
      FROM pg_database d JOIN pg_roles r ON r.rolname = current_user
      WHERE d.datname = current_database()`);
    validateOwner(identity.rows[0]);
    locked = (await owner.query('SELECT pg_try_advisory_lock(741209, 17) AS locked')).rows[0]?.locked === true;
    if (!locked) refuse('AUDIT_RECOVERY_BUSY');
    // PostgreSQL roles are cluster-wide. Refuse to reset shared roles if an
    // unexpected database exists, even though the target URL is correct.
    const databases = await owner.query(`SELECT datname FROM pg_database WHERE NOT datistemplate
      AND datname NOT IN ('postgres', 'dawaee_audit_db')`);
    if (databases.rows.length) refuse('AUDIT_RECOVERY_SHARED_CLUSTER');
    const ledger = await owner.query('SELECT count(*)::int AS count FROM public.schema_migrations');
    if (ledger.rows[0]?.count !== 97) refuse('AUDIT_RECOVERY_SCHEMA_MISMATCH');
    for (const role of ROLES) {
      const result = await owner.query(`SELECT rolname AS role, rolsuper AS super,
        rolbypassrls AS bypass, rolcreaterole AS create_role, rolcreatedb AS create_db,
        pg_has_role(rolname, $2, 'MEMBER') AS owner_member,
        pg_has_role(rolname, $3, 'MEMBER') AS sibling_member
        FROM pg_roles WHERE rolname = $1`, [role, OWNER, ROLES.find(r => r !== role)]);
      validateRuntimeRole(result.rows, role);
    }
    const valid = [];
    for (let i = 0; i < ROLES.length; i++) valid.push(await probe(ROLES[i], passwords[i]));
    const mismatched = ROLES.filter((_, i) => !valid[i]);
    if (!apply || !mismatched.length) return { repaired: [], mismatched };
    await owner.query('BEGIN'); transaction = true;
    await owner.query("SET LOCAL lock_timeout = '5s'");
    await owner.query("SET LOCAL statement_timeout = '10s'");
    // Both identifiers and values have strict allowlists above. No grants,
    // schema changes, table writes, account resets, or connection termination.
    for (let i = 0; i < ROLES.length; i++) {
      if (!valid[i]) await owner.query(`ALTER ROLE ${ROLES[i]} WITH PASSWORD '${passwords[i]}'`);
    }
    await owner.query('COMMIT'); transaction = false;
    for (let i = 0; i < ROLES.length; i++) {
      if (!await probe(ROLES[i], passwords[i])) refuse('AUDIT_RECOVERY_VERIFICATION_FAILED');
    }
    return { repaired: mismatched, mismatched: [] };
  } finally {
    if (transaction) await owner.query('ROLLBACK').catch(() => undefined);
    if (locked) await owner.query('SELECT pg_advisory_unlock(741209, 17)').catch(() => undefined);
    await owner.end().catch(() => undefined);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length > 1 || (args.length && args[0] !== '--apply')) refuse('AUDIT_RECOVERY_ARGUMENT_INVALID');
    const result = await recoverPreviewCredentials(process.env, args[0] === '--apply');
    console.log(JSON.stringify({ event: 'AUDIT_RECOVERY_RESULT', ...result }));
    if (result.mismatched.length) process.exitCode = 1;
  } catch (error) {
    console.error(/^AUDIT_[A-Z_]+$/.test(error?.message ?? '') ? error.message : 'AUDIT_RECOVERY_FAILED');
    process.exitCode = 1;
  }
}
