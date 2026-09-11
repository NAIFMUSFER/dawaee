import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { dispatchJob } from '../../worker/src/jobs/dispatcher.js';
import { authHeaders, resetDatabase, signIn, startHarness, type Harness, type TestUser } from './harness.js';

let h: Harness;
let db: pg.Pool;
let patient: TestUser;
let caregiver: TestUser;
let seq = 0;

beforeAll(async () => {
  resetDatabase();
  h = await startHarness();
  db = new pg.Pool({ connectionString: 'postgres://postgres:postgres@127.0.0.1:5433/dawaee_test', max: 6 });
  patient = await signIn(h, '+966500097821');
  caregiver = await signIn(h, '+966500097822');
}, 120_000);

beforeEach(() => h.push.reset());

afterAll(async () => {
  await db.end();
  await h.close();
});

async function createRelationship(permissions: string[]): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO caregiver_relationships
       (patient_profile_id, caregiver_user_id, invited_phone_e164, invited_name,
        role, status, permissions, escalation_priority, invited_by_user_id, accepted_at)
     VALUES ($1,$2,$3,'Digest Helper','caregiver','active',$4::text[],1,$5,now())
     RETURNING id`,
    [patient.profileId, caregiver.userId, caregiver.phone, permissions, patient.userId],
  );
  return rows[0]!.id;
}

async function enqueueDigest(relationshipId: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO notification_deliveries
       (patient_profile_id, recipient_user_id, relationship_id, kind, channel, locale,
        title, body, payload, dedupe_key, scheduled_for, next_attempt_at, status)
     VALUES ($1,$2,$3,'daily_summary','push','en','Daily report',
             'Scheduled 4, taken 2, missed 2','{"scheduled":4,"taken":2,"missed":2}'::jsonb,
             $4, now(), TIMESTAMPTZ '2000-01-01 00:00:00+00', 'queued')
     RETURNING id`,
    [patient.profileId, caregiver.userId, relationshipId, `digest-revoke-${Date.now()}-${seq++}`],
  );
  return rows[0]!.id;
}

async function registerPushToken(): Promise<void> {
  await db.query(
    `INSERT INTO push_tokens (user_id, token, platform, device_id, active, last_seen_at)
     VALUES ($1,$2,'android',$3,true,now())
     ON CONFLICT (user_id, device_id) DO UPDATE
       SET token=EXCLUDED.token, active=true, last_seen_at=now()`,
    [caregiver.userId, `ExponentPushToken[digest-${seq}]`, `digest-device-${seq}`],
  );
}

async function deliveryStatus(id: string): Promise<string> {
  const { rows } = await db.query<{ status: string }>(
    'SELECT status::text AS status FROM notification_deliveries WHERE id=$1', [id],
  );
  return rows[0]!.status;
}

describe('queued caregiver digests follow current adherence permissions', () => {
  it('permission narrowing suppresses a digest that was queued while access was valid', async () => {
    const relationshipId = await createRelationship([
      'receive_notifications', 'view_adherence', 'view_schedule',
    ]);
    const deliveryId = await enqueueDigest(relationshipId);

    const narrowed = await h.app.inject({
      method: 'PATCH',
      url: `/v1/caregivers/${relationshipId}/permissions`,
      headers: authHeaders(patient),
      payload: { permissions: ['receive_notifications', 'view_schedule'] },
    });
    expect(narrowed.statusCode, narrowed.body).toBe(200);
    expect(await deliveryStatus(deliveryId),
      'a queued adherence summary survived removal of view_adherence').toBe('skipped');
  });

  it('dispatcher refuses a legacy queued digest when required data access is already absent', async () => {
    const relationshipId = await createRelationship(['receive_notifications', 'view_schedule']);
    const deliveryId = await enqueueDigest(relationshipId);
    await registerPushToken();

    const client = await h.worker.pool.connect();
    try {
      const result = await dispatchJob(h.worker, client);
      expect(result.itemsProcessed,
        'dispatcher counted a caregiver digest that current permissions forbid').toBe(0);
    } finally {
      client.release();
    }

    expect(h.push.sent,
      'dispatcher sent adherence data after view_adherence had already been removed').toHaveLength(0);
    expect(await deliveryStatus(deliveryId),
      'unauthorised legacy digest was not retired from the outbox').toBe('skipped');
  });
});
