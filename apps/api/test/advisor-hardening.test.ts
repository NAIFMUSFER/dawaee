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

  it('relocates app extensions without invalidating the medication search index', async () => {
    const { rows: extensions } = await owner.query<{
      name: string;
      schema: string;
      relocatable: boolean;
    }>(
      `SELECT e.extname AS name,
              n.nspname AS schema,
              e.extrelocatable AS relocatable
         FROM pg_extension e
         JOIN pg_namespace n ON n.oid = e.extnamespace
        WHERE e.extname IN ('pg_trgm', 'btree_gist')
        ORDER BY e.extname`,
    );

    expect(extensions).toEqual([
      { name: 'btree_gist', schema: 'extensions', relocatable: true },
      { name: 'pg_trgm', schema: 'extensions', relocatable: true },
    ]);

    const { rows: indexes } = await owner.query<{
      index_name: string;
      opclass_schema: string;
      valid: boolean;
      ready: boolean;
    }>(
      `SELECT index_class.relname AS index_name,
              opclass_schema.nspname AS opclass_schema,
              idx.indisvalid AS valid,
              idx.indisready AS ready
         FROM pg_index idx
         JOIN pg_class index_class ON index_class.oid = idx.indexrelid
         CROSS JOIN LATERAL unnest(idx.indclass::oid[]) AS opclass_key(opclass_oid)
         JOIN pg_opclass opclass ON opclass.oid = opclass_key.opclass_oid
         JOIN pg_namespace opclass_schema ON opclass_schema.oid = opclass.opcnamespace
        WHERE index_class.relname = 'medications_name_trgm_idx'`,
    );

    expect(indexes).toEqual([
      {
        index_name: 'medications_name_trgm_idx',
        opclass_schema: 'extensions',
        valid: true,
        ready: true,
      },
    ]);

    const { rows: smoke } = await owner.query<{ similarity: number }>(
      `SELECT extensions.similarity('Panadol', 'Panadol') AS similarity`,
    );
    expect(Number(smoke[0]?.similarity)).toBe(1);
  });
});
