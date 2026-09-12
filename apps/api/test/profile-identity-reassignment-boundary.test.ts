import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetDatabase, signIn, startHarness, type Harness, type TestUser } from './harness.js';

let h: Harness;
let appPool: pg.Pool;
let alice: TestUser;
let bob: TestUser;

interface Attempt {
  rowCount: number;
  errorCode: string | null;
  constraint: string | null;
  error: string | null;
}

async function updateProfileIdentityAsAlice(
  column: 'owner_user_id' | 'linked_user_id',
  value: string,
): Promise<Attempt> {
  const client = await appPool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1,$2,true)', ['app.user_id', alice.userId]);
    const result = await client.query(
      `UPDATE patient_profiles SET ${column} = $1 WHERE id = $2 RETURNING id`,
      [value, alice.profileId],
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

async function insertProfileLinkedToBobAsAlice(): Promise<Attempt> {
  const client = await appPool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1,$2,true)', ['app.user_id', alice.userId]);
    const result = await client.query(
      `INSERT INTO patient_profiles
         (owner_user_id, linked_user_id, display_name, timezone, home_timezone, is_self)
       VALUES ($1,$2,'Cross-account linked profile','Asia/Riyadh','Asia/Riyadh',false)
       RETURNING id`,
      [alice.userId, bob.userId],
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
  alice = await signIn(h, '+966500099981');
  bob = await signIn(h, '+966500099982');
}, 120_000);

afterAll(async () => {
  await appPool?.end();
  await h?.close();
});

describe('patient-profile identity edges cannot be reassigned by the authenticated runtime role', () => {
  it('does not let an owner create a profile that silently grants linked-patient access to another account', async () => {
    const attempt = await insertProfileLinkedToBobAsAlice();
    expect(attempt.errorCode, attempt.error ?? 'cross-account linked profile unexpectedly succeeded').toBe('42501');
    expect(attempt.constraint).toBe('patient_profile_identity_reassignment');
  });

  it('does not let an owner gift linked-patient access to an arbitrary account', async () => {
    const attempt = await updateProfileIdentityAsAlice('linked_user_id', bob.userId);
    expect(attempt.errorCode, attempt.error ?? 'linked_user_id reassignment unexpectedly succeeded').toBe('42501');
    expect(attempt.constraint).toBe('patient_profile_identity_reassignment');
  });

  it('does not let an owner transfer profile ownership to an arbitrary account', async () => {
    const attempt = await updateProfileIdentityAsAlice('owner_user_id', bob.userId);
    expect(attempt.errorCode, attempt.error ?? 'owner_user_id reassignment unexpectedly succeeded').toBe('42501');
    expect(attempt.constraint).toBe('patient_profile_identity_reassignment');
  });

  it('still allows an owner to edit ordinary profile metadata', async () => {
    const client = await appPool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT set_config($1,$2,true)', ['app.user_id', alice.userId]);
      const result = await client.query(
        `UPDATE patient_profiles SET display_name = 'Alice updated' WHERE id = $1 RETURNING id`,
        [alice.profileId],
      );
      expect(result.rowCount).toBe(1);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });
});
