import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { readFile, readdir } from 'node:fs/promises';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import type { PoolClient } from 'pg';
import { registerProfileRoutes } from '../src/routes/profiles.js';
import { registerCaregiverRoutes } from '../src/routes/caregivers.js';
import { registerErrorHandler } from '../src/middleware/error-handler.js';
import { signAccessToken } from '../src/auth/tokens.js';

// Exercise the real HTTP contracts, JWT/session middleware and audit writes
// against this same PostgreSQL engine; only the connection pool is adapted.
vi.mock('../src/lib/db.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/lib/db.js')>(),
  withUser: (uid: string, fn: (tx: PoolClient) => Promise<unknown>) => routeTransaction(fn, uid),
  withUserReadOnly: (uid: string, fn: (tx: PoolClient) => Promise<unknown>) => routeTransaction(fn, uid, true),
  withTransaction: (fn: (tx: PoolClient) => Promise<unknown>) => routeTransaction(fn),
}));

// Actual PostgreSQL engine (WASM), all checked-in migrations, and the same
// NOSUPERUSER/NOBYPASSRLS ownership model. Native multi-connection race suites
// remain separate; this single-connection engine cannot prove concurrency.
let db: PGlite;
let beforeRouteWrite: (() => Promise<void>) | undefined;
async function routeTransaction<T>(fn: (tx: PoolClient) => Promise<T>, uid?: string, readOnly = false): Promise<T> {
  if (uid && !readOnly && beforeRouteWrite) {
    const run = beforeRouteWrite; beforeRouteWrite = undefined; await run();
  }
  return db.transaction(async tx => {
    if (readOnly) await tx.exec('SET TRANSACTION READ ONLY');
    await tx.exec('SET LOCAL ROLE dawaee_app');
    if (uid) await tx.query("SELECT set_config('app.user_id',$1,true)", [uid]);
    return fn(tx as unknown as PoolClient);
  });
}
const http = Fastify();
const hash = () => randomBytes(32).toString('hex');
const headersFor = async (f: { uid: string; session: string }) => ({ authorization: `Bearer ${await signAccessToken(f.uid, f.session)}` });
async function newDevice(uid: string) {
  const session = randomUUID();
  await owner("INSERT INTO auth_sessions(id,user_id,refresh_token_hash,device_id,expires_at) VALUES($1,$2,$3,$4,now()+interval '1 day')", [session,uid,hash(),session]);
  return {uid,session};
}
const oldPassword = 'synthetic-original-password-hash-that-is-long-enough';
const newPassword = 'synthetic-replacement-password-hash-that-is-long-enough';
async function query(sql: string, args: unknown[] = [], role = 'dawaee_app', uid?: string) {
  return db.transaction(async tx => {
    await tx.exec(`SET LOCAL ROLE ${role}`);
    if (uid) await tx.query("SELECT set_config('app.user_id',$1,true)", [uid]);
    return tx.query(sql, args);
  });
}
const owner = (sql: string, args: unknown[] = []) => query(sql, args, 'dawaee_migrator');
const value = async (sql: string, args: unknown[] = [], uid?: string) => Object.values((await query(sql,args,'dawaee_app',uid)).rows[0] as object)[0];
beforeAll(async () => {
  db = await PGlite.create({ extensions: { pgcrypto, pg_trgm, btree_gist } });
  await db.exec(`CREATE ROLE dawaee_migrator CREATEDB CREATEROLE NOSUPERUSER NOBYPASSRLS;
    CREATE ROLE dawaee_app; CREATE ROLE dawaee_worker;
    GRANT dawaee_app TO dawaee_migrator WITH ADMIN TRUE, INHERIT FALSE, SET FALSE;
    GRANT dawaee_worker TO dawaee_migrator WITH ADMIN TRUE, INHERIT FALSE, SET FALSE;
    ALTER DATABASE postgres OWNER TO dawaee_migrator; ALTER SCHEMA public OWNER TO dawaee_migrator;
    SET ROLE dawaee_migrator;
    CREATE TABLE schema_migrations(filename text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now());`);
  await db.exec(await readFile('db/maintenance/definer_policies.sql','utf8'));
  for (const file of (await readdir('db/migrations')).filter(f=>f.endsWith('.sql')).sort()) {
    await db.exec(await readFile(`db/migrations/${file}`,'utf8'));
  }
  await db.exec(await readFile('db/maintenance/definer_policies.sql','utf8'));
  await db.exec('RESET ROLE');
  registerErrorHandler(http);
  registerProfileRoutes(http);
  registerCaregiverRoutes(http);
  await http.ready();
}, 60_000);
afterAll(async () => { await http.close(); await db?.close(); });
async function fixture(verified = false) {
  const uid=randomUUID(), session=randomUUID(), email=`${uid}@example.com`;
  await owner('INSERT INTO users(id,email,display_name) VALUES($1,$2,$3)',[uid,email,'Email fixture']);
  await owner('INSERT INTO user_credentials(user_id,password_hash) VALUES($1,$2)',[uid,oldPassword]);
  await owner("INSERT INTO auth_sessions(id,user_id,refresh_token_hash,device_id,expires_at) VALUES($1,$2,$3,'device',now()+interval '1 day')",[session,uid,hash()]);
  await owner("INSERT INTO push_tokens(user_id,token,platform,device_id) VALUES($1,$2,'android','device')",[uid,hash()]);
  if(verified) await owner('INSERT INTO user_email_verifications(user_id,email) VALUES($1,$2)',[uid,email]);
  return { uid,session,email };
}
const requestVerify = (f: Awaited<ReturnType<typeof fixture>>, token: string, email=f.email, credential=oldPassword, uid=f.uid) =>
  value('SELECT app.request_email_verification($1,$2,$3,$4,$5,$6)',[f.uid,f.session,email,token,credential,'encrypted-fixture'],uid);
const requestReset = (email: string, token: string) => query('SELECT app.request_email_recovery($1,$2,$3)',[email,token,'encrypted-fixture']);
const finish = (token: string, purpose='verify', password: string | null=null, request: string | null=null) =>
  value('SELECT app.complete_email_action($1,$2,$3,$4)',[token,purpose,password,request]);

describe('account email SQL boundaries', () => {
  it('enforces onboarding for new email accounts until the real verification action completes', async () => {
    const email = `${randomUUID()}@example.test`;
    const registered = await query('SELECT * FROM app.register_email_account(NULL,$1,$2,$3,$4)', [email,'New email account',oldPassword,'ar']);
    const uid = (registered.rows[0] as { user_id: string }).user_id;
    expect(await value('SELECT app.email_verification_required($1)',[uid],uid)).toBe(true);
    expect(await value('SELECT app.has_verified_email($1)',[uid],uid)).toBe(false);
    const session=randomUUID();
    await owner("INSERT INTO auth_sessions(id,user_id,refresh_token_hash,device_id,expires_at) VALUES($1,$2,$3,'new-email',now()+interval '1 day')",[session,uid,hash()]);
    const token=hash();
    expect(await requestVerify({uid,session,email},token)).toBe(true);
    expect(await value('SELECT app.email_verification_required($1)',[uid],uid)).toBe(true);
    expect(await finish(token)).toBe(uid);
    expect(await value('SELECT app.email_verification_required($1)',[uid],uid)).toBe(false);
    // A later raw email change cannot reuse the previous verification.
    await owner('UPDATE users SET email=$2 WHERE id=$1',[uid,`new-${email}`]);
    expect(await value('SELECT app.email_verification_required($1)',[uid],uid)).toBe(true);
  });
  it('keeps legacy accounts intact and does not expose or allow changing onboarding flags', async () => {
    const f=await fixture();
    expect(await value('SELECT app.email_verification_required($1)',[f.uid],f.uid)).toBe(false);
    const token=hash(); await requestVerify(f,token); expect(await finish(token)).toBe(f.uid);
    expect(await value('SELECT app.has_verified_email($1)',[f.uid],f.uid)).toBe(true);
    for (const role of ['dawaee_app','dawaee_worker']) {
      await expect(query('SELECT * FROM account_email_onboarding',[],role)).rejects.toMatchObject({code:'42501'});
      await expect(query('DELETE FROM account_email_onboarding',[],role)).rejects.toMatchObject({code:'42501'});
    }
    await expect(query('SELECT * FROM app.register_email_account(NULL,NULL,$1,$2,$3)',['No email',oldPassword,'ar'])).rejects.toMatchObject({code:'22023'});
  });
  it('keeps mail tables and queue functions inaccessible to the worker and raw table reads inaccessible to API', async () => {
    for (const role of ['dawaee_app','dawaee_worker']) {
      await expect(query('SELECT * FROM account_email_challenges',[],role)).rejects.toMatchObject({code:'42501'});
      await expect(query('SELECT * FROM user_email_verifications',[],role)).rejects.toMatchObject({code:'42501'});
    }
    await expect(query('SELECT * FROM app.claim_account_emails($1)',[randomUUID()],'dawaee_worker')).rejects.toMatchObject({code:'42501'});
  });
  it('does not infer verification from typed email or create unknown accounts', async () => {
    const f=await fixture(); const token=hash();
    expect(await value('SELECT app.has_verified_email($1)',[f.uid],f.uid)).toBe(false);
    await requestReset(f.email,token); await requestReset('unknown@example.com',hash());
    expect((await owner('SELECT * FROM account_email_challenges WHERE user_id=$1',[f.uid])).rows).toHaveLength(0);
    expect(await finish(token,'reset',newPassword,hash())).toBeNull();
  });
  it('requires own identity, a live session and the checked current credential', async () => {
    const f=await fixture(); expect(await requestVerify(f,hash(),f.email,'wrong')).toBe(false);
    expect(await requestVerify(f,hash(),f.email,oldPassword,randomUUID())).toBe(false);
    await owner('UPDATE auth_sessions SET revoked_at=now() WHERE id=$1',[f.session]);
    expect(await requestVerify(f,hash())).toBe(false);
  });
  it('changes email only after mailbox confirmation and binds the token to its purpose', async () => {
    const f=await fixture(); const token=hash(), email=`next-${f.email}`;
    expect(await requestVerify(f,token,email)).toBe(true);
    expect((await owner('SELECT email FROM users WHERE id=$1',[f.uid])).rows[0]).toEqual({email:f.email});
    expect(await finish(token,'reset',newPassword,hash())).toBeNull();
    expect(await finish(token)).toBe(f.uid);
    expect(await value('SELECT app.has_verified_email($1)',[f.uid],f.uid)).toBe(true);
    expect((await owner('SELECT email FROM users WHERE id=$1',[f.uid])).rows[0]).toEqual({email});
    expect(await finish(token)).toBeNull();
  });
  it('never lets a second account claim an occupied email', async () => {
    const a=await fixture(), b=await fixture();
    expect(await requestVerify(a,hash(),b.email)).toBe(false);
  });
  it('replaces old links and rejects expiry and credential changes after issuance', async () => {
    const f=await fixture(); const old=hash(), latest=hash();
    await requestVerify(f,old); await requestVerify(f,latest);
    expect(await finish(old)).toBeNull();
    await owner("UPDATE account_email_challenges SET expires_at=now()-interval '1 second' WHERE token_hash=$1",[latest]);
    expect(await finish(latest)).toBeNull();
    const next=hash(); await requestVerify(f,next);
    await owner('SELECT app.set_password($1,$2)',[f.uid,newPassword]);
    expect(await finish(next)).toBeNull();
  });
  it('resets only a verified mailbox, revokes sessions and push, and retries only the same password operation', async () => {
    const f=await fixture(true); const token=hash(), request=hash(); await requestReset(f.email,token);
    expect(await finish(token,'reset',newPassword,request)).toBe(f.uid);
    expect((await owner('SELECT password_hash FROM user_credentials WHERE user_id=$1',[f.uid])).rows[0]).toEqual({password_hash:newPassword});
    expect((await owner('SELECT id FROM auth_sessions WHERE user_id=$1 AND revoked_at IS NULL',[f.uid])).rows).toHaveLength(0);
    expect((await owner('SELECT id FROM push_tokens WHERE user_id=$1 AND active',[f.uid])).rows).toHaveLength(0);
    expect(await finish(token,'reset',newPassword,request)).toBe(f.uid);
    expect(await finish(token,'reset','different-password-hash'.repeat(3),hash())).toBeNull();
    await owner('SELECT app.set_password($1,$2)',[f.uid,oldPassword]);
    expect(await finish(token,'reset',newPassword,request)).toBeNull();
  });
  it('invalidates recovery on email changes, including changing back to a previously verified address', async () => {
    const f=await fixture(true); const token=hash(); await requestReset(f.email,token);
    await owner('UPDATE users SET email=$2 WHERE id=$1',[f.uid,`other-${f.email}`]);
    await owner('UPDATE users SET email=$2 WHERE id=$1',[f.uid,f.email]);
    expect(await value('SELECT app.has_verified_email($1)',[f.uid],f.uid)).toBe(false);
    expect(await finish(token,'reset',newPassword,hash())).toBeNull();
  });
  it('rejects disabled users even when the issued token was valid', async () => {
    const f=await fixture(true); const token=hash(); await requestReset(f.email,token);
    await owner('UPDATE users SET disabled_at=now() WHERE id=$1',[f.uid]);
    expect(await finish(token,'reset',newPassword,hash())).toBeNull();
  });
  it('leases jobs once, retries with the same token identity, and rejects acknowledgements for a replaced job', async () => {
    await owner('UPDATE account_email_challenges SET payload=NULL');
    const f=await fixture(true); const first=hash(); await requestReset(f.email,first);
    const lease=randomUUID(); const jobs=await query('SELECT * FROM app.claim_account_emails($1)',[lease]);
    expect(jobs.rows).toEqual([{token_hash:first,payload:'encrypted-fixture'}]);
    expect((await query('SELECT * FROM app.claim_account_emails($1)',[randomUUID()])).rows).toHaveLength(0);
    await query('SELECT app.finish_account_email($1,$2,false)',[first,lease]);
    await owner('UPDATE account_email_challenges SET next_attempt_at=now() WHERE token_hash=$1',[first]);
    const lease2=randomUUID(); expect((await query('SELECT * FROM app.claim_account_emails($1)',[lease2])).rows[0]).toMatchObject({token_hash:first});
    const second=hash(); await requestReset(f.email,second);
    await query('SELECT app.finish_account_email($1,$2,true)',[first,lease2]);
    expect((await query('SELECT * FROM app.claim_account_emails($1)',[randomUUID()])).rows[0]).toMatchObject({token_hash:second});
  });
  it('cascades mail ownership and encrypted jobs on account erasure', async () => {
    const f=await fixture(true); await requestReset(f.email,hash()); await owner('DELETE FROM users WHERE id=$1',[f.uid]);
    for(const table of ['user_email_verifications','account_email_challenges']) expect((await owner(`SELECT * FROM ${table} WHERE user_id=$1`,[f.uid])).rows).toHaveLength(0);
  });
});

async function invitationFixtures(verified = true) {
  const patient = await fixture(true), recipient = await fixture(verified), unrelated = await fixture(true);
  const profile = randomUUID(), otherProfile = randomUUID(), id = randomUUID(), token = hash();
  await owner("INSERT INTO patient_profiles(id,owner_user_id,display_name,is_self) VALUES($1,$2,'Synthetic patient',true),($3,$4,'Private caregiver profile',true)", [profile,patient.uid,otherProfile,recipient.uid]);
  await query(`INSERT INTO caregiver_relationships(id,patient_profile_id,invited_email,invited_name,role,status,permissions,invitation_token_hash,invitation_expires_at,invited_by_user_id)
    VALUES($1,$2,$3,'Synthetic caregiver','caregiver','pending',ARRAY['view_medications','view_schedule','view_history','confirm_dose'],$4,now()+interval '3 days',$5)`,[id,profile,recipient.email,token,patient.uid],'dawaee_app',patient.uid);
  return {patient,recipient,unrelated,profile,otherProfile,id,token};
}

describe('verified mailbox invitation and linked account boundaries', () => {
  it('recovers the invitation in a new tab, grants only the patient profile, and supports acceptance retry', async () => {
    const f = await invitationFixtures();
    expect((await query('SELECT * FROM app.pending_email_invitations()',[],'dawaee_app',f.recipient.uid)).rows).toEqual([
      expect.objectContaining({id:f.id,patient_name:'Synthetic patient'})]);
    expect((await query('SELECT * FROM app.pending_email_invitations()',[],'dawaee_app',f.unrelated.uid)).rows).toHaveLength(0);
    expect((await query('SELECT * FROM app.accept_email_invitation($1)',[f.id],'dawaee_app',f.unrelated.uid)).rows[0]).toMatchObject({outcome:'invalid'});
    for (let i=0;i<2;i++) expect((await query('SELECT * FROM app.accept_email_invitation($1)',[f.id],'dawaee_app',f.recipient.uid)).rows[0]).toMatchObject({outcome:'accepted',patient_profile_id:f.profile});
    expect(await value('SELECT app.has_permission($1,$2)',[f.profile,'view_history'],f.recipient.uid)).toBe(true);
    expect(await value('SELECT app.has_permission($1,$2)',[f.otherProfile,'view_history'],f.patient.uid)).toBe(false);
    expect((await query('SELECT id FROM patient_profiles WHERE id=$1',[f.otherProfile],'dawaee_app',f.patient.uid)).rows).toHaveLength(0);
    await query("UPDATE caregiver_relationships SET status='revoked' WHERE id=$1",[f.id],'dawaee_app',f.patient.uid);
    expect(await value('SELECT app.has_permission($1,$2)',[f.profile,'view_history'],f.recipient.uid)).toBe(false);
  });
  it('a link and typed email without mailbox verification never grant access', async () => {
    const f = await invitationFixtures(false);
    expect((await query('SELECT * FROM app.pending_email_invitations()',[],'dawaee_app',f.recipient.uid)).rows).toHaveLength(0);
    expect((await query('SELECT * FROM app.accept_caregiver_invitation($1,$2)',[f.token,f.recipient.uid],'dawaee_app',f.recipient.uid)).rows[0]).toMatchObject({outcome:'invalid'});
    await owner('INSERT INTO user_email_verifications(user_id,email) VALUES($1,$2)',[f.recipient.uid,f.recipient.email]);
    expect((await query('SELECT * FROM app.accept_caregiver_invitation($1,$2)',[f.token,f.recipient.uid],'dawaee_app',f.recipient.uid)).rows[0]).toMatchObject({outcome:'accepted'});
    await owner('UPDATE users SET email=$2 WHERE id=$1',[f.recipient.uid,'changed-'+f.recipient.email]);
    expect(await value('SELECT app.has_permission($1,$2)',[f.profile,'view_history'],f.recipient.uid)).toBe(false);
  });
  it('preserves the verified-phone requirement for phone invitations', async () => {
    const f = await invitationFixtures();
    const phone='+966500098881';
    await owner('UPDATE users SET phone_e164=$2 WHERE id=$1',[f.recipient.uid,phone]);
    await owner('UPDATE caregiver_relationships SET invited_email=NULL, invited_phone_e164=$2 WHERE id=$1',[f.id,phone]);
    expect((await query('SELECT * FROM app.accept_caregiver_invitation($1,$2)',[f.token,f.recipient.uid],'dawaee_app',f.recipient.uid)).rows[0]).toMatchObject({outcome:'verification_required'});
    await value('SELECT app.record_verified_phone($1,$2,now())',[f.recipient.uid,phone],f.recipient.uid);
    expect((await query('SELECT * FROM app.accept_caregiver_invitation($1,$2)',[f.token,f.recipient.uid],'dawaee_app',f.recipient.uid)).rows[0]).toMatchObject({outcome:'accepted'});
  });
  it('links a missing phone to the same email account without merging identities or claiming verification', async () => {
    const f=await fixture(true), stranger=await fixture(true), phone='+966500098882';
    expect(await value('SELECT app.attach_account_phone($1,$2,$3)',[f.uid,phone,'wrong'],f.uid)).toBe(false);
    expect(await value('SELECT app.attach_account_phone($1,$2,$3)',[f.uid,phone,oldPassword],stranger.uid)).toBe(false);
    expect(await value('SELECT app.attach_account_phone($1,$2,$3)',[f.uid,phone,oldPassword],f.uid)).toBe(true);
    expect(await value('SELECT app.has_verified_phone($1)',[f.uid],f.uid)).toBe(false);
    expect((await owner('SELECT email,phone_e164 FROM users WHERE id=$1',[f.uid])).rows[0]).toEqual({email:f.email,phone_e164:phone});
    expect(await value('SELECT app.attach_account_phone($1,$2,$3)',[stranger.uid,phone,oldPassword],stranger.uid)).toBe(false);
  });
});


describe('recipient review before caregiver acceptance', () => {
  const preview = (id: string, uid: string, token: string | null = null) => query(
    'SELECT * FROM app.preview_caregiver_invitation($1,$2)', [token, token ? null : id], 'dawaee_app', uid);
  const accept = (id: string, uid: string, permissions: string[], role = 'caregiver') => query(
    'SELECT * FROM app.accept_reviewed_caregiver_invitation($1,$2,$3)', [id, role, permissions], 'dawaee_app', uid);
  it('returns only the verified recipient preview without activating the relationship or exposing patient rows', async () => {
    const f = await invitationFixtures();
    const expected = ['view_medications','view_schedule','view_history','confirm_dose'];
    for (const token of [null, f.token]) {
      expect((await preview(f.id, f.recipient.uid, token)).rows[0]).toMatchObject({ id: f.id, patient_name: 'Synthetic patient', permissions: expected, outcome: 'ready' });
      expect((await preview(f.id, f.unrelated.uid, token)).rows[0]).toEqual({ id: null, patient_name: null, role: null, permissions: null, expires_at: null, outcome: 'invalid' });
    }
    expect((await query('SELECT * FROM app.pending_caregiver_invitation_previews()', [], 'dawaee_app', f.recipient.uid)).rows[0]).toMatchObject({ id: f.id, permissions: expected });
    expect((await owner('SELECT status::text,invitation_token_hash FROM caregiver_relationships WHERE id=$1', [f.id])).rows[0]).toEqual({ status:'pending', invitation_token_hash:f.token });
    expect((await query('SELECT id FROM patient_profiles WHERE id=$1',[f.profile],'dawaee_app',f.recipient.uid)).rows).toHaveLength(0);
  });
  it('requires fresh consent after a permission or role change and supports lost-response retries', async () => {
    const f = await invitationFixtures();
    const old = (await preview(f.id,f.recipient.uid)).rows[0] as { permissions: string[] };
    await owner("UPDATE caregiver_relationships SET permissions=ARRAY['view_schedule'],role='nurse' WHERE id=$1",[f.id]);
    expect((await accept(f.id,f.recipient.uid,old.permissions)).rows[0]).toMatchObject({outcome:'changed'});
    expect((await owner('SELECT status::text FROM caregiver_relationships WHERE id=$1',[f.id])).rows[0]).toEqual({status:'pending'});
    expect((await accept(f.id,f.unrelated.uid,['view_schedule'],'nurse')).rows[0]).toMatchObject({outcome:'invalid'});
    for (let i=0; i<2; i++) expect((await accept(f.id,f.recipient.uid,['view_schedule'],'nurse')).rows[0]).toMatchObject({outcome:'accepted',patient_profile_id:f.profile});
    await owner("UPDATE caregiver_relationships SET status='revoked' WHERE id=$1",[f.id]);
    expect((await accept(f.id,f.recipient.uid,['view_schedule'],'nurse')).rows[0]).toMatchObject({outcome:'invalid'});
  });
  it('does not disclose an expired invitation to the wrong account or mutate expiry during preview', async () => {
    const f = await invitationFixtures();
    await owner("UPDATE caregiver_relationships SET invitation_expires_at=now()-interval '1 second' WHERE id=$1",[f.id]);
    expect((await preview(f.id,f.unrelated.uid,f.token)).rows[0]).toMatchObject({outcome:'invalid',patient_name:null});
    expect((await preview(f.id,f.recipient.uid,f.token)).rows[0]).toMatchObject({outcome:'expired',patient_name:null});
    expect((await owner('SELECT status::text FROM caregiver_relationships WHERE id=$1',[f.id])).rows[0]).toEqual({status:'pending'});
  });
  it('requires phone proof before disclosing the patient and permits review only after verification', async () => {
    const f = await invitationFixtures(), phone='+966500098889';
    await owner('UPDATE users SET phone_e164=$2 WHERE id=$1',[f.recipient.uid,phone]);
    await owner('UPDATE caregiver_relationships SET invited_email=NULL,invited_phone_e164=$2 WHERE id=$1',[f.id,phone]);
    expect((await preview(f.id,f.recipient.uid,f.token)).rows[0]).toMatchObject({outcome:'verification_required',patient_name:null,permissions:null});
    await value('SELECT app.record_verified_phone($1,$2,now())',[f.recipient.uid,phone],f.recipient.uid);
    expect((await preview(f.id,f.recipient.uid,f.token)).rows[0]).toMatchObject({outcome:'ready'});
  });
  it('refuses unverified email, archived profiles, worker execution, and anonymous execution', async () => {
    const f = await invitationFixtures(false);
    expect((await preview(f.id,f.recipient.uid,f.token)).rows[0]).toMatchObject({outcome:'invalid'});
    expect((await query('SELECT * FROM app.preview_caregiver_invitation($1,NULL)',[f.token])).rows[0]).toMatchObject({outcome:'invalid'});
    await expect(query('SELECT * FROM app.preview_caregiver_invitation($1,NULL)',[f.token],'dawaee_worker',f.recipient.uid)).rejects.toMatchObject({code:'42501'});
    await owner('INSERT INTO user_email_verifications(user_id,email) VALUES($1,$2)',[f.recipient.uid,f.recipient.email]);
    await owner('UPDATE patient_profiles SET archived_at=now() WHERE id=$1',[f.profile]);
    expect((await preview(f.id,f.recipient.uid,f.token)).rows[0]).toMatchObject({outcome:'invalid'});
  });
});


describe('reviewed invitations through real HTTP and PostgreSQL', () => {
  it('previews without activation and requires the exact displayed permission snapshot', async () => {
    const f = await invitationFixtures();
    const headers = await headersFor(f.recipient);
    const token = randomBytes(32).toString('hex');
    await owner('UPDATE caregiver_relationships SET invitation_token_hash=$2 WHERE id=$1',[f.id,createHash('sha256').update(token).digest('hex')]);
    const review = await http.inject({method:'POST',url:'/v1/caregivers/invitations/preview',headers,payload:{token}});
    expect(review.statusCode,review.body).toBe(200);
    expect(review.json()).toMatchObject({id:f.id,patientName:'Synthetic patient',role:'caregiver',permissions:expect.arrayContaining(['view_history'])});
    expect(review.body).not.toContain(f.profile);
    expect(await value('SELECT app.has_permission($1,$2)',[f.profile,'view_history'],f.recipient.uid)).toBe(false);
    const snapshot = {relationshipId:f.id,role:review.json().role,permissions:review.json().permissions};
    await owner("UPDATE caregiver_relationships SET permissions=ARRAY['view_schedule'] WHERE id=$1",[f.id]);
    const changed = await http.inject({method:'POST',url:'/v1/caregivers/invitations/accept',headers,payload:snapshot});
    expect(changed.statusCode,changed.body).toBe(409);
    expect(changed.json().error.code).toBe('invitation_changed');
    const updated = await http.inject({method:'POST',url:'/v1/caregivers/invitations/preview',headers,payload:{relationshipId:f.id}});
    const accepted = await http.inject({method:'POST',url:'/v1/caregivers/invitations/accept',headers,payload:{...snapshot,permissions:updated.json().permissions}});
    expect(accepted.statusCode,accepted.body).toBe(200);
    expect(accepted.json().profileId).toBe(f.profile);
    expect(await value('SELECT app.has_permission($1,$2)',[f.profile,'view_schedule'],f.recipient.uid)).toBe(true);
    expect(await value('SELECT app.has_permission($1,$2)',[f.profile,'view_history'],f.recipient.uid)).toBe(false);
  });
  it('validates the transport and keeps wrong-recipient and expired-invitation responses private', async () => {
    const f = await invitationFixtures();
    const headers = await headersFor(f.recipient);
    for (const payload of [{},{relationshipId:f.id,token:'x'.repeat(64)}]) {
      expect((await http.inject({method:'POST',url:'/v1/caregivers/invitations/preview',headers,payload})).statusCode).toBe(400);
    }
    const wrong = await http.inject({method:'POST',url:'/v1/caregivers/invitations/preview',headers:await headersFor(f.unrelated),payload:{relationshipId:f.id}});
    expect(wrong.statusCode).toBe(404); expect(wrong.body).not.toContain('Synthetic patient');
    await owner("UPDATE caregiver_relationships SET invitation_expires_at=now()-interval '1 second' WHERE id=$1",[f.id]);
    const expired = await http.inject({method:'POST',url:'/v1/caregivers/invitations/preview',headers,payload:{relationshipId:f.id}});
    expect(expired.statusCode).toBe(410); expect(expired.json().error.code).toBe('invitation_expired');
  });
});

describe('account deletion through real HTTP, sessions and PostgreSQL', () => {
  it('revokes all sessions and push, retains the deadline after sign-in, and explicitly recovers within grace', async () => {
    const f = await fixture(true), second = await newDevice(f.uid);
    const original = await headersFor(f), other = await headersFor(second);
    const deletion = await http.inject({method:'POST',url:'/v1/me/deletion-request',headers:original,payload:{confirm:true}});
    expect(deletion.statusCode,deletion.body).toBe(200);
    expect(Date.parse(deletion.json().scheduledFor)-Date.parse(deletion.json().requestedAt)).toBe(14*86400000);
    for(const headers of [original,other]) expect((await http.inject({method:'GET',url:'/v1/me',headers})).statusCode).toBe(401);
    expect((await owner('SELECT id FROM push_tokens WHERE user_id=$1 AND active',[f.uid])).rows).toHaveLength(0);
    const fresh = await headersFor(await newDevice(f.uid));
    expect((await http.inject({method:'GET',url:'/v1/me',headers:fresh})).json().user.deletionScheduledFor).toBe(deletion.json().scheduledFor);
    expect((await http.inject({method:'GET',url:'/v1/care-circle?profileId='+randomUUID(),headers:fresh})).statusCode).toBe(403);
    expect((await http.inject({method:'POST',url:'/v1/me/deletion-cancel',headers:fresh,payload:{confirm:false}})).statusCode).toBe(400);
    const cancelled = await http.inject({method:'POST',url:'/v1/me/deletion-cancel',headers:fresh,payload:{confirm:true}});
    expect(cancelled.statusCode,cancelled.body).toBe(200);
    expect((await http.inject({method:'GET',url:'/v1/me',headers:fresh})).json().user.deletionScheduledFor).toBeNull();
    expect((await owner("SELECT action FROM audit_logs WHERE actor_user_id=$1 AND action IN ('account.deletion_requested','account.deletion_cancelled')",[f.uid])).rows).toHaveLength(2);
  });
  it('does not move a repeated request deadline and refuses recovery after it expires', async () => {
    const f = await fixture(true);
    await owner("UPDATE users SET deletion_requested_at=now()-interval '15 days' WHERE id=$1",[f.uid]);
    const before = (await owner('SELECT deletion_requested_at FROM users WHERE id=$1',[f.uid])).rows[0] as {deletion_requested_at:Date};
    const refused = await http.inject({method:'POST',url:'/v1/me/deletion-cancel',headers:await headersFor(f),payload:{confirm:true}});
    expect(refused.statusCode,refused.body).toBe(400);
    const repeated = await http.inject({method:'POST',url:'/v1/me/deletion-request',headers:await headersFor(f),payload:{confirm:true}});
    expect(repeated.statusCode,repeated.body).toBe(200);
    expect(repeated.json().requestedAt).toBe(new Date(before.deletion_requested_at).toISOString());
  });
  it('rechecks session liveness after authentication, before a delayed request can cancel deletion', async () => {
    const f = await fixture(true);
    await owner('UPDATE users SET deletion_requested_at=now() WHERE id=$1',[f.uid]);
    beforeRouteWrite = async () => { await owner('UPDATE auth_sessions SET revoked_at=now() WHERE user_id=$1',[f.uid]); };
    try {
      const res = await http.inject({method:'POST',url:'/v1/me/deletion-cancel',headers:await headersFor(f),payload:{confirm:true}});
      expect(res.statusCode,res.body).toBe(401);
      expect((await owner('SELECT deletion_requested_at IS NOT NULL AS pending FROM users WHERE id=$1',[f.uid])).rows[0]).toEqual({pending:true});
    } finally { beforeRouteWrite=undefined; }
  });
});
