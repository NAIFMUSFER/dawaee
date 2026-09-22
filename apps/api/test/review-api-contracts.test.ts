import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { readFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import Fastify from 'fastify';
import type { PoolClient } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Real PostgreSQL/WASM, complete migrations and restricted runtime roles.
// Authentication transport is replaced; access checks, RLS, SQL and services
// are real. Native multi-connection race tests remain a separate CI gate.
const h = vi.hoisted(() => ({ run: null as any }));
vi.mock('../src/lib/db.js', async original => ({
  ...await original<typeof import('../src/lib/db.js')>(),
  withUser: (uid: string, fn: any) => h.run(uid, fn),
  withUserReadOnly: (uid: string, fn: any) => h.run(uid, fn),
}));
vi.mock('../src/middleware/context.js', () => ({
  authenticate: async () => undefined,
  currentUser: (req: any) => ({ userId: req.headers['x-test-user'] }),
}));
import { registerMedicationRoutes } from '../src/routes/medications.js';
import { registerNoteRoutes } from '../src/routes/notes.js';
import { registerReportRoutes } from '../src/routes/reports.js';
import { registerProfileRoutes } from '../src/routes/profiles.js';
import { registerDoseRoutes } from '../src/routes/doses.js';
import { registerDosePrivateRoutes } from '../src/routes/dose-private.js';
import { registerStockRoutes } from '../src/routes/stock.js';
import { registerErrorHandler } from '../src/middleware/error-handler.js';
import { setClockSource, resetClockSource } from '../src/lib/clock.js';
import { attemptPasswordLogin, MAX_LOGIN_ATTEMPTS } from '../src/auth/password-service.js';
import { hashPassword } from '../src/lib/password.js';

let db: PGlite;
let app: ReturnType<typeof Fastify>;
let patient: string, caregiver: string, profile: string;
const date = '2026-09-19';
let now = new Date(`${date}T04:00:00Z`);
let queryFailure = '';
const password = 'Audit account secret 23981!';
const { prepareValue } = createRequire(import.meta.url)('pg/lib/utils.js');
function client(tx: any): PoolClient {
  return { query: async (sql: string, values: unknown[] = []) => {
    // PGlite does not serialize custom enum arrays; use node-postgres's exact
    // wire representation for arrays, without changing queries or DB policy.
    const result = await tx.query(sql, values.map(v => Array.isArray(v) ? prepareValue(v) : v)).catch((error: any) => {
      queryFailure = `${error.code}: ${error.message} ${error.detail ?? ''}`;
      throw error;
    });
    // Match node-postgres's configured DATE parser and timestamp values.
    for (const row of result.rows) for (const field of result.fields ?? []) {
      const value = row[field.name];
      if (value === null || value === undefined) continue;
      if (field.dataTypeID === 1082 && value instanceof Date) row[field.name] = value.toISOString().slice(0, 10);
      if ([1114, 1184].includes(field.dataTypeID) && typeof value === 'string') row[field.name] = new Date(value);
    }
    return { ...result, rowCount: result.affectedRows ?? result.rows.length };
  } } as unknown as PoolClient;
}
const owner = (sql: string, values: unknown[] = []) => db.transaction(async tx => {
  await tx.exec('SET LOCAL ROLE dawaee_migrator');
  return client(tx).query(sql, values);
});
beforeAll(async () => {
  db = await PGlite.create({ extensions: { pgcrypto, pg_trgm, btree_gist } });
  await db.exec(`CREATE ROLE dawaee_migrator CREATEDB CREATEROLE NOSUPERUSER NOBYPASSRLS;
    CREATE ROLE dawaee_app; CREATE ROLE dawaee_worker;
    GRANT dawaee_app TO dawaee_migrator WITH ADMIN TRUE, INHERIT FALSE, SET FALSE;
    GRANT dawaee_worker TO dawaee_migrator WITH ADMIN TRUE, INHERIT FALSE, SET FALSE;
    ALTER DATABASE postgres OWNER TO dawaee_migrator; ALTER SCHEMA public OWNER TO dawaee_migrator;
    SET ROLE dawaee_migrator;
    CREATE TABLE schema_migrations(filename text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now());`);
  await db.exec(await readFile('db/maintenance/definer_policies.sql', 'utf8'));
  for (const file of (await readdir('db/migrations')).filter(f => f.endsWith('.sql')).sort()) {
    await db.exec(await readFile(`db/migrations/${file}`, 'utf8'));
  }
  await db.exec(await readFile('db/maintenance/definer_policies.sql', 'utf8'));
  await db.exec('RESET ROLE');
  h.run = (uid: string, fn: any) => db.transaction(async tx => {
    await tx.exec('SET LOCAL ROLE dawaee_app');
    await tx.query("SELECT set_config('app.user_id',$1,true)", [uid]);
    return fn(client(tx));
  });
  app = Fastify(); registerErrorHandler(app);
  registerMedicationRoutes(app); registerNoteRoutes(app); registerReportRoutes(app);
  registerProfileRoutes(app); registerDoseRoutes(app); registerDosePrivateRoutes(app); registerStockRoutes(app);
  await app.ready();
}, 60_000);
beforeEach(async () => {
  patient = randomUUID(); caregiver = randomUUID(); profile = randomUUID();
  now = new Date(`${date}T04:00:00Z`); setClockSource(() => now);
  await owner('INSERT INTO users(id,email,display_name) VALUES($1,$2,$3),($4,$5,$6)',
    [patient, `${patient}@example.test`, 'Audit patient', caregiver, `${caregiver}@example.test`, 'Audit caregiver']);
  await owner("INSERT INTO patient_profiles(id,owner_user_id,display_name,is_self,timezone,home_timezone) VALUES($1,$2,'Audit profile',true,'Asia/Riyadh','Asia/Riyadh')", [profile, patient]);
  await owner('INSERT INTO user_email_verifications(user_id,email) VALUES($1,$2)', [caregiver, `${caregiver}@example.test`]);
  await owner(`INSERT INTO caregiver_relationships(patient_profile_id,caregiver_user_id,role,status,permissions,invited_by_user_id,accepted_at,invited_email)
    VALUES($1,$2,'nurse','active',$3,$4,now(),$5)`, [profile, caregiver,
    ['view_medications','view_schedule','view_history','view_reports','confirm_dose','edit_medication','edit_schedule','update_stock'], patient, `${caregiver}@example.test`]);
});
afterAll(async () => { resetClockSource(); await app?.close(); await db?.close(); });
function request(method: string, url: string, payload?: object, uid = patient, headers = {}) {
  return app.inject({ method: method as 'GET', url, payload, headers: { 'x-test-user': uid, ...headers } });
}
async function medication(extra = {}, uid = patient) {
  const res = await request('POST', '/v1/medications', {
    patientProfileId: profile, name: `Audit ${randomUUID()}`, form: 'tablet', startDate: date,
    schedule: { rule: { kind: 'fixed_times', times: ['08:00','12:00'] }, doseQuantity: 1, doseUnit: 'tablet', startDate: date },
    stock: { trackingEnabled: true, initialQuantity: 20, unit: 'tablet' }, ...extra,
  }, uid);
  expect(res.statusCode, `${res.body} ${queryFailure}`).toBe(200); return res.json();
}
async function doses() {
  const res = await request('GET', `/v1/doses?profileId=${profile}&from=${date}&to=2026-10-03`);
  expect(res.statusCode, res.body).toBe(200);
  return res.json().doses.sort((a: any, b: any) => a.scheduledAt.localeCompare(b.scheduledAt));
}

describe('reviewed API workflows and clinical output', () => {
  it('keeps historical dose quantities and stable medication identity in clinician output', async () => {
    const med = await medication(); const dose = (await doses())[0]; now = new Date(dose.scheduledAt);
    expect((await request('POST','/v1/dose/action',{doseId:dose.id,action:'taken',clientEventId:'report-take-1'})).statusCode).toBe(200);
    expect((await request('PATCH',`/v1/schedules/${med.scheduleId}`,{doseQuantity:2,confirmHighRiskChange:true})).statusCode).toBe(200);
    const report = await request('GET',`/v1/reports/clinician?profileId=${profile}&from=${date}&to=${date}`);
    expect(report.statusCode,report.body).toBe(200);
    expect(report.json().doses[0]).toMatchObject({medicationId:med.medication.id,dose:'1 tablet',status:'taken'});
    expect(report.json().medications[0].medicationId).toBe(med.medication.id);
    now = new Date(`${date}T13:00:00Z`);
    const late = await request('GET',`/v1/reports/clinician?profileId=${profile}&from=${date}&to=${date}`);
    expect(late.json().doses[1].status).toBe('missed');
  });
  it('limits future generation to medication treatment dates and reconciles later date edits', async () => {
    const med = await medication({endDate:date});
    expect((await doses()).every((d:any)=>d.scheduledLocalDate===date)).toBe(true);
    const expanded = await request('PATCH',`/v1/medications/${med.medication.id}`,{endDate:'2026-09-21'});
    expect(expanded.statusCode,expanded.body).toBe(200);
    expect((await doses()).map((d:any)=>d.scheduledLocalDate)).toContain('2026-09-21');
    const narrowed = await request('PATCH',`/v1/medications/${med.medication.id}`,{startDate:'2026-09-20',endDate:'2026-09-20'});
    expect(narrowed.statusCode,narrowed.body).toBe(200);
    expect((await doses()).map((d:any)=>d.scheduledLocalDate)).toEqual(['2026-09-20','2026-09-20']);
  });
  it('restores schedule timezone when returning from local travel to home time', async () => {
    const med = await medication();
    for (const decision of ['follow_local_time','keep_home_time']) {
      const res = await request('POST',`/v1/profiles/${profile}/timezone-decision`,{decision,detectedTimezone:'Europe/London'});
      expect(res.statusCode,res.body).toBe(200);
    }
    const detail = await request('GET',`/v1/medications/${med.medication.id}`);
    expect(detail.json().schedules[0].timezone).toBe('Asia/Riyadh');
    expect((await doses())[0].scheduledAt).toBe(`${date}T05:00:00.000Z`);
  });
  it('attributes offline nurse confirmation and other clinical writes to caregiver', async () => {
    const med=await medication();const list=await doses();now=new Date(list[0].scheduledAt);
    const sync=await request('POST','/v1/doses/sync',{deviceId:'review-device',actions:[{type:'taken',doseOccurrenceId:list[0].id,at:now.toISOString(),clientEventId:'nurse-sync-1'}]},caregiver);
    expect(sync.json().applied,sync.body).toBe(1);
    const detail=await request('GET',`/v1/doses/${list[0].id}`);
    expect(detail.json().dose.confirmationMethod).toBe('caregiver');
    const undo=await request('POST','/v1/dose/action',{doseId:list[0].id,action:'undo'},caregiver);expect(undo.statusCode,undo.body).toBe(200);
    const skip=await request('POST','/v1/dose/action',{doseId:list[0].id,action:'skip',clientEventId:'nurse-skip-1'},caregiver);expect(skip.statusCode,skip.body).toBe(200);
    const refill=await request('POST',`/v1/medications/${med.medication.id}/refill`,{quantityAdded:2,unit:'tablet'},caregiver);expect(refill.statusCode,refill.body).toBe(200);
    const audit=await owner('SELECT actor_role FROM audit_logs WHERE actor_user_id=$1',[caregiver]);
    expect(audit.rows.length).toBeGreaterThanOrEqual(4);expect(audit.rows.every(r=>r.actor_role==='caregiver')).toBe(true);
  });
  it('reads only the author notes under confirm-only grants and transports the dose in a header', async () => {
    await medication();const dose=(await doses())[0];
    for(const [uid,text] of [[patient,'Patient private note'],[caregiver,'My caregiver note']]) {
      const res=await request('POST','/v1/notes',{profileId:profile,doseOccurrenceId:dose.id,text},uid);expect(res.statusCode,res.body).toBe(200);
    }
    await owner("UPDATE caregiver_relationships SET permissions=ARRAY['view_medications','view_schedule','confirm_dose']::text[] WHERE caregiver_user_id=$1",[caregiver]);
    const read=await request('GET',`/v1/notes?profileId=${profile}&own=true`,undefined,caregiver,{'x-dawaee-dose-id':dose.id});
    expect(read.statusCode,read.body).toBe(200);expect(read.json().ownOnly).toBe(true);
    expect(read.json().notes.map((n:any)=>n.text)).toEqual(['My caregiver note']);
    expect((await request('GET',`/v1/notes?profileId=${profile}`,undefined,caregiver)).statusCode).toBe(403);
    expect((await request('GET',`/v1/notes?profileId=${profile}&doseOccurrenceId=${randomUUID()}`,undefined,patient,{'x-dawaee-dose-id':dose.id})).statusCode).toBe(400);
  });
  it('freezes a snooze at the original action time during sync and echoes its accepted deadline', async () => {
    await medication();const dose=(await doses())[0];const actionAt=new Date(dose.scheduledAt);now=new Date(actionAt.getTime()+5*60000);
    const payload={deviceId:'review-snooze-device',actions:[{type:'snoozed',doseOccurrenceId:dose.id,at:actionAt.toISOString(),clientEventId:'frozen-snooze-1',minutes:15}]};
    const res=await request('POST','/v1/doses/sync',payload,caregiver);
    expect(res.json().results[0],res.body).toMatchObject({ok:true,status:'snoozed',snoozeCount:1,snoozedUntil:new Date(actionAt.getTime()+15*60000).toISOString()});
    now=new Date(actionAt.getTime()+7*60000);
    const replay=await request('POST','/v1/doses/sync',payload,caregiver);expect(replay.json().results[0].snoozedUntil).toBe(res.json().results[0].snoozedUntil);
    const audit=await owner("SELECT actor_role FROM audit_logs WHERE actor_user_id=$1 AND action='dose.snoozed'",[caregiver]);expect(audit.rows[0].actor_role).toBe('caregiver');
  });
  it('does not disclose a known identifier on the failed-password lock transition', async () => {
    await owner('INSERT INTO user_credentials(user_id,password_hash) VALUES($1,$2)',[patient,await hashPassword(password)]);
    const outcomes=[];
    for(let i=0;i<MAX_LOGIN_ATTEMPTS+1;i++) outcomes.push(await h.run(patient,(tx:PoolClient)=>attemptPasswordLogin(tx,`${patient}@example.test`,'Incorrect secret 813!')));
    expect(outcomes).toEqual(Array.from({length:MAX_LOGIN_ATTEMPTS+1},()=>({outcome:'invalid'})));
    const locked = await h.run(patient,(tx:PoolClient)=>tx.query(
      'SELECT locked_until,failed_login_count,locked_until > now() AS lock_active FROM app.find_user_for_password_login($1)',
      [`${patient}@example.test`],
    ));
    expect(locked.rows[0].failed_login_count).toBeGreaterThanOrEqual(MAX_LOGIN_ATTEMPTS);
    expect(locked.rows[0].lock_active).toBe(true);
    expect(await h.run(patient,(tx:PoolClient)=>attemptPasswordLogin(tx,`${patient}@example.test`,password))).toEqual({outcome:'invalid'});
  });

  it('rejects expired and future snooze intents and the actual schedule missed boundary', async () => {
    await medication({schedule:{rule:{kind:'fixed_times',times:['08:00']},doseQuantity:1,doseUnit:'tablet',startDate:date,missedAfterMinutes:30}});
    const dose = (await doses())[0];
    const scheduled = new Date(dose.scheduledAt).getTime();
    now = new Date(scheduled + 5 * 60_000);
    for (const [actionAt, minutes] of [
      [scheduled, 5], [scheduled + 6 * 60_000, 10], [scheduled, 30],
    ]) {
      const res = await request('POST', '/v1/dose/action', {
        action: 'snooze', doseId: dose.id, clientEventId: randomUUID(),
        actionAt: new Date(actionAt!).toISOString(), minutes,
      });
      expect(res.statusCode, res.body).toBe(422);
    }
    const accepted = await request('POST', '/v1/dose/action', {
      action:'snooze',doseId:dose.id,clientEventId:'boundary-valid',
      actionAt:new Date(scheduled).toISOString(),minutes:15,
    });
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(accepted.json().snoozedUntil).toBe(new Date(scheduled+15*60_000).toISOString());
    expect((await request('POST', '/v1/dose/action', { action:'taken',doseId:dose.id,clientEventId:'after-snooze-take' })).statusCode).toBe(200);
    const replay=await request('POST', '/v1/dose/action', {action:'snooze',doseId:dose.id,clientEventId:'boundary-valid',minutes:15});
    expect(replay.json()).toMatchObject({status:'taken',snoozedUntil:null,idempotentReplay:true});
  });

  it('does not erase hidden authored history when a caregiver edits a future schedule', async () => {
    const med = await medication(); const dose = (await doses())[0];
    expect((await request('POST','/v1/notes',{profileId:profile,doseOccurrenceId:dose.id,text:'Keep this clinical note'})).statusCode).toBe(200);
    await owner("UPDATE caregiver_relationships SET permissions=ARRAY['view_medications','view_schedule','edit_schedule']::text[] WHERE caregiver_user_id=$1",[caregiver]);
    const edit=await request('PATCH',`/v1/schedules/${med.scheduleId}`,{doseQuantity:2,confirmHighRiskChange:true},caregiver);
    expect(edit.statusCode,edit.body).toBe(200);
    const existing=await owner('SELECT id,dose_quantity FROM dose_occurrences WHERE id=$1',[dose.id]);
    expect(existing.rows).toHaveLength(1);
    expect(Number(existing.rows[0].dose_quantity)).toBe(1);
    const notes=await owner('SELECT dose_occurrence_id,text FROM symptom_notes WHERE patient_profile_id=$1',[profile]);
    expect(notes.rows[0]).toMatchObject({dose_occurrence_id:dose.id,text:'Keep this clinical note'});
  });

  it('bounds the history guard to authorized editors and the worker role', async () => {
    await medication(); const [recorded, untouched] = await doses();
    expect((await request('POST','/v1/notes',{profileId:profile,doseOccurrenceId:recorded.id,text:'Private note'})).statusCode).toBe(200);
    const guard = (uid: string, id: string) => h.run(uid, async (tx: PoolClient) =>
      (await tx.query('SELECT app.dose_has_recorded_history($1) AS protected', [id])).rows[0].protected);
    expect(await guard(caregiver, recorded.id)).toBe(true);
    expect(await guard(caregiver, untouched.id)).toBe(false);
    await owner("UPDATE caregiver_relationships SET permissions=ARRAY['view_medications','view_schedule']::text[] WHERE caregiver_user_id=$1",[caregiver]);
    expect(await guard(caregiver, untouched.id)).toBe(true);
    expect(await guard(caregiver, randomUUID())).toBe(true);
    await db.transaction(async tx => {
      await tx.exec('SET LOCAL ROLE dawaee_worker');
      const result = await client(tx).query('SELECT app.dose_has_recorded_history($1) AS recorded, app.dose_has_recorded_history($2) AS untouched',[recorded.id,untouched.id]);
      expect(result.rows[0]).toEqual({recorded:true,untouched:false});
    });
  });

  it('records an offline skip at the device action time, with no stock movement', async () => {
    const med = await medication(); const dose = (await doses())[0];
    const at = dose.scheduledAt;
    now = new Date(new Date(at).getTime() + 30 * 60_000);
    const payload = {deviceId:'skip-device',actions:[{
      type:'skipped',doseOccurrenceId:dose.id,at,clientEventId:'original-skip-time',reason:'Recorded offline',
    }]};
    const response = await request('POST','/v1/doses/sync',payload,caregiver);
    expect(response.json().applied,response.body).toBe(1);
    const detail = await request('GET',`/v1/doses/${dose.id}`);
    expect(detail.json().dose.confirmedAt).toBe(at);
    expect(detail.json().events[0].at).toBe(at);
    const stock = await owner('SELECT remaining_quantity FROM medication_stock WHERE medication_id=$1',[med.medication.id]);
    expect(Number(stock.rows[0].remaining_quantity)).toBe(20);
  });

  it('rejects queued skips outside the action window or ahead of the server', async () => {
    await medication(); const dose = (await doses())[0];
    const scheduled = new Date(dose.scheduledAt).getTime();
    now = new Date(scheduled + 26 * 60 * 60_000);
    for (const at of [scheduled - 16 * 60_000, scheduled + 25 * 60 * 60_000, now.getTime() + 60_000]) {
      const response = await request('POST','/v1/doses/sync',{deviceId:'invalid-skip-device',actions:[{
        type:'skipped',doseOccurrenceId:dose.id,at:new Date(at).toISOString(),clientEventId:randomUUID(),
      }]});
      expect(response.json().results[0],response.body).toMatchObject({ok:false,error:'dose_not_actionable'});
    }
  });

  it('does not apply an older queued skip after a newer snooze', async () => {
    await medication(); const dose = (await doses())[0];
    const scheduled = new Date(dose.scheduledAt).getTime();
    now = new Date(scheduled + 10 * 60_000);
    expect((await request('POST','/v1/dose/action',{action:'snooze',doseId:dose.id,minutes:20,clientEventId:'newer-device-snooze'})).statusCode).toBe(200);
    now = new Date(scheduled + 12 * 60_000);
    const response = await request('POST','/v1/doses/sync',{deviceId:'older-skip-device',actions:[{
      type:'skipped',doseOccurrenceId:dose.id,at:new Date(scheduled + 5 * 60_000).toISOString(),clientEventId:'older-device-skip',
    }]});
    expect(response.json().results[0],response.body).toMatchObject({ok:false,error:'dose_not_actionable'});
    expect((await request('GET',`/v1/doses/${dose.id}`)).json().dose.status).toBe('snoozed');
  });

  it('keeps confirm-only replay idempotent after undo without granting history', async () => {
    await medication(); const dose = (await doses())[0]; now = new Date(dose.scheduledAt);
    await owner("UPDATE caregiver_relationships SET permissions=ARRAY['view_medications','view_schedule','confirm_dose']::text[] WHERE caregiver_user_id=$1",[caregiver]);
    const payload = {deviceId:'confirm-only-device',actions:[{type:'skipped',doseOccurrenceId:dose.id,at:now.toISOString(),clientEventId:'skip-then-undo-replay'}]};
    expect((await request('POST','/v1/doses/sync',payload,caregiver)).json().applied).toBe(1);
    now = new Date(now.getTime() + 60_000);
    const undo = await request('POST','/v1/dose/action',{action:'undo',doseId:dose.id,clientEventId:'newer-undo-intent'});
    expect(undo.statusCode,undo.body).toBe(200);
    const replay = await request('POST','/v1/doses/sync',payload,caregiver);
    expect(replay.json(),replay.body).toMatchObject({applied:0,replayed:1});
    expect((await request('GET',`/v1/doses/${dose.id}`)).json().dose.status).toBe('due');
  });

  it('lets a confirm-only nurse record and undo their own action without reading history', async () => {
    const med = await medication(); const dose = (await doses())[0]; now = new Date(dose.scheduledAt);
    await owner("UPDATE caregiver_relationships SET permissions=ARRAY['view_medications','view_schedule','confirm_dose']::text[] WHERE caregiver_user_id=$1",[caregiver]);
    const taken = await request('POST','/v1/dose/action',{action:'taken',doseId:dose.id,clientEventId:'confirm-only-record'},caregiver);
    expect(taken.statusCode,`${taken.body} ${queryFailure}`).toBe(200);
    expect(taken.json().stock).toMatchObject({remainingQuantity:19,clamped:false});
    const undo = await request('POST','/v1/dose/action',{action:'undo',doseId:dose.id,clientEventId:'confirm-only-undo'},caregiver);
    expect(undo.statusCode,`${undo.body} ${queryFailure}`).toBe(200);
    const history = await h.run(caregiver,(tx: PoolClient) => tx.query('SELECT id FROM dose_events WHERE dose_occurrence_id=$1',[dose.id]));
    expect(history.rows).toHaveLength(0);
    const stock = await owner('SELECT remaining_quantity FROM medication_stock WHERE medication_id=$1',[med.medication.id]);
    expect(Number(stock.rows[0].remaining_quantity)).toBe(20);
  });

  it('accepts a timely offline skip after the worker marks missed, but never replaces a user confirmation', async () => {
    await medication(); const [automatic, confirmed] = await doses();
    const scheduled = new Date(automatic.scheduledAt).getTime();
    now = new Date(scheduled + 26 * 60 * 60_000);
    await owner("UPDATE dose_occurrences SET status='missed' WHERE id=$1",[automatic.id]);
    await owner("INSERT INTO dose_events(dose_occurrence_id,patient_profile_id,type,at,metadata) VALUES($1,$2,'missed',$3,'{\"source\":\"worker\"}')",[automatic.id,profile,now]);
    const payload = {deviceId:'late-reconnect-device',actions:[{
      type:'skipped',doseOccurrenceId:automatic.id,at:automatic.scheduledAt,clientEventId:'before-automatic-miss',
    }]};
    expect((await request('POST','/v1/doses/sync',payload)).json().applied).toBe(1);
    expect((await request('GET',`/v1/doses/${automatic.id}`)).json().dose.confirmedAt).toBe(automatic.scheduledAt);
    now = new Date(new Date(confirmed.scheduledAt).getTime() + 10 * 60_000);
    expect((await request('POST','/v1/dose/action',{action:'taken',doseId:confirmed.id,clientEventId:'other-device-confirmation'})).statusCode).toBe(200);
    const lateSkip = await request('POST','/v1/doses/sync',{deviceId:'different-device',actions:[{
      type:'skipped',doseOccurrenceId:confirmed.id,at:confirmed.scheduledAt,clientEventId:'obsolete-skip-intent',
    }]},caregiver);
    expect(lateSkip.json().results[0],lateSkip.body).toMatchObject({ok:false,error:'dose_already_resolved'});
    expect((await request('GET',`/v1/doses/${confirmed.id}`)).json().dose.status).toBe('taken');
  });

  it('bounds automatic stock transitions to the exact authorized dose and actor event', async () => {
    const med = await medication(); const [dose, anotherDose] = await doses(); now = new Date(dose.scheduledAt);
    expect((await request('POST','/v1/dose/action',{action:'taken',doseId:dose.id,clientEventId:'stock-authorized-take'})).statusCode).toBe(200);
    const events = await owner("SELECT id FROM dose_events WHERE dose_occurrence_id=$1 AND type='taken'",[dose.id]);
    const eventId = events.rows[0].id;
    const apply = (uid: string, doseId: string, event: unknown) => h.run(uid,(tx: PoolClient) =>
      tx.query('SELECT * FROM app.apply_dose_stock_event($1,$2)',[doseId,event]));
    await expect(apply(patient,dose.id,'9223372036854775807')).rejects.toMatchObject({code:'42501'});
    await expect(apply(patient,anotherDose.id,eventId)).rejects.toMatchObject({code:'42501'});
    await expect(apply(caregiver,dose.id,eventId)).rejects.toMatchObject({code:'42501'});
    await expect(apply(randomUUID(),dose.id,eventId)).rejects.toMatchObject({code:'42501'});
    const otherProfile = randomUUID();
    await owner("INSERT INTO patient_profiles(id,owner_user_id,display_name,is_self,timezone,home_timezone) VALUES($1,$2,'Other patient',true,'Asia/Riyadh','Asia/Riyadh')",[otherProfile,caregiver]);
    const otherMedication = await medication({patientProfileId:otherProfile},caregiver);
    const otherDoses = await owner('SELECT id FROM dose_occurrences WHERE medication_id=$1',[otherMedication.medication.id]);
    await expect(apply(patient,otherDoses.rows[0].id,eventId)).rejects.toMatchObject({code:'42501'});
    await apply(patient,dose.id,eventId);
    expect((await request('POST','/v1/dose/action',{action:'undo',doseId:dose.id,clientEventId:'stock-authorized-undo'})).statusCode).toBe(200);
    await apply(patient,dose.id,eventId);
    const stock = await owner('SELECT remaining_quantity FROM medication_stock WHERE medication_id=$1',[med.medication.id]);
    expect(Number(stock.rows[0].remaining_quantity)).toBe(20);
    const ledger = await owner('SELECT delta FROM stock_transactions WHERE dose_occurrence_id=$1 ORDER BY dose_event_id',[dose.id]);
    expect(ledger.rows.map(row=>Number(row.delta))).toEqual([-1,1]);
  });

  it('never retroactively consumes an old untracked event after tracking is enabled', async () => {
    const med = await medication({stock:{trackingEnabled:false,initialQuantity:20,unit:'tablet'}});
    const dose = (await doses())[0]; now = new Date(dose.scheduledAt);
    const payload = {action:'taken',doseId:dose.id,clientEventId:'untracked-original-event'};
    const taken = await request('POST','/v1/dose/action',payload);
    expect(taken.statusCode,taken.body).toBe(200); expect(taken.json().stock).toBeNull();
    const events = await owner("SELECT id FROM dose_events WHERE dose_occurrence_id=$1 AND type='taken'",[dose.id]);
    await owner('UPDATE medication_stock SET tracking_enabled=true WHERE medication_id=$1',[med.medication.id]);
    await expect(h.run(patient,(tx:PoolClient)=>tx.query('SELECT * FROM app.apply_dose_stock_event($1,$2)',[dose.id,events.rows[0].id]))).rejects.toMatchObject({code:'42501'});
    const replay = await request('POST','/v1/dose/action',payload);
    expect(replay.json()).toMatchObject({status:'taken',idempotentReplay:true,stock:null});
    const stock = await owner('SELECT remaining_quantity FROM medication_stock WHERE medication_id=$1',[med.medication.id]);
    expect(Number(stock.rows[0].remaining_quantity)).toBe(20);
    const ledger = await owner('SELECT id FROM stock_transactions WHERE dose_occurrence_id=$1',[dose.id]);
    expect(ledger.rows).toHaveLength(0);
  });

  it('preserves clamped stock and ledger identity through repeated take/undo and skip/undo', async () => {
    const med = await medication({stock:{trackingEnabled:true,initialQuantity:0.5,unit:'tablet'}});
    const dose = (await doses())[0]; now = new Date(dose.scheduledAt);
    for (let cycle=0;cycle<3;cycle++) {
      const taken = await request('POST','/v1/dose/action',{action:'taken',doseId:dose.id,clientEventId:`clamped-take-${cycle}`});
      expect(taken.statusCode,taken.body).toBe(200);
      expect(taken.json().stock).toEqual({remainingQuantity:0,clamped:true});
      const undo = await request('POST','/v1/dose/action',{action:'undo',doseId:dose.id,clientEventId:`clamped-undo-${cycle}`});
      expect(undo.statusCode,undo.body).toBe(200);
    }
    expect((await request('POST','/v1/dose/action',{action:'skip',doseId:dose.id,clientEventId:'skip-after-clamped-cycles'})).statusCode).toBe(200);
    expect((await request('POST','/v1/dose/action',{action:'undo',doseId:dose.id,clientEventId:'undo-skip-after-clamped-cycles'})).statusCode).toBe(200);
    const stock = await owner('SELECT remaining_quantity FROM medication_stock WHERE medication_id=$1',[med.medication.id]);
    expect(Number(stock.rows[0].remaining_quantity)).toBe(0.5);
    const ledger = await owner('SELECT delta,dose_event_id FROM stock_transactions WHERE dose_occurrence_id=$1 ORDER BY dose_event_id',[dose.id]);
    expect(ledger.rows.map(row=>Number(row.delta))).toEqual([-0.5,0.5,-0.5,0.5,-0.5,0.5]);
    expect(new Set(ledger.rows.map(row=>row.dose_event_id)).size).toBe(6);
  });

  it('does not subtract a preserved old-unit dose from newly created stock in another unit', async () => {
    const med = await medication({stock:undefined}); const dose = (await doses())[0];
    expect((await request('POST','/v1/notes',{profileId:profile,doseOccurrenceId:dose.id,text:'Keep original dose snapshot'})).statusCode).toBe(200);
    const edit = await request('PATCH',`/v1/schedules/${med.scheduleId}`,{doseUnit:'ml',confirmHighRiskChange:true});
    expect(edit.statusCode,edit.body).toBe(200);
    const refill = await request('POST',`/v1/medications/${med.medication.id}/refill`,{quantityAdded:20,unit:'ml'});
    expect(refill.statusCode,refill.body).toBe(200);
    now = new Date(dose.scheduledAt);
    const taken = await request('POST','/v1/dose/action',{action:'taken',doseId:dose.id,clientEventId:'historical-unit-take'});
    expect(taken.statusCode,taken.body).toBe(200); expect(taken.json().stock).toBeNull();
    const stock = await owner('SELECT remaining_quantity,unit FROM medication_stock WHERE medication_id=$1',[med.medication.id]);
    expect(Number(stock.rows[0].remaining_quantity)).toBe(20); expect(stock.rows[0].unit).toBe('ml');
  });

  it('updates stock over HTTP and rearms the low-stock alert only after an increase', async () => {
    const med = await medication();
    const marker = now.toISOString();
    await owner('UPDATE medication_stock SET low_stock_notified_at=$2 WHERE medication_id=$1',[med.medication.id,marker]);
    const decrease = await request('PUT',`/v1/medications/${med.medication.id}/stock`,{remainingQuantity:10},caregiver);
    expect(decrease.statusCode,`${decrease.body} ${queryFailure}`).toBe(200);
    expect(decrease.json()).toMatchObject({remainingQuantity:10,delta:-10,unit:'tablet'});
    const afterDecrease = await owner('SELECT low_stock_notified_at FROM medication_stock WHERE medication_id=$1',[med.medication.id]);
    expect(afterDecrease.rows[0].low_stock_notified_at.toISOString()).toBe(marker);
    const increase = await request('PUT',`/v1/medications/${med.medication.id}/stock`,{delta:5},caregiver);
    expect(increase.statusCode,increase.body).toBe(200);
    expect(increase.json()).toMatchObject({remainingQuantity:15,delta:5,unit:'tablet'});
    const afterIncrease = await owner('SELECT remaining_quantity,low_stock_notified_at FROM medication_stock WHERE medication_id=$1',[med.medication.id]);
    expect(Number(afterIncrease.rows[0].remaining_quantity)).toBe(15);
    expect(afterIncrease.rows[0].low_stock_notified_at).toBeNull();
  });
});
