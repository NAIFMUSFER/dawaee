import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeaders, resetDatabase, signIn, startHarness, type Harness, type TestUser } from './harness.js';

let h: Harness;
let user: TestUser;
let owner: pg.Pool;

beforeAll(async () => {
  resetDatabase();
  h = await startHarness();
  user = await signIn(h, '+966500099940');
  owner = new pg.Pool({ connectionString: 'postgres://postgres:postgres@127.0.0.1:5433/dawaee_test' });
});

afterAll(async () => {
  await owner.end();
  await h.close();
});

describe('P20 account-erasure audit detachment', () => {
  it('erases a due user while retaining the audit row with only FK identity detached', async () => {
    const request = await h.app.inject({
      method: 'POST', url: '/v1/me/deletion-request', headers: authHeaders(user), payload: { confirm: true },
    });
    expect(request.statusCode, request.body).toBe(200);

    const before = await owner.query<{
      id: string; actor_user_id: string | null; patient_profile_id: string | null;
      action: string; entity_type: string; request_id: string | null; previous_value: unknown; new_value: unknown;
    }>(
      `SELECT id::text, actor_user_id, patient_profile_id, action, entity_type, request_id, previous_value, new_value
         FROM audit_logs
        WHERE actor_user_id = $1
        ORDER BY id DESC LIMIT 1`,
      [user.userId],
    );
    expect(before.rows).toHaveLength(1);
    const original = before.rows[0]!;

    await owner.query(
      `UPDATE users SET deletion_requested_at = now() - interval '15 days' WHERE id = $1`,
      [user.userId],
    );
    const erased = await h.worker.pool.query<{ erased: boolean }>(
      'SELECT app.erase_due_account($1, 14) AS erased', [user.userId],
    );
    expect(erased.rows[0]?.erased).toBe(true);

    const after = await owner.query<{
      id: string; actor_user_id: string | null; patient_profile_id: string | null;
      action: string; entity_type: string; request_id: string | null; previous_value: unknown; new_value: unknown;
    }>(
      `SELECT id::text, actor_user_id, patient_profile_id, action, entity_type, request_id, previous_value, new_value
         FROM audit_logs WHERE id = $1`, [original.id],
    );
    expect(after.rows).toHaveLength(1);
    expect(after.rows[0]!.actor_user_id).toBeNull();
    expect(after.rows[0]!.patient_profile_id).toBeNull();
    expect({
      action: after.rows[0]!.action,
      entity_type: after.rows[0]!.entity_type,
      request_id: after.rows[0]!.request_id,
      previous_value: after.rows[0]!.previous_value,
      new_value: after.rows[0]!.new_value,
    }).toEqual({
      action: original.action,
      entity_type: original.entity_type,
      request_id: original.request_id,
      previous_value: original.previous_value,
      new_value: original.new_value,
    });
  });

  it('still refuses a direct attempt to rewrite audit content', async () => {
    const victim = await owner.query<{ id: string }>('SELECT id::text FROM audit_logs ORDER BY id LIMIT 1');
    expect(victim.rows).toHaveLength(1);
    const err = await owner.query(
      `UPDATE audit_logs SET action = action || '.tampered' WHERE id = $1`, [victim.rows[0]!.id],
    ).then(() => null).catch((e: { code?: string; message: string }) => e);
    expect(err?.code).toBe('42501');
    expect(err?.message).toMatch(/append-only/i);
  });

  it('cannot null an actor merely by spoofing the transaction marker for a different user', async () => {
    const other = await signIn(h, '+966500099941');
    const row = await owner.query<{ id: string }>(
      'SELECT id::text FROM audit_logs WHERE actor_user_id = $1 ORDER BY id DESC LIMIT 1', [other.userId],
    );
    const c = await owner.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.erasing_user_id', $1, true)", [user.userId]);
      const err = await c.query('UPDATE audit_logs SET actor_user_id = NULL WHERE id = $1', [row.rows[0]!.id])
        .then(() => null).catch((e: { code?: string; message: string }) => e);
      expect(err?.code).toBe('42501');
      await c.query('ROLLBACK');
    } finally {
      c.release();
    }
  });
});
