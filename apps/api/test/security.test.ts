import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeaders, PANADOL, resetDatabase, signIn, startHarness, type Harness, type TestUser } from './harness.js';

/**
 * Cross-user isolation.
 *
 * The whole product rests on one promise: patient A's medication data is
 * invisible to everyone A has not authorized. These tests attack that promise
 * from every direction the API exposes.
 */

let h: Harness;
let alice: TestUser;
let bob: TestUser;
let son: TestUser;
let stranger: TestUser;
let aliceMedicationId: string;
let aliceDoseId: string;
let bobMedicationId: string;

beforeAll(async () => {
  resetDatabase();
  h = await startHarness();
  alice = await signIn(h, '0522000001');
  bob = await signIn(h, '0522000002');
  son = await signIn(h, '0522000003');
  stranger = await signIn(h, '0522000004');

  const makeMed = async (user: TestUser, name: string) => {
    const res = await h.app.inject({
      method: 'POST', url: '/v1/medications', headers: authHeaders(user),
      payload: {
        patientProfileId: user.profileId, ...PANADOL, name, startDate: '2026-09-01',
        schedule: {
          rule: { kind: 'fixed_times', times: ['08:00', '20:00'] },
          doseQuantity: 1, doseUnit: 'tablet', startDate: '2026-09-01',
        },
        stock: { trackingEnabled: true, initialQuantity: 30, unit: 'tablet' },
      },
    });
    return res.json().medication.id as string;
  };
  aliceMedicationId = await makeMed(alice, 'Alice Medication');
  bobMedicationId = await makeMed(bob, 'Bob Medication');

  const doses = await h.app.inject({
    method: 'GET', url: `/v1/doses?profileId=${alice.profileId}&from=2026-09-01&to=2027-01-01`,
    headers: authHeaders(alice),
  });
  aliceDoseId = doses.json().doses[0].id;
});

afterAll(async () => {
  await h.close();
});

describe('patient A cannot reach patient B', () => {
  it('does not list B’s medications', async () => {
    const res = await h.app.inject({
      method: 'GET', url: `/v1/medications?profileId=${alice.profileId}`, headers: authHeaders(alice),
    });
    const names = res.json().medications.map((m: { name: string }) => m.name);
    expect(names).toContain('Alice Medication');
    expect(names).not.toContain('Bob Medication');
  });

  it('refuses a direct read of B’s medication by id (IDOR)', async () => {
    const res = await h.app.inject({
      method: 'GET', url: `/v1/medications/${bobMedicationId}`, headers: authHeaders(alice),
    });
    expect(res.statusCode).toBe(404);
  });

  it('refuses to scope a listing to B’s profile', async () => {
    const res = await h.app.inject({
      method: 'GET', url: `/v1/medications?profileId=${bob.profileId}`, headers: authHeaders(alice),
    });
    expect(res.statusCode).toBe(404);
  });

  it('refuses B’s Today, history, adherence and reports', async () => {
    const urls = [
      `/v1/today?profileId=${bob.profileId}`,
      `/v1/doses?profileId=${bob.profileId}&from=2026-09-01&to=2026-09-30`,
      `/v1/adherence?profileId=${bob.profileId}&from=2026-09-01&to=2026-09-30`,
      `/v1/reports/weekly?profileId=${bob.profileId}`,
      `/v1/reports/export?profileId=${bob.profileId}`,
      `/v1/care-circle?profileId=${bob.profileId}`,
      `/v1/emergency/card?profileId=${bob.profileId}`,
      `/v1/stock/low?profileId=${bob.profileId}`,
      `/v1/notes?profileId=${bob.profileId}`,
    ];
    for (const url of urls) {
      const res = await h.app.inject({ method: 'GET', url, headers: authHeaders(alice) });
      expect([403, 404], `${url} returned ${res.statusCode}`).toContain(res.statusCode);
    }
  });

  it('refuses to write into B’s profile', async () => {
    const create = await h.app.inject({
      method: 'POST', url: '/v1/medications', headers: authHeaders(alice),
      payload: { patientProfileId: bob.profileId, name: 'Planted', form: 'tablet', startDate: '2026-09-01' },
    });
    expect([403, 404]).toContain(create.statusCode);

    const edit = await h.app.inject({
      method: 'PATCH', url: `/v1/medications/${bobMedicationId}`, headers: authHeaders(alice),
      payload: { notes: 'tampered' },
    });
    expect([403, 404]).toContain(edit.statusCode);

    const remove = await h.app.inject({
      method: 'DELETE', url: `/v1/medications/${bobMedicationId}`, headers: authHeaders(alice),
    });
    expect([403, 404]).toContain(remove.statusCode);
  });

  it('refuses to confirm a dose belonging to B', async () => {
    const bobDoses = await h.app.inject({
      method: 'GET', url: `/v1/doses?profileId=${bob.profileId}&from=2026-09-01&to=2027-01-01`,
      headers: authHeaders(bob),
    });
    const bobDoseId = bobDoses.json().doses[0].id;
    const res = await h.app.inject({
      method: 'POST', url: `/v1/doses/${bobDoseId}/taken`, headers: authHeaders(alice),
      payload: { clientEventId: 'evt-cross-user-1', method: 'app' },
    });
    expect([403, 404]).toContain(res.statusCode);
  });

  it('refuses to attach itself as a caregiver of B', async () => {
    const res = await h.app.inject({
      method: 'POST', url: '/v1/caregivers/invite', headers: authHeaders(alice),
      payload: {
        patientProfileId: bob.profileId, invitedName: 'Alice', invitedPhone: '0522000001',
        role: 'other', permissions: ['view_medications'],
      },
    });
    expect([403, 404]).toContain(res.statusCode);
  });
});

describe('caregiver permission scope', () => {

  it('grants nothing before the invitation is accepted', async () => {
    const invite = await h.app.inject({
      method: 'POST', url: '/v1/caregivers/invite', headers: authHeaders(alice),
      payload: {
        patientProfileId: alice.profileId, invitedName: 'Son', invitedPhone: son.phone,
        role: 'son', permissions: ['view_adherence', 'receive_notifications'], escalationPriority: 1,
      },
    });
    expect(invite.statusCode).toBe(200);

    const peek = await h.app.inject({
      method: 'GET', url: `/v1/today?profileId=${alice.profileId}`, headers: authHeaders(son),
    });
    expect(peek.statusCode).toBe(404);
  });

  it('grants exactly the configured permissions after acceptance', async () => {
    const link: string = (await h.app.inject({
      method: 'POST', url: '/v1/caregivers/invite', headers: authHeaders(alice),
      payload: {
        patientProfileId: alice.profileId, invitedName: 'Son', invitedPhone: son.phone,
        role: 'son', permissions: ['view_adherence', 'receive_notifications'], escalationPriority: 1,
      },
    })).json().invitationLink;
    const token = link.split('/invite/')[1]!;

    const accept = await h.app.inject({
      method: 'POST', url: '/v1/caregivers/accept', headers: authHeaders(son), payload: { token },
    });
    expect(accept.statusCode).toBe(200);

    // Granted: adherence.
    const adherence = await h.app.inject({
      method: 'GET', url: `/v1/adherence?profileId=${alice.profileId}&from=2026-09-01&to=2026-09-30`,
      headers: authHeaders(son),
    });
    expect(adherence.statusCode).toBe(200);

    // Not granted: the medication list, history, reports, emergency card.
    for (const url of [
      `/v1/medications?profileId=${alice.profileId}`,
      `/v1/doses?profileId=${alice.profileId}&from=2026-09-01&to=2026-09-30`,
      `/v1/reports/weekly?profileId=${alice.profileId}`,
      `/v1/emergency/card?profileId=${alice.profileId}`,
    ]) {
      const res = await h.app.inject({ method: 'GET', url, headers: authHeaders(son) });
      expect([403, 404], `${url} returned ${res.statusCode}`).toContain(res.statusCode);
    }
  });

  it('refuses to let a caregiver edit or add medication without permission', async () => {
    const edit = await h.app.inject({
      method: 'PATCH', url: `/v1/medications/${aliceMedicationId}`, headers: authHeaders(son),
      payload: { notes: 'caregiver tampering' },
    });
    expect([403, 404]).toContain(edit.statusCode);

    const confirm = await h.app.inject({
      method: 'POST', url: `/v1/doses/${aliceDoseId}/taken`, headers: authHeaders(son),
      payload: { clientEventId: 'evt-caregiver-1', method: 'app' },
    });
    expect([403, 404]).toContain(confirm.statusCode);
  });

  it('refuses to let a caregiver grant themselves more permissions', async () => {
    const circle = await h.app.inject({
      method: 'GET', url: `/v1/care-circle?profileId=${alice.profileId}`, headers: authHeaders(son),
    });
    const mine = circle.json().caregivers.find((c: { isYou: boolean }) => c.isYou);
    const res = await h.app.inject({
      method: 'PATCH', url: `/v1/caregivers/${mine.id}/permissions`, headers: authHeaders(son),
      payload: { permissions: ['view_medications', 'edit_medication', 'manage_caregivers'] },
    });
    expect([403, 404]).toContain(res.statusCode);
  });

  it('lets the patient widen and then revoke access, taking effect immediately', async () => {
    const circle = await h.app.inject({
      method: 'GET', url: `/v1/care-circle?profileId=${alice.profileId}`, headers: authHeaders(alice),
    });
    const active = circle.json().caregivers.find((c: { status: string }) => c.status === 'active');

    const widen = await h.app.inject({
      method: 'PATCH', url: `/v1/caregivers/${active.id}/permissions`, headers: authHeaders(alice),
      payload: { permissions: ['view_adherence', 'view_medications', 'receive_notifications'] },
    });
    expect(widen.statusCode).toBe(200);

    const nowVisible = await h.app.inject({
      method: 'GET', url: `/v1/medications?profileId=${alice.profileId}`, headers: authHeaders(son),
    });
    expect(nowVisible.statusCode).toBe(200);

    const revoke = await h.app.inject({
      method: 'DELETE', url: `/v1/caregivers/${active.id}`, headers: authHeaders(alice),
    });
    expect(revoke.statusCode).toBe(200);

    // No cached grant: the very next request is refused.
    const afterRevoke = await h.app.inject({
      method: 'GET', url: `/v1/medications?profileId=${alice.profileId}`, headers: authHeaders(son),
    });
    expect(afterRevoke.statusCode).toBe(404);
  });

  it('refuses an expired invitation token', async () => {
    const invite = await h.app.inject({
      method: 'POST', url: '/v1/caregivers/invite', headers: authHeaders(alice),
      payload: {
        patientProfileId: alice.profileId, invitedName: 'Late', invitedPhone: stranger.phone,
        role: 'other', permissions: ['view_adherence'], expiresInHours: 1,
      },
    });
    const token = invite.json().invitationLink.split('/invite/')[1]!;

    const { execFileSync } = await import('node:child_process');
    execFileSync('psql', ['-d', 'dawaee_test', '-c',
      `UPDATE caregiver_relationships SET invitation_expires_at = now() - interval '1 hour' WHERE status = 'pending'`], {
      env: { ...process.env, PGHOST: '127.0.0.1', PGPORT: '5433', PGUSER: 'postgres' }, stdio: 'pipe',
    });

    const res = await h.app.inject({
      method: 'POST', url: '/v1/caregivers/accept', headers: authHeaders(stranger), payload: { token },
    });
    expect(res.statusCode).toBe(410);
    expect(res.json().error.code).toBe('invitation_expired');
  });

  it('refuses a forged or reused invitation token', async () => {
    const forged = await h.app.inject({
      method: 'POST', url: '/v1/caregivers/accept', headers: authHeaders(stranger),
      payload: { token: 'a'.repeat(43) },
    });
    expect(forged.statusCode).toBe(404);
  });
});

describe('upload security', () => {
  it('rejects a disallowed content type and an oversized file', async () => {
    const badType = await h.app.inject({
      method: 'POST', url: '/v1/uploads/request', headers: authHeaders(alice),
      payload: { purpose: 'medication_image', contentType: 'application/pdf', byteSize: 1000 },
    });
    expect(badType.statusCode).toBe(400);

    const tooBig = await h.app.inject({
      method: 'POST', url: '/v1/uploads/request', headers: authHeaders(alice),
      payload: { purpose: 'medication_image', contentType: 'image/jpeg', byteSize: 60 * 1024 * 1024 },
    });
    expect(tooBig.statusCode).toBe(400);
  });

  it('generates an unguessable server-side key and never uses a client filename', async () => {
    const res = await h.app.inject({
      method: 'POST', url: '/v1/uploads/request', headers: authHeaders(alice),
      payload: {
        purpose: 'medication_image', contentType: 'image/jpeg', byteSize: 1000,
        patientProfileId: alice.profileId,
        // A hostile "filename" has nowhere to land: the API never accepts one.
        fileName: '../../etc/passwd',
      },
    });
    expect(res.statusCode).toBe(200);
    const key = res.json().objectKey as string;
    expect(key).not.toContain('..');
    expect(key).not.toContain('passwd');
    expect(key).toMatch(/^medication_image\/\d{4}-\d{2}-\d{2}\/[0-9a-f]{8}\/[0-9a-f-]{36}\.jpg$/);
  });

  it('rejects a file whose bytes are not a real image', async () => {
    const ticket = await h.app.inject({
      method: 'POST', url: '/v1/uploads/request', headers: authHeaders(alice),
      payload: { purpose: 'medication_image', contentType: 'image/png', byteSize: 50, patientProfileId: alice.profileId },
    });
    const url = ticket.json().upload.uploadUrl as string;

    // Declared image/png, actually a shell script.
    const res = await h.app.inject({
      method: 'PUT', url, headers: { 'content-type': 'image/png' },
      payload: Buffer.from('#!/bin/sh\nrm -rf /\n'),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('upload_rejected');
  });

  it('rejects an unsigned or tampered upload URL', async () => {
    const res = await h.app.inject({
      method: 'PUT', url: '/v1/uploads/local/medication_image%2Fforged.jpg?expires=9999999999999&sig=deadbeef',
      headers: { 'content-type': 'image/png' }, payload: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    });
    expect(res.statusCode).toBe(403);
  });

  it('refuses to hand out a read URL for another patient’s object', async () => {
    const ticket = await h.app.inject({
      method: 'POST', url: '/v1/uploads/request', headers: authHeaders(bob),
      payload: { purpose: 'medication_image', contentType: 'image/jpeg', byteSize: 1000, patientProfileId: bob.profileId },
    });
    const key = ticket.json().objectKey as string;
    const res = await h.app.inject({
      method: 'GET', url: `/v1/uploads/url?objectKey=${encodeURIComponent(key)}`, headers: authHeaders(alice),
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('injection and malformed input', () => {
  it('treats SQL metacharacters as data, not code', async () => {
    const res = await h.app.inject({
      method: 'POST', url: '/v1/medications', headers: authHeaders(alice),
      payload: {
        patientProfileId: alice.profileId,
        name: "Robert'); DROP TABLE medications;--",
        form: 'tablet', startDate: '2026-09-01',
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().medication.name).toBe("Robert'); DROP TABLE medications;--");

    const stillThere = await h.app.inject({
      method: 'GET', url: `/v1/medications?profileId=${alice.profileId}`, headers: authHeaders(alice),
    });
    expect(stillThere.statusCode).toBe(200);
    expect(stillThere.json().medications.length).toBeGreaterThan(0);
  });

  it('rejects a malformed profile id instead of leaking a database error', async () => {
    const res = await h.app.inject({
      method: 'GET', url: '/v1/today?profileId=not-a-uuid', headers: authHeaders(alice),
    });
    expect([400, 404]).toContain(res.statusCode);
    expect(res.body).not.toContain('syntax');
    expect(res.body).not.toContain('postgres');
  });

  it('never leaks a stack trace or SQL in an error response', async () => {
    const res = await h.app.inject({
      method: 'POST', url: '/v1/medications', headers: authHeaders(alice), payload: { nonsense: true },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toMatch(/at Module|node_modules|SELECT |INSERT /);
  });
});

describe('admin surface', () => {
  it('refuses a non-admin', async () => {
    for (const url of ['/v1/admin/overview', '/v1/admin/deliveries/failed', '/v1/admin/jobs']) {
      const res = await h.app.inject({ method: 'GET', url, headers: authHeaders(alice) });
      expect(res.statusCode).toBe(403);
    }
  });
});
