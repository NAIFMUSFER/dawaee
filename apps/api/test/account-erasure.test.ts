import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeaders, resetDatabase, signIn, startHarness, type Harness, type TestUser } from './harness.js';
import { housekeepingJob } from '../../worker/src/jobs/housekeeping.js';
import { runJob } from '../../worker/src/context.js';

let h: Harness;
let alice: TestUser;
let bob: TestUser;
let medicationId = '';

function adminSql(sql: string): void {
  execFileSync('psql', ['-d', 'dawaee_test', '-v', 'ON_ERROR_STOP=1', '-c', sql], {
    env: { ...process.env, PGHOST: '127.0.0.1', PGPORT: '5433', PGUSER: 'postgres' },
    stdio: 'pipe',
  });
}

async function runHousekeeping(): Promise<void> {
  const result = await runJob(h.worker, 'account-erasure-test', (client) => housekeepingJob(h.worker, client));
  expect(result.ran).toBe(true);
  const failures = (result as typeof result & { failures?: Array<{ step: string; error: string }> }).failures ?? [];
  expect(failures, `housekeeping failed before erasure: ${JSON.stringify(failures)}`).toEqual([]);
}

beforeAll(async () => {
  resetDatabase();
  h = await startHarness();
  alice = await signIn(h, '0544333301');
  bob = await signIn(h, '0544333302');

  // Alice owns the medical record. Re-point only its creator attribution to Bob
  // to model the legitimate case where Bob added a medicine while acting as a
  // caregiver. Erasing Bob must not erase Alice's medicine.
  const med = await h.app.inject({
    method: 'POST', url: '/v1/medications', headers: authHeaders(alice),
    payload: {
      patientProfileId: alice.profileId,
      name: 'Patient-owned medicine', form: 'tablet', startDate: '2026-09-01',
    },
  });
  expect(med.statusCode, med.body).toBe(200);
  medicationId = med.json().medication.id;
  adminSql(`UPDATE medications SET created_by = '${bob.userId}' WHERE id = '${medicationId}'`);
});

afterAll(async () => { await h.close(); });

describe('scheduled account erasure', () => {
  it('does not erase an account before the promised fourteen-day grace period', async () => {
    const requested = await h.app.inject({
      method: 'POST', url: '/v1/me/deletion-request', headers: authHeaders(bob),
      payload: { confirm: true },
    });
    expect(requested.statusCode, requested.body).toBe(200);

    // The narrow worker enumeration must not expose object keys for a user who
    // is not due yet, even if the worker supplies that user's id directly.
    const premature = await h.worker.pool.query<{ object_key: string }>(
      'SELECT object_key FROM app.list_due_account_object_keys($1, 14)', [bob.userId],
    );
    expect(premature.rows).toEqual([]);

    await runHousekeeping();

    const { rows } = await h.worker.pool.query<{ id: string }>('SELECT id FROM users WHERE id = $1', [bob.userId]);
    expect(rows).toHaveLength(1);
  });

  it('erases a due account while preserving another patient record it merely created', async () => {
    // The erasure function uses database time deliberately. Age only the durable
    // request marker; do not fake the worker clock and accidentally prove a
    // different condition than production executes.
    adminSql(`UPDATE users SET deletion_requested_at = now() - interval '15 days' WHERE id = '${bob.userId}'`);

    await runHousekeeping();

    const { rows: users } = await h.worker.pool.query<{ id: string }>('SELECT id FROM users WHERE id = $1', [bob.userId]);
    expect(users).toHaveLength(0);

    const { rows: ownProfiles } = await h.worker.pool.query<{ id: string }>(
      'SELECT id FROM patient_profiles WHERE id = $1', [bob.profileId],
    );
    expect(ownProfiles).toHaveLength(0);

    const { rows: patientRows } = await h.worker.pool.query<{ id: string }>(
      'SELECT id FROM patient_profiles WHERE id = $1', [alice.profileId],
    );
    expect(patientRows).toHaveLength(1);

    const { rows: medicationRows } = await h.worker.pool.query<{ id: string; created_by: string | null }>(
      'SELECT id, created_by FROM medications WHERE id = $1', [medicationId],
    );
    expect(medicationRows).toEqual([{ id: medicationId, created_by: null }]);
  });
});

describe('erasure schema boundaries', () => {
  it('keeps creator/uploader attribution nullable with ON DELETE SET NULL', async () => {
    // information_schema hides metadata from roles that do not hold table
    // privileges. The worker intentionally cannot read several of these PHI
    // tables, so asking information_schema as the worker produced an empty set
    // and made a correct schema look broken. pg_catalog describes the schema
    // itself without requiring data-plane SELECT on those tables.
    const { rows } = await h.worker.pool.query<{
      table_name: string; column_name: string; is_nullable: boolean; delete_action: string;
    }>(
      `SELECT c.relname AS table_name,
              a.attname AS column_name,
              NOT a.attnotnull AS is_nullable,
              con.confdeltype::text AS delete_action
         FROM pg_constraint con
         JOIN pg_class c ON c.oid = con.conrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN LATERAL unnest(con.conkey) AS k(attnum) ON true
         JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
         JOIN pg_class parent ON parent.oid = con.confrelid
        WHERE n.nspname = 'public'
          AND con.contype = 'f'
          AND parent.relname = 'users'
          AND (c.relname, a.attname) IN (
            ('medications','created_by'),
            ('medication_schedules','created_by'),
            ('prescriptions','created_by'),
            ('refill_events','created_by'),
            ('symptom_notes','created_by'),
            ('health_measurements','created_by'),
            ('caregiver_relationships','invited_by_user_id'),
            ('stored_objects','owner_user_id')
          )
        ORDER BY c.relname, a.attname`,
    );

    expect(rows).toHaveLength(8);
    expect(rows.every((r) => r.is_nullable)).toBe(true);
    // pg_constraint confdeltype 'n' = SET NULL.
    expect(rows.every((r) => r.delete_action === 'n')).toBe(true);
  });

  it('does not expose erasure helpers to PUBLIC', async () => {
    const { rows } = await h.worker.pool.query<{ name: string; public_exec: boolean; worker_exec: boolean }>(
      `SELECT p.proname AS name,
              EXISTS (
                SELECT 1
                  FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) acl
                 WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
              ) AS public_exec,
              has_function_privilege('dawaee_worker', p.oid, 'EXECUTE') AS worker_exec
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'app'
          AND p.proname IN (
            'erase_due_account','remove_abandoned_object_metadata',
            'list_due_account_ids','list_due_account_object_keys','list_abandoned_object_keys'
          )
        ORDER BY p.proname`,
    );
    expect(rows).toHaveLength(5);
    expect(rows.every((r) => r.public_exec === false)).toBe(true);
    expect(rows.every((r) => r.worker_exec === true)).toBe(true);
  });
});
