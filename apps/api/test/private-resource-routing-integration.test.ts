import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeaders, PANADOL, resetDatabase, signIn, startHarness, type Harness, type TestUser } from './harness.js';
import {
  DEVICE_ID_HEADER, MEDICATION_ID_HEADER, SCHEDULE_ID_HEADER,
} from '../src/middleware/private-resource-routing.js';
import { PROFILE_ID_HEADER } from '../src/middleware/profile-routing.js';
import { resetClockSource, setClockSource } from '../src/lib/clock.js';
import { withUser } from '../src/lib/db.js';

let h: Harness;
let alice: TestUser;
let bob: TestUser;
let aliceMedicationId = '';
let bobMedicationId = '';
let aliceScheduleId = '';
let bobScheduleId = '';
const ALICE_DEVICE_ID = 'dev-private-routing-alice';

async function addMedication(user: TestUser): Promise<string> {
  const res = await h.app.inject({
    method: 'POST', url: '/v1/medications', headers: authHeaders(user),
    payload: { patientProfileId: user.profileId, ...PANADOL, startDate: '2026-09-01' },
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json<{ medication: { id: string } }>().medication.id;
}

async function addSchedule(user: TestUser, medicationId: string): Promise<string> {
  const res = await h.app.inject({
    method: 'POST', url: `/v1/medications/${medicationId}/schedules`, headers: authHeaders(user),
    payload: {
      rule: { kind: 'fixed_times', times: ['08:00'] },
      doseQuantity: 1,
      doseUnit: 'tablet',
      startDate: '2026-09-01',
    },
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json<{ schedule: { id: string } }>().schedule.id;
}

beforeAll(async () => {
  // Keep the 08:00 Riyadh occurrence inside the materializer's six-hour
  // backfill window and before the later schedule-deactivation assertion. The
  // scenario is about private routing/authorization, not wall-clock timing.
  setClockSource(() => new Date('2026-09-10T05:30:00.000Z'));
  resetDatabase();
  h = await startHarness();
  alice = await signIn(h, '+966500091101', ALICE_DEVICE_ID);
  bob = await signIn(h, '+966500091102');
  aliceMedicationId = await addMedication(alice);
  bobMedicationId = await addMedication(bob);
  aliceScheduleId = await addSchedule(alice, aliceMedicationId);
  bobScheduleId = await addSchedule(bob, bobMedicationId);
}, 120_000);

afterAll(async () => {
  try { await h.close(); } finally { resetClockSource(); }
});

describe('fixed public resource routing reaches the established authorization handlers', () => {
  it('reads the owner medication through a public path containing no medication id', async () => {
    const publicPath = '/v1/medication';
    expect(publicPath).not.toContain(aliceMedicationId);
    const res = await h.app.inject({
      method: 'GET', url: publicPath,
      headers: { ...authHeaders(alice), [MEDICATION_ID_HEADER]: aliceMedicationId },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<{ medication: { id: string } }>().medication.id).toBe(aliceMedicationId);
  });

  it('reuses the same protection for stock without exposing the id in the path', async () => {
    const res = await h.app.inject({
      method: 'GET', url: '/v1/medication/stock',
      headers: { ...authHeaders(alice), [MEDICATION_ID_HEADER]: aliceMedicationId },
    });
    expect(res.statusCode, res.body).toBe(200);
  });

  it('does not let a fixed path become a BOLA bypass', async () => {
    const res = await h.app.inject({
      method: 'GET', url: '/v1/medication',
      headers: { ...authHeaders(alice), [MEDICATION_ID_HEADER]: bobMedicationId },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.body).not.toContain(PANADOL.name);
  });

  it('still requires authentication after the internal rewrite', async () => {
    const res = await h.app.inject({
      method: 'GET', url: '/v1/medication', headers: { [MEDICATION_ID_HEADER]: aliceMedicationId },
    });
    expect(res.statusCode).toBe(401);
  });

  it('updates an owner schedule through a fixed path containing no schedule id', async () => {
    const publicPath = '/v1/schedule';
    expect(publicPath).not.toContain(aliceScheduleId);
    const res = await h.app.inject({
      method: 'PATCH', url: publicPath,
      headers: { ...authHeaders(alice), [SCHEDULE_ID_HEADER]: aliceScheduleId },
      payload: { active: false },
    });
    expect(res.statusCode, res.body).toBe(200);
  });

  it('preserves schedule cross-profile isolation after rewriting', async () => {
    const res = await h.app.inject({
      method: 'PATCH', url: '/v1/schedule',
      headers: { ...authHeaders(alice), [SCHEDULE_ID_HEADER]: bobScheduleId },
      payload: { active: false },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.body).not.toContain(bob.phone);
  });

  it('promotes private profile and medication filter headers for dose history', async () => {
    const res = await h.app.inject({
      method: 'GET', url: '/v1/doses?from=2026-09-01&to=2026-09-10',
      headers: {
        ...authHeaders(alice),
        [PROFILE_ID_HEADER]: alice.profileId,
        [MEDICATION_ID_HEADER]: aliceMedicationId,
      },
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json<{ doses: Array<{ medicationId: string }> }>();
    expect(body.doses.length).toBeGreaterThan(0);
    expect(body.doses.every((dose) => dose.medicationId === aliceMedicationId)).toBe(true);
  });

  it('reads the owner profile through the fixed profile path', async () => {
    const res = await h.app.inject({
      method: 'GET', url: '/v1/profile',
      headers: { ...authHeaders(alice), [PROFILE_ID_HEADER]: alice.profileId },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<{ profile: { id: string } }>().profile.id).toBe(alice.profileId);
  });

  it('preserves profile cross-account isolation after rewriting', async () => {
    const res = await h.app.inject({
      method: 'GET', url: '/v1/profile',
      headers: { ...authHeaders(alice), [PROFILE_ID_HEADER]: bob.profileId },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.body).not.toContain(bob.phone);
  });

  it('removes an owner push token through a fixed path containing no stable device id', async () => {
    const deviceId = ALICE_DEVICE_ID;
    const registration = await h.app.inject({
      method: 'POST', url: '/v1/devices/push-token', headers: authHeaders(alice),
      payload: { token: 'ExponentPushToken[private-routing-alice]', platform: 'ios', deviceId },
    });
    expect(registration.statusCode, registration.body).toBe(200);

    const publicPath = '/v1/devices/push-token';
    expect(publicPath).not.toContain(deviceId);
    const removal = await h.app.inject({
      method: 'DELETE', url: publicPath,
      headers: { ...authHeaders(alice), [DEVICE_ID_HEADER]: deviceId },
    });
    expect(removal.statusCode, removal.body).toBe(200);

    const active = await withUser(alice.userId, async (tx) => {
      const { rows } = await tx.query<{ active: boolean }>(
        'SELECT active FROM push_tokens WHERE user_id = $1 AND device_id = $2',
        [alice.userId, deviceId],
      );
      return rows[0]?.active;
    });
    expect(active).toBe(false);
  });
});
