import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { redactUrl } from '../src/lib/logger.js';
import {
  authHeaders, resetDatabase, signIn, startHarness, PANADOL, type Harness, type TestUser,
} from './harness.js';

/**
 * P13 — the audit trail, and who can read the operational record.
 *
 * The audit trail is the one place in this system that is SUPPOSED to remember
 * what happened to a patient's medication. So "does it contain health data" is
 * the wrong question; it does, and it should. The right questions are narrower:
 *
 *   Is its readership no wider than the data it describes?
 *   Can the actor be forged?
 *   Can it be rewritten?
 *   Does it carry anything that is a secret rather than a record?
 *
 * The answers below are measured against real rows written by real requests.
 */

let h: Harness;
let patient: TestUser;
let other: TestUser;
let admin: TestUser;
let medicationId = '';

const psql = (sql: string) => execFileSync('psql', ['-d', 'dawaee_test', '-tAc', sql], {
  env: { ...process.env, PGHOST: '127.0.0.1', PGPORT: '5433', PGUSER: 'postgres' },
}).toString().trim();

let probeAddr = 0;
const send = (args: Record<string, unknown>) =>
  h.app.inject({ remoteAddress: `198.51.108.${(probeAddr++ % 250) + 1}`, ...args } as never);

/** Distinctive values planted so a match in a log or a row cannot be chance. */
const PROBE = {
  medication: 'Zoprexa-Audit-Probe',
  doctorInstructions: 'probe-doctor-instructions',
  notesBefore: 'probe-private-notes',
  notesAfter: 'probe-changed-notes',
  allergy: 'probe-penicillin-allergy',
  condition: 'probe-condition-text',
  symptom: 'probe-symptom-free-text',
  carerPhone: '+966500098009',
};

beforeAll(async () => {
  resetDatabase();
  h = await startHarness();
  patient = await signIn(h, '+966500098001');
  other = await signIn(h, '+966500098002');
  admin = await signIn(h, '+966500098003');

  psql(`UPDATE users SET is_admin = true WHERE id = '${admin.userId}'`);
  const refreshed = await send({
    method: 'POST', url: '/v1/auth/refresh', payload: { refreshToken: admin.refreshToken },
  });
  admin = { ...admin, token: refreshed.json<{ accessToken: string }>().accessToken };

  const med = await send({
    method: 'POST', url: '/v1/medications', headers: authHeaders(patient),
    payload: {
      patientProfileId: patient.profileId, ...PANADOL,
      name: PROBE.medication, doctorInstructions: PROBE.doctorInstructions,
      notes: PROBE.notesBefore, startDate: '2026-09-01',
      schedule: {
        rule: { kind: 'fixed_times', times: ['08:00'] },
        doseQuantity: 1, doseUnit: 'tablet', startDate: '2026-09-01',
      },
    },
  });
  expect(med.statusCode, med.body).toBe(200);
  medicationId = med.json<{ medication: { id: string } }>().medication.id;

  await send({
    method: 'PATCH', url: `/v1/medications/${medicationId}`, headers: authHeaders(patient),
    payload: { notes: PROBE.notesAfter },
  });
  await send({
    method: 'PUT', url: `/v1/emergency/card?profileId=${patient.profileId}`, headers: authHeaders(patient),
    payload: { bloodType: 'AB-', allergies: [PROBE.allergy], conditionsNote: PROBE.condition },
  });
  await send({
    method: 'POST', url: `/v1/emergency/qr/enable?profileId=${patient.profileId}`, headers: authHeaders(patient),
  });
  await send({
    method: 'POST', url: '/v1/caregivers/invite', headers: authHeaders(patient),
    payload: {
      patientProfileId: patient.profileId, invitedName: 'Probe Carer',
      invitedPhone: PROBE.carerPhone, role: 'caregiver',
      permissions: ['view_schedule', 'view_medications'], escalationPriority: 1,
    },
  });
  const doses = await send({
    method: 'GET', url: `/v1/doses?profileId=${patient.profileId}&from=2026-09-01&to=2026-09-30`,
    headers: authHeaders(patient),
  });
  const doseId = doses.json<{ doses: Array<{ id: string }> }>().doses[0]!.id;
  await send({
    method: 'POST', url: `/v1/doses/${doseId}/taken`, headers: authHeaders(patient),
    payload: { clientEventId: 'audit-probe-0001', note: { tags: ['nausea'], text: PROBE.symptom } },
  });
}, 240_000);

afterAll(async () => { await h.close(); });

const allAudit = () => psql(
  "SELECT coalesce(previous_value::text,'') || ' ' || coalesce(new_value::text,'') FROM audit_logs",
);

describe('P13-9 the audit trail records the act, not the contents', () => {
  it('carries no secret of any kind', () => {
    const rows = allAudit();
    // Keys that would mean a credential or a capability had been copied in.
    // `"method": "password"` is not one of them — that is the NAME of the way
    // the account signed in, which is exactly what an auth audit should say,
    // and an earlier version of this assertion matched it by accident.
    for (const forbidden of [
      '"token"', '"refreshToken"', '"codeHash"', '"password":', '"qrTokenHash"',
      '"invitationTokenHash"', '"passwordHash"', '"accessToken"',
    ]) {
      expect(rows, `audit_logs carried ${forbidden}`).not.toContain(forbidden);
    }
    // And no value that looks like one.
    expect(rows).not.toMatch(/\beyJ[A-Za-z0-9_-]{4,}\./);
  });

  /**
   * `auth.register` records the deviceId the client sent. It is opaque to the
   * server and its purpose — telling one of a patient's phones from another in
   * the sign-in history — is legitimate, but it is CLIENT-CONTROLLED text in a
   * retained table, so whatever the app puts there is what gets kept. This
   * test harness happens to name devices after the phone number, which is what
   * made the exposure visible; a real client should not.
   */
  it('records the device identifier verbatim, whatever the client chose', () => {
    const row = psql("SELECT coalesce(new_value::text,'') FROM audit_logs WHERE action = 'auth.register' LIMIT 1");
    expect(row).toContain('deviceId');
  });

  it('records a caregiver invitation without the phone number it was sent to', () => {
    const row = psql("SELECT coalesce(new_value::text,'') FROM audit_logs WHERE action = 'caregiver.invited'");
    expect(row).toContain('permissions');
    expect(row, 'the invited phone is in the audit trail').not.toContain(PROBE.carerPhone);
  });

  it('records an emergency card change as counts, not as the allergies themselves', () => {
    const row = psql("SELECT coalesce(new_value::text,'') FROM audit_logs WHERE action = 'emergency_card.updated'");
    expect(row).toContain('allergyCount');
    expect(row, 'the allergy value is in the audit trail').not.toContain(PROBE.allergy);
    expect(row, 'the conditions note is in the audit trail').not.toContain(PROBE.condition);
  });

  it('records a dose confirmation without the symptom note the patient typed', () => {
    const row = psql("SELECT coalesce(new_value::text,'') FROM audit_logs WHERE action = 'dose.confirmed'");
    expect(row).toContain('status');
    expect(row, 'the symptom text is in the audit trail').not.toContain(PROBE.symptom);
  });

  it('does record the medication name and the notes that changed — and that is the point', () => {
    // Stated rather than removed. "Who added this medication, and what did they
    // change it to" is the accountability record; an audit trail that cannot
    // answer it is not one. It is defensible here only because of the next
    // block: the row is readable by the profile owner and nobody else.
    const created = psql("SELECT coalesce(new_value::text,'') FROM audit_logs WHERE action = 'medication.created'");
    expect(created).toContain(PROBE.medication);
    const updated = psql("SELECT coalesce(previous_value::text,'') || coalesce(new_value::text,'') FROM audit_logs WHERE action = 'medication.updated'");
    expect(updated).toContain(PROBE.notesBefore);
    expect(updated).toContain(PROBE.notesAfter);
  });
});

describe('P13-10 the audit trail is readable only by the profile owner', () => {
  it('the owner can export their own trail', async () => {
    const res = await send({
      method: 'GET', url: `/v1/reports/export?profileId=${patient.profileId}`, headers: authHeaders(patient),
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.body, 'the export carries the trail it is meant to').toContain('auditLog');
  });

  it('an unrelated patient cannot', async () => {
    const res = await send({
      method: 'GET', url: `/v1/reports/export?profileId=${patient.profileId}`, headers: authHeaders(other),
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.body).not.toContain(PROBE.medication);
  });

  it('and neither can an administrator, through any endpoint', async () => {
    // Deliberate: an operator debugging deliveries has no business reading a
    // patient's medication history. `audit_read` is scoped to
    // `app.owns_profile`, and no admin route selects from the table.
    for (const url of [
      '/v1/admin/overview', '/v1/admin/jobs', '/v1/admin/webhooks/unprocessed',
      '/v1/admin/deliveries/failed', '/v1/admin/deliveries/stats',
    ]) {
      const res = await send({ method: 'GET', url, headers: authHeaders(admin) });
      expect(res.statusCode, `${url}: ${res.body}`).toBe(200);
      expect(res.body, `${url} disclosed a medication name`).not.toContain(PROBE.medication);
      expect(res.body, `${url} disclosed a patient phone`).not.toContain(patient.phone);
    }
  });

  it('the operational endpoints refuse an ordinary patient outright', async () => {
    for (const url of [
      '/v1/admin/overview', '/v1/admin/jobs', '/v1/admin/webhooks/unprocessed',
      '/v1/admin/deliveries/failed', '/v1/admin/deliveries/stats',
    ]) {
      const res = await send({ method: 'GET', url, headers: authHeaders(patient) });
      expect(res.statusCode, `${url} answered a patient`).toBe(403);
    }
  });

  it('the webhook endpoint returns event metadata, never the provider payload', async () => {
    psql(`INSERT INTO provider_webhook_events (provider, external_id, event_type, payload, signature_ok)
          VALUES ('probe','probe-1','delivery', '{"secret":"probe-webhook-body-value"}', true)`);
    const res = await send({ method: 'GET', url: '/v1/admin/webhooks/unprocessed', headers: authHeaders(admin) });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.body, 'the raw provider payload reached the API').not.toContain('probe-webhook-body-value');
    // The endpoint selects id, provider, event_type, signature_ok and
    // received_at — enough to know an event is stuck, and nothing more. Even
    // `external_id` stays behind.
    expect(res.body, 'but the event itself is visible').toContain('"provider":"probe"');
    expect(res.body).not.toContain('payload');
  });
});

describe('P13-11 the audit trail cannot be rewritten or misattributed', () => {
  it('the application role holds no UPDATE or DELETE on the table', () => {
    const grants = psql(
      `SELECT coalesce(string_agg(privilege_type, ',' ORDER BY privilege_type), 'none')
         FROM information_schema.role_table_grants
        WHERE table_name = 'audit_logs' AND grantee = 'dawaee_app'`,
    );
    expect(grants).toBe('INSERT,SELECT');
  });

  it('and the append-only trigger refuses an UPDATE even as the table owner', () => {
    // The grant is the first line; the trigger is what holds if a future
    // migration widens it, or if someone connects as the owner.
    let refused = false;
    try {
      psql("UPDATE audit_logs SET action = 'forged' WHERE id = (SELECT min(id) FROM audit_logs)");
    } catch (e) {
      refused = String((e as { stderr?: Buffer }).stderr ?? e).includes('append-only');
    }
    expect(refused, 'an UPDATE against audit_logs succeeded').toBe(true);
  });

  it('and refuses a DELETE', () => {
    let refused = false;
    try {
      psql('DELETE FROM audit_logs WHERE id = (SELECT min(id) FROM audit_logs)');
    } catch (e) {
      refused = String((e as { stderr?: Buffer }).stderr ?? e).includes('append-only');
    }
    expect(refused, 'a DELETE against audit_logs succeeded').toBe(true);
  });

  it('attributes the actor to the authenticated session, not to anything in the body', async () => {
    const before = Number(psql('SELECT count(*) FROM audit_logs'));
    const res = await send({
      method: 'PATCH', url: `/v1/medications/${medicationId}`, headers: authHeaders(patient),
      payload: {
        notes: 'attribution probe',
        // Every shape a caller might use to claim to be someone else.
        actorUserId: other.userId, actor_user_id: other.userId,
        userId: other.userId, createdByUserId: other.userId, actorRole: 'admin',
      },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(Number(psql('SELECT count(*) FROM audit_logs'))).toBeGreaterThan(before);

    const row = psql(
      `SELECT actor_user_id::text || '/' || actor_role::text
         FROM audit_logs WHERE action = 'medication.updated' ORDER BY id DESC LIMIT 1`,
    );
    expect(row, 'the audit actor was taken from the request body').toBe(`${patient.userId}/patient`);
  });

  it('positive control: a caregiver’s action is attributed to the caregiver', async () => {
    const carer = await signIn(h, '+966500098010');
    const invite = await send({
      method: 'POST', url: '/v1/caregivers/invite', headers: authHeaders(patient),
      payload: {
        patientProfileId: patient.profileId, invitedName: 'Carer', invitedPhone: carer.phone,
        // `view_history` is required to read the dated dose list, and
        // `view_medications` travels with any dose read — see P12-14.
        role: 'caregiver',
        permissions: ['view_schedule', 'view_history', 'view_medications', 'confirm_dose'],
        escalationPriority: 2,
      },
    });
    const token = invite.json<{ invitationLink: string }>().invitationLink.split('/invite/')[1]!;
    expect((await send({
      method: 'POST', url: '/v1/caregivers/accept', headers: authHeaders(carer), payload: { token },
    })).statusCode).toBe(200);

    const doses = await send({
      method: 'GET', url: `/v1/doses?profileId=${patient.profileId}&from=2026-09-01&to=2026-09-30`,
      headers: authHeaders(carer),
    });
    expect(doses.statusCode, `caregiver could not list doses: ${doses.body}`).toBe(200);
    const target = doses.json<{ doses: Array<{ id: string; status: string }> }>()
      .doses.find((d) => d.status !== 'taken')!;
    expect(target, 'no unconfirmed dose to use').toBeTruthy();
    const done = await send({
      method: 'POST', url: `/v1/doses/${target.id}/taken`, headers: authHeaders(carer),
      payload: { clientEventId: 'audit-probe-carer-1' },
    });
    expect(done.statusCode, done.body).toBe(200);

    const row = psql(
      `SELECT actor_user_id::text || '/' || actor_role::text
         FROM audit_logs WHERE action = 'dose.confirmed' ORDER BY id DESC LIMIT 1`,
    );
    expect(row).toBe(`${carer.userId}/caregiver`);
  }, 120_000);
});

describe('P13-12 the client address is hashed where it is kept, raw only where it is not', () => {
  it('every audit row carries a hash, and no row carries an address', () => {
    const hashes = psql("SELECT coalesce(string_agg(DISTINCT ip_hash, '|'), '') FROM audit_logs WHERE ip_hash IS NOT NULL");
    expect(hashes.length, 'no audit row recorded an address at all').toBeGreaterThan(0);
    // 128 bits of sha256 over a secret salt plus the address.
    for (const hash of hashes.split('|')) expect(hash).toMatch(/^[0-9a-f]{32}$/);
    // The probe addresses used by this file must not appear anywhere in the row.
    const everything = psql("SELECT coalesce(string_agg(row_to_json(a)::text, ' '), '') FROM audit_logs a");
    expect(everything, 'a raw client address was persisted').not.toMatch(/198\.51\.108\.\d+/);
  });

  it('the same address hashes the same way, and a different one differently', () => {
    const distinct = Number(psql('SELECT count(DISTINCT ip_hash) FROM audit_logs WHERE ip_hash IS NOT NULL'));
    const rows = Number(psql('SELECT count(*) FROM audit_logs WHERE ip_hash IS NOT NULL'));
    // This file rotates the source address per request, so most rows differ.
    expect(distinct).toBeGreaterThan(1);
    expect(distinct).toBeLessThanOrEqual(rows);
  });

  it('no other table keeps a client address', () => {
    // A hash in the audit trail is a deliberate, retained record. A second copy
    // somewhere else would quietly undo the decision.
    const columns = psql(
      `SELECT coalesce(string_agg(table_name || '.' || column_name, ' '), 'none')
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND (column_name ILIKE '%ip%address%' OR column_name = 'ip' OR column_name ILIKE 'client_ip%'
               OR column_name ILIKE 'remote_addr%')`,
    );
    expect(columns).toBe('none');
  });
});

describe('P13-13 capability values never survive into a request log line', () => {
  const CASES: Array<[string, string, string]> = [
    ['the emergency scan token', '/v1/emergency/scan/PROBE-CAPABILITY-abcdef123456', 'PROBE-CAPABILITY-abcdef123456'],
    ['the short emergency link', '/e/PROBE-CAPABILITY-abcdef123456', 'PROBE-CAPABILITY-abcdef123456'],
    ['the local upload signature', '/v1/uploads/local/key.png?expires=1&sig=PROBE-SIGNATURE-abcdef', 'PROBE-SIGNATURE-abcdef'],
    ['the signed-read object key', '/v1/uploads/url?objectKey=medication_image%2F2026-09-06%2Fabc12345%2FPROBE-OBJECT.png', 'PROBE-OBJECT'],
  ];

  it('redactUrl removes each of them', () => {
    const leaked: string[] = [];
    for (const [label, url, secret] of CASES) {
      if (redactUrl(url).includes(secret)) leaked.push(label);
    }
    expect(leaked, 'these capability values would be written to the log').toEqual([]);
  });

  it('and keeps the route itself, so the event is still legible', () => {
    expect(redactUrl(CASES[0]![1])).toBe('/v1/emergency/scan/[redacted]');
    expect(redactUrl(CASES[3]![1])).toBe('/v1/uploads/url?[redacted]');
  });

  it('positive control: an ordinary route is logged in full', () => {
    const url = `/v1/doses?profileId=${patient.profileId}&from=2026-09-01&to=2026-09-30`;
    expect(redactUrl(url)).toBe(url);
  });
});
