import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeaders, resetDatabase, signIn, startHarness, type Harness, type TestUser } from './harness.js';

/**
 * Red-team interleavings for caregiver notification revocation.
 *
 * These tests deliberately exercise the gap between an already-enqueued remote
 * delivery and a later access/permission revocation. The safety contract is
 * fail-closed: once the patient has revoked the caregiver (or only the
 * receive_notifications capability), a queued/sending delivery must not be
 * claimable or resurrectable by a worker that still holds an old lease.
 */

let h: Harness;
let db: pg.Pool;
let patient: TestUser;
let caregiver: TestUser;
let seq = 0;

beforeAll(async () => {
  resetDatabase();
  h = await startHarness();
  db = new pg.Pool({ connectionString: 'postgres://postgres:postgres@127.0.0.1:5433/dawaee_test', max: 6 });
  patient = await signIn(h, '+966500092100');
  caregiver = await signIn(h, '+966500092101');
}, 120_000);

afterAll(async () => {
  await db.end();
  await h.close();
});

async function createRelationship(permissions: string[]) {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO caregiver_relationships
       (patient_profile_id, caregiver_user_id, invited_phone_e164, invited_name,
        role, status, permissions, escalation_priority, invited_by_user_id, accepted_at)
     VALUES ($1,$2,$3,'Race Helper','caregiver','active',$4::text[],1,$5,now())
     RETURNING id`,
    [patient.profileId, caregiver.userId, '+966500092101', permissions, patient.userId],
  );
  return rows[0]!.id;
}

async function enqueueFor(relationshipId: string) {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO notification_deliveries
       (patient_profile_id, recipient_user_id, relationship_id, kind, channel, locale,
        title, body, payload, dedupe_key, scheduled_for, next_attempt_at, status)
     VALUES ($1,$2,$3,'escalation','push','en','Care alert','Dose needs attention','{}'::jsonb,
             $4, now(), TIMESTAMPTZ '2000-01-01 00:00:00+00', 'queued')
     RETURNING id`,
    [patient.profileId, caregiver.userId, relationshipId, `care-revoke-race-${Date.now()}-${seq++}`],
  );
  return rows[0]!.id;
}

async function dispatcherQuery(marker: string) {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../../worker/src/jobs/dispatcher.ts', import.meta.url), 'utf8');
  const start = src.indexOf(marker);
  expect(start, `dispatcher query marker not found: ${marker}`).toBeGreaterThan(-1);
  const end = src.indexOf('`', start + 1);
  expect(end, `dispatcher query end not found: ${marker}`).toBeGreaterThan(start);
  return src.slice(start + 1, end);
}

async function claimSql() {
  return dispatcherQuery('`UPDATE notification_deliveries d');
}

async function sentFinaliseSql() {
  return dispatcherQuery("`UPDATE notification_deliveries\n            SET status = 'sent'");
}

async function deliveryState(id: string) {
  const { rows } = await db.query<{
    status: string;
    lease_token: string | null;
    lease_until: Date | null;
    provider_message_id: string | null;
  }>(
    `SELECT status, lease_token, lease_until, provider_message_id
       FROM notification_deliveries WHERE id=$1`,
    [id],
  );
  return rows[0]!;
}

describe('caregiver notification revocation is authoritative over worker leases', () => {
  it('a worker holding an old lease cannot resurrect a delivery after full caregiver revoke', async () => {
    const relationshipId = await createRelationship(['receive_notifications', 'view_adherence']);
    const deliveryId = await enqueueFor(relationshipId);
    const claim = await claimSql();
    const sent = await sentFinaliseSql();

    const { rows: claimed } = await db.query<{ id: string; lease_token: string }>(
      claim, [new Date(), 120, 200],
    );
    const mine = claimed.find((row) => row.id === deliveryId);
    expect(mine, 'worker did not claim the caregiver delivery').toBeTruthy();
    expect((await deliveryState(deliveryId)).status).toBe('sending');

    const revoked = await h.app.inject({
      method: 'DELETE',
      url: `/v1/caregivers/${relationshipId}`,
      headers: authHeaders(patient),
    });
    expect(revoked.statusCode, revoked.body).toBe(200);
    expect((await deliveryState(deliveryId)).status, 'revoke did not suppress the in-flight delivery').toBe('skipped');

    // Simulate the provider returning success to the worker that claimed before
    // the patient revoked access. Its stale finaliser must lose authority.
    const stale = await db.query(
      sent,
      [deliveryId, mine!.lease_token, new Date(), 'expo', 'provider-after-revoke'],
    );
    expect(stale.rowCount,
      'a pre-revoke worker lease was still authorised to turn skipped back into sent').toBe(0);

    const final = await deliveryState(deliveryId);
    expect(final.status, 'the revoked caregiver delivery was resurrected').toBe('skipped');
    expect(final.provider_message_id, 'a stale provider result was persisted after revoke').toBeNull();
  });

  it('removing receive_notifications suppresses already queued deliveries before dispatch', async () => {
    const relationshipId = await createRelationship(['receive_notifications', 'view_adherence']);
    const deliveryId = await enqueueFor(relationshipId);

    const changed = await h.app.inject({
      method: 'PATCH',
      url: `/v1/caregivers/${relationshipId}/permissions`,
      headers: authHeaders(patient),
      payload: { permissions: ['view_adherence'] },
    });
    expect(changed.statusCode, changed.body).toBe(200);

    const afterPermissionRemoval = await deliveryState(deliveryId);
    expect(afterPermissionRemoval.status,
      'a delivery queued under a permission the patient just removed remained eligible to send').toBe('skipped');

    const claim = await claimSql();
    const { rows: claimed } = await db.query<{ id: string }>(claim, [new Date(), 120, 200]);
    expect(claimed.map((row) => row.id),
      'the dispatcher could still claim a delivery after receive_notifications was removed').not.toContain(deliveryId);
  });
});
