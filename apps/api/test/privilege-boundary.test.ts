import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetDatabase } from './harness.js';

/**
 * What the two runtime roles are allowed to do, pinned exactly.
 *
 * Two separate questions, and they need different answers.
 *
 * LEAST PRIVILEGE (P8-1): the worker's grants are an explicit allowlist, so
 * adding a table to it is a deliberate act rather than something that happens
 * by default. It used to happen by default — `ALTER DEFAULT PRIVILEGES … GRANT
 * SELECT, INSERT, UPDATE ON TABLES TO dawaee_worker` meant every table any
 * future migration created became readable by the worker automatically, which
 * is how it ended up able to read emergency cards and prescriptions it never
 * queries.
 *
 * TRUST BOUNDARY: `app.user_id` is a session GUC that the application role sets
 * itself. That is not a flaw to be fixed — it is the mechanism — but it decides
 * what row level security is actually worth, and the answer is written down
 * here rather than assumed. See the final describe block.
 */

let owner: pg.Pool;

/** The owner password differs from the application roles' in this environment. */
const PASSWORD: Record<string, string> = {
  postgres: 'postgres', dawaee_app: 'devpass', dawaee_worker: 'devpass',
};

const conn = (role: string) => new pg.Pool({
  connectionString: `postgres://${role}:${PASSWORD[role]}@127.0.0.1:5433/dawaee_test`, max: 2,
});

/**
 * The worker's complete, intended privilege set — derived from every SQL
 * statement in apps/worker/src, with the job that needs each one.
 *
 * A diff against this is a review event. That is the entire point: the previous
 * arrangement had no such list, so nobody could tell over-privilege from
 * intent.
 */
const WORKER_MANIFEST: Record<string, string[]> = {
  // reminders.ts
  dose_occurrences: ['SELECT', 'UPDATE'],
  medications: ['SELECT', 'UPDATE'],
  medication_schedules: ['SELECT'],
  patient_profiles: ['SELECT'],
  users: ['SELECT'],
  user_preferences: ['SELECT'],
  escalation_policies: ['SELECT'],
  caregiver_notification_rules: ['SELECT'],
  dose_events: ['INSERT'],
  // dispatcher
  notification_deliveries: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'],
  push_tokens: ['SELECT', 'UPDATE'],
  // stock-alerts.ts
  medication_stock: ['SELECT', 'UPDATE'],
  // housekeeping.ts
  caregiver_relationships: ['SELECT', 'UPDATE'],
  stored_objects: ['DELETE', 'SELECT'],
  // operational, no patient data, no RLS
  job_runs: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'],
  provider_webhook_events: ['DELETE', 'SELECT', 'UPDATE'],
};

/**
 * The SECURITY DEFINER functions the worker may execute.
 *
 * Only these two, because a SECURITY DEFINER function runs as the table owner
 * and is therefore a deliberate hole through every policy in the schema. The
 * authorization predicates (owns_profile, can_read_profile, caregives_profile,
 * has_permission) are also SECURITY DEFINER and executable by everyone, but
 * they answer a boolean about `app.current_user_id()` — which the worker never
 * sets — so they return false for it and disclose nothing. They are listed as
 * permitted rather than silently excluded.
 */
const WORKER_DEFINER_ALLOWED = [
  'can_read_profile', 'caregives_profile', 'cleanup_expired_sessions',
  'has_permission', 'owns_profile', 'purge_expired_otp',
  // Retention for the shared auth rate-limit buckets. Deletes by age only; it
  // cannot read a bucket, and the keys are keyed digests in any case, so this
  // grant carries no visibility of who tried to sign in or from where.
  'purge_rate_buckets',
];

/**
 * The ones a worker must never reach: they mint sessions, rotate refresh
 * tokens, set passwords, issue and verify one-time codes, redeem caregiver
 * invitations, and resolve emergency cards. Named explicitly so a regression
 * reports which capability leaked rather than a count.
 */
const WORKER_DEFINER_FORBIDDEN = [
  'accept_caregiver_invitation', 'clear_login_failures', 'create_session',
  'find_or_create_user_by_phone', 'find_user_for_password_login', 'issue_otp',
  'record_login_failure', 'register_with_password', 'resolve_emergency_qr',
  'revoke_session', 'rotate_session', 'session_is_live', 'set_password', 'verify_otp',
];

beforeAll(() => {
  resetDatabase();
  owner = conn('postgres');
});
afterAll(async () => { await owner.end(); });

async function grants(role: string) {
  const { rows } = await owner.query<{ table_name: string; privs: string }>(
    `SELECT table_name, string_agg(DISTINCT privilege_type, ',' ORDER BY privilege_type) AS privs
       FROM information_schema.role_table_grants
      WHERE grantee = $1 AND table_schema = 'public'
      GROUP BY table_name`,
    [role],
  );
  return Object.fromEntries(rows.map((r) => [r.table_name, r.privs.split(',')]));
}

describe('the worker holds exactly its manifest and nothing more', () => {
  it('touches no table outside the allowlist', async () => {
    const actual = await grants('dawaee_worker');
    const extra = Object.keys(actual).filter((t) => !(t in WORKER_MANIFEST)).sort();
    expect(extra, `worker gained access to tables not in the manifest:\n${extra.join('\n')}`)
      .toEqual([]);
  });

  it('holds exactly the verbs the manifest lists, per table', async () => {
    const actual = await grants('dawaee_worker');
    for (const [table, expected] of Object.entries(WORKER_MANIFEST)) {
      expect(actual[table]?.sort(), `grants on ${table}`).toEqual([...expected].sort());
    }
  });

  /**
   * The specific tables finding P8-1 named. Listed separately from the diff
   * above so a regression names the data that leaked rather than a count.
   */
  it('cannot read the PHI tables it never queries', async () => {
    const p = conn('dawaee_worker');
    try {
      for (const table of [
        'emergency_cards', 'symptom_notes', 'health_measurements', 'prescriptions',
        'consents', 'refill_events', 'travel_prompts', 'stock_transactions',
        'audit_logs', 'user_credentials', 'auth_otp_challenges',
      ]) {
        const res = await p.query(`SELECT 1 FROM ${table} LIMIT 1`)
          .then(() => ({ ok: true, msg: '' }))
          .catch((e: Error) => ({ ok: false, msg: e.message }));
        expect(res.ok, `worker can still read ${table}`).toBe(false);
        expect(res.msg).toMatch(/permission denied/i);
      }
    } finally { await p.end(); }
  });

  /**
   * auth_sessions holds a refresh token hash, device name and IP hash for every
   * user. The worker's only session work is deleting long-expired rows, and it
   * now does that through a function that returns a count.
   */
  it('cannot touch auth_sessions at all', async () => {
    const p = conn('dawaee_worker');
    try {
      for (const sql of [
        'SELECT 1 FROM auth_sessions LIMIT 1',
        'DELETE FROM auth_sessions WHERE false',
        "UPDATE auth_sessions SET device_name='x' WHERE false",
      ]) {
        const res = await p.query(sql).then(() => null).catch((e: Error) => e.message);
        expect(res, `worker could run: ${sql}`).toMatch(/permission denied/i);
      }
    } finally { await p.end(); }
  });

  it('inherits nothing automatically from a future migration', async () => {
    const { rows } = await owner.query<{ defaclacl: string }>(
      `SELECT array_to_string(defaclacl, ',') AS defaclacl FROM pg_default_acl d
         JOIN pg_namespace n ON n.oid = d.defaclnamespace
        WHERE n.nspname='public' AND d.defaclobjtype='r'`,
    );
    const acl = rows.map((r) => r.defaclacl).join(',');
    expect(acl, 'worker is in the default ACL for new tables').not.toMatch(/dawaee_worker=/);
    expect(acl, 'the API role should still inherit').toMatch(/dawaee_app=/);
  });
});

describe('the session cleanup function is a narrow hole, not a wide one', () => {
  it('deletes expired sessions and returns only a count', async () => {
    const p = conn('dawaee_worker');
    try {
      const res = await p.query<{ cleanup_expired_sessions: string }>(
        'SELECT app.cleanup_expired_sessions(30)',
      );
      expect(Number(res.rows[0]!.cleanup_expired_sessions)).toBeGreaterThanOrEqual(0);
      expect(Object.keys(res.rows[0]!)).toEqual(['cleanup_expired_sessions']);
    } finally { await p.end(); }
  });

  /**
   * A caller passing 0 or a negative number would delete sessions that have not
   * expired — signing every user of the product out at once. Validated inside
   * the function rather than trusted from the caller.
   */
  it('refuses an argument that would delete live sessions', async () => {
    const p = conn('dawaee_worker');
    try {
      for (const bad of [0, -1, -100000, 366, null]) {
        const err = await p.query('SELECT app.cleanup_expired_sessions($1)', [bad])
          .then(() => null).catch((e: Error) => e.message);
        expect(err, `accepted ${bad}`).toMatch(/must be between 1 and 365/);
      }
    } finally { await p.end(); }
  });

  it('leaves live sessions alone', async () => {
    const before = await owner.query<{ n: string }>(
      'SELECT count(*) AS n FROM auth_sessions WHERE expires_at > now()',
    );
    const p = conn('dawaee_worker');
    try { await p.query('SELECT app.cleanup_expired_sessions(1)'); } finally { await p.end(); }
    const after = await owner.query<{ n: string }>(
      'SELECT count(*) AS n FROM auth_sessions WHERE expires_at > now()',
    );
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
  });

  it('pins its search_path and is not executable by PUBLIC', async () => {
    const { rows } = await owner.query<{ proconfig: string[] | null; acl: string | null }>(
      `SELECT p.proconfig, array_to_string(p.proacl,',') AS acl
         FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='app' AND p.proname='cleanup_expired_sessions'`,
    );
    expect(rows).toHaveLength(1);
    expect((rows[0]!.proconfig ?? []).join(',')).toMatch(/search_path=/);
    expect(rows[0]!.acl ?? '', 'EXECUTE granted to PUBLIC').not.toMatch(/(^|,)=X\//);
    expect(rows[0]!.acl ?? '').toMatch(/dawaee_worker=X\//);
  });

  it('is not executable by the API role', async () => {
    const p = conn('dawaee_app');
    try {
      const err = await p.query('SELECT app.cleanup_expired_sessions(30)')
        .then(() => null).catch((e: Error) => e.message);
      expect(err, 'the API role can purge sessions').toMatch(/permission denied/i);
    } finally { await p.end(); }
  });

  it('can execute no SECURITY DEFINER function outside its allowlist', async () => {
    const { rows } = await owner.query<{ proname: string }>(
      `SELECT DISTINCT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='app' AND p.prosecdef
          AND has_function_privilege('dawaee_worker', p.oid, 'EXECUTE')`,
    );
    const names = rows.map((r) => r.proname).sort();
    expect(names, `worker SECURITY DEFINER grants drifted:\n${names.join('\n')}`)
      .toEqual([...WORKER_DEFINER_ALLOWED].sort());
  });

  /**
   * The capabilities that would matter. Executed rather than inferred from the
   * ACL, because a grant to PUBLIC would not show up as a grant to the worker.
   */
  it('cannot execute any session, credential or OTP function', async () => {
    const { rows } = await owner.query<{ proname: string }>(
      `SELECT DISTINCT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='app' AND p.prosecdef AND p.proname = ANY($1)
          AND has_function_privilege('dawaee_worker', p.oid, 'EXECUTE')`,
      [WORKER_DEFINER_FORBIDDEN],
    );
    expect(rows.map((r) => r.proname), 'worker can execute privileged auth functions').toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════════════
//  THE app.user_id TRUST BOUNDARY
// ══════════════════════════════════════════════════════════════════════

/**
 * Row level security here is scoped by a session GUC that the application role
 * sets for itself. This block establishes, by execution rather than by reading
 * the schema, exactly what that buys — because the honest description of it is
 * narrower than "the database enforces tenancy", and shipping while believing
 * the wider claim is how a system gets built on a boundary that was never there.
 *
 * WHAT IT IS. RLS is a backstop against APPLICATION AUTHORIZATION MISTAKES. If
 * a route forgets an ownership check, or takes a profile id from a request body
 * and trusts it, the policies still scope the query to the authenticated user —
 * which is precisely the class of bug the P8 matrix found nothing of, and the
 * reason that matrix is worth running.
 *
 * WHAT IT IS NOT. It is NOT containment against an attacker who can execute
 * arbitrary SQL on the runtime connection. Such an attacker sets `app.user_id`
 * to any value and reads any patient — the tests below prove it rather than
 * suppose it. So the security of this system against SQL injection rests on
 * parameterised queries and on the runtime role's own privileges, NOT on RLS,
 * and that dependency is what P12 (endpoint review) and P19 (adversarial
 * review) have to carry.
 *
 * The rest of this block establishes the containment that does exist: the
 * runtime role cannot become another role, cannot alter the schema, cannot
 * write a SECURITY DEFINER function, and cannot switch row security off.
 */
describe('the app.user_id trust boundary, established by execution', () => {
  it('the API role CAN set app.user_id to any value — RLS is not injection containment', async () => {
    const p = conn('dawaee_app');
    try {
      const c = await p.connect();
      await c.query('BEGIN');
      // An arbitrary identity, accepted without challenge. This is the
      // mechanism working as designed, and simultaneously the limit of what it
      // protects against.
      await c.query("SELECT set_config('app.user_id', '00000000-0000-4000-8000-000000000000', true)");
      const r = await c.query<{ id: string }>('SELECT app.current_user_id() AS id');
      await c.query('ROLLBACK');
      c.release();
      expect(r.rows[0]!.id).toBe('00000000-0000-4000-8000-000000000000');
    } finally { await p.end(); }
  });

  it('cannot become another database role', async () => {
    const p = conn('dawaee_app');
    try {
      for (const role of ['dawaee_worker', 'postgres']) {
        const err = await p.query(`SET ROLE ${role}`).then(() => null).catch((e: Error) => e.message);
        expect(err, `dawaee_app escalated to ${role}`).toBeTruthy();
        expect(err).toMatch(/permission denied|must be (a )?member/i);
      }
    } finally { await p.end(); }
  });

  it('is a member of no other role', async () => {
    const { rows } = await owner.query<{ n: string }>(
      `SELECT count(*) AS n FROM pg_auth_members m
         JOIN pg_roles r ON r.oid = m.member
        WHERE r.rolname IN ('dawaee_app','dawaee_worker')`,
    );
    expect(Number(rows[0]!.n), 'a runtime role inherits another role').toBe(0);
  });

  it('cannot create objects in public or app', async () => {
    const p = conn('dawaee_app');
    try {
      for (const sql of [
        'CREATE TABLE public.nc_evil (id int)',
        'CREATE TABLE app.nc_evil (id int)',
        'CREATE SCHEMA nc_evil',
      ]) {
        const err = await p.query(sql).then(() => null).catch((e: Error) => e.message);
        expect(err, `dawaee_app could run: ${sql}`).toMatch(/permission denied/i);
      }
    } finally { await p.end(); }
  });

  /**
   * The one that would end everything: a runtime role able to define a
   * SECURITY DEFINER function can write itself a function that runs as the
   * table owner and returns any row in the database.
   */
  it('cannot create a SECURITY DEFINER function', async () => {
    const p = conn('dawaee_app');
    try {
      const err = await p.query(
        `CREATE FUNCTION public.nc_pwn() RETURNS setof medications
         LANGUAGE sql SECURITY DEFINER AS $$ SELECT * FROM medications $$`,
      ).then(() => null).catch((e: Error) => e.message);
      expect(err, 'dawaee_app defined a SECURITY DEFINER function').toMatch(/permission denied/i);
    } finally { await p.end(); }
  });

  it('cannot alter policies, tables or row security', async () => {
    const p = conn('dawaee_app');
    try {
      for (const sql of [
        'ALTER TABLE medications DISABLE ROW LEVEL SECURITY',
        'ALTER TABLE medications NO FORCE ROW LEVEL SECURITY',
        'CREATE POLICY nc_open ON medications FOR SELECT USING (true)',
        'DROP POLICY IF EXISTS medications_definer ON medications',
        'ALTER TABLE medications ADD COLUMN nc int',
        'DROP TABLE medications',
      ]) {
        const err = await p.query(sql).then(() => null).catch((e: Error) => e.message);
        expect(err, `dawaee_app could run: ${sql}`).toMatch(/permission denied|must be owner/i);
      }
    } finally { await p.end(); }
  });

  /**
   * `row_security = off` makes a session error rather than silently returning
   * everything, but only for a role that is exempt from policies. A non-owner,
   * non-BYPASSRLS role gains nothing — asserted so the reasoning is on record.
   */
  it('gains nothing from setting row_security = off', async () => {
    const p = conn('dawaee_app');
    try {
      const c = await p.connect();
      await c.query('BEGIN');
      await c.query('SET LOCAL row_security = off');
      const res = await c.query<{ n: string }>('SELECT count(*) AS n FROM medications')
        .then((r) => ({ n: Number(r.rows[0]!.n), err: null as string | null }))
        .catch((e: Error) => ({ n: -1, err: e.message }));
      await c.query('ROLLBACK').catch(() => undefined);
      c.release();
      // Either it errors, or it returns nothing. Never everything.
      expect(res.n, 'row_security=off exposed rows').toBeLessThanOrEqual(0);
    } finally { await p.end(); }
  });

  it('cannot read credentials or sessions directly, RLS aside', async () => {
    const p = conn('dawaee_app');
    try {
      const err = await p.query('SELECT * FROM user_credentials LIMIT 1')
        .then(() => null).catch((e: Error) => e.message);
      expect(err, 'the API role can read password hashes').toMatch(/permission denied/i);
    } finally { await p.end(); }
  });

  it('the worker cannot become the API role either', async () => {
    const p = conn('dawaee_worker');
    try {
      const err = await p.query('SET ROLE dawaee_app').then(() => null).catch((e: Error) => e.message);
      expect(err, 'dawaee_worker escalated to dawaee_app').toBeTruthy();
    } finally { await p.end(); }
  });
});

describe('caregiver relationship writes have two independent controls', () => {
  /**
   * The trigger compares OLD to NEW and is the only thing that can express
   * "permissions unchanged" — a WITH CHECK clause cannot see OLD. But the
   * policy CAN constrain the row a caregiver is allowed to produce, and the
   * only legitimate caregiver self-update is leaving the care circle. So even
   * with the trigger gone, a caregiver's UPDATE can now only ever result in a
   * revoked row.
   */
  it('the WITH CHECK clause pins the caregiver branch to a revoked row', async () => {
    const { rows } = await owner.query<{ withcheck: string | null }>(
      `SELECT pg_get_expr(polwithcheck, polrelid) AS withcheck
         FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
        WHERE c.relname='caregiver_relationships' AND p.polname='caregiver_rel_update'`,
    );
    expect(rows).toHaveLength(1);
    const clause = rows[0]!.withcheck ?? '';
    expect(clause).toMatch(/owns_profile/);
    expect(clause, 'the caregiver branch is unconstrained').toMatch(/status\s*=\s*'revoked'/);
  });

  it('the OLD/NEW trigger is still present as the second control', async () => {
    const { rows } = await owner.query<{ tgname: string }>(
      `SELECT t.tgname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
        WHERE c.relname='caregiver_relationships' AND NOT t.tgisinternal
          AND t.tgname = 'caregiver_rel_privilege_guard'`,
    );
    expect(rows, 'the privilege guard trigger was removed').toHaveLength(1);
  });
});
