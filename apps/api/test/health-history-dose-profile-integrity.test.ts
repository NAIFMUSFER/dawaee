import { reviewAndAcceptInvitation } from './reviewed-invitation-fixture.js';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  authHeaders, PANADOL, resetDatabase, signIn, startHarness,
  type Harness, type TestUser,
} from './harness.js';

let h: Harness;
let owner: pg.Pool;
let alice: TestUser;
let bob: TestUser;
let aliceDoseId: string;
let bobDoseId: string;

async function seedDose(user: TestUser): Promise<string> {
  const created = await h.app.inject({
    method: 'POST', url: '/v1/medications', headers: authHeaders(user),
    payload: {
      patientProfileId: user.profileId,
      ...PANADOL,
      name: `Dose reference guard ${Math.random().toString(36).slice(2)}`,
      startDate: '2026-09-01',
      schedule: {
        rule: { kind: 'fixed_times', times: ['08:00'] },
        doseQuantity: 1, doseUnit: 'tablet', startDate: '2026-09-01',
      },
    },
  });
  expect(created.statusCode, created.body).toBe(200);

  const doses = await h.app.inject({
    method: 'GET',
    url: `/v1/doses?profileId=${user.profileId}&from=2026-09-01&to=2026-09-30`,
    headers: authHeaders(user),
  });
  expect(doses.statusCode, doses.body).toBe(200);
  const doseId = doses.json<{ doses: Array<{ id: string }> }>().doses[0]?.id;
  expect(doseId).toBeTruthy();
  return doseId!;
}

beforeAll(async () => {
  resetDatabase();
  h = await startHarness();
  owner = new pg.Pool({ connectionString: 'postgres://postgres:postgres@127.0.0.1:5433/dawaee_test' });
  alice = await signIn(h, '+966500096871');
  bob = await signIn(h, '+966500096872');
  aliceDoseId = await seedDose(alice);
  bobDoseId = await seedDose(bob);
});

afterAll(async () => {
  await owner.end();
  await h.close();
});

describe('patient-history dose references stay inside one patient profile', () => {
  it('filters notes by the exact dose and denies the reverse patient-to-caregiver relationship', async () => {
    const invite=await h.app.inject({method:'POST',url:'/v1/caregivers/invite',headers:authHeaders(alice),payload:{patientProfileId:alice.profileId,invitedName:'Caregiver',invitedPhone:bob.phone,role:'caregiver',permissions:['view_schedule','view_medications','view_history','confirm_dose'],escalationPriority:1}});
    expect(invite.statusCode,invite.body).toBe(200);
    const token=invite.json().invitationLink.split('/invite/')[1];
    const accepted=await reviewAndAcceptInvitation(options => h.app.inject(options), {method:'POST',url: '/v1/caregivers/invitations/preview',headers:authHeaders(bob),payload:{token}});
    expect(accepted.statusCode,accepted.body).toBe(200);
    const note=await h.app.inject({method:'POST',url:'/v1/notes',headers:authHeaders(bob),payload:{profileId:alice.profileId,doseOccurrenceId:aliceDoseId,text:'Caregiver note for this dose'}});
    expect(note.statusCode,note.body).toBe(200);
    const list=await h.app.inject({url:`/v1/notes?profileId=${alice.profileId}&doseOccurrenceId=${aliceDoseId}`,headers:authHeaders(alice)});
    expect(list.statusCode,list.body).toBe(200);
    expect(list.json().notes).toContainEqual(expect.objectContaining({id:note.json().note.id,doseOccurrenceId:aliceDoseId,text:'Caregiver note for this dose'}));
    const caregiverRead=await h.app.inject({url:`/v1/notes?profileId=${alice.profileId}&doseOccurrenceId=${aliceDoseId}`,headers:authHeaders(bob)});
    expect(caregiverRead.statusCode).toBe(200);
    const patientProfiles=await h.app.inject({url:'/v1/profiles',headers:authHeaders(alice)});
    expect(patientProfiles.json().profiles.map((p:{id:string})=>p.id)).not.toContain(bob.profileId);
    const reverse=await h.app.inject({url:`/v1/notes?profileId=${bob.profileId}&doseOccurrenceId=${bobDoseId}`,headers:authHeaders(alice)});
    expect(reverse.statusCode).toBe(404);
    const mismatched=await h.app.inject({url:`/v1/notes?profileId=${alice.profileId}&doseOccurrenceId=${bobDoseId}`,headers:authHeaders(bob)});
    expect(mismatched.statusCode).toBe(404);
    const revoked=await h.app.inject({method:'DELETE',url:`/v1/caregivers/${accepted.json().relationshipId}`,headers:authHeaders(alice)});
    expect(revoked.statusCode,revoked.body).toBe(200);
    expect((await h.app.inject({url:`/v1/notes?profileId=${alice.profileId}`,headers:authHeaders(bob)})).statusCode).toBe(404);
  });
  it('rejects a symptom note linked to another patient dose at the database boundary', async () => {
    await expect(owner.query(
      `INSERT INTO symptom_notes
         (patient_profile_id, dose_occurrence_id, text, created_by)
       VALUES ($1, $2, 'cross-profile note', $3)`,
      [alice.profileId, bobDoseId, alice.userId],
    )).rejects.toMatchObject({ code: '23514', constraint: 'symptom_note_dose_profile_match' });
  });

  it('rejects a health measurement linked to another patient dose at the database boundary', async () => {
    await expect(owner.query(
      `INSERT INTO health_measurements
         (patient_profile_id, dose_occurrence_id, type, value_primary, unit, created_by)
       VALUES ($1, $2, 'weight', 70, 'kg', $3)`,
      [alice.profileId, bobDoseId, alice.userId],
    )).rejects.toMatchObject({ code: '23514', constraint: 'measurement_dose_profile_match' });
  });

  it('rejects a dose event linked to another patient dose at the database boundary', async () => {
    await expect(owner.query(
      `INSERT INTO dose_events
         (dose_occurrence_id, patient_profile_id, type, metadata)
       VALUES ($1, $2, 'notified', '{}'::jsonb)`,
      [bobDoseId, alice.profileId],
    )).rejects.toMatchObject({ code: '23514', constraint: 'dose_event_profile_match' });
  });

  it('still accepts same-profile dose references and null references', async () => {
    const note = await owner.query<{ id: string }>(
      `INSERT INTO symptom_notes
         (patient_profile_id, dose_occurrence_id, text, created_by)
       VALUES ($1, $2, 'same-profile note', $3) RETURNING id`,
      [alice.profileId, aliceDoseId, alice.userId],
    );
    expect(note.rowCount).toBe(1);

    const measurement = await owner.query<{ id: string }>(
      `INSERT INTO health_measurements
         (patient_profile_id, dose_occurrence_id, type, value_primary, unit, created_by)
       VALUES ($1, NULL, 'weight', 70, 'kg', $2) RETURNING id`,
      [alice.profileId, alice.userId],
    );
    expect(measurement.rowCount).toBe(1);

    const event = await owner.query<{ id: string }>(
      `INSERT INTO dose_events
         (dose_occurrence_id, patient_profile_id, type, metadata)
       VALUES ($1, $2, 'notified', '{}'::jsonb) RETURNING id::text`,
      [aliceDoseId, alice.profileId],
    );
    expect(event.rowCount).toBe(1);
  });
});
