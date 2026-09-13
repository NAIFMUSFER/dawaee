import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetDatabase, signIn, startHarness, type Harness, type TestUser } from './harness.js';

let h: Harness;
let appPool: pg.Pool;
let fixturePool: pg.Pool;
let alice: TestUser;
let bob: TestUser;
let linkedProfileId: string;

interface Attempt {
  rowCount: number;
  errorCode: string | null;
  constraint: string | null;
  error: string | null;
}

async function insertConsentAs(
  user: TestUser,
  patientProfileId: string | null,
): Promise<Attempt> {
  const client = await appPool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1,$2,true)', ['app.user_id', user.userId]);
    const result = await client.query(
      `INSERT INTO consents
         (user_id, patient_profile_id, type, granted, version, granted_at)
       VALUES ($1,$2,'ocr_image_processing',true,'consent-owner-integrity',now())
       RETURNING id`,
      [user.userId, patientProfileId],
    );
    await client.query('ROLLBACK');
    return { rowCount: result.rowCount ?? 0, errorCode: null, constraint: null, error: null };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    const pgError = error as Error & { code?: string; constraint?: string };
    return {
      rowCount: 0,
      errorCode: pgError.code ?? null,
      constraint: pgError.constraint ?? null,
      error: pgError.message,
    };
  } finally {
    client.release();
  }
}

beforeAll(async () => {
  resetDatabase();
  h = await startHarness();
  appPool = new pg.Pool({
    connectionString: 'postgres://dawaee_app:devpass@127.0.0.1:5433/dawaee_test',
    max: 2,
  });
  fixturePool = new pg.Pool({
    connectionString: 'postgres://postgres:postgres@127.0.0.1:5433/dawaee_test',
    max: 2,
  });

  alice = await signIn(h, '+966500099971');
  bob = await signIn(h, '+966500099972');

  const { rows } = await fixturePool.query<{ id: string }>(
    `INSERT INTO patient_profiles
       (owner_user_id, linked_user_id, display_name, is_self)
     VALUES ($1,$2,'Linked-owner consent fixture',false)
     RETURNING id`,
    [alice.userId, bob.userId],
  );
  linkedProfileId = rows[0]!.id;
}, 120_000);

afterAll(async () => {
  await appPool?.end();
  await fixturePool?.end();
  await h?.close();
});

describe('consent patient-profile ownership is enforced by PostgreSQL', () => {
  it('rejects a runtime-role consent that points at another patient profile', async () => {
    const attempt = await insertConsentAs(alice, bob.profileId);
    expect(attempt.errorCode, attempt.error ?? 'cross-patient consent unexpectedly succeeded').toBe('23514');
    expect(attempt.constraint).toBe('consent_profile_owner_match');
  });

  it('allows a consent for the caller own profile', async () => {
    const attempt = await insertConsentAs(alice, alice.profileId);
    expect(attempt.error, attempt.error ?? '').toBeNull();
    expect(attempt.rowCount).toBe(1);
  });

  it('allows the linked patient identity to consent for its linked profile', async () => {
    const attempt = await insertConsentAs(bob, linkedProfileId);
    expect(attempt.error, attempt.error ?? '').toBeNull();
    expect(attempt.rowCount).toBe(1);
  });

  it('preserves account-wide consent when patient_profile_id is null', async () => {
    const attempt = await insertConsentAs(alice, null);
    expect(attempt.error, attempt.error ?? '').toBeNull();
    expect(attempt.rowCount).toBe(1);
  });
});
