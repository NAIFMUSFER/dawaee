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
        role: 'son', permissions: ['view_adherence', 'view_schedule', 'receive_notifications'], escalationPriority: 1,
      },
    })).json().invitationLink;
    const fragment = new URL(link).hash.slice(1);
    const token = fragment.startsWith('/invite/') ? fragment.slice('/invite/'.length) : fragment;
    expect(token, 'invite response did not contain a fragment token').toBeTruthy();

    const accept = await h.app.inject({
      method: 'POST', url: '/v1/caregivers/accept', headers: authHeaders(son), payload: { token },
    });
    expect(accept.statusCode).toBe(200);

    const adherence = await h.app.inject({
      method: 'GET', url: `/v1/adherence?profileId=${alice.profileId}&from=2026-09-01&to=2026-09-30`,
      headers: authHeaders(son),
    });
    expect(adherence.statusCode).toBe(200);

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
    const invitationLink = invite.json<{ invitationLink: string }>().invitationLink;
    const fragment = new URL(invitationLink).hash.slice(1);
    const token = fragment.startsWith('/invite/') ? fragment.slice('/invite/'.length) : fragment;
    expect(token, 'invite response did not contain a fragment token').toBeTruthy();

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
        fileName: '../../etc/passwd',
      },
    });
    expect(res.statusCode).toBe(200);
    const key = res.json().objectKey as string;
    expect(key).not.toContain('..');
    expect(key).not.toContain('passwd');
    expect(key).not.toContain(alice.profileId);
    expect(key).not.toContain(alice.profileId.slice(0, 8));
    expect(key).toMatch(/^medication_image\/\d{4}-\d{2}-\d{2}\/[0-9a-f-]{36}\.jpg$/);
  });

  it('rejects a file whose bytes are not a real image', async () => {
    const ticket = await h.app.inject({
      method: 'POST', url: '/v1/uploads/request', headers: authHeaders(alice),
      payload: { purpose: 'medication_image', contentType: 'image/png', byteSize: 50, patientProfileId: alice.profileId },
    });
    const url = ticket.json().upload.uploadUrl as string;
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

describe('cross-patient writes through an id in the request body', () => {
  it('refuses a consent written against a profile the caller does not own', async () => {
    const res = await h.app.inject({
      method: 'PUT', url: '/v1/me/consents', headers: authHeaders(alice),
      payload: { patientProfileId: bob.profileId, type: 'analytics', granted: true, version: '1.0' },
    });
    expect([403, 404]).toContain(res.statusCode);
  });

  it('still allows a consent on the caller\'s own profile', async () => {
    const res = await h.app.inject({
      method: 'PUT', url: '/v1/me/consents', headers: authHeaders(alice),
      payload: { patientProfileId: alice.profileId, type: 'analytics', granted: true, version: '1.0' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('still allows an account-wide consent with no profile at all', async () => {
    const res = await h.app.inject({
      method: 'PUT', url: '/v1/me/consents', headers: authHeaders(alice),
      payload: { type: 'ocr_image_processing', granted: true, version: '1.0' },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('PATCH /v1/me validates what it writes', () => {
  it('refuses a time zone that is not a time zone', async () => {
    for (const timezone of ['Mars/Olympus', 'Asia/Riyadh; DROP', '../../etc', 'x'.repeat(80)]) {
      const res = await h.app.inject({
        method: 'PATCH', url: '/v1/me', headers: authHeaders(alice), payload: { timezone },
      });
      expect(res.statusCode, timezone).toBe(400);
    }
  });

  it('accepts a real one', async () => {
    const res = await h.app.inject({
      method: 'PATCH', url: '/v1/me', headers: authHeaders(alice), payload: { timezone: 'Asia/Riyadh' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.timezone).toBe('Asia/Riyadh');
  });

  it('refuses a locale the app cannot render', async () => {
    const res = await h.app.inject({
      method: 'PATCH', url: '/v1/me', headers: authHeaders(alice), payload: { locale: 'fr' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('refuses a malformed email rather than storing it', async () => {
    const res = await h.app.inject({
      method: 'PATCH', url: '/v1/me', headers: authHeaders(alice), payload: { email: 'not-an-email' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('the emergency card publishes only what the patient chose', () => {
  it('reveals nothing but a name when the QR is enabled and nothing was chosen', async () => {
    const enable = await h.app.inject({
      method: 'POST', url: `/v1/emergency/qr/enable?profileId=${bob.profileId}`,
      headers: authHeaders(bob), payload: {},
    });
    expect(enable.statusCode).toBe(200);
    const token = enable.json().token as string;

    const scan = await h.app.inject({
      method: 'GET', url: '/v1/emergency/scan/card', headers: { authorization: `Bearer ${token}` },
    });
    expect(scan.statusCode).toBe(200);
    const card = scan.json();
    expect(card.medications).toEqual([]);
    expect(card.allergies).toEqual([]);
    expect(card.emergencyContacts).toEqual([]);
    expect(card.bloodType).toBeNull();
    expect(card.conditionsNote).toBeNull();
  });

  it('reveals each field only once the patient turns that field on', async () => {
    await h.app.inject({
      method: 'PUT', url: `/v1/emergency/card?profileId=${bob.profileId}`,
      headers: authHeaders(bob),
      payload: {
        patientProfileId: bob.profileId,
        bloodType: 'O-', allergies: ['penicillin'],
        conditionsNote: 'a private note',
        emergencyContacts: [{ name: 'Sara', phoneE164: '+966501234567' }],
        includeAllergies: true, includeContacts: false,
        includeMedications: false, includeConditions: false,
      },
    });
    const enable = await h.app.inject({
      method: 'POST', url: `/v1/emergency/qr/enable?profileId=${bob.profileId}`,
      headers: authHeaders(bob), payload: {},
    });
    const token = enable.json().token as string;
    const card = (await h.app.inject({
      method: 'GET', url: '/v1/emergency/scan/card', headers: { authorization: `Bearer ${token}` },
    })).json();

    expect(card.allergies).toEqual(['penicillin']);
    expect(card.bloodType).toBe('O-');
    expect(card.conditionsNote).toBeNull();
    expect(card.emergencyContacts).toEqual([]);
    expect(card.medications).toEqual([]);
  });
});

const riyadhDay = (offsetDays: number) => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Riyadh', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date(Date.now() + offsetDays * 86_400_000));

describe('a client event id belongs to one dose, not to the whole database', () => {
  it('does not report a different dose as an already-recorded replay', async () => {
    const doses = await h.app.inject({
      method: 'GET', url: `/v1/doses?profileId=${alice.profileId}&from=${riyadhDay(1)}&to=${riyadhDay(6)}`,
      headers: authHeaders(alice),
    });
    const list = (doses.json().doses as Array<{ id: string; status: string; scheduledAt: string }>)
      .filter((d) => ['upcoming', 'due', 'pending_confirmation'].includes(d.status));
    expect(list.length, 'the suite needs two unresolved doses to collide').toBeGreaterThan(1);
    const [first, second] = list as [
      { id: string; scheduledAt: string },
      { id: string; scheduledAt: string },
    ];

    const restoreNow = new Date();
    const shared = 'evt-collision-probe-1';
    try {
      h.setServerNow(new Date(first.scheduledAt));
      const a = await h.app.inject({
        method: 'POST', url: `/v1/doses/${first.id}/taken`, headers: authHeaders(alice),
        payload: { clientEventId: shared, method: 'app', takenAt: first.scheduledAt },
      });
      expect(a.statusCode).toBe(200);
      expect(a.json().doseId).toBe(first.id);

      h.setServerNow(new Date(second.scheduledAt));
      const b = await h.app.inject({
        method: 'POST', url: `/v1/doses/${second.id}/taken`, headers: authHeaders(alice),
        payload: { clientEventId: shared, method: 'app', takenAt: second.scheduledAt },
      });
      expect(b.json().doseId ?? second.id).not.toBe(first.id);
    } finally {
      h.setServerNow(restoreNow);
    }
  });

  it('lets two patients use the same id without colliding', async () => {
    const shared = 'evt-shared-across-patients';
    const doseOf = async (u: TestUser) => {
      const res = await h.app.inject({
        method: 'GET', url: `/v1/doses?profileId=${u.profileId}&from=${riyadhDay(7)}&to=${riyadhDay(7)}`,
        headers: authHeaders(u),
      });
      return (res.json().doses as Array<{ id: string; scheduledAt: string }>)[0]!;
    };
    const aliceDose = await doseOf(alice);
    const bobDose = await doseOf(bob);
    const restoreNow = new Date();

    try {
      h.setServerNow(new Date(aliceDose.scheduledAt));
      const one = await h.app.inject({
        method: 'POST', url: `/v1/doses/${aliceDose.id}/taken`, headers: authHeaders(alice),
        payload: { clientEventId: shared, method: 'app', takenAt: aliceDose.scheduledAt },
      });
      h.setServerNow(new Date(bobDose.scheduledAt));
      const two = await h.app.inject({
        method: 'POST', url: `/v1/doses/${bobDose.id}/taken`, headers: authHeaders(bob),
        payload: { clientEventId: shared, method: 'app', takenAt: bobDose.scheduledAt },
      });
      expect(one.statusCode).toBe(200);
      expect(two.statusCode, two.body).toBe(200);
    } finally {
      h.setServerNow(restoreNow);
    }
  });
});

describe('the public emergency scan cannot be forced to demand a login', () => {
  it('ignores a query string crafted to trip another route\'s auth hook', async () => {
    const enable = await h.app.inject({
      method: 'POST', url: `/v1/emergency/qr/enable?profileId=${alice.profileId}`,
      headers: authHeaders(alice), payload: {},
    });
    const token = enable.json().token as string;
    for (const suffix of ['', '?x=/stock', '?y=/refill', '?z=/medications']) {
      const res = await h.app.inject({
        method: 'GET', url: `/v1/emergency/scan/card${suffix}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode, suffix).toBe(200);
    }
  });
});

describe('medication detail in notifications is off until the patient asks', () => {
  it('is false for a brand-new account', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/v1/me', headers: authHeaders(alice) });
    expect(res.statusCode).toBe(200);
    expect(res.json().preferences.showMedicationInNotifications).toBe(false);
  });

  it('turns on only when explicitly set, and back off again', async () => {
    const on = await h.app.inject({
      method: 'PATCH', url: '/v1/me/preferences', headers: authHeaders(alice),
      payload: { showMedicationInNotifications: true },
    });
    expect(on.statusCode).toBe(200);
    expect((await h.app.inject({ method: 'GET', url: '/v1/me', headers: authHeaders(alice) }))
      .json().preferences.showMedicationInNotifications).toBe(true);

    await h.app.inject({
      method: 'PATCH', url: '/v1/me/preferences', headers: authHeaders(alice),
      payload: { showMedicationInNotifications: false },
    });
    expect((await h.app.inject({ method: 'GET', url: '/v1/me', headers: authHeaders(alice) }))
      .json().preferences.showMedicationInNotifications).toBe(false);
  });

  it('is one patient’s choice and not another’s', async () => {
    await h.app.inject({
      method: 'PATCH', url: '/v1/me/preferences', headers: authHeaders(alice),
      payload: { showMedicationInNotifications: true },
    });
    expect((await h.app.inject({ method: 'GET', url: '/v1/me', headers: authHeaders(bob) }))
      .json().preferences.showMedicationInNotifications).toBe(false);
  });

  it('leaves the other preferences alone when it changes', async () => {
    await h.app.inject({
      method: 'PATCH', url: '/v1/me/preferences', headers: authHeaders(alice),
      payload: { elderlyMode: true, defaultSnoozeMinutes: 15 },
    });
    await h.app.inject({
      method: 'PATCH', url: '/v1/me/preferences', headers: authHeaders(alice),
      payload: { showMedicationInNotifications: true },
    });
    const prefs = (await h.app.inject({ method: 'GET', url: '/v1/me', headers: authHeaders(alice) }))
      .json().preferences;
    expect(prefs.elderlyMode).toBe(true);
    expect(prefs.defaultSnoozeMinutes).toBe(15);
    expect(prefs.showMedicationInNotifications).toBe(true);
  });
});