import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  authHeaders, resetDatabase, signIn, startHarness, type Harness, type TestUser,
} from './harness.js';

// Real HTTP handlers, authentication, app-role transactions and PostgreSQL RLS.
// Administrative SQL is restricted to synthetic fixtures in dawaee_test.
// No worker tick or outbound notification provider is invoked by this suite.
const ROUTE = '/v1/caregivers/notification/resolve';
const PERMISSIONS = ['receive_notifications', 'view_adherence', 'view_schedule'];
const PRIVATE_PAYLOAD = 'SYNTHETIC-HISTORICAL-CLINICAL-PAYLOAD';
let h: Harness;
let db: pg.Pool;
let patientA: TestUser;
let patientB: TestUser;
let caregiver: TestUser;
let peer: TestUser;
let stranger: TestUser;
let relationshipA: string;
let relationshipB: string;

async function relate(patient: TestUser, recipient: TestUser): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO caregiver_relationships
       (patient_profile_id, caregiver_user_id, invited_phone_e164, invited_name, role,
        status, permissions, escalation_priority, invited_by_user_id, accepted_at,
        invitation_token_hash, invitation_expires_at)
     VALUES ($1,$2,$3,'Synthetic caregiver','caregiver','active',$4::text[],1,$5,now(),
             $6,now() + interval '1 hour')
     RETURNING id`,
    [patient.profileId, recipient.userId, recipient.phone, PERMISSIONS, patient.userId, randomUUID()],
  );
  return rows[0]!.id;
}

beforeAll(async () => {
  resetDatabase();
  h = await startHarness();
  db = new pg.Pool({ connectionString: 'postgres://postgres:postgres@127.0.0.1:5433/dawaee_test', max: 4 });
  patientA = await signIn(h, '+966500097851');
  patientB = await signIn(h, '+966500097852');
  caregiver = await signIn(h, '+966500097853');
  peer = await signIn(h, '+966500097854');
  stranger = await signIn(h, '+966500097855');
  relationshipA = await relate(patientA, caregiver);
  relationshipB = await relate(patientB, caregiver);
  await relate(patientA, peer);
}, 120_000);

beforeEach(async () => {
  h.push.reset();
  await db.query('DELETE FROM notification_deliveries WHERE patient_profile_id = ANY($1::uuid[])',
    [[patientA.profileId, patientB.profileId]]);
  await db.query(
    `UPDATE caregiver_relationships SET status = 'active', permissions = $2::text[], revoked_at = NULL
      WHERE patient_profile_id = ANY($1::uuid[])`,
    [[patientA.profileId, patientB.profileId], PERMISSIONS],
  );
  await db.query(
    `UPDATE patient_profiles SET archived_at = NULL,
       display_name = CASE WHEN id = $1 THEN 'Current patient A' ELSE 'Current patient B' END
      WHERE id = ANY($2::uuid[])`,
    [patientA.profileId, [patientA.profileId, patientB.profileId]],
  );
});

afterAll(async () => {
  if (db) await db.end();
  if (h) await h.close();
});

async function enqueue(options: {
  patient?: TestUser; relationship?: string; kind?: string; channel?: string;
} = {}): Promise<string> {
  const patient = options.patient ?? patientA;
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO notification_deliveries
       (patient_profile_id, recipient_user_id, relationship_id, kind, channel,
        title, body, payload, dedupe_key, status)
     VALUES ($1,$2,$3,$4::notification_kind,$5::notification_channel,$6,$6,$7::jsonb,$8,'sent')
     RETURNING id`,
    [patient.profileId, caregiver.userId, options.relationship ?? relationshipA,
      options.kind ?? 'escalation', options.channel ?? 'push', PRIVATE_PAYLOAD,
      JSON.stringify({ patientProfileId: patientB.profileId, patientName: PRIVATE_PAYLOAD,
        medicationName: PRIVATE_PAYLOAD, url: 'https://untrusted.example/ignore' }),
      `resolve-fixture-${randomUUID()}`],
  );
  return rows[0]!.id;
}

function resolveNotification(id: unknown, user: TestUser = caregiver, extra: Record<string, unknown> = {}) {
  return h.app.inject({ method: 'POST', url: ROUTE, headers: authHeaders(user),
    payload: { ...extra, deliveryId: id } });
}

async function narrow(permissions: string[]) {
  await db.query('UPDATE caregiver_relationships SET permissions = $2::text[] WHERE id = $1',
    [relationshipA, permissions]);
}

describe('authenticated delivery-specific caregiver notification resolution', () => {
  for (const kind of ['escalation', 'daily_summary', 'weekly_summary']) {
    it(`resolves the exact ${kind} recipient to minimal current profile identity`, async () => {
      const id = await enqueue({ kind });
      const res = await resolveNotification(id);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toEqual({ notification: {
        kind, patientProfileId: patientA.profileId, patientDisplayName: 'Current patient A',
      } });
      expect(res.headers['cache-control']).toContain('no-store');
      expect(res.body).not.toContain(PRIVATE_PAYLOAD);
      expect(res.body).not.toContain('untrusted.example');
      expect(res.body).not.toContain(patientA.phone);
      expect(h.push.sent).toHaveLength(0);
    });
  }

  it('distinguishes two followed patients rather than selecting the current or first one', async () => {
    const first = await enqueue();
    const second = await enqueue({ patient: patientB, relationship: relationshipB });
    const a = await resolveNotification(first);
    const b = await resolveNotification(second);
    expect(a.statusCode, a.body).toBe(200);
    expect(b.statusCode, b.body).toBe(200);
    expect(a.json().notification.patientProfileId).toBe(patientA.profileId);
    expect(b.json().notification.patientProfileId).toBe(patientB.profileId);
  });

  it('ignores client-selected recipients, patients, kinds, names and URLs', async () => {
    const id = await enqueue();
    const res = await resolveNotification(id, caregiver, {
      recipientUserId: stranger.userId, patientProfileId: patientB.profileId,
      relationshipId: relationshipB, kind: 'weekly_summary',
      patientName: PRIVATE_PAYLOAD, url: 'https://untrusted.example/ignore',
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ notification: {
      kind: 'escalation', patientProfileId: patientA.profileId, patientDisplayName: 'Current patient A',
    } });
  });

  it('requires authentication before resolving a delivery', async () => {
    const id = await enqueue();
    const res = await h.app.inject({ method: 'POST', url: ROUTE, payload: { deliveryId: id } });
    expect(res.statusCode, res.body).toBe(401);
    expect(res.body).not.toContain(patientA.profileId);
    expect(res.body).not.toContain('Current patient A');
  });

  for (const actor of ['peer', 'stranger', 'patient'] as const) {
    it(`does not treat ${actor} profile access or knowledge of the id as recipient authorization`, async () => {
      const id = await enqueue();
      const user = actor === 'peer' ? peer : actor === 'patient' ? patientA : stranger;
      const res = await resolveNotification(id, user);
      const missing = await resolveNotification(randomUUID(), user);
      expect(res.statusCode, res.body).toBe(404);
      expect(missing.statusCode, missing.body).toBe(404);
      expect(res.json().error.code).toBe(missing.json().error.code);
      expect(res.json().error.message).toBe(missing.json().error.message);
      expect(res.body).not.toContain(patientA.profileId);
      expect(res.body).not.toContain(PRIVATE_PAYLOAD);
    });
  }

  for (const status of ['pending', 'revoked', 'declined', 'expired']) {
    it(`refuses an old notification after its original relationship becomes ${status}`, async () => {
      const id = await enqueue();
      await db.query('UPDATE caregiver_relationships SET status = $2::caregiver_relationship_status WHERE id = $1',
        [relationshipA, status]);
      const res = await resolveNotification(id);
      expect(res.statusCode, res.body).toBe(404);
      expect(res.body).not.toContain('Current patient A');
    });
  }

  it('does not revive an old delivery through a replacement relationship to the same patient', async () => {
    const oldId = await enqueue();
    await db.query("UPDATE caregiver_relationships SET status = 'revoked' WHERE id = $1", [relationshipA]);
    const replacement = await relate(patientA, caregiver);
    try {
      const old = await resolveNotification(oldId);
      expect(old.statusCode, old.body).toBe(404);
      const newId = await enqueue({ relationship: replacement });
      const current = await resolveNotification(newId);
      expect(current.statusCode, current.body).toBe(200);
      expect(current.json().notification.patientProfileId).toBe(patientA.profileId);
    } finally {
      await db.query('DELETE FROM notification_deliveries WHERE relationship_id = $1', [replacement]);
      await db.query('DELETE FROM caregiver_relationships WHERE id = $1', [replacement]);
    }
  });

  it('refuses resolution after the patient removes notification permission', async () => {
    const id = await enqueue();
    const changed = await h.app.inject({ method: 'PATCH', url: '/v1/caregivers/permissions',
      headers: authHeaders(patientA), payload: { relationshipId: relationshipA,
        permissions: ['view_adherence', 'view_schedule'] } });
    expect(changed.statusCode, changed.body).toBe(200);
    const res = await resolveNotification(id);
    expect(res.statusCode, res.body).toBe(404);
  });

  for (const kind of ['daily_summary', 'weekly_summary']) {
    for (const permission of ['view_adherence', 'view_schedule']) {
      it(`refuses an old ${kind} after ${permission} is removed`, async () => {
        const id = await enqueue({ kind });
        await narrow(PERMISSIONS.filter(value => value !== permission));
        const res = await resolveNotification(id);
        expect(res.statusCode, res.body).toBe(404);
      });
    }
  }

  it('does not require clinical read grants merely to resolve a generic escalation identity', async () => {
    const id = await enqueue();
    await narrow(['receive_notifications']);
    const res = await resolveNotification(id);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ notification: {
      kind: 'escalation', patientProfileId: patientA.profileId, patientDisplayName: 'Current patient A',
    } });
  });

  it('does not resolve an archived patient even while the relationship row remains active', async () => {
    const id = await enqueue();
    await db.query('UPDATE patient_profiles SET archived_at = now() WHERE id = $1', [patientA.profileId]);
    const res = await resolveNotification(id);
    expect(res.statusCode, res.body).toBe(404);
  });

  for (const channel of ['local', 'in_app']) {
    it(`does not accept a ${channel} row as a remote caregiver push`, async () => {
      const id = await enqueue({ channel });
      const res = await resolveNotification(id);
      expect(res.statusCode, res.body).toBe(404);
    });
  }

  for (const kind of ['system', 'dose_reminder']) {
    it(`does not accept a ${kind} row as a caregiver alert`, async () => {
      const id = await enqueue({ kind });
      const res = await resolveNotification(id);
      expect(res.statusCode, res.body).toBe(404);
    });
  }

  const invalidIds: unknown[] = [undefined, null, '', 'not-a-uuid', 42, [], {}, 'x'.repeat(2048)];
  for (const [index, id] of invalidIds.entries()) {
    it(`rejects malformed identifier case ${index} at the request edge`, async () => {
      const res = await resolveNotification(id);
      expect(res.statusCode, res.body).toBe(400);
      expect(res.json().error.code).toBe('validation_failed');
    });
  }

  it('does not use a query-string identifier in place of the private JSON body', async () => {
    const id = await enqueue();
    const res = await h.app.inject({ method: 'POST', url: `${ROUTE}?deliveryId=${id}`,
      headers: authHeaders(caregiver), payload: {} });
    expect(res.statusCode, res.body).toBe(400);
  });

  it('is repeatable without changing delivery/read state or sending another notification', async () => {
    const id = await enqueue();
    const before = await db.query('SELECT * FROM notification_deliveries WHERE id = $1', [id]);
    const first = await resolveNotification(id);
    const second = await resolveNotification(id);
    expect(first.statusCode, first.body).toBe(200);
    expect(second.statusCode, second.body).toBe(200);
    expect(first.json()).toEqual(second.json());
    const after = await db.query('SELECT * FROM notification_deliveries WHERE id = $1', [id]);
    expect(after.rows).toEqual(before.rows);
    expect(h.push.sent).toHaveLength(0);
  });
});
