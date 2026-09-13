import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeaders, resetDatabase, signIn, startHarness, type Harness, type TestUser } from './harness.js';

let h: Harness;
let appPool: pg.Pool;
let alice: TestUser;
let bob: TestUser;

async function asAliceRollback<T>(work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await appPool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1,$2,true)', ['app.user_id', alice.userId]);
    return await work(client);
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
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
  // Registration exercises the existing SECURITY DEFINER path as well as the
  // ordinary runtime controls below. These are synthetic harness accounts.
  alice = await signIn(h, '+966500099991');
  bob = await signIn(h, '+966500099992');
}, 120_000);

afterAll(async () => {
  await appPool?.end();
  await h?.close();
});

describe('profile identity runtime guard preserves supported operations', () => {
  it('runs as the restricted caller rather than bypassing its own role check', async () => {
    await asAliceRollback(async (client) => {
      const { rows } = await client.query<{
        role_name: string; rolsuper: boolean; rolbypassrls: boolean;
        prosecdef: boolean; tgenabled: string; tgtype: number;
      }>(
        `SELECT current_user AS role_name, r.rolsuper, r.rolbypassrls,
                p.prosecdef, t.tgenabled, t.tgtype::int AS tgtype
           FROM pg_trigger t
           JOIN pg_proc p ON p.oid = t.tgfoid
           JOIN pg_roles r ON r.rolname = current_user
          WHERE t.tgrelid = 'public.patient_profiles'::regclass
            AND t.tgname = 'patient_profile_identity_reassignment_guard'`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual({
        role_name: 'dawaee_app', rolsuper: false, rolbypassrls: false,
        prosecdef: false, tgenabled: 'O', tgtype: 23,
      });
    });
  });

  it('still permits an unlinked dependent owned by the caller', async () => {
    await asAliceRollback(async (client) => {
      // Match POST /v1/profiles: profiles_read uses a STABLE same-table lookup,
      // so INSERT ... RETURNING cannot see the new row in that statement's
      // snapshot. Keep RLS intact and read the exact generated id separately.
      const profileId = randomUUID();
      const inserted = await client.query(
        `INSERT INTO patient_profiles (id, owner_user_id, display_name, is_self)
         VALUES ($1,$2,'Synthetic dependent',false)`,
        [profileId, alice.userId],
      );
      expect(inserted.rowCount).toBe(1);
      const result = await client.query<{ owner_user_id: string; linked_user_id: string | null }>(
        'SELECT owner_user_id, linked_user_id FROM patient_profiles WHERE id = $1',
        [profileId],
      );
      expect(result.rowCount).toBe(1);
      expect(result.rows[0]).toEqual({ owner_user_id: alice.userId, linked_user_id: null });
    });
  });

  it('does not reject a link to the same account that already owns the new profile', async () => {
    await asAliceRollback(async (client) => {
      // As above, the supported creation contract is INSERT then SELECT.
      const profileId = randomUUID();
      const inserted = await client.query(
        `INSERT INTO patient_profiles (id, owner_user_id, linked_user_id, display_name, is_self)
         VALUES ($1,$2,$2,'Same-account profile',false)`,
        [profileId, alice.userId],
      );
      expect(inserted.rowCount).toBe(1);
      const result = await client.query<{ owner_user_id: string; linked_user_id: string | null }>(
        'SELECT owner_user_id, linked_user_id FROM patient_profiles WHERE id = $1',
        [profileId],
      );
      expect(result.rowCount).toBe(1);
      expect(result.rows[0]).toEqual({ owner_user_id: alice.userId, linked_user_id: alice.userId });
    });
  });

  it('creates a dependent through the real API and lists it only for its owner', async () => {
    const created = await h.app.inject({
      method: 'POST', url: '/v1/profiles', headers: authHeaders(alice),
      payload: { displayName: 'Synthetic API dependent', timezone: 'Asia/Riyadh', isSelf: false },
    });
    expect(created.statusCode, created.body).toBe(200);
    const profileId = created.json<{ profile: { id: string } }>().profile.id;
    expect(profileId).toEqual(expect.any(String));
    expect(profileId).not.toBe(alice.profileId);

    const own = await h.app.inject({
      method: 'GET', url: '/v1/profiles', headers: authHeaders(alice),
    });
    expect(own.statusCode, own.body).toBe(200);
    expect(own.json<{ profiles: Array<{ id: string }> }>().profiles.map(p => p.id)).toContain(profileId);

    const other = await h.app.inject({
      method: 'GET', url: '/v1/profiles', headers: authHeaders(bob),
    });
    expect(other.statusCode, other.body).toBe(200);
    const otherIds = other.json<{ profiles: Array<{ id: string }> }>().profiles.map(p => p.id);
    expect(otherIds).toContain(bob.profileId);
    expect(otherIds).not.toContain(profileId);
  });

  it('allows explicit unchanged identity columns in an ordinary metadata update', async () => {
    await asAliceRollback(async (client) => {
      const result = await client.query<{ display_name: string }>(
        `UPDATE patient_profiles
            SET owner_user_id = owner_user_id, linked_user_id = linked_user_id,
                display_name = 'Updated synthetic profile'
          WHERE id = $1 RETURNING display_name`,
        [alice.profileId],
      );
      expect(result.rowCount).toBe(1);
      expect(result.rows[0]?.display_name).toBe('Updated synthetic profile');
    });
  });

  it('aborts an identity-changing transaction and leaves the persisted ownership unchanged', async () => {
    const before = await asAliceRollback(async (client) => {
      const { rows } = await client.query(
        'SELECT owner_user_id, linked_user_id FROM patient_profiles WHERE id = $1',
        [alice.profileId],
      );
      expect(rows).toHaveLength(1);
      return rows[0];
    });

    await asAliceRollback(async (client) => {
      await expect(client.query(
        'UPDATE patient_profiles SET linked_user_id = $1 WHERE id = $2',
        [bob.userId, alice.profileId],
      )).rejects.toMatchObject({
        code: '42501', constraint: 'patient_profile_identity_reassignment',
      });
      await expect(client.query('SELECT 1')).rejects.toMatchObject({ code: '25P02' });
    });

    await asAliceRollback(async (client) => {
      const { rows } = await client.query(
        'SELECT owner_user_id, linked_user_id FROM patient_profiles WHERE id = $1',
        [alice.profileId],
      );
      expect(rows).toEqual([before]);
    });
  });
});
