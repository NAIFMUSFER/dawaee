// One-off, read-only inventory for the owner's all-account reset request.
// Run only as an explicitly requested operator job. Never add to app startup.
// No contacts, credentials, tokens, health data or connection strings are logged.
const { createHash } = require('node:crypto');
const pg = require('pg');

const deadline = setTimeout(() => {
  console.error('PREVIEW_INVENTORY_DEADLINE');
  process.exit(124);
}, 30000);
let client;

async function main() {
  let url;
  try { url = new URL(process.env.DATABASE_URL); }
  catch { throw new Error('PREVIEW_DATABASE_CONFIG_REQUIRED'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)
      || url.hostname !== 'dpg-daipq80jo6nc73fsmhhg-a'
      || url.pathname !== '/dawaee_audit_db'
      || url.username !== 'dawaee_audit_db_user'
      || !url.password || (url.port && url.port !== '5432')
      || url.search || url.hash || process.env.NODE_OPTIONS) {
    throw new Error('PREVIEW_DATABASE_TARGET_REFUSED');
  }
  const tls = process.env.DATABASE_SSL ?? 'false';
  if (!['true', 'false'].includes(tls)) throw new Error('PREVIEW_TLS_MODE_REFUSED');
  client = new pg.Client({
    connectionString: url.toString(),
    ssl: tls === 'true' ? { rejectUnauthorized: true } : false,
    connectionTimeoutMillis: 10000,
    statement_timeout: 10000,
    application_name: 'preview-account-inventory-20260920',
  });
  await client.connect();
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const { rows: [identity] } = await client.query(`
    SELECT current_database() AS db, current_user AS role,
      pg_get_userbyid(d.datdba) AS owner, r.rolsuper AS super,
      r.rolbypassrls AS bypass, current_setting('server_version_num') AS version
    FROM pg_database d JOIN pg_roles r ON r.rolname=current_user
    WHERE d.datname=current_database()`);
  if (identity?.db !== 'dawaee_audit_db'
      || identity.role !== 'dawaee_audit_db_user'
      || identity.owner !== 'dawaee_audit_db_user'
      || identity.super !== false || identity.bypass !== false
      || Number(identity.version) < 170000 || Number(identity.version) >= 180000) {
    throw new Error('PREVIEW_OWNER_IDENTITY_REFUSED');
  }
  const { rows: [cutoff] } = await client.query('SELECT transaction_timestamp()::text AS cutoff');
  const { rows: ids } = await client.query('SELECT id FROM public.users ORDER BY id');
  const { rows: [counts] } = await client.query(`SELECT
    (SELECT count(*) FROM public.users WHERE disabled_at IS NULL) AS non_disabled,
    (SELECT count(*) FROM public.users WHERE deletion_requested_at IS NOT NULL) AS deletion_requested,
    (SELECT count(*) FROM public.auth_sessions WHERE revoked_at IS NULL) AS live_sessions,
    (SELECT count(*) FROM public.patient_profiles) AS profiles,
    (SELECT count(*) FROM public.stored_objects) AS stored_objects,
    (SELECT count(*) FROM public.schema_migrations) AS migrations,
    (SELECT count(*) FROM public.email_registration_challenges) AS registration_challenges`);
  await client.query('ROLLBACK');
  console.log(JSON.stringify({
    result: 'PREVIEW_INVENTORY_READ_ONLY',
    database: identity.db, cutoff: cutoff.cutoff, account_count: ids.length,
    account_fingerprint: createHash('sha256').update(ids.map(row => row.id).join(',')).digest('hex'),
    counts,
  }));
}

main().catch(error => {
  const known = new Set(['PREVIEW_DATABASE_CONFIG_REQUIRED', 'PREVIEW_DATABASE_TARGET_REFUSED',
    'PREVIEW_TLS_MODE_REFUSED', 'PREVIEW_OWNER_IDENTITY_REFUSED']);
  console.error(known.has(error.message) ? error.message : 'PREVIEW_INVENTORY_FAILED');
  process.exitCode = 1;
}).finally(async () => {
  if (client) await client.end().catch(() => {});
  clearTimeout(deadline);
});
