import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { readFile, readdir } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Real PostgreSQL/WASM and all migrations, with the deployed non-bypass owner
// model. The worker deliberately has no request-scoped app.user_id. This tests
// the SQL authorization boundary, not provider receipt or native delivery.
let db: PGlite;
async function query(sql: string, args: unknown[] = [], role = 'dawaee_migrator', uid?: string) {
  return db.transaction(async tx => {
    await tx.exec(`SET LOCAL ROLE ${role}`);
    await tx.query("SELECT set_config('app.user_id', $1, true)", [uid ?? '']);
    return tx.query(sql, args);
  });
}
const worker = (sql: string, args: unknown[] = []) => query(sql, args, 'dawaee_worker');

beforeAll(async () => {
  db = await PGlite.create({ extensions: { pgcrypto, pg_trgm, btree_gist } });
  await db.exec(`CREATE ROLE dawaee_migrator CREATEDB CREATEROLE NOSUPERUSER NOBYPASSRLS;
    CREATE ROLE dawaee_app; CREATE ROLE dawaee_worker;
    GRANT dawaee_app TO dawaee_migrator WITH ADMIN TRUE, INHERIT FALSE, SET FALSE;
    GRANT dawaee_worker TO dawaee_migrator WITH ADMIN TRUE, INHERIT FALSE, SET FALSE;
    ALTER DATABASE postgres OWNER TO dawaee_migrator;
    ALTER SCHEMA public OWNER TO dawaee_migrator;
    SET ROLE dawaee_migrator;
    CREATE TABLE schema_migrations(filename text PRIMARY KEY, checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now());`);
  await db.exec(await readFile('db/maintenance/definer_policies.sql', 'utf8'));
  for (const file of (await readdir('db/migrations')).filter(f => f.endsWith('.sql')).sort()) {
    await db.exec(await readFile(`db/migrations/${file}`, 'utf8'));
  }
  await db.exec(await readFile('db/maintenance/definer_policies.sql', 'utf8'));
  await db.exec('RESET ROLE');
}, 60_000);
afterAll(async () => { await db?.close(); });

async function fixture(verified = true) {
  const patient = randomUUID(), recipient = randomUUID(), profile = randomUUID(), id = randomUUID();
  const email = `${recipient}@example.test`, token = randomBytes(32).toString('hex');
  await query("INSERT INTO users(id, email, display_name) VALUES($1, $2, 'Recipient'), ($3, $4, 'Patient')",
    [recipient, email, patient, `${patient}@example.test`]);
  await query("INSERT INTO patient_profiles(id, owner_user_id, display_name, is_self) VALUES($1, $2, 'Patient', true)",
    [profile, patient]);
  if (verified) await query('INSERT INTO user_email_verifications(user_id, email) VALUES($1, $2)', [recipient, email]);
  await query(`INSERT INTO caregiver_relationships(id, patient_profile_id, invited_email, invited_name,
      role, status, permissions, invitation_token_hash, invitation_expires_at, invited_by_user_id)
    VALUES($1, $2, $3, 'Recipient', 'nurse', 'pending',
      ARRAY['receive_notifications','view_medications','view_schedule','view_adherence'], $4, now()+interval '1 day', $5)`,
  [id, profile, email, token, patient], 'dawaee_app', patient);
  return { patient, recipient, profile, id, email, token };
}
async function accept(f: Awaited<ReturnType<typeof fixture>>) {
  const result = await query('SELECT * FROM app.accept_caregiver_invitation($1, $2)',
    [f.token, f.recipient], 'dawaee_app', f.recipient);
  expect(result.rows[0]).toMatchObject({ outcome: 'accepted', patient_profile_id: f.profile });
}
async function recipients(id: string) {
  // Same active-relationship and verification boundary used by the reminder,
  // digest and final dispatch queries, executed as the real worker SQL role.
  return (await worker(`SELECT caregiver_user_id FROM caregiver_relationships
    WHERE id=$1 AND status='active' AND app.caregiver_identity_verified(id)`, [id])).rows;
}

describe('verified email relationships in worker context', () => {
  it('keeps an accepted email nurse eligible without impersonating a signed-in user', async () => {
    const f = await fixture();
    await accept(f);
    expect((await worker('SELECT app.current_user_id() AS id')).rows).toEqual([{ id: null }]);
    expect(await recipients(f.id)).toEqual([{ caregiver_user_id: f.recipient }]);
    expect((await query('SELECT app.has_permission($1, $2) AS allowed',
      [f.profile, 'view_schedule'], 'dawaee_app', f.recipient)).rows).toEqual([{ allowed: true }]);
  });

  it('never infers proof from a typed email or an unrelated verification record', async () => {
    const f = await fixture(false);
    await query("UPDATE caregiver_relationships SET caregiver_user_id=$2, status='active' WHERE id=$1", [f.id, f.recipient]);
    expect(await recipients(f.id)).toEqual([]);
    await query('INSERT INTO user_email_verifications(user_id, email) VALUES($1, $2)', [f.recipient, `other-${f.email}`]);
    expect(await recipients(f.id)).toEqual([]);
  });

  it('invalidates both changed email and a change back to the previously verified address', async () => {
    const f = await fixture(); await accept(f);
    await query('UPDATE users SET email=$2 WHERE id=$1', [f.recipient, `changed-${f.email}`]);
    expect(await recipients(f.id)).toEqual([]);
    await query('UPDATE users SET email=$2 WHERE id=$1', [f.recipient, f.email]);
    expect(await recipients(f.id)).toEqual([]);
  });

  it('rejects disabled recipients and revoked relationships', async () => {
    const disabled = await fixture(); await accept(disabled);
    await query('UPDATE users SET disabled_at=now() WHERE id=$1', [disabled.recipient]);
    expect(await recipients(disabled.id)).toEqual([]);
    const revoked = await fixture(); await accept(revoked);
    await query("UPDATE caregiver_relationships SET status='revoked' WHERE id=$1", [revoked.id]);
    expect(await recipients(revoked.id)).toEqual([]);
    expect((await worker('SELECT app.caregiver_identity_verified($1) AS verified', [randomUUID()])).rows)
      .toEqual([{ verified: false }]);
  });

  it('preserves phone proof for an existing phone relationship', async () => {
    const f = await fixture();
    const phone = '+966500098883';
    await query('UPDATE users SET phone_e164=$2 WHERE id=$1', [f.recipient, phone]);
    await query('UPDATE caregiver_relationships SET invited_email=NULL, invited_phone_e164=$2 WHERE id=$1', [f.id, phone]);
    const refused = await query('SELECT * FROM app.accept_caregiver_invitation($1, $2)',
      [f.token, f.recipient], 'dawaee_app', f.recipient);
    expect(refused.rows[0]).toMatchObject({ outcome: 'verification_required' });
    await query('SELECT app.record_verified_phone($1, $2, now())', [f.recipient, phone], 'dawaee_app', f.recipient);
    await accept(f);
    expect(await recipients(f.id)).toEqual([{ caregiver_user_id: f.recipient }]);
  });

  it('preserves self-only email inspection and private table/function grants', async () => {
    const f = await fixture(); await accept(f);
    expect((await query('SELECT app.has_verified_email($1) AS verified', [f.recipient], 'dawaee_app', f.recipient)).rows)
      .toEqual([{ verified: true }]);
    expect((await query('SELECT app.has_verified_email($1) AS verified', [f.recipient], 'dawaee_app', f.patient)).rows)
      .toEqual([{ verified: false }]);
    await expect(worker('SELECT app.has_verified_email($1)', [f.recipient])).rejects.toMatchObject({ code: '42501' });
    for (const role of ['dawaee_app', 'dawaee_worker']) {
      await expect(query('SELECT * FROM user_email_verifications', [], role)).rejects.toMatchObject({ code: '42501' });
    }
    const publicGrant = await query(`SELECT EXISTS(SELECT 1 FROM pg_proc p,
      LATERAL aclexplode(p.proacl) acl WHERE p.oid='app.caregiver_identity_verified(uuid)'::regprocedure
      AND acl.grantee=0 AND acl.privilege_type='EXECUTE') AS allowed`);
    expect(publicGrant.rows).toEqual([{ allowed: false }]);
  });
});
