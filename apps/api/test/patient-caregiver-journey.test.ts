import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CAREGIVER_ROLE_PRESETS } from '@dawaee/shared';
import { reminderJob } from '../../worker/src/jobs/reminders.js';
import { authHeaders, resetDatabase, signIn, startHarness, TEST_PASSWORD, type Harness, type TestUser } from './harness.js';

let h: Harness, owner: pg.Pool, patient: TestUser, caregiver: TestUser, nurse: TestUser;
const DAY = '2026-09-19';
const NOW = new Date('2026-09-18T22:16:00Z'); // 01:16 next day in Riyadh.
async function read(user: TestUser, url: string) {
  const res = await h.app.inject({ url, headers: authHeaders(user) });
  expect(res.statusCode, res.body).toBe(200); return res.json();
}
async function post(user: TestUser, url: string, payload: object) {
  const res = await h.app.inject({ method:'POST', url, headers:authHeaders(user), payload });
  expect(res.statusCode, res.body).toBe(200); return res.json();
}
async function invite(user: TestUser, role: 'caregiver'|'nurse') {
  const email = `fixture-${user.phone.replace(/\D/g,'')}@example.test`;
  return post(patient,'/v1/caregivers/invite',{patientProfileId:patient.profileId,invitedName:role,invitedEmail:email,
    role,permissions:CAREGIVER_ROLE_PRESETS[role === 'nurse' ? 'nurse' : 'family'],escalationPriority:role==='nurse'?2:1});
}
async function medication(name: string, times = ['01:15','08:00']) {
  return post(patient,'/v1/medications',{patientProfileId:patient.profileId,name,form:'tablet',notes:'ملاحظة الدواء التجريبية',startDate:DAY,
    schedule:{rule:{kind:'fixed_times',times},doseQuantity:1,doseUnit:'tablet',startDate:DAY},
    stock:{trackingEnabled:true,initialQuantity:30,unit:'tablet'}});
}
beforeAll(async()=>{
  resetDatabase();h=await startHarness();h.setNow(NOW);
  owner=new pg.Pool({connectionString:'postgres://postgres:postgres@127.0.0.1:5433/dawaee_test'});
  patient=await signIn(h,'+966500098891');
  caregiver=await signIn(h,'+966500098892',undefined,{verifiedPhone:false});
  nurse=await signIn(h,'+966500098893',undefined,{verifiedPhone:false});
});
afterAll(async()=>{await owner?.end();await h?.close();});

describe('reported patient, caregiver and nurse journeys through HTTP and PostgreSQL',()=>{
  it('logs into the same user by phone, Arabic phone digits and email',async()=>{
    for(const identifier of [patient.phone,'٠٥٠٠٠٩٨٨٩١',`fixture-${patient.phone.replace(/\D/g,'')}@example.test`]) {
      const login=await h.app.inject({method:'POST',url:'/v1/auth/login',remoteAddress:'10.88.1.2',payload:{identifier,password:TEST_PASSWORD,deviceId:`journey-${identifier}`}});
      expect(login.statusCode,login.body).toBe(200);
      const me=await h.app.inject({url:'/v1/me',headers:{authorization:`Bearer ${login.json().accessToken}`}});
      expect(me.json().user.id).toBe(patient.userId);
    }
  });
  it('accepts email invitations by link and from a new-tab inbox, shows patient to caregivers but never the reverse',async()=>{
    const a=await invite(caregiver,'caregiver'),b=await invite(nurse,'nurse');
    const fragment=new URL(a.invitationLink).hash.slice(1);
    const token=fragment.startsWith('/invite/')?fragment.slice('/invite/'.length):fragment;
    const wrong=await h.app.inject({method:'POST',url:'/v1/caregivers/accept',headers:authHeaders(nurse),payload:{token}});
    expect(wrong.statusCode).toBe(404);
    await post(caregiver,'/v1/caregivers/accept',{token});
    const pending=await read(nurse,'/v1/caregivers/incoming');
    expect(pending.invitations.map((r:any)=>r.id)).toContain(b.relationshipId);
    for(let i=0;i<2;i++) await post(nurse,'/v1/caregivers/incoming/accept',{relationshipId:b.relationshipId});
    for(const helper of [caregiver,nurse]) expect((await read(helper,'/v1/profiles')).profiles).toContainEqual(expect.objectContaining({id:patient.profileId,role:'caregiver'}));
    const own=await read(patient,'/v1/profiles');
    expect(own.profiles.map((r:any)=>r.id)).not.toContain(caregiver.profileId);
    expect(own.profiles.map((r:any)=>r.id)).not.toContain(nurse.profileId);
  });
  it('shows a new medication immediately, shares its note and records a taken dose with its separate note after Saudi midnight',async()=>{
    const med=await medication('Synthetic new medicine');
    const today=await read(patient,`/v1/today?profileId=${patient.profileId}`);
    expect(today.localDate).toBe(DAY);
    const dose=today.today.find((d:any)=>d.medicationId===med.medication.id&&d.scheduledLocalTime==='01:15');
    expect(dose.medication.notes).toBe('ملاحظة الدواء التجريبية');
    await post(nurse,`/v1/doses/${dose.id}/taken`,{clientEventId:randomUUID(),method:'caregiver',takenAt:NOW.toISOString()});
    const note=await post(nurse,'/v1/notes',{profileId:patient.profileId,doseOccurrenceId:dose.id,text:'ملاحظة الجرعة بعد التأكيد'});
    await owner.query('UPDATE symptom_notes SET recorded_at=$1 WHERE id=$2',[NOW,note.note.id]);
    for(const viewer of [patient,caregiver,nurse]){
      const recorded=await read(viewer,`/v1/doses?profileId=${patient.profileId}&medicationId=${med.medication.id}&from=${DAY}&to=${DAY}&recorded=true&limit=20`);
      expect(recorded.doses).toHaveLength(1);
      expect(recorded.doses[0]).toMatchObject({id:dose.id,status:'taken',medication:{notes:'ملاحظة الدواء التجريبية'},notes:[expect.objectContaining({text:'ملاحظة الجرعة بعد التأكيد'})]});
      const notes=await read(viewer,`/v1/notes?profileId=${patient.profileId}&from=${DAY}&to=${DAY}`);
      expect(notes.notes).toContainEqual(expect.objectContaining({id:note.note.id}));
      const refreshed=await read(viewer,`/v1/today?profileId=${patient.profileId}`);
      expect(refreshed.today.find((d:any)=>d.id===dose.id).status).toBe('taken');
    }
    const stock=await read(patient,`/v1/medications/${med.medication.id}/stock`);
    expect(stock.stock.remainingQuantity).toBe(29);
  });
  it('queues reminders for newly created medications, not only preexisting doses',async()=>{
    const med=await medication('Synthetic newly scheduled reminder',['01:16']);
    const client=await h.worker.pool.connect();
    try{await client.query('BEGIN');await reminderJob(h.worker,client);await client.query('COMMIT');}finally{client.release();}
    const rows=await owner.query('SELECT id FROM notification_deliveries WHERE medication_id=$1 AND recipient_user_id=$2',[med.medication.id,patient.userId]);
    expect(rows.rowCount).toBeGreaterThan(0);
    const today=await read(patient,`/v1/today?profileId=${patient.profileId}`);
    expect(today.today.some((d:any)=>d.medicationId===med.medication.id)).toBe(true);
  });
  it('does not expose dose notes to a helper without history permission and revocation blocks further reads',async()=>{
    const circle=await read(patient,`/v1/care-circle?profileId=${patient.profileId}`);
    const rel=circle.caregivers.find((r:any)=>r.name==='caregiver');
    const changed=await h.app.inject({method:'PATCH',url:`/v1/caregivers/${rel.id}/permissions`,headers:authHeaders(patient),payload:{permissions:['view_medications','view_schedule','confirm_dose']}});
    expect(changed.statusCode,changed.body).toBe(200);
    const today=await read(caregiver,`/v1/today?profileId=${patient.profileId}`);
    expect(today.today.every((d:any)=>d.notes.length===0)).toBe(true);
    const removed=await h.app.inject({method:'DELETE',url:`/v1/caregivers/${rel.id}`,headers:authHeaders(patient)});
    expect(removed.statusCode,removed.body).toBe(200);
    expect((await h.app.inject({url:`/v1/today?profileId=${patient.profileId}`,headers:authHeaders(caregiver)})).statusCode).toBe(404);
  });
});
