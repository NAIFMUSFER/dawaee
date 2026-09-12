import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeaders, resetDatabase, signIn, startHarness, type Harness, type TestUser } from './harness.js';

/**
 * The adversarial CRUD matrix, executed against the database directly.
 *
 * The API is NOT used to make these attempts. Every route check is bypassed and
 * the queries are issued on a connection opened as `dawaee_app` — the role the
 * running API actually uses — with `app.user_id` set to the attacker. That is
 * the only way to answer the question this phase asks: not "does the API refuse
 * to build this query", but "if it ever did build it, would the database stop
 * it". A route guard is one bug away from being absent; row level security is
 * the layer that has to hold when it is.
 *
 * Every case below is written as an ATTACK with a stated expectation, and
 * `granted` is measured rather than assumed — a SELECT that returns zero rows
 * and an UPDATE that reports zero affected rows are both "denied", while an
 * error is denied for a different reason and is recorded separately, because
 * "it threw" and "it silently did nothing" have very different failure modes if
 * a policy is later relaxed.
 */

let h: Harness;
let alice: TestUser;      // Patient A
let bob: TestUser;        // Patient B
let carol: TestUser;       // Caregiver of A
let dave: TestUser;       // Caregiver of B
let mallory: TestUser;    // Caregiver of A, later REVOKED

let aliceMedId: string;
let aliceDoseId: string;
let bobMedId: string;
let bobDoseId: string;
let aliceScheduleId: string;
let bobScheduleId: string;
let malloryRelId: string;

const DATE = '2026-05-04';
const at = (hhmm: string) => {
  const [hh, mm] = hhmm.split(':').map(Number) as [number, number];
  return new Date(Date.UTC(2026, 4, 4, hh - 3, mm, 0));
};

/** A pool for the RUNTIME role, not the owner. This is the whole point. */
let appPool: pg.Pool;
/** The owner, used only to observe ground truth and to seed. */
let ownerPool: pg.Pool;

/**
 * Run one statement as `dawaee_app` with `app.user_id` set to `actor`, exactly
 * as `withUser()` does in production — transaction-scoped, so nothing leaks to
 * the next borrower of the pooled connection.
 */
async function asUser<T extends pg.QueryResultRow = pg.QueryResultRow>(
  actor: string | null, sql: string, params: unknown[] = [], rollback = false,
): Promise<{ rows: T[]; rowCount: number; error: string | null; errorCode: string | null; errorConstraint: string | null }> {
  const client = await appPool.connect();
  try {
    await client.query('BEGIN');
    if (actor) await client.query('SELECT set_config($1,$2,true)', ['app.user_id', actor]);
    const res = await client.query<T>(sql, params);
    await client.query(rollback ? 'ROLLBACK' : 'COMMIT');
    return { rows: res.rows, rowCount: res.rowCount ?? 0, error: null, errorCode: null, errorConstraint: null };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    return { rows: [], rowCount: 0, error: (err as Error).message,
      errorCode: (err as { code?: string }).code ?? null,
      errorConstraint: (err as { constraint?: string }).constraint ?? null };
  } finally {
    client.release();
  }
}

/** Ground truth, read as the owner, so a denied write can be proven not to have happened. */
async function truth<T extends pg.QueryResultRow = pg.QueryResultRow>(
  sql: string, params: unknown[] = [],
): Promise<T[]> {
  const res = await ownerPool.query<T>(sql, params);
  return res.rows;
}

/** Every attempt that ran, for the printed matrix at the end. */
const matrix: Array<{
  resource: string; actor: string; op: string; expected: 'DENY' | 'ALLOW';
  actual: 'DENIED' | 'ALLOWED' | 'ERROR'; status: 'PASS' | 'FAIL' | 'FINDING';
  errorCode: string | null;
  errorConstraint: string | null;
}> = [];

/** SQL/schema/connection failures are not evidence of an authorization denial. */
function classifyAttempt(
  expected: 'DENY' | 'ALLOW', rowCount: number, error: string | null,
  errorCode: string | null, expectedErrorCode = '42501',
  errorConstraint: string | null = null, expectedErrorConstraint: string | null = null,
) {
  const actual: 'DENIED' | 'ALLOWED' | 'ERROR' =
    error ? 'ERROR' : rowCount > 0 ? 'ALLOWED' : 'DENIED';
  const matchingError = errorCode === expectedErrorCode
    && (expectedErrorConstraint === null || errorConstraint === expectedErrorConstraint);
  const ok = expected === 'DENY'
    ? error ? matchingError : rowCount === 0 && expectedErrorConstraint === null
    : !error && rowCount > 0;
  return { actual, ok };
}

/**
 * `finding` marks a row that is knowingly open and tracked as an open finding
 * rather than an unexplained failure. Without the distinction the printed
 * matrix would read as eight unexplained cross-account holes, which is exactly
 * the kind of summary that gets waved through.
 */
function record(
  resource: string, actor: string, op: string,
  expected: 'DENY' | 'ALLOW', rowCount: number, error: string | null,
  errorCode: string | null = null, finding = false, expectedErrorCode = '42501',
  errorConstraint: string | null = null, expectedErrorConstraint: string | null = null,
) {
  const { actual, ok } = classifyAttempt(expected, rowCount, error, errorCode,
    expectedErrorCode, errorConstraint, expectedErrorConstraint);
  matrix.push({
    resource, actor, op, expected, actual, errorCode, errorConstraint,
    status: ok ? 'PASS' : finding ? 'FINDING' : 'FAIL',
  });
  return { actual, ok };
}

/** Assert an attack was stopped, and say which resource and actor if it was not. */
async function denied(
  resource: string, actor: string, op: string,
  run: () => Promise<{ rowCount: number; error: string | null; errorCode?: string | null }>,
) {
  const res = await run();
  const { ok } = record(resource, actor, op, 'DENY', res.rowCount, res.error, res.errorCode);
  expect(ok, `${actor} ${op} ${resource} — access granted or invalid probe (${res.errorCode ?? 'none'}): ${res.error ?? ''}`).toBe(true);
}

/** Assert the legitimate owner is still able to do the thing. */
async function allowed(
  resource: string, actor: string, op: string,
  run: () => Promise<{ rowCount: number; error: string | null; errorCode?: string | null }>,
) {
  const res = await run();
  const { actual } = record(resource, actor, op, 'ALLOW', res.rowCount, res.error, res.errorCode);
  expect(actual, `${actor} ${op} ${resource} was wrongly blocked: ${res.error ?? ''}`).toBe('ALLOWED');
}

async function seedMedication(user: TestUser, name: string) {
  const med = await h.app.inject({
    method: 'POST', url: '/v1/medications', headers: authHeaders(user),
    payload: {
      patientProfileId: user.profileId, name, form: 'tablet',
      strengthValue: 10, strengthUnit: 'mg', foodInstruction: 'no_preference', startDate: DATE,
      schedule: {
        rule: { kind: 'fixed_times', times: ['09:00'] },
        doseQuantity: 1, doseUnit: 'tablet', startDate: DATE,
        lateAfterMinutes: 15, missedAfterMinutes: 120,
      },
      stock: { trackingEnabled: true, initialQuantity: 30, unit: 'tablet' },
    },
  });
  expect(med.statusCode, `seed ${name}: ${med.body}`).toBe(200);
  const medicationId = med.json().medication.id as string;

  const doses = await h.app.inject({
    method: 'GET', url: `/v1/doses?profileId=${user.profileId}&from=${DATE}&to=${DATE}`,
    headers: authHeaders(user),
  });
  const doseId = doses.json().doses[0].id as string;

  const schedule = await truth<{ id: string }>(
    'SELECT id FROM medication_schedules WHERE medication_id = $1', [medicationId],
  );
  return { medicationId, doseId, scheduleId: schedule[0]!.id };
}

async function inviteAndAccept(
  inviter: TestUser, invitee: TestUser, permissions: string[], priority = 1,
) {
  const invite = await h.app.inject({
    method: 'POST', url: '/v1/caregivers/invite', headers: authHeaders(inviter),
    payload: {
      patientProfileId: inviter.profileId, invitedName: 'Caregiver',
      invitedPhone: invitee.phone, role: 'caregiver', permissions,
      escalationPriority: priority,
    },
  });
  expect(invite.statusCode, `invite: ${invite.body}`).toBe(200);
  // The raw token is never returned as a field — it exists only inside the
  // outgoing link, which is the point: the database keeps a hash.
  const token = (invite.json().invitationLink as string).split('/invite/')[1]!;
  expect(token, `no token in invite response: ${invite.body}`).toBeTruthy();

  const accept = await h.app.inject({
    method: 'POST', url: '/v1/caregivers/accept', headers: authHeaders(invitee),
    payload: { token },
  });
  expect(accept.statusCode, `accept: ${accept.body}`).toBe(200);
  return { token, relationshipId: accept.json().relationshipId as string };
}

beforeAll(async () => {
  resetDatabase();
  h = await startHarness();

  appPool = new pg.Pool({
    connectionString: 'postgres://dawaee_app:devpass@127.0.0.1:5433/dawaee_test',
    max: 4,
  });
  ownerPool = new pg.Pool({
    connectionString: 'postgres://postgres:postgres@127.0.0.1:5433/dawaee_test',
    max: 2,
  });

  h.setNow(at('08:00'));

  alice = await signIn(h, '+966500001001');
  bob = await signIn(h, '+966500001002');
  carol = await signIn(h, '+966500001003');
  dave = await signIn(h, '+966500001004');
  mallory = await signIn(h, '+966500001005');

  ({ medicationId: aliceMedId, doseId: aliceDoseId, scheduleId: aliceScheduleId } =
    await seedMedication(alice, 'AliceDrug'));
  ({ medicationId: bobMedId, doseId: bobDoseId, scheduleId: bobScheduleId } =
    await seedMedication(bob, 'BobDrug'));

  // A real dose action, so dose_events has rows to be isolated. Without one,
  // "A cannot read B's dose_events" would pass against an empty table and
  // prove nothing. Put the API clock at the occurrence time: this suite is
  // testing RLS isolation, not the separate early-action safety boundary.
  h.setServerNow(at('09:05'));
  try {
    for (const [user, doseId] of [[alice, aliceDoseId], [bob, bobDoseId]] as const) {
      const taken = await h.app.inject({
        method: 'POST', url: `/v1/doses/${doseId}/taken`, headers: authHeaders(user),
        payload: { clientEventId: `evt-seed-${doseId.slice(0, 8)}`, takenAt: at('09:05').toISOString() },
      });
      expect(taken.statusCode, `seed dose event: ${taken.body}`).toBe(200);
    }
  } finally {
    h.setServerNow(at('08:00'));
  }

  await inviteAndAccept(alice, carol, ['view_medications', 'view_adherence', 'confirm_dose']);
  await inviteAndAccept(bob, dave, ['view_medications', 'view_adherence']);
  ({ relationshipId: malloryRelId } = await inviteAndAccept(alice, mallory, ['view_medications']));

  // Mallory is revoked but keeps every id she learned while authorised — the
  // situation a revocation has to actually close.
  const revoke = await h.app.inject({
    method: 'DELETE', url: `/v1/caregivers/${malloryRelId}`, headers: authHeaders(alice),
  });
  expect(revoke.statusCode, `revoke: ${revoke.body}`).toBe(200);
});

afterAll(async () => {
  // The matrix, printed as evidence rather than described.
  const mark = { PASS: '  ', FINDING: 'F ', FAIL: '!!' } as const;
  const rows = matrix.map((m) =>
    `${mark[m.status]} ${m.resource.padEnd(34)} ${m.actor.padEnd(20)} ` +
    `${m.op.padEnd(7)} expected=${m.expected.padEnd(5)} actual=${m.actual} sqlstate=${m.errorCode ?? 'none'} constraint=${m.errorConstraint ?? 'none'}`);
  const failures = matrix.filter((m) => m.status === 'FAIL').length;
  const findings = matrix.filter((m) => m.status === 'FINDING').length;
  console.log(
    `\n=== P8 RLS ADVERSARIAL MATRIX ===\n`
    + `${matrix.length} attempts · ${failures} unexplained FAIL · ${findings} open FINDING\n\n`
    + rows.join('\n') + '\n',
  );
  await appPool.end();
  await ownerPool.end();
  await h.close();
  expect(failures, 'the printed RLS matrix contains failed or invalid probes').toBe(0);
});

// ══════════════════════════════════════════ the roles themselves

describe('the runtime roles cannot escape row level security', () => {
  /**
   * If the runtime role could bypass RLS, every policy below would be
   * decoration. Checked first, because a false result here invalidates the
   * whole phase.
   */
  it('dawaee_app and dawaee_worker are not superuser and cannot BYPASSRLS', async () => {
    const roles = await truth<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean }>(
      "SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname LIKE 'dawaee%'",
    );
    expect(roles.length).toBeGreaterThan(0);
    for (const r of roles) {
      expect(r.rolsuper, `${r.rolname} is superuser`).toBe(false);
      expect(r.rolbypassrls, `${r.rolname} can bypass RLS`).toBe(false);
    }
  });

  /**
   * The tables are owned by `postgres`, and a table owner is exempt from its
   * own policies unless FORCE is set. Since migrations run as the owner, FORCE
   * is what stops an owner-role connection from being a way around everything.
   */
  it('every user-data table has RLS enabled AND forced', async () => {
    const tables = await truth<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname='public' AND c.relkind='r'
          AND c.relname NOT IN ('schema_migrations','job_runs','provider_webhook_events','auth_otp_challenges')`,
    );
    const unprotected = tables.filter((t) => !t.relrowsecurity || !t.relforcerowsecurity);
    expect(unprotected.map((t) => t.relname), 'tables without forced RLS').toEqual([]);
  });

  /**
   * With no `app.user_id` set — a bug that forgot `withUser`, or a connection
   * borrowed mid-request — the policies must deny rather than fall open.
   */
  it('an unauthenticated connection sees nothing', async () => {
    for (const table of [
      'patient_profiles', 'medications', 'medication_schedules', 'dose_occurrences',
      'dose_events', 'medication_stock', 'stock_transactions', 'refill_events',
      'caregiver_relationships', 'symptom_notes', 'emergency_cards', 'stored_objects',
      'health_measurements', 'prescriptions', 'user_preferences', 'consents',
      'notification_deliveries', 'push_tokens', 'auth_sessions', 'users',
    ]) {
      const res = await asUser(null, `SELECT count(*)::int AS n FROM ${table}`);
      record(table, 'unauthenticated', 'SELECT', 'DENY', Number(res.rows[0]?.n ?? 0), res.error, res.errorCode);
      expect(Number(res.rows[0]?.n ?? -1), `${table} visible with no identity`).toBe(0);
    }
  });

  /**
   * Credentials are reachable only through SECURITY DEFINER functions.
   *
   * This used to assert zero policies — deny-all, the strongest possible
   * statement. That was only ever true because the test database was owned by a
   * superuser, which is exempt from FORCE ROW LEVEL SECURITY for free. On a
   * managed PostgreSQL the owner is not exempt, so with zero policies
   * `app.register_with_password` could not write a password hash and
   * registration returned 404 for every user. (P18.)
   *
   * The invariant that actually matters is narrower and is what is pinned now:
   * exactly one policy, naming the schema owner and nobody else. A later
   * "convenience" policy for a runtime role is still a failure.
   */
  it('user_credentials is unreachable from the runtime role entirely', async () => {
    const policies = await truth<{ policyname: string; roles: string }>(
      `SELECT policyname, roles::text AS roles FROM pg_policies
        WHERE schemaname='public' AND tablename='user_credentials'`,
    );
    expect(policies.map((p) => p.policyname), 'policies on user_credentials')
      .toEqual(['user_credentials_definer']);
    for (const p of policies) {
      expect(p.roles, `${p.policyname} names a runtime role or PUBLIC`)
        .not.toMatch(/dawaee_app|dawaee_worker|public/);
    }

    const res = await asUser(alice.userId, 'SELECT count(*)::int AS n FROM user_credentials');
    record('user_credentials', 'Patient A', 'SELECT', 'DENY', Number(res.rows[0]?.n ?? 0), res.error, res.errorCode);
    // Denied at the GRANT level, before RLS is even consulted — a stronger
    // refusal than an empty result set, and the one worth having for a table
    // of password hashes.
    expect(res.error, 'user_credentials was readable').toMatch(/permission denied/i);
  });
});

// ══════════════════════════════════════════ Patient A vs Patient B

describe('Patient A supplies Patient B ids directly', () => {
  const RESOURCES: Array<[string, string, string]> = [
    ['patient_profiles', 'SELECT * FROM patient_profiles WHERE id = $1', 'profileId'],
    ['medications', 'SELECT * FROM medications WHERE id = $1', 'medId'],
    ['medication_schedules', 'SELECT * FROM medication_schedules WHERE id = $1', 'scheduleId'],
    ['dose_occurrences', 'SELECT * FROM dose_occurrences WHERE id = $1', 'doseId'],
    ['medication_stock', 'SELECT * FROM medication_stock WHERE medication_id = $1', 'medId'],
    ['stock_transactions', 'SELECT * FROM stock_transactions WHERE medication_id = $1', 'medId'],
    ['dose_events', 'SELECT * FROM dose_events WHERE dose_occurrence_id = $1', 'doseId'],
  ];

  it('reads nothing of Patient B, on any table, with the real id in hand', async () => {
    for (const [resource, sql, which] of RESOURCES) {
      const id = which === 'profileId' ? bob.profileId : which === 'medId' ? bobMedId
        : which === 'scheduleId' ? bobScheduleId : bobDoseId;
      await denied(resource, 'Patient A', 'SELECT', async () => {
        const r = await asUser(alice.userId, sql, [id]);
        return { rowCount: r.rows.length, error: r.error, errorCode: r.errorCode };
      });
    }
  });

  it('and Patient B reads nothing of Patient A, symmetrically', async () => {
    for (const [resource, sql, which] of RESOURCES) {
      const id = which === 'profileId' ? alice.profileId : which === 'medId' ? aliceMedId
        : which === 'scheduleId' ? aliceScheduleId : aliceDoseId;
      await denied(resource, 'Patient B', 'SELECT', async () => {
        const r = await asUser(bob.userId, sql, [id]);
        return { rowCount: r.rows.length, error: r.error, errorCode: r.errorCode };
      });
    }
  });

  it('can still read its own, so the policies are not simply denying everything', async () => {
    for (const [resource, sql, which] of RESOURCES) {
      const id = which === 'profileId' ? alice.profileId : which === 'medId' ? aliceMedId
        : which === 'scheduleId' ? aliceScheduleId : aliceDoseId;
      await allowed(resource, 'Patient A (own)', 'SELECT', async () => {
        const r = await asUser(alice.userId, sql, [id]);
        return { rowCount: r.rows.length, error: r.error, errorCode: r.errorCode };
      });
    }
  });
});

describe('Patient A writes to Patient B', () => {
  it('cannot UPDATE any of B’s rows', async () => {
    const cases: Array<[string, string, unknown[]]> = [
      ['patient_profiles', "UPDATE patient_profiles SET display_name='pwned' WHERE id=$1", [bob.profileId]],
      ['medications', "UPDATE medications SET name='pwned' WHERE id=$1", [bobMedId]],
      ['medication_schedules', 'UPDATE medication_schedules SET dose_quantity=99 WHERE id=$1', [bobScheduleId]],
      ['dose_occurrences', "UPDATE dose_occurrences SET status='taken' WHERE id=$1", [bobDoseId]],
      ['medication_stock', 'UPDATE medication_stock SET remaining_quantity=0 WHERE medication_id=$1', [bobMedId]],
      ['emergency_cards', "UPDATE emergency_cards SET conditions_note='pwned' WHERE patient_profile_id=$1", [bob.profileId]],
      ['user_preferences', 'UPDATE user_preferences SET show_medication_in_notifications=true WHERE user_id=$1', [bob.userId]],
      ['users', "UPDATE users SET display_name='pwned' WHERE id=$1", [bob.userId]],
    ];
    for (const [resource, sql, params] of cases) {
      await denied(resource, 'Patient A', 'UPDATE', async () => {
        const r = await asUser(alice.userId, sql, params);
        return { rowCount: r.rowCount, error: r.error, errorCode: r.errorCode };
      });
    }
    // Ground truth: nothing actually changed.
    const [b] = await truth<{ display_name: string }>('SELECT display_name FROM patient_profiles WHERE id=$1', [bob.profileId]);
    expect(b!.display_name).not.toBe('pwned');
    const [m] = await truth<{ name: string }>('SELECT name FROM medications WHERE id=$1', [bobMedId]);
    expect(m!.name).toBe('BobDrug');
  });

  it('cannot DELETE any of B’s rows', async () => {
    const cases: Array<[string, string, unknown[]]> = [
      ['medications', 'DELETE FROM medications WHERE id=$1', [bobMedId]],
      ['medication_schedules', 'DELETE FROM medication_schedules WHERE id=$1', [bobScheduleId]],
      ['dose_occurrences', 'DELETE FROM dose_occurrences WHERE id=$1', [bobDoseId]],
      ['patient_profiles', 'DELETE FROM patient_profiles WHERE id=$1', [bob.profileId]],
      ['caregiver_relationships', 'DELETE FROM caregiver_relationships WHERE patient_profile_id=$1', [bob.profileId]],
      ['emergency_cards', 'DELETE FROM emergency_cards WHERE patient_profile_id=$1', [bob.profileId]],
    ];
    for (const [resource, sql, params] of cases) {
      await denied(resource, 'Patient A', 'DELETE', async () => {
        const r = await asUser(alice.userId, sql, params);
        return { rowCount: r.rowCount, error: r.error, errorCode: r.errorCode };
      });
    }
    const still = await truth<{ n: number }>('SELECT count(*)::int AS n FROM medications WHERE id=$1', [bobMedId]);
    expect(Number(still[0]!.n), "B's medication was deleted").toBe(1);
  });

  /**
   * The attacker-controlled owner column. An INSERT naming somebody else's
   * profile is the shape that a route which trusts a body field would produce,
   * and it is what a WITH CHECK clause exists to stop.
   */
  it('cannot INSERT a row owned by B', async () => {
    const cases: Array<[string, string, unknown[]]> = [
      ['medications', `INSERT INTO medications (patient_profile_id, name, form, start_date, created_by)
                       VALUES ($1,'planted','tablet',$2,$3) RETURNING id`, [bob.profileId, DATE, alice.userId]],
      ['symptom_notes', `INSERT INTO symptom_notes (patient_profile_id, recorded_at, text, created_by)
                         VALUES ($1, now(), 'planted', $2) RETURNING id`, [bob.profileId, alice.userId]],
      ['health_measurements', `INSERT INTO health_measurements (patient_profile_id, type, measured_at, value_primary, unit, created_by)
                               VALUES ($1,'weight', now(), 1, 'kg', $2) RETURNING id`, [bob.profileId, alice.userId]],
      ['emergency_cards', `INSERT INTO emergency_cards (patient_profile_id, conditions_note)
                           VALUES ($1,'planted') RETURNING id`, [bob.profileId]],
      ['dose_events', `INSERT INTO dose_events (dose_occurrence_id, patient_profile_id, type, actor_user_id)
                       VALUES ($1,$2,'taken',$3) RETURNING id`, [bobDoseId, bob.profileId, alice.userId]],
    ];
    for (const [resource, sql, params] of cases) {
      if (resource !== 'emergency_cards') {
        const ownerParams = params.map((value) => value === alice.userId ? bob.userId : value);
        await allowed(resource, 'Patient B (rollback control)', 'INSERT', () =>
          asUser(bob.userId, sql, ownerParams, true));
      }
      await denied(resource, 'Patient A', 'INSERT', async () => {
        const r = await asUser(alice.userId, sql, params);
        return { rowCount: r.rows.length, error: r.error, errorCode: r.errorCode };
      });
    }
    const planted = await truth<{ n: number }>(
      "SELECT count(*)::int AS n FROM medications WHERE name='planted'",
    );
    expect(Number(planted[0]!.n), 'a row was planted in B’s account').toBe(0);
  });

  /**
   * Re-parenting must be stopped even when the OLD row belongs to the caller.
   * Migration 0069 uses an AFTER trigger. A foreign-account target must
   * therefore fail RLS WITH CHECK first (42501). Same-owner targets reach the
   * named graph guard instead; the dedicated boundary suite tests both paths.
   */
  it('cannot re-parent its OWN row onto B’s profile', async () => {
    const r = await asUser(alice.userId,
      'UPDATE medications SET patient_profile_id=$1 WHERE id=$2', [bob.profileId, aliceMedId]);
    const { ok } = record('medications (reparent)', 'Patient A', 'UPDATE', 'DENY',
      r.rowCount, r.error, r.errorCode);
    expect(r.errorCode, 'foreign-account reparenting must fail RLS first').toBe('42501');
    expect(r.errorConstraint).toBeNull();
    expect(ok, `unexpected reparent result: ${r.errorCode}/${r.errorConstraint}: ${r.error}`).toBe(true);
    const [m] = await truth<{ patient_profile_id: string }>(
      'SELECT patient_profile_id FROM medications WHERE id=$1', [aliceMedId],
    );
    expect(m!.patient_profile_id, 'medication was re-parented').toBe(alice.profileId);
  });

  it('the profile guard still permits a valid owner update with an unchanged profile', async () => {
    await allowed('medications (same profile)', 'Patient A', 'UPDATE', () =>
      asUser(alice.userId,
        'UPDATE medications SET patient_profile_id=$1 WHERE id=$2 RETURNING id',
        [alice.profileId, aliceMedId], true));
  });

  /**
   * UPDATE ... RETURNING on a predicate that spans both accounts. If the policy
   * were applied only to the write and not the read-back, this would disclose
   * B's rows in the RETURNING clause.
   */
  it('a mixed-scope UPDATE ... RETURNING touches and returns only A’s rows', async () => {
    const r = await asUser<{ id: string; patient_profile_id: string }>(
      alice.userId,
      `UPDATE medications SET notes = 'sweep' WHERE id = ANY($1::uuid[])
       RETURNING id, patient_profile_id`,
      [[aliceMedId, bobMedId]],
    );
    record('medications (mixed ids)', 'Patient A', 'UPDATE', 'ALLOW', r.rows.length, r.error, r.errorCode);
    expect(r.error).toBeNull();
    expect(r.rows.map((row) => row.id)).toEqual([aliceMedId]);
    for (const row of r.rows) {
      expect(row.patient_profile_id, 'B row returned by a mixed UPDATE').toBe(alice.profileId);
    }
    const [b] = await truth<{ notes: string | null }>('SELECT notes FROM medications WHERE id=$1', [bobMedId]);
    expect(b!.notes, "B's row was modified by a mixed-id sweep").not.toBe('sweep');
  });

  it('a mixed-scope SELECT returns only A’s rows', async () => {
    const r = await asUser<{ id: string }>(
      alice.userId, 'SELECT id FROM medications WHERE id = ANY($1::uuid[])',
      [[aliceMedId, bobMedId]],
    );
    record('medications (mixed ids)', 'Patient A', 'SELECT', 'ALLOW', r.rows.length, r.error, r.errorCode);
    expect(r.rows.map((x) => x.id)).toEqual([aliceMedId]);
  });

  /**
   * A dose action naming a medication that belongs to someone else. The trigger
   * `assert_profile_matches_medication` exists for this; asserted rather than
   * assumed.
   */
  it('cannot create a dose occurrence linking A’s profile to B’s medication', async () => {
    const r = await asUser(alice.userId,
      `INSERT INTO dose_occurrences
         (patient_profile_id, medication_id, schedule_id, scheduled_at, dose_quantity, dose_unit,
          status, scheduled_local_date, scheduled_local_time, scheduled_timezone)
       VALUES ($1,$2,$3,$4,1,'tablet','upcoming',$5,'10:00','Asia/Riyadh') RETURNING id`,
      [alice.profileId, bobMedId, bobScheduleId, at('10:00'), DATE]);
    expect(r.errorCode, 'the profile-binding trigger did not refuse the cross-medication link').toBe('P0001');
    expect(r.error).toBe(`medication ${bobMedId} not found`);
    const { ok } = record('dose_occurrences (cross med)', 'Patient A', 'INSERT', 'DENY',
      r.rowCount, r.error, r.errorCode, false, 'P0001');
    expect(ok).toBe(true);
  });
});

// ══════════════════════════════════════════ caregivers

describe('a caregiver is scoped to the patient who invited them', () => {
  it('Caregiver of A can read A’s medications', async () => {
    await allowed('medications', 'Caregiver of A', 'SELECT', async () => {
      const r = await asUser(carol.userId, 'SELECT id FROM medications WHERE id=$1', [aliceMedId]);
      return { rowCount: r.rows.length, error: r.error, errorCode: r.errorCode };
    });
  });

  it('Caregiver of A cannot read B at all', async () => {
    for (const [resource, sql, id] of [
      ['medications', 'SELECT id FROM medications WHERE id=$1', bobMedId],
      ['patient_profiles', 'SELECT id FROM patient_profiles WHERE id=$1', bob.profileId],
      ['dose_occurrences', 'SELECT id FROM dose_occurrences WHERE id=$1', bobDoseId],
      ['symptom_notes', 'SELECT id FROM symptom_notes WHERE patient_profile_id=$1', bob.profileId],
      ['emergency_cards', 'SELECT id FROM emergency_cards WHERE patient_profile_id=$1', bob.profileId],
    ] as Array<[string, string, string]>) {
      await denied(resource, 'Caregiver of A', 'SELECT', async () => {
        const r = await asUser(carol.userId, sql, [id]);
        return { rowCount: r.rows.length, error: r.error, errorCode: r.errorCode };
      });
    }
  });

  it('Caregiver of B cannot read A, symmetrically', async () => {
    await denied('medications', 'Caregiver of B', 'SELECT', async () => {
      const r = await asUser(dave.userId, 'SELECT id FROM medications WHERE id=$1', [aliceMedId]);
      return { rowCount: r.rows.length, error: r.error, errorCode: r.errorCode };
    });
  });

  it('Caregiver of A cannot substitute B’s profile id into a write', async () => {
    await denied('medications', 'Caregiver of A', 'INSERT', async () => {
      const r = await asUser(carol.userId,
        `INSERT INTO medications (patient_profile_id, name, form, start_date, created_by)
         VALUES ($1,'planted-by-caregiver','tablet',$2,$3) RETURNING id`,
        [bob.profileId, DATE, carol.userId]);
      return { rowCount: r.rows.length, error: r.error, errorCode: r.errorCode };
    });
    await denied('dose_occurrences', 'Caregiver of A', 'UPDATE', async () => {
      const r = await asUser(carol.userId,
        "UPDATE dose_occurrences SET status='taken' WHERE id=$1", [bobDoseId]);
      return { rowCount: r.rowCount, error: r.error, errorCode: r.errorCode };
    });
  });

  /**
   * Privilege escalation from inside the relationship row. A caregiver who can
   * write their own permissions can grant themselves anything the patient never
   * agreed to — the DB-side guard is a SECURITY INVOKER trigger comparing
   * OLD/NEW, because a WITH CHECK clause only sees NEW.
   */
  it('a caregiver cannot widen their own permissions', async () => {
    const rel = await truth<{ id: string }>(
      'SELECT id FROM caregiver_relationships WHERE caregiver_user_id=$1 AND patient_profile_id=$2',
      [carol.userId, alice.profileId],
    );
    await denied('caregiver_relationships', 'Caregiver of A', 'UPDATE', async () => {
      const r = await asUser(carol.userId,
        `UPDATE caregiver_relationships
            SET permissions = ARRAY['view_medications','confirm_dose','edit_medication','manage_caregivers']
          WHERE id=$1`, [rel[0]!.id]);
      return { rowCount: r.rowCount, error: r.error, errorCode: r.errorCode };
    });
    const [after] = await truth<{ permissions: string[] }>(
      'SELECT permissions FROM caregiver_relationships WHERE id=$1', [rel[0]!.id],
    );
    expect(after!.permissions, 'caregiver widened their own permissions')
      .not.toContain('edit_medication');
  });

  it('a caregiver cannot promote themselves onto another patient', async () => {
    await denied('caregiver_relationships', 'Caregiver of A', 'INSERT', async () => {
      const r = await asUser(carol.userId,
        `INSERT INTO caregiver_relationships
           (patient_profile_id, caregiver_user_id, permissions, escalation_priority, status, invited_by_user_id)
         VALUES ($1,$2,ARRAY['view_medications'],1,'active',$2) RETURNING id`,
        [bob.profileId, carol.userId]);
      return { rowCount: r.rows.length, error: r.error, errorCode: r.errorCode };
    });
  });
});

describe('a revoked caregiver keeps the ids and loses the access', () => {
  it('can no longer read anything of the patient who revoked her', async () => {
    for (const [resource, sql, id] of [
      ['medications', 'SELECT id FROM medications WHERE id=$1', aliceMedId],
      ['patient_profiles', 'SELECT id FROM patient_profiles WHERE id=$1', alice.profileId],
      ['dose_occurrences', 'SELECT id FROM dose_occurrences WHERE id=$1', aliceDoseId],
      ['medication_stock', 'SELECT medication_id FROM medication_stock WHERE medication_id=$1', aliceMedId],
      ['emergency_cards', 'SELECT id FROM emergency_cards WHERE patient_profile_id=$1', alice.profileId],
      ['symptom_notes', 'SELECT id FROM symptom_notes WHERE patient_profile_id=$1', alice.profileId],
    ] as Array<[string, string, string]>) {
      await denied(resource, 'revoked caregiver', 'SELECT', async () => {
        const r = await asUser(mallory.userId, sql, [id]);
        return { rowCount: r.rows.length, error: r.error, errorCode: r.errorCode };
      });
    }
  });

  it('cannot write either', async () => {
    await denied('dose_occurrences', 'revoked caregiver', 'UPDATE', async () => {
      const r = await asUser(mallory.userId,
        "UPDATE dose_occurrences SET status='taken' WHERE id=$1", [aliceDoseId]);
      return { rowCount: r.rowCount, error: r.error, errorCode: r.errorCode };
    });
    await denied('medications', 'revoked caregiver', 'UPDATE', async () => {
      const r = await asUser(mallory.userId,
        "UPDATE medications SET name='pwned' WHERE id=$1", [aliceMedId]);
      return { rowCount: r.rowCount, error: r.error, errorCode: r.errorCode };
    });
  });

  it('cannot reinstate her own relationship row', async () => {
    await denied('caregiver_relationships', 'revoked caregiver', 'UPDATE', async () => {
      const r = await asUser(mallory.userId,
        "UPDATE caregiver_relationships SET status='active' WHERE id=$1", [malloryRelId]);
      return { rowCount: r.rowCount, error: r.error, errorCode: r.errorCode };
    });
    const [rel] = await truth<{ status: string }>(
      'SELECT status FROM caregiver_relationships WHERE id=$1', [malloryRelId],
    );
    expect(rel!.status, 'a revoked caregiver reactivated herself').not.toBe('active');
  });
});

describe('caregiver invitations', () => {
  /**
   * An invitation is addressed to whoever holds the token, but redeeming it
   * must not be a way to attach to a DIFFERENT patient, and a spent or expired
   * one must not work at all.
   */
  it('a spent invitation cannot be redeemed a second time', async () => {
    const { token } = await inviteAndAccept(bob, carol, ['view_medications'], 5);
    const again = await h.app.inject({
      method: 'POST', url: '/v1/caregivers/accept', headers: authHeaders(dave),
      payload: { token },
    });
    expect(again.statusCode, 'a spent invitation was redeemed twice').not.toBe(200);
    record('caregiver_invitations', 'wrong account', 'REDEEM', 'DENY',
      again.statusCode === 200 ? 1 : 0, null);
  });

  it('an expired invitation is refused', async () => {
    const invite = await h.app.inject({
      method: 'POST', url: '/v1/caregivers/invite', headers: authHeaders(alice),
      payload: {
        patientProfileId: alice.profileId, invitedName: 'Expired', invitedPhone: dave.phone,
        role: 'caregiver', permissions: ['view_medications'], escalationPriority: 7,
      },
    });
    expect(invite.statusCode, invite.body).toBe(200);
    const token = (invite.json().invitationLink as string).split('/invite/')[1]!;
    // An invitation IS a caregiver_relationships row in status 'pending'.
    await ownerPool.query(
      "UPDATE caregiver_relationships SET invitation_expires_at = now() - interval '1 day' WHERE status='pending'",
    );
    const accept = await h.app.inject({
      method: 'POST', url: '/v1/caregivers/accept', headers: authHeaders(dave),
      payload: { token },
    });
    expect(accept.statusCode, 'an expired invitation was accepted').not.toBe(200);
    record('caregiver_invitations', 'expired', 'REDEEM', 'DENY',
      accept.statusCode === 200 ? 1 : 0, null);
  });

  /**
   * The pending invitation row carries the token HASH. A patient who could read
   * another patient's pending rows could not replay the token from a hash, but
   * would learn who is being invited into that care circle — and the row is in
   * the same table as active relationships, so this is also the read path a
   * caregiver-scoped policy has to get right.
   */
  it('a patient cannot read invitations belonging to another patient', async () => {
    await denied('caregiver_relationships (pending)', 'Patient B', 'SELECT', async () => {
      const r = await asUser(bob.userId,
        "SELECT id FROM caregiver_relationships WHERE patient_profile_id=$1 AND status='pending'",
        [alice.profileId]);
      return { rowCount: r.rows.length, error: r.error, errorCode: r.errorCode };
    });
  });

  it('nobody can read an invitation token hash from another account', async () => {
    await denied('caregiver_relationships (token hash)', 'Patient B', 'SELECT', async () => {
      const r = await asUser(bob.userId,
        'SELECT invitation_token_hash FROM caregiver_relationships WHERE patient_profile_id=$1',
        [alice.profileId]);
      return { rowCount: r.rows.length, error: r.error, errorCode: r.errorCode };
    });
  });
});

// ══════════════════════════════════════════ SECURITY DEFINER surface

describe('the SECURITY DEFINER functions are a boundary, not a hole', () => {
  /**
   * A SECURITY DEFINER function without a pinned search_path can be hijacked by
   * a caller who creates a same-named object in a schema they control. Every
   * one of these runs as the table owner, so a hijack is a total compromise.
   */
  it('every SECURITY DEFINER function pins its search_path', async () => {
    const fns = await truth<{ proname: string; proconfig: string[] | null }>(
      `SELECT p.proname, p.proconfig FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='app' AND p.prosecdef`,
    );
    expect(fns.length).toBeGreaterThan(10);
    const unpinned = fns.filter(
      (f) => !(f.proconfig ?? []).some((c) => c.startsWith('search_path=')),
    );
    expect(unpinned.map((f) => f.proname), 'SECURITY DEFINER without search_path').toEqual([]);
  });

  it('and none of them is executable by PUBLIC', async () => {
    const fns = await truth<{ proname: string; acl: string | null }>(
      `SELECT p.proname, array_to_string(p.proacl,',') AS acl
         FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='app' AND p.prosecdef`,
    );
    const publicExec = fns.filter((f) => (f.acl ?? '').match(/(^|,)=X\//));
    expect(publicExec.map((f) => f.proname), 'EXECUTE granted to PUBLIC').toEqual([]);
  });

  /**
   * The authorization helpers themselves. If `can_read_profile` answered true
   * for a stranger, every policy built on it would open at once.
   */
  it('can_read_profile and owns_profile refuse a stranger', async () => {
    for (const fn of ['app.can_read_profile', 'app.owns_profile', 'app.caregives_profile']) {
      const r = await asUser<{ ok: boolean }>(bob.userId, `SELECT ${fn}($1) AS ok`, [alice.profileId]);
      record(fn, 'Patient B', 'CALL', 'DENY', r.rows[0]?.ok ? 1 : 0, r.error, r.errorCode);
      expect(r.rows[0]?.ok, `${fn} said yes to a stranger`).not.toBe(true);
    }
    const own = await asUser<{ ok: boolean }>(alice.userId, 'SELECT app.owns_profile($1) AS ok', [alice.profileId]);
    expect(own.rows[0]?.ok, 'owner refused their own profile').toBe(true);
  });

  it('has_permission refuses a permission the patient never granted', async () => {
    const r = await asUser<{ ok: boolean }>(carol.userId,
      "SELECT app.has_permission($1,'edit_medication') AS ok", [alice.profileId]);
    record('app.has_permission', 'Caregiver of A', 'CALL', 'DENY', r.rows[0]?.ok ? 1 : 0, r.error, r.errorCode);
    expect(r.rows[0]?.ok).not.toBe(true);
  });

  it('the emergency resolver discloses nothing for an unknown token', async () => {
    const r = await asUser(null, 'SELECT * FROM app.resolve_emergency_qr($1)', ['deadbeef'.repeat(8)]);
    record('app.resolve_emergency_qr', 'unauthenticated', 'CALL', 'DENY', r.rows.length, r.error, r.errorCode);
    expect(r.rows.length).toBe(0);
  });

  /**
   * The audit trail is append-only by trigger. A patient who can edit it can
   * erase the evidence of everything else in this file.
   */
  it('audit_logs cannot be updated or deleted by anyone at runtime', async () => {
    for (const [op, sql] of [
      ['UPDATE', "UPDATE audit_logs SET action='rewritten'"],
      ['DELETE', 'DELETE FROM audit_logs'],
    ] as Array<[string, string]>) {
      await denied('audit_logs', 'Patient A', op, async () => {
        const r = await asUser(alice.userId, sql);
        return { rowCount: r.rowCount, error: r.error, errorCode: r.errorCode };
      });
    }
  });
});

// ══════════════════════════════════════════ worker role

describe('the worker role is scoped to what a worker needs', () => {
  const workerPool = () => new pg.Pool({
    connectionString: 'postgres://dawaee_worker:devpass@127.0.0.1:5433/dawaee_test', max: 2,
  });

  it('cannot read password hashes', async () => {
    const p = workerPool();
    try {
      const error = await p.query('SELECT count(*)::int AS n FROM user_credentials')
        .then(() => null).catch((e: unknown) => e as { code?: string; message: string });
      record('user_credentials', 'worker role', 'SELECT', 'DENY', error ? 0 : 1,
        error?.message ?? null, error?.code ?? null);
      expect(error, 'worker must be refused by privileges, not an empty table').toMatchObject({ code: '42501' });
    } finally { await p.end(); }
  });

  /**
   * FINDING P8-1, now CLOSED — the worker role was over-privileged.
   *
   * It held SELECT on 27 tables with `USING (true)` policies, so it read every
   * row of every patient, while touching 17. Among the ones it never queried
   * were emergency_cards, symptom_notes, health_measurements, prescriptions and
   * consents. Migration 0021 revoked everything and re-granted an explicit
   * manifest; these assertions are the ones that used to pin the hole open, now
   * inverted to hold it shut. The full allowlist lives in
   * privilege-boundary.test.ts.
   */
  it('cannot read the PHI tables it never queries (P8-1 closed)', async () => {
    const p = workerPool();
    const NEVER_QUERIED = [
      'emergency_cards', 'symptom_notes', 'health_measurements',
      'prescriptions', 'consents', 'refill_events', 'travel_prompts',
    ];
    try {
      const readable: string[] = [];
      for (const table of NEVER_QUERIED) {
        const error = await p.query(`SELECT count(*)::int AS n FROM ${table}`)
          .then(() => null).catch((e: unknown) => e as { code?: string; message: string });
        record(table, 'worker role', 'SELECT', 'DENY', error ? 0 : 1,
          error?.message ?? null, error?.code ?? null);
        if (!error) readable.push(table);
        else expect(error, `${table}: only an actual privilege refusal counts`).toMatchObject({ code: '42501' });
      }
      expect(readable, 'worker regained PHI read access').toEqual([]);
    } finally { await p.end(); }
  });

  /**
   * auth_sessions holds refresh token hashes, device names and IP hashes for
   * every user. The worker's only session work — deleting long-expired rows —
   * now goes through `app.cleanup_expired_sessions`, which returns a count and
   * nothing else, so the table itself is unreachable.
   */
  it('cannot read session rows at all (P8-1 closed)', async () => {
    const p = workerPool();
    try {
      const error = await p.query('SELECT count(*) FROM auth_sessions')
        .then(() => null).catch((e: unknown) => e as { code?: string; message: string });
      record('auth_sessions', 'worker role', 'SELECT', 'DENY', error ? 0 : 1,
        error?.message ?? null, error?.code ?? null);
      expect(error, 'worker can still read sessions').toMatchObject({ code: '42501' });
    } finally { await p.end(); }
  });
});


describe('RLS evidence classifier rejects false-success', () => {
  it.each(['42703', '42P01', '42601', '23502', '23514', '57014', '08006'])(
    'SQLSTATE %s is not an authorization denial', (code) => {
      expect(classifyAttempt('DENY', 0, 'invalid probe', code).ok).toBe(false);
    },
  );

  it('accepts only an actual privilege refusal or a successful zero-row statement', () => {
    expect(classifyAttempt('DENY', 0, 'permission denied', '42501').ok).toBe(true);
    expect(classifyAttempt('DENY', 0, null, null).ok).toBe(true);
    expect(classifyAttempt('DENY', 1, null, null).ok).toBe(false);
    expect(classifyAttempt('DENY', 0, 'unknown error', null).ok).toBe(false);
    expect(classifyAttempt('DENY', 0, 'unrelated trigger failed', 'P0001').ok).toBe(false);
    expect(classifyAttempt('ALLOW', 0, null, null).ok).toBe(false);
  });

  it('accepts a structural denial only for the exact expected constraint', () => {
    const constraint = 'medication_patient_profile_immutable';
    expect(classifyAttempt('DENY', 0, 'profile rejected', '23514', '23514', constraint, constraint).ok).toBe(true);
    expect(classifyAttempt('DENY', 0, 'unrelated check', '23514', '23514', 'another_check', constraint).ok).toBe(false);
    expect(classifyAttempt('DENY', 0, 'unnamed check', '23514', '23514', null, constraint).ok).toBe(false);
    expect(classifyAttempt('DENY', 0, 'wrong SQLSTATE', '42703', '23514', constraint, constraint).ok).toBe(false);
    expect(classifyAttempt('DENY', 0, null, null, '23514', null, constraint).ok).toBe(false);
    expect(classifyAttempt('DENY', 1, null, null, '23514', null, constraint).ok).toBe(false);
  });

  it('a real undefined-column error is rejected by the same matrix classifier', async () => {
    const r = await asUser(alice.userId, 'SELECT nonexistent_rls_audit_column FROM medications');
    expect(r.errorCode).toBe('42703');
    expect(classifyAttempt('DENY', r.rowCount, r.error, r.errorCode).ok).toBe(false);
    // ROLLBACK must have restored the pooled connection for a valid query.
    const own = await asUser(alice.userId, 'SELECT id FROM medications WHERE id=$1', [aliceMedId]);
    expect(own.error).toBeNull();
    expect(own.rows).toHaveLength(1);
  });
});
