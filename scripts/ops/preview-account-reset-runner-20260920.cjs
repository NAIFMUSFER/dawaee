// One-off preview reset runner: rehearse, explicitly commit, or verify read-only.
// Run only as an explicitly requested operator job. Never add to app startup.
// No contacts, credentials, tokens, health data or connection strings are logged.
const { createHash } = require('node:crypto');
const mode = process.argv[3];
const sql = Buffer.from(process.argv[2] || '', 'base64').toString('utf8');
const pg = require('pg');

const deadline = setTimeout(() => {
  console.error('PREVIEW_RESET_DEADLINE');
  process.exit(124);
}, 55000);
let client;

async function main() {
  if (!['rehearse', 'commit', 'verify'].includes(mode)) throw new Error('PREVIEW_MODE_REFUSED');
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
    statement_timeout: 30000,
    application_name: 'preview-account-reset-20260920',
  });
  await client.connect();
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

  if (mode !== 'verify') {
    const expectedHash = '53d5670dd358126d6f00700311bbae0c380f02a7e65138159f4e9f9ea5d4b4ff';
    if (createHash('sha256').update(sql).digest('hex') !== expectedHash) throw new Error('PREVIEW_SQL_HASH_REFUSED');
    const ending = "ROLLBACK;\nSELECT 'Reset rehearsal completed; all account changes rolled back' AS result;\n";
    if (!sql.endsWith(ending)) throw new Error('PREVIEW_SQL_ENDING_REFUSED');
    const statement = mode === 'commit' ? sql.slice(0, -ending.length) + 'COMMIT;\n' : sql;
    await client.query(statement);
    console.log(JSON.stringify({ result: mode === 'commit' ? 'PREVIEW_RESET_COMMITTED' : 'PREVIEW_SQL_REHEARSED', sql_sha256: expectedHash }));
    await client.end();
    client = new pg.Client({ connectionString: url.toString(),
      ssl: tls === 'true' ? { rejectUnauthorized: true } : false,
      connectionTimeoutMillis: 10000, statement_timeout: 10000,
      application_name: 'preview-account-reset-independent-verification' });
    await client.connect();
  }

  // Each verification uses a fresh connection and read-only snapshot.
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const { rows: [counts] } = await client.query(`
    WITH targets AS (SELECT id FROM users WHERE created_at <= '2026-09-20T10:22:25.790051Z'),
    profiles AS (SELECT id FROM patient_profiles WHERE owner_user_id IN (SELECT id FROM targets))
    SELECT transaction_timestamp()::text AS verified_at,
      (SELECT count(*) FROM targets) AS accounts,
      (SELECT count(*) FROM users WHERE id IN (SELECT id FROM targets) AND disabled_at IS NULL) AS non_disabled,
      (SELECT count(*) FROM users WHERE id IN (SELECT id FROM targets) AND (phone_e164 IS NOT NULL OR email IS DISTINCT FROM 'reset-'||id::text||'@deleted.invalid')) AS retained_identifiers,
      (SELECT count(*) FROM auth_sessions WHERE user_id IN (SELECT id FROM targets) AND revoked_at IS NULL) AS live_sessions,
      (SELECT count(*) FROM user_credentials WHERE user_id IN (SELECT id FROM targets)) AS credentials,
      (SELECT count(*) FROM push_tokens WHERE user_id IN (SELECT id FROM targets) AND active) AS active_push,
      (SELECT count(*) FROM patient_profiles WHERE id IN (SELECT id FROM profiles) AND archived_at IS NULL) AS active_profiles,
      (SELECT count(*) FROM medication_schedules WHERE patient_profile_id IN (SELECT id FROM profiles) AND active) AS active_schedules,
      (SELECT count(*) FROM caregiver_relationships WHERE (patient_profile_id IN (SELECT id FROM profiles) OR caregiver_user_id IN (SELECT id FROM targets)) AND (status IN ('active','pending') OR invitation_token_hash IS NOT NULL)) AS usable_care_links,
      (SELECT count(*) FROM emergency_cards WHERE patient_profile_id IN (SELECT id FROM profiles) AND (qr_enabled OR qr_token_hash IS NOT NULL)) AS usable_qr,
      (SELECT count(*) FROM notification_deliveries WHERE (patient_profile_id IN (SELECT id FROM profiles) OR recipient_user_id IN (SELECT id FROM targets)) AND status IN ('queued','sending')) AS pending_notifications,
      (SELECT count(*) FROM account_email_challenges WHERE user_id IN (SELECT id FROM targets)) AS account_email_proofs,
      (SELECT count(*) FROM email_registration_challenges WHERE completed_user_id IN (SELECT id FROM targets) OR expires_at <= '2026-09-20T10:52:25.790051Z') AS old_registration_proofs,
      (SELECT count(*) FROM user_phone_verifications WHERE user_id IN (SELECT id FROM targets)) AS phone_proofs,
      (SELECT count(*) FROM user_email_verifications WHERE user_id IN (SELECT id FROM targets)) AS email_proofs,
      (SELECT count(*) FROM account_email_onboarding WHERE user_id IN (SELECT id FROM targets)) AS onboarding_proofs,
      (SELECT count(*) FROM password_recovery_receipts WHERE user_id IN (SELECT id FROM targets)) AS recovery_proofs,
      (SELECT count(*) FROM schema_migrations) AS migrations,
      (SELECT count(*) FROM stored_objects) AS stored_objects,
      (SELECT count(*) FROM audit_logs WHERE request_id='owner-account-reset-20260920-preview') AS reset_audit,
      (SELECT max(deletion_requested_at)+interval '14 days' FROM users WHERE id IN (SELECT id FROM targets))::text AS physical_erasure_eligible,
      (SELECT encode(sha256(convert_to(string_agg(id::text, ',' ORDER BY id), 'UTF8')), 'hex') FROM targets) AS account_fingerprint
  `);
  await client.query('ROLLBACK');
  if (counts.accounts !== '28' || counts.migrations !== '95' || counts.stored_objects !== '3'
      || counts.account_fingerprint !== 'b5ad82b0ecb739f1e590c1c454d13e78801800df0eab7c20be9a6b93c83ba381') {
    throw new Error('PREVIEW_VERIFY_SCOPE_FAILED');
  }
  if (mode === 'rehearse') {
    if (counts.non_disabled !== '28' || counts.reset_audit !== '0') throw new Error('PREVIEW_ROLLBACK_VERIFY_FAILED');
  } else {
    const zeroFields = ['non_disabled','retained_identifiers','live_sessions','credentials','active_push',
      'active_profiles','active_schedules','usable_care_links','usable_qr','pending_notifications',
      'account_email_proofs','old_registration_proofs','phone_proofs','email_proofs','onboarding_proofs','recovery_proofs'];
    if (zeroFields.some(key => counts[key] !== '0') || counts.reset_audit !== '1') throw new Error('PREVIEW_COMMIT_VERIFY_FAILED');
  }
  console.log(JSON.stringify({ result: mode === 'rehearse' ? 'PREVIEW_REHEARSAL_ROLLED_BACK' : 'PREVIEW_RESET_VERIFIED', mode, counts }));
}

main().catch(error => {
  // Never log SQL detail, row values, connection strings or emailed tokens.
  console.error(JSON.stringify({ result: 'PREVIEW_RESET_FAILED', code: error.code || null,
    error: /^(PREVIEW_|Reset requires|This account reset|Worker job|Account inventory|Account state|Patient profile|Preview migration|Email delivery|Expected exactly|Reset postconditions|Protected schema)/.test(error.message) ? error.message : 'Operation failed; no sensitive error detail logged' }));
  process.exitCode = 1;
}).finally(async () => {
  if (client) { await client.query('ROLLBACK').catch(() => {}); await client.end().catch(() => {}); }
  clearTimeout(deadline);
});
