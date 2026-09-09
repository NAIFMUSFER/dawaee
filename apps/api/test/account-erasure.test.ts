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
    const { rows } = await h.worker.pool.query<{ table_name: string; column_name: string; is_nullable: string; delete_rule: string }>(
      `SELECT kcu.table_name, kcu.column_name, cols.is_nullable, rc.delete_rule
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON tc.constraint_name = kcu.constraint_name AND tc.constraint_schema = kcu.constraint_schema
         JOIN information_schema.constraint_column_usage ccu
           ON ccu.constraint_name = tc.constraint_name AND ccu.constraint_schema = tc.constraint_schema
         JOIN information_schema.referential_constraints rc
           ON rc.constraint_name = tc.constraint_name AND rc.constraint_schema = tc.constraint_schema
         JOIN information_schema.columns cols
           ON cols.table_schema = kcu.table_schema AND cols.table_name = kcu.table_name AND cols.column_name = kcu.column_name
        WHERE tc.constraint_type = 'FOREIGN KEY'
          AND ccu.table_name = 'users'
          AND (kcu.table_name, kcu.column_name) IN (
            ('medications','created_by'),
            ('medication_schedules','created_by'),
            ('prescriptions','created_by'),
            ('refill_events','created_by'),
            ('symptom_notes','created_by'),
            ('health_measurements','created_by'),
            ('caregiver_relationships','invited_by_user_id'),
            ('stored_objects','owner_user_id')
          )
        ORDER BY kcu.table_name, kcu.column_name`,
    );

    expect(rows).toHaveLength(8);
    expect(rows.every((r) => r.is_nullable === 'YES')).toBe(true);
    expect(rows.every((r) => r.delete_rule === 'SET NULL')).toBe(true);
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
          AND p.proname IN ('erase_due_account','remove_abandoned_object_metadata')
        ORDER BY p.proname`,
    );
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.public_exec === false)).toBe(true);
    expect(rows.every((r) => r.worker_exec === true)).toBe(true);
  });
});
