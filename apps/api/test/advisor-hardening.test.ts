import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetDatabase } from './harness.js';

let owner: pg.Pool;

beforeAll(() => {
  resetDatabase();
  owner = new pg.Pool({
    connectionString: 'postgres://postgres:postgres@127.0.0.1:5433/dawaee_test',
    max: 1,
  });
});

afterAll(async () => { await owner.end(); });

const hardenedFunctions = [
  'app.current_user_id()',
  'app.touch_updated_at()',
  'app.valid_permissions(text[])',
  'app.assert_profile_matches_medication()',
  'app.assert_caregiver_not_patient()',
  'app.try_job_lock(text)',
  'app.block_audit_mutation()',
  'app.audit_allow_only_profile_redaction()',
];

describe('Supabase advisor hardening', () => {
  it('pins search_path on every function flagged by the security advisor', async () => {
    for (const signature of hardenedFunctions) {
      const { rows } = await owner.query<{ config: string[] | null }>(
        `SELECT p.proconfig AS config
           FROM pg_proc p
          WHERE p.oid = $1::regprocedure`,
        [signature],
      );

      expect(rows, `${signature} was not found`).toHaveLength(1);
      expect(rows[0]?.config).toContain('search_path=pg_catalog, public, app');
    }
  });

  it('keeps the lease-era claimable index and removes the identical legacy queue index', async () => {
    const { rows } = await owner.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef
         FROM pg_indexes
        WHERE schemaname = 'public'
          AND tablename = 'notification_deliveries'
          AND indexname IN ('notification_claimable_idx', 'notification_queue_idx')
        ORDER BY indexname`,
    );

    expect(rows.map((r) => r.indexname)).toEqual(['notification_claimable_idx']);
    expect(rows[0]?.indexdef).toContain('(next_attempt_at)');
    expect(rows[0]?.indexdef).toContain("status = ANY (ARRAY['queued'::delivery_status, 'sending'::delivery_status])");
  });
});
