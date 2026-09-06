import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { resetDatabase, startHarness, type Harness } from './harness.js';

/**
 * The definer privilege model, and the topology the rest of the suite runs on.
 *
 * WHAT THIS FILE EXISTS TO PREVENT
 *
 * A SECURITY DEFINER function runs as the role that owns it — here the role that
 * runs migrations, which also owns every table. Under FORCE ROW LEVEL SECURITY
 * that role is NOT exempt from its own tables' policies unless it is a
 * superuser or holds BYPASSRLS, and no managed PostgreSQL grants either.
 *
 * Migration 0008 knew this and granted the exemption for seven tables, listed by
 * hand. Twenty tables created afterwards were never added to the list. Measured
 * consequences, on a database differing from the old test database only in the
 * owner's `rolsuper` and `rolbypassrls`:
 *
 *   * POST /v1/auth/register -> 404. `app.register_with_password` could not
 *     INSERT `user_credentials` (SQLSTATE 42501). The product was unusable from
 *     its first request, and 1013 tests passed anyway.
 *   * Upgrading a populated 0019 database aborted at 0025: its dedup DELETE on
 *     `dose_events` matched zero rows — silently, because RLS filtering a DELETE
 *     to nothing is not an error — and the unique index that followed failed on
 *     duplicate keys, with 0020-0024 already committed.
 *
 * The test database is now owned by `dawaee_migrator`, which is deliberately
 * NOSUPERUSER and NOBYPASSRLS. Every assertion below is therefore about the
 * configuration production runs on, not a laboratory one.
 */

const PGHOST = '127.0.0.1';
const PGPORT = 5433;
const DB = 'dawaee_test';

function conn(user: string, password: string): pg.Pool {
  return new pg.Pool({
    connectionString: `postgres://${user}:${password}@${PGHOST}:${PGPORT}/${DB}`,
    max: 2,
    connectionTimeoutMillis: 5000,
  });
}

const owner = () => conn('dawaee_migrator', process.env.DAWAEE_MIGRATOR_PASSWORD ?? 'migratorpw');
const asApp = () => conn('dawaee_app', 'devpass');
const asWorker = () => conn('dawaee_worker', 'devpass');

async function one<T extends Record<string, unknown>>(pool: pg.Pool, sql: string): Promise<T> {
  const { rows } = await pool.query<T>(sql);
  return rows[0]!;
}
async function all<T extends Record<string, unknown>>(pool: pg.Pool, sql: string): Promise<T[]> {
  const { rows } = await pool.query<T>(sql);
  return rows;
}

let root: pg.Pool;
let harness: Harness;

beforeAll(async () => {
  resetDatabase();
  root = owner();
  harness = await startHarness();
}, 120_000);

afterAll(async () => {
  await root?.end().catch(() => undefined);
  await harness?.close().catch(() => undefined);
});

// ══════════════════════════════════════════════ the topology itself

describe('the test topology matches a managed PostgreSQL', () => {
  /**
   * The single assertion that would have prevented every failure this file
   * documents. If someone makes the migration role a superuser to get past an
   * error, every row-level-security test in the repository silently stops
   * proving anything, and nothing else would notice.
   */
  it('the migration owner is NOSUPERUSER and NOBYPASSRLS', async () => {
    const r = await one<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean }>(
      root,
      "SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
    );
    expect(r.rolsuper, `${r.rolname} is a superuser`).toBe(false);
    expect(r.rolbypassrls, `${r.rolname} can bypass RLS`).toBe(false);
  });

  it('the database is owned by that role, not by a superuser', async () => {
    const r = await one<{ owner: string; owner_super: boolean }>(
      root,
      `SELECT pg_get_userbyid(datdba) AS owner,
              (SELECT rolsuper FROM pg_roles WHERE oid = datdba) AS owner_super
         FROM pg_database WHERE datname = current_database()`,
    );
    expect(r.owner).toBe('dawaee_migrator');
    expect(r.owner_super, 'the database owner is a superuser').toBe(false);
  });

  it('every table and every definer function has the same owner', async () => {
    const strays = await all<{ kind: string; name: string; owner: string }>(
      root,
      `SELECT 'table' AS kind, c.relname AS name, pg_get_userbyid(c.relowner) AS owner
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r'
          AND pg_get_userbyid(c.relowner) <> current_user
       UNION ALL
       SELECT 'function', p.proname, pg_get_userbyid(p.proowner)
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'app' AND p.prosecdef
          AND pg_get_userbyid(p.proowner) <> current_user`,
    );
    expect(strays, 'ownership is split, so the definer path cannot be reasoned about').toEqual([]);
  });

  it('neither runtime role can bypass row level security', async () => {
    const rows = await all<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean }>(
      root,
      "SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname IN ('dawaee_app','dawaee_worker') ORDER BY 1",
    );
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.rolsuper, `${r.rolname} is a superuser`).toBe(false);
      expect(r.rolbypassrls, `${r.rolname} holds BYPASSRLS`).toBe(false);
    }
  });
});

// ══════════════════════════════════════════════ structural drift

describe('the definer exemption covers every forced table', () => {
  /**
   * The drift guard. A hand-kept list is what went stale; this asserts the
   * property directly against the catalogue, so a table added by a future
   * migration fails here rather than in production.
   */
  it('no FORCE ROW LEVEL SECURITY table is missing its definer policy', async () => {
    const uncovered = await all<{ relname: string }>(
      root,
      `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relforcerowsecurity
          AND NOT EXISTS (SELECT 1 FROM pg_policies p
                           WHERE p.schemaname = 'public' AND p.tablename = c.relname
                             AND p.policyname = c.relname || '_definer')
        ORDER BY 1`,
    );
    expect(uncovered.map((r) => r.relname),
      'these tables would deny every SECURITY DEFINER function').toEqual([]);
  });

  it('there is more than a handful of them, so this is not passing vacuously', async () => {
    const r = await one<{ n: string }>(
      root,
      `SELECT count(*)::text AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relforcerowsecurity`,
    );
    expect(Number(r.n)).toBeGreaterThan(20);
  });

  it('a table that enables row level security also forces it', async () => {
    const unforced = await all<{ relname: string }>(
      root,
      `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r'
          AND c.relrowsecurity AND NOT c.relforcerowsecurity ORDER BY 1`,
    );
    expect(unforced.map((r) => r.relname),
      'the owner is exempt on these, which defeats the model').toEqual([]);
  });

  /**
   * The tables with no row-level security at all, pinned by name. Three hold no
   * patient data and one is the ledger. A patient table added without RLS would
   * appear here and fail, which is the point; updating this list is a review
   * decision, not a formality.
   */
  it('only the operational tables opt out of row level security', async () => {
    const bare = await all<{ relname: string }>(
      root,
      `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity ORDER BY 1`,
    );
    expect(bare.map((r) => r.relname)).toEqual([
      'job_runs',                 // worker bookkeeping, no patient data
      'provider_webhook_events',  // delivery receipts, no patient data
      'schema_migrations',        // the ledger
    ]);
  });
});

// ══════════════════════════════════════════════ containment

describe('the exemption cannot be reached from a request', () => {
  it('every definer policy names exactly one role, and it is the owner', async () => {
    const rows = await all<{ tablename: string; policyname: string; roles: string }>(
      root,
      `SELECT tablename, policyname, roles::text AS roles FROM pg_policies
        WHERE schemaname = 'public' AND policyname LIKE '%\\_definer' ORDER BY 1`,
    );
    expect(rows.length).toBeGreaterThan(20);
    for (const r of rows) {
      expect(r.roles, `${r.policyname} names more than one role`).toBe('{dawaee_migrator}');
    }
  });

  /**
   * A permissive policy granted TO PUBLIC unions with every role's own policies
   * and silently undoes the tenancy model. 0021 introduced one by dropping a
   * `TO dawaee_app` clause during a rewrite; 0030's assertion caught it.
   */
  it('no policy anywhere in public is granted TO PUBLIC', async () => {
    const rows = await all<{ tablename: string; policyname: string }>(
      root,
      `SELECT tablename, policyname FROM pg_policies
        WHERE schemaname = 'public' AND roles::text[] @> ARRAY['public'] ORDER BY 1, 2`,
    );
    expect(rows).toEqual([]);
  });

  it('neither runtime role is a member of the owner, so neither can SET ROLE to it', async () => {
    const r = await one<{ app_member: boolean; worker_member: boolean }>(
      root,
      `SELECT pg_has_role('dawaee_app', current_user, 'MEMBER') AS app_member,
              pg_has_role('dawaee_worker', current_user, 'MEMBER') AS worker_member`,
    );
    expect(r.app_member, 'dawaee_app can become the schema owner').toBe(false);
    expect(r.worker_member, 'dawaee_worker can become the schema owner').toBe(false);
  });

  it('the owner administers the runtime roles without inheriting them', async () => {
    // PostgreSQL 16 needs ADMIN on a role to change its password, and
    // scripts/migrate.sh sets both on every deploy. Granted WITH INHERIT FALSE,
    // SET FALSE so the owner cannot read through their policies: plain
    // membership made the owner see `dose_events` through the worker's policy
    // and silently disarmed NC2.
    for (const runtime of ['dawaee_app', 'dawaee_worker']) {
      const r = await one<{ admin: boolean; inherits: boolean; can_set: boolean }>(
        root,
        `SELECT pg_has_role(current_user, '${runtime}', 'MEMBER') AS admin,
                pg_has_role(current_user, '${runtime}', 'USAGE')  AS inherits,
                pg_has_role(current_user, '${runtime}', 'SET')    AS can_set`,
      );
      expect(r.admin, `the owner cannot administer ${runtime}, so migrate.sh will fail`).toBe(true);
      expect(r.inherits, `the owner inherits ${runtime}'s privileges and policies`).toBe(false);
      expect(r.can_set, `the owner can SET ROLE to ${runtime}`).toBe(false);
    }
  });

  it('SET ROLE to the owner is refused at runtime, not merely absent from the catalogue', async () => {
    for (const [label, pool] of [['dawaee_app', asApp()], ['dawaee_worker', asWorker()]] as const) {
      try {
        const err = await pool.query('SET ROLE dawaee_migrator').then(() => null, (e: Error) => e);
        expect(err, `${label} was able to SET ROLE dawaee_migrator`).toBeTruthy();
        expect(String(err?.message)).toMatch(/permission denied|must be a member/i);
      } finally {
        await pool.end();
      }
    }
  });

  /**
   * The definer policies are `USING (true)`, which is only defensible because
   * the grantee is a role no request can reach. This asserts the other half:
   * the runtime role's own view of a table with a definer policy is still
   * scoped by its own policies.
   */
  it('the definer policy does not widen what the application role can see', async () => {
    const pool = asApp();
    try {
      // No `app.user_id` set: every patient row must be invisible, definer
      // policy or not.
      for (const table of ['patient_profiles', 'medications', 'dose_occurrences', 'user_preferences']) {
        const { rows } = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table}`);
        expect(Number(rows[0]!.n), `${table} visible to dawaee_app with no identity`).toBe(0);
      }
      // And the table the definer path exists for is not readable at all.
      const err = await pool.query('SELECT 1 FROM user_credentials').then(() => null, (e: Error) => e);
      expect(String(err?.message)).toMatch(/permission denied/i);
    } finally {
      await pool.end();
    }
  });
});

// ══════════════════════════════════════════════ behaviour

describe('every SECURITY DEFINER flow works under a non-BYPASSRLS owner', () => {
  const send = (() => {
    let n = 0;
    return (opts: { method: string; url: string; payload?: unknown; headers?: Record<string, string> }) => {
      n += 1;
      return harness.app.inject({
        method: opts.method as 'GET',
        url: opts.url,
        payload: opts.payload as object,
        headers: { 'x-forwarded-for': `10.77.${Math.floor(n / 250) % 250}.${n % 250}`, ...(opts.headers ?? {}) },
      });
    };
  })();

  const pw = 'DefinerModel!Pass123';
  let phone: string;
  let access: string;
  let refresh: string;
  let profileId: string;

  it('registration writes users, patient_profiles, user_preferences AND user_credentials', async () => {
    phone = `+9665${String(4100000 + Math.floor(Math.random() * 800000)).slice(0, 8)}`;
    const res = await send({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { phone, displayName: 'نموذج المُعرِّف', password: pw, locale: 'ar', deviceId: 'definer-test-device' },
    });
    // The exact request that returned 404 on a realistic owner before 0030.
    expect(res.statusCode, res.body.slice(0, 200)).toBe(200);
    const body = res.json() as { accessToken: string; refreshToken: string };
    access = body.accessToken;
    refresh = body.refreshToken;
    expect(access).toBeTruthy();

    // Four FORCE-RLS tables, one of which (user_credentials) has no grant to any
    // runtime role at all — so this row can only have been written through the
    // definer path.
    const r = await one<{ users: string; profiles: string; prefs: string; creds: string }>(
      root,
      `SELECT (SELECT count(*)::text FROM users WHERE phone_e164 = '${phone}') AS users,
              (SELECT count(*)::text FROM patient_profiles p JOIN users u ON u.id = p.owner_user_id
                WHERE u.phone_e164 = '${phone}') AS profiles,
              (SELECT count(*)::text FROM user_preferences up JOIN users u ON u.id = up.user_id
                WHERE u.phone_e164 = '${phone}') AS prefs,
              (SELECT count(*)::text FROM user_credentials uc JOIN users u ON u.id = uc.user_id
                WHERE u.phone_e164 = '${phone}') AS creds`,
    );
    expect(r).toEqual({ users: '1', profiles: '1', prefs: '1', creds: '1' });
  });

  it('password login reads the credential through app.find_user_for_password_login', async () => {
    const res = await send({
      method: 'POST', url: '/v1/auth/login',
      payload: { identifier: phone, password: pw, deviceId: 'definer-test-device-2' },
    });
    expect(res.statusCode, res.body.slice(0, 200)).toBe(200);
  });

  it('a wrong password records a failure through app.record_login_failure', async () => {
    const res = await send({
      method: 'POST', url: '/v1/auth/login',
      payload: { identifier: phone, password: 'wrong-on-purpose', deviceId: 'definer-test-device-3' },
    });
    expect([401, 429]).toContain(res.statusCode);
    const r = await one<{ n: string }>(
      root,
      `SELECT failed_login_count::text AS n FROM user_credentials uc
         JOIN users u ON u.id = uc.user_id WHERE u.phone_e164 = '${phone}'`,
    );
    expect(Number(r.n), 'the failure was not recorded').toBeGreaterThan(0);
  });

  it('the shared rate limiter writes auth_rate_buckets through app.consume_rate_budget', async () => {
    const before = await one<{ n: string }>(root, 'SELECT count(*)::text AS n FROM auth_rate_buckets');
    await send({
      method: 'POST', url: '/v1/auth/login',
      payload: { identifier: phone, password: 'wrong-again', deviceId: 'definer-test-device-4' },
    });
    const after = await one<{ n: string }>(root, 'SELECT count(*)::text AS n FROM auth_rate_buckets');
    expect(Number(after.n), 'no rate bucket was written').toBeGreaterThanOrEqual(Number(before.n));
    expect(Number(after.n)).toBeGreaterThan(0);
  });

  it('session rotation works through app.rotate_session', async () => {
    const res = await send({ method: 'POST', url: '/v1/auth/refresh', payload: { refreshToken: refresh } });
    expect(res.statusCode, res.body.slice(0, 200)).toBe(200);
    access = (res.json() as { accessToken: string }).accessToken;
  });

  it('an authenticated read works, and the profile came from the definer path', async () => {
    const res = await send({ method: 'GET', url: '/v1/profiles', headers: { authorization: `Bearer ${access}` } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { profiles?: Array<{ id: string }> } | Array<{ id: string }>;
    const list = Array.isArray(body) ? body : (body.profiles ?? []);
    expect(list.length).toBeGreaterThan(0);
    profileId = list[0]!.id;
  });

  it('an ordinary RLS write works: a medication, scoped by policy rather than by definer', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const res = await send({
      method: 'POST', url: '/v1/medications',
      headers: { authorization: `Bearer ${access}` },
      payload: {
        patientProfileId: profileId, name: 'ميتفورمين', form: 'tablet',
        foodInstruction: 'no_preference', startDate: today,
        schedule: {
          rule: { kind: 'fixed_times', times: ['08:00'] }, doseQuantity: 1, doseUnit: 'tablet',
          startDate: today, missedAfterMinutes: 120, lateAfterMinutes: 15,
        },
      },
    });
    expect(res.statusCode, res.body.slice(0, 200)).toBe(200);
  });

  it('a password change works through app.password_hash_for_user and app.set_password', async () => {
    const res = await send({
      method: 'POST', url: '/v1/auth/password',
      headers: { authorization: `Bearer ${access}` },
      payload: { currentPassword: pw, newPassword: 'DefinerModel!Changed456' },
    });
    expect(res.statusCode, res.body.slice(0, 200)).toBe(200);
  });

  it('the emergency card resolves through app.resolve_emergency_qr', async () => {
    const enable = await send({
      method: 'POST', url: `/v1/emergency/qr/enable?profileId=${profileId}`,
      headers: { authorization: `Bearer ${access}` }, payload: {},
    });
    expect(enable.statusCode).toBe(200);
    const body = enable.json() as { token?: string; scanUrl?: string; url?: string };
    const token = body.token ?? body.scanUrl?.split('/').pop() ?? body.url?.split('/').pop();
    expect(token).toBeTruthy();
    const scan = await send({ method: 'GET', url: `/v1/emergency/scan/${token}` });
    expect(scan.statusCode).toBe(200);
  });

  it('housekeeping runs as the worker role, which owns none of this', async () => {
    const pool = asWorker();
    try {
      for (const call of [
        'SELECT app.cleanup_expired_sessions(30)',
        'SELECT app.purge_expired_otp(7)',
        'SELECT app.purge_rate_buckets(24)',
      ]) {
        const { rows } = await pool.query<Record<string, string>>(call);
        expect(Number(Object.values(rows[0]!)[0]), `${call} did not return a count`).toBeGreaterThanOrEqual(0);
      }
    } finally {
      await pool.end();
    }
  });
});

// ══════════════════════════════════════ negative controls

/**
 * Each control below is mutated in a transaction that is then rolled back, so
 * the database is unchanged. The point is not to test PostgreSQL: it is to show
 * that if the control were absent, something would actually break — a test that
 * cannot fail proves nothing, and P18 found two of those.
 */
describe('negative controls — each protection is load-bearing', () => {
  it('NC1: without the definer policy, registration is refused at the credential table', async () => {
    const client = await root.connect();
    try {
      await client.query('BEGIN');
      await client.query('DROP POLICY user_credentials_definer ON user_credentials');
      const err = await client
        .query(`SELECT app.register_with_password('+966509999001', NULL, 'nc1', 'scrypt$x', 'ar')`)
        .then(() => null, (e: Error & { code?: string }) => e);
      expect(err, 'registration succeeded with the definer policy removed').toBeTruthy();
      expect(err?.code, 'expected an RLS refusal (42501)').toBe('42501');
      expect(String(err?.message)).toMatch(/row-level security policy for table "user_credentials"/);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });

  it('NC2: without the definer policy, 0025-style dedup DML silently matches nothing', async () => {
    const client = await root.connect();
    try {
      await client.query('BEGIN');
      // Model the pre-0025 state: the guard index does not exist yet, and the
      // table carries the duplicates the worker race produced.
      await client.query('DROP INDEX dose_events_one_missed_idx');
      await client.query(`
        INSERT INTO dose_events (dose_occurrence_id, patient_profile_id, type, at)
        SELECT o.id, o.patient_profile_id, 'missed', now() - (g || ' minutes')::interval
          FROM dose_occurrences o, generate_series(1, 3) g
         WHERE o.id = (SELECT id FROM dose_occurrences ORDER BY scheduled_at LIMIT 1)`);
      const seeded = await client.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM dose_events WHERE type = 'missed'");
      expect(Number(seeded.rows[0]!.n),
        'no duplicates were seeded, so this control would pass vacuously').toBeGreaterThanOrEqual(3);

      await client.query('DROP POLICY dose_events_definer ON dose_events');

      // The exact shape of 0025's dedup DELETE. No error, no rows — which is how
      // a migration commits a lie and the index build fails immediately after.
      const del = await client.query(
        `DELETE FROM dose_events e USING dose_events keep
          WHERE e.type = 'missed' AND keep.type = 'missed'
            AND e.dose_occurrence_id = keep.dose_occurrence_id
            AND (keep.at < e.at OR (keep.at = e.at AND keep.id < e.id))`);
      expect(del.rowCount, 'the DELETE removed rows, so the silence is not reproduced').toBe(0);

      const visible = await client.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM dose_events WHERE type = 'missed'");
      expect(visible.rows[0]!.n, 'rows stayed visible without the policy').toBe('0');

      // And the consequence that aborted the upgrade: the index cannot be built.
      const err = await client
        .query(`CREATE UNIQUE INDEX dose_events_one_missed_idx ON dose_events (dose_occurrence_id) WHERE type = 'missed'`)
        .then(() => null, (e: Error) => e);
      expect(err, 'the unique index built despite the duplicates').toBeTruthy();
      expect(String(err?.message)).toMatch(/could not create unique index|duplicate key/i);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });

  it('NC3: a blanket policy for dawaee_app really does expose other patients', async () => {
    // Committed rather than rolled back, because the leak has to be observed
    // from a SEPARATE connection as dawaee_app — an uncommitted policy is
    // invisible to it, and a control nobody can see fire is not a control.
    // Dropped in `finally`, and this database is rebuilt per suite file anyway.
    const app = asApp();
    try {
      const before = await app.query<{ n: string }>('SELECT count(*)::text AS n FROM patient_profiles');
      expect(before.rows[0]!.n, 'the app role already sees profiles with no identity set').toBe('0');

      const seeded = await one<{ n: string }>(root, 'SELECT count(*)::text AS n FROM patient_profiles');
      expect(Number(seeded.n), 'no profiles exist, so the leak could not show').toBeGreaterThan(0);

      await root.query('CREATE POLICY nc3_leak ON patient_profiles TO dawaee_app USING (true)');

      const after = await app.query<{ n: string }>('SELECT count(*)::text AS n FROM patient_profiles');
      expect(Number(after.rows[0]!.n),
        'the blanket policy did not actually widen anything, so the containment check is unfalsifiable')
        .toBe(Number(seeded.n));
    } finally {
      await root.query('DROP POLICY IF EXISTS nc3_leak ON patient_profiles').catch(() => undefined);
      const after = await app.query<{ n: string }>('SELECT count(*)::text AS n FROM patient_profiles')
        .catch(() => ({ rows: [{ n: 'error' }] }));
      expect(after.rows[0]!.n, 'the leak was not cleaned up').toBe('0');
      await app.end();
    }
  });

  it('NC4: a policy granted TO PUBLIC is detected', async () => {
    const client = await root.connect();
    try {
      await client.query('BEGIN');
      await client.query('CREATE POLICY nc4_public ON patient_profiles USING (true)');
      const { rows } = await client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM pg_policies
          WHERE schemaname='public' AND roles::text[] @> ARRAY['public']`,
      );
      expect(Number(rows[0]!.n), 'the TO PUBLIC check would not have fired').toBeGreaterThan(0);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });

  it('NC5: if the app role could SET ROLE to the owner, the escalation check fires', async () => {
    // Not mutated — granting cluster-wide membership is not transactional in a
    // way this suite should rely on, and the property is a catalogue fact.
    // Instead: prove the check distinguishes, by asking it about a pair where
    // the answer is known to be true.
    const r = await one<{ self: boolean; app_to_owner: boolean }>(
      root,
      `SELECT pg_has_role(current_user, current_user, 'MEMBER') AS self,
              pg_has_role('dawaee_app', current_user, 'MEMBER') AS app_to_owner`,
    );
    expect(r.self, 'pg_has_role always returns false, so the check is vacuous').toBe(true);
    expect(r.app_to_owner).toBe(false);
  });

  it('NC6: making the owner BYPASSRLS would hide every failure above', async () => {
    // The attribute that made 1013 tests pass against a broken configuration.
    // Asserted as absent rather than toggled: ALTER ROLE is not transactional,
    // and a test that leaves a superuser behind is worse than no test.
    const r = await one<{ rolbypassrls: boolean }>(
      root, 'SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user',
    );
    expect(r.rolbypassrls,
      'the owner bypasses RLS, so NC1 and NC2 above cannot fail and prove nothing').toBe(false);
  });
});

// ══════════════════════════════════ P19 §6 — the last SQL interpolation

/**
 * `runStep` builds `SAVEPOINT ${step}` by interpolation, because a savepoint
 * name cannot be a bind parameter. Every caller passes a literal, so nothing
 * user-controlled reaches it — but it is the only interpolation left in the
 * codebase, and "no caller does that today" is a property of today.
 */
describe('P19 the one unparameterised identifier is guarded', () => {
  it('rejects a step name that is not a bare identifier', async () => {
    const { runStep } = await import('../../worker/src/jobs/housekeeping-step.js');
    const ctx = { log: { error: () => undefined } } as never;
    const client = {
      query: async () => { throw new Error('the guard let a hostile name through to the database'); },
    } as never;
    for (const hostile of [
      'otp; DROP TABLE users; --',
      'a" ; SELECT 1',
      "x' OR '1'='1",
      '1otp',
      '',
      'a'.repeat(64),
    ]) {
      const outcome = { removed: 0, failures: [] as Array<{ step: string; error: string }> };
      await expect(runStep(ctx, client, outcome, hostile, async () => 0))
        .rejects.toThrow(/not a safe identifier/);
    }
  });

  it('and still accepts every name the worker actually uses', async () => {
    const { runStep } = await import('../../worker/src/jobs/housekeeping-step.js');
    const seen: string[] = [];
    const ctx = { log: { error: () => undefined } } as never;
    const client = { query: async (sql: string) => { seen.push(sql); return { rows: [] }; } } as never;
    for (const good of ['otp', 'expired', 'sessions', 'deliveries', 'rateBuckets', 'webhooks', 'jobs', 'uploads', 'expiredMeds']) {
      const outcome = { removed: 0, failures: [] as Array<{ step: string; error: string }> };
      await runStep(ctx, client, outcome, good, async () => 1);
      expect(outcome.removed, `${good} did not run`).toBe(1);
    }
    expect(seen.filter((s) => s.startsWith('SAVEPOINT ')).length).toBe(9);
  });

  it('the worker passes only literals, so nothing dynamic reaches it', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(import.meta.dirname, '../../worker/src/jobs/housekeeping.ts'), 'utf8');
    const calls = [...src.matchAll(/runStep\(\s*ctx,\s*client,\s*outcome,\s*([^,]+),/g)].map((m) => m[1]!.trim());
    expect(calls.length).toBeGreaterThan(5);
    for (const arg of calls) {
      expect(arg, `runStep called with a non-literal step name: ${arg}`).toMatch(/^'[a-zA-Z][a-zA-Z0-9_]*'$/);
    }
  });
});
