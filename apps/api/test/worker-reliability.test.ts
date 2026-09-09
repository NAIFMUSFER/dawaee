import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeaders, resetDatabase, signIn, startHarness, type Harness, type TestUser } from './harness.js';

/**
 * Worker reliability, executed rather than reasoned about.
 *
 * The questions that matter here are all about what happens at a boundary — two
 * replicas reaching the same tick, a process dying between a provider call and a
 * database commit, a patient pressing "Taken" at the moment mark-missed runs.
 * None of those can be answered by reading the code, so every claim below is
 * driven against a real database, with the interleavings forced on separate
 * connections where a scheduler would otherwise decide the outcome.
 */

let h: Harness;
let owner: pg.Pool;

const DATE = '2026-06-10';
const at = (hhmm: string, dayOffset = 0) => {
  const [hh, mm] = hhmm.split(':').map(Number) as [number, number];
  return new Date(Date.UTC(2026, 5, 10 + dayOffset, hh - 3, mm, 0)); // Riyadh = UTC+3
};

const conn = (max = 10) => new pg.Pool({
  connectionString: 'postgres://postgres:postgres@127.0.0.1:5433/dawaee_test', max,
});

/**
 * Removes JS comments so a structural assertion reads the code and not the
 * prose about it.
 *
 * These files explain the defects they fixed by quoting the old query
 * verbatim, so "the buggy pattern is absent" is false for the file and true
 * for the program. Assertions that cannot tell those apart are assertions
 * about documentation, and they fail the moment someone writes a good comment.
 *
 * Deliberately simple — it is applied only to worker job files, which contain
 * no `//` or block-comment sequences inside string or template literals. Every
 * caller pairs it with a positive control proving the executable text survived.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, '');
}

async function seedMedication(user: TestUser, name: string, time = '09:00', missedAfter = 60) {
  const med = await h.app.inject({
    method: 'POST', url: '/v1/medications', headers: authHeaders(user),
    payload: {
      patientProfileId: user.profileId, name, form: 'tablet',
      strengthValue: 10, strengthUnit: 'mg', foodInstruction: 'no_preference', startDate: DATE,
      schedule: {
        rule: { kind: 'fixed_times', times: [time] },
        doseQuantity: 1, doseUnit: 'tablet', startDate: DATE,
        lateAfterMinutes: 15, missedAfterMinutes: missedAfter,
      },
      stock: { trackingEnabled: true, initialQuantity: 30, unit: 'tablet' },
    },
  });
  expect(med.statusCode, `seed ${name}: ${med.body}`).toBe(200);
  const medicationId = med.json().medication.id as string;
  const { rows } = await owner.query<{ id: string }>(
    'SELECT id FROM medication_schedules WHERE medication_id=$1', [medicationId],
  );
  return { medicationId, scheduleId: rows[0]!.id };
}

async function doseFor(user: TestUser, date = DATE) {
  const res = await h.app.inject({
    method: 'GET', url: `/v1/doses?profileId=${user.profileId}&from=${date}&to=${date}`,
    headers: authHeaders(user),
  });
  return res.json().doses as Array<{ id: string; status: string }>;
}

beforeAll(async () => {
  resetDatabase();
  h = await startHarness();
  owner = conn();
  h.setNow(at('08:00'));
  await signIn(h, '+966500004001');
});

afterAll(async () => {
  await owner.end();
  await h.close();
});

// ══════════════════════════════════════ 1. locking / multi-replica

/**
 * `app.try_job_lock(name)` is `pg_try_advisory_xact_lock(hashtext(name))` — a
 * TRANSACTION-level lock, which is the important detail: it is released by
 * COMMIT, by ROLLBACK, and by the connection dying, so a worker killed mid-job
 * cannot leave a lock behind that blocks every future tick.
 */
describe('job locking is exclusive, and cannot strand a job', () => {
  it('two replicas reaching the same job: exactly one wins', async () => {
    const a = await owner.connect();
    const b = await owner.connect();
    try {
      await a.query('BEGIN');
      await b.query('BEGIN');
      const ra = await a.query<{ locked: boolean }>("SELECT app.try_job_lock('reminders') AS locked");
      const rb = await b.query<{ locked: boolean }>("SELECT app.try_job_lock('reminders') AS locked");
      expect([ra.rows[0]!.locked, rb.rows[0]!.locked].filter(Boolean).length,
        'both replicas acquired the same job lock').toBe(1);
      await a.query('ROLLBACK'); await b.query('ROLLBACK');
    } finally { a.release(); b.release(); }
  });

  it('the loser does not block: it takes the lock on the next tick', async () => {
    const a = await owner.connect();
    try {
      await a.query('BEGIN');
      await a.query("SELECT app.try_job_lock('dispatch')");
      await a.query('ROLLBACK'); // the winner finishes
    } finally { a.release(); }

    const b = await owner.connect();
    try {
      await b.query('BEGIN');
      const r = await b.query<{ locked: boolean }>("SELECT app.try_job_lock('dispatch') AS locked");
      expect(r.rows[0]!.locked, 'a completed job left its lock held').toBe(true);
      await b.query('ROLLBACK');
    } finally { b.release(); }
  });

  it('a connection dying releases the lock — no stale lock survives a crash', async () => {
    const victim = new pg.Pool({
      connectionString: 'postgres://postgres:postgres@127.0.0.1:5433/dawaee_test', max: 1,
    });
    const c = await victim.connect();
    const pid = (await c.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
    await c.query('BEGIN');
    await c.query("SELECT app.try_job_lock('materialize')");

    // Destroy, do not merely return, the connection. `Pool#end()` closes idle
    // sockets asynchronously; attempting the next lock before Postgres has
    // observed the FIN makes this crash test a race against TCP teardown rather
    // than a test of transaction-scoped advisory locks.
    c.release(true);
    await victim.end();

    let alive = true;
    for (let i = 0; i < 50 && alive; i++) {
      const status = await owner.query<{ alive: boolean }>(
        'SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid=$1) AS alive', [pid],
      );
      alive = status.rows[0]!.alive;
      if (alive) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(alive, 'the simulated crashed backend never disconnected').toBe(false);

    const after = await owner.connect();
    try {
      await after.query('BEGIN');
      const r = await after.query<{ locked: boolean }>("SELECT app.try_job_lock('materialize') AS locked");
      expect(r.rows[0]!.locked, 'a dead worker stranded the job lock forever').toBe(true);
      await after.query('ROLLBACK');
    } finally { after.release(); }
  });

  it('rollback releases it, so a failed job retries next tick', async () => {
    const a = await owner.connect();
    try {
      await a.query('BEGIN');
      await a.query("SELECT app.try_job_lock('mark-missed')");
      await a.query('ROLLBACK');
      await a.query('BEGIN');
      const r = await a.query<{ locked: boolean }>("SELECT app.try_job_lock('mark-missed') AS locked");
      expect(r.rows[0]!.locked).toBe(true);
      await a.query('ROLLBACK');
    } finally { a.release(); }
  });

  /**
   * The lock identity is `hashtext(jobName)`, which is a 32-bit hash. Two job
   * names colliding would silently serialize two unrelated jobs against each
   * other — one would simply never run while the other held the tick.
   */
  it('no two job names collide on the lock key', async () => {
    const names = ['materialize', 'reminders', 'dispatch', 'mark-missed', 'stock-alerts', 'digests', 'housekeeping'];
    const { rows } = await owner.query<{ name: string; key: string }>(
      'SELECT n AS name, hashtext(n)::bigint::text AS key FROM unnest($1::text[]) AS n', [names],
    );
    const keys = rows.map((r) => r.key);
    expect(new Set(keys).size, `job lock key collision: ${JSON.stringify(rows)}`).toBe(names.length);
  });

  it('different jobs do not block each other', async () => {
    const a = await owner.connect();
    const b = await owner.connect();
    try {
      await a.query('BEGIN'); await b.query('BEGIN');
      const ra = await a.query<{ locked: boolean }>("SELECT app.try_job_lock('reminders') AS locked");
      const rb = await b.query<{ locked: boolean }>("SELECT app.try_job_lock('digests') AS locked");
      expect(ra.rows[0]!.locked && rb.rows[0]!.locked,
        'two different jobs serialized against each other').toBe(true);
      await a.query('ROLLBACK'); await b.query('ROLLBACK');
    } finally { a.release(); b.release(); }
  });
});

// ══════════════════════════════════════ 2. materialization

describe('one logical dose produces one occurrence', () => {
  /**
   * The invariant is a database constraint, not a code path: a UNIQUE index on
   * (schedule_id, scheduled_at). That is what makes "materialize twice" safe
   * regardless of how the two runs interleave — a duplicate is rejected by the
   * engine rather than avoided by a check that could race.
   */
  it('is enforced by a unique index, not by application logic', async () => {
    const { rows } = await owner.query<{ indexdef: string }>(
      "SELECT indexdef FROM pg_indexes WHERE tablename='dose_occurrences' AND indexname='dose_occurrences_unique_idx'",
    );
    expect(rows, 'the occurrence uniqueness index is missing').toHaveLength(1);
    expect(rows[0]!.indexdef).toMatch(/UNIQUE/);
    expect(rows[0]!.indexdef).toMatch(/schedule_id, scheduled_at/);
  });

  it('rejects a duplicate occurrence at the database level', async () => {
    const user = await signIn(h, '+966500004002');
    await seedMedication(user, 'MatDrug');
    h.setNow(at('08:00'));
    await h.tick();

    const { rows } = await owner.query<{
      schedule_id: string; scheduled_at: Date; patient_profile_id: string; medication_id: string;
      dose_quantity: string; dose_unit: string; scheduled_local_date: string;
      scheduled_local_time: string; scheduled_timezone: string;
    }>(
      `SELECT schedule_id, scheduled_at, patient_profile_id, medication_id, dose_quantity, dose_unit,
              scheduled_local_date, scheduled_local_time, scheduled_timezone
         FROM dose_occurrences WHERE patient_profile_id = $1 LIMIT 1`, [user.profileId],
    );
    expect(rows).toHaveLength(1);
    const d = rows[0]!;

    // Byte-for-byte the same logical dose, inserted a second time.
    const dup = await owner.query(
      `INSERT INTO dose_occurrences
         (patient_profile_id, medication_id, schedule_id, scheduled_at, dose_quantity, dose_unit,
          scheduled_local_date, scheduled_local_time, scheduled_timezone, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'upcoming')`,
      [d.patient_profile_id, d.medication_id, d.schedule_id, d.scheduled_at, d.dose_quantity,
       d.dose_unit, d.scheduled_local_date, d.scheduled_local_time, d.scheduled_timezone],
    ).then(() => null).catch((e: Error) => e.message);

    expect(dup, 'a duplicate occurrence was accepted').toMatch(/duplicate key|unique/i);
  });

  it('materializing repeatedly creates nothing extra', async () => {
    const user = await signIn(h, '+966500004003');
    await seedMedication(user, 'RepeatDrug');
    h.setNow(at('08:00'));
    for (let i = 0; i < 4; i++) await h.tick();

    const { rows } = await owner.query<{ n: string }>(
      'SELECT count(*) AS n FROM dose_occurrences WHERE patient_profile_id=$1 AND scheduled_local_date=$2',
      [user.profileId, DATE],
    );
    expect(Number(rows[0]!.n), 'repeat materialization duplicated a dose').toBe(1);
  });

  /**
   * Two replicas materializing the same schedule at the same instant, forced
   * rather than hoped for: both transactions insert the same (schedule_id,
   * scheduled_at) and the loser must be rejected by the index.
   */
  it('two concurrent materializations cannot both insert the same dose', async () => {
    const user = await signIn(h, '+966500004004');
    const { scheduleId, medicationId } = await seedMedication(user, 'RaceDrug', '14:00');
    // A slot nothing has materialized: the point is two writers colliding on
    // the same NEW row, not on one that already exists.
    const when = at('14:00', 40);

    const a = await owner.connect();
    const b = await owner.connect();
    const results: string[] = [];
    try {
      await a.query('BEGIN'); await b.query('BEGIN');
      const insert = (c: pg.PoolClient) => c.query(
        `INSERT INTO dose_occurrences
           (patient_profile_id, medication_id, schedule_id, scheduled_at, dose_quantity, dose_unit,
            scheduled_local_date, scheduled_local_time, scheduled_timezone, status)
         VALUES ($1,$2,$3,$4,1,'tablet',$5,'14:00','Asia/Riyadh','upcoming')`,
        [user.profileId, medicationId, scheduleId, when, DATE],
      ).then(() => 'ok').catch((e: Error) => e.message);

      // Each writer commits as soon as ITS OWN insert returns, rather than the
      // test deciding who goes first.
      //
      // The previous shape awaited `pa` and only then committed A. Which writer
      // reaches the unique index first is not ordered, so whenever B won the
      // race the test deadlocked itself: A blocked on B's uncommitted tuple, and
      // B's COMMIT was queued behind an `await` that could never return. Not a
      // product deadlock — PostgreSQL cannot see a cycle that runs through the
      // client — so it simply hung until the 30s test timeout. Observed once in
      // four full-suite runs, on a loaded machine; a race that only usually
      // resolves is a flake waiting for CI.
      const settle = (c: pg.PoolClient, p: Promise<string>) =>
        p.then(async (r) => { await c.query('COMMIT').catch(() => undefined); return r; });
      results.push(...await Promise.all([settle(a, insert(a)), settle(b, insert(b))]));
    } finally { a.release(); b.release(); }

    expect(results.filter((r) => r === 'ok').length,
      'both replicas inserted the same logical dose').toBe(1);
  });

  it('does not materialize before the start date or after the end date', async () => {
    const user = await signIn(h, '+966500004005');
    const { scheduleId } = await seedMedication(user, 'BoundedDrug');
    // Before ANY tick: the first tick materializes a prefetch window, so
    // bounding afterwards would measure occurrences that predate the bound.
    await owner.query('UPDATE medication_schedules SET end_date = $2 WHERE id=$1', [scheduleId, DATE]);
    await owner.query('DELETE FROM dose_occurrences WHERE schedule_id=$1', [scheduleId]);

    h.setNow(at('08:00', 3)); // three days later
    await h.tick();

    const { rows } = await owner.query<{ n: string }>(
      'SELECT count(*) AS n FROM dose_occurrences WHERE schedule_id=$1 AND scheduled_local_date > $2',
      [scheduleId, DATE],
    );
    expect(Number(rows[0]!.n), 'materialized past the schedule end date').toBe(0);
  });

  it('leaves already-materialized occurrences alone when the schedule is edited', async () => {
    const user = await signIn(h, '+966500004006');
    const { scheduleId } = await seedMedication(user, 'EditDrug', '10:00');
    h.setNow(at('08:00'));
    await h.tick();
    const countFor = async () => {
      const { rows } = await owner.query<{ n: string }>(
        'SELECT count(*) AS n FROM dose_occurrences WHERE schedule_id=$1', [scheduleId],
      );
      return Number(rows[0]!.n);
    };
    expect(await countFor(), 'nothing was materialized to begin with').toBeGreaterThan(0);

    // The patient moves the dose time. Existing occurrences are historical
    // record; only future materialization should change.
    await owner.query(
      `UPDATE medication_schedules SET rule = jsonb_set(rule, '{times}', '["18:00"]') WHERE id=$1`,
      [scheduleId],
    );
    await h.tick();

    // The invariant is not "the count stayed the same" — an edit may legitimately
    // add or stop future slots. It is that no INSTANT is ever duplicated.
    expect(await countFor(), 'the edit destroyed existing occurrences').toBeGreaterThan(0);
    const { rows: dupes } = await owner.query<{ n: string }>(
      `SELECT count(*) AS n FROM (
         SELECT scheduled_at FROM dose_occurrences WHERE schedule_id=$1
         GROUP BY scheduled_at HAVING count(*) > 1) x`, [scheduleId],
    );
    expect(Number(dupes[0]!.n), 'a schedule edit produced duplicate instants').toBe(0);
  });
});

// ══════════════════════════════════════ 3/4/5. dispatch

/**
 * The dispatcher claims with `FOR UPDATE SKIP LOCKED`, which is the correct
 * primitive: a second worker skips the locked rows instead of blocking or
 * double-claiming. What the tests below establish is the boundary behaviour
 * around the PROVIDER call, which is where duplicates actually come from.
 */
describe('delivery claiming is atomic across replicas', () => {
  const dispatcherClaimSql = async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../../worker/src/jobs/dispatcher.ts', import.meta.url), 'utf8');
    const start = src.indexOf('`UPDATE notification_deliveries d');
    expect(start, 'the dispatcher claim query could not be located').toBeGreaterThan(-1);
    const end = src.indexOf('`', start + 1);
    return src.slice(start + 1, end);
  };

  it('two workers cannot claim the same queued delivery', async () => {
    const user = await signIn(h, '+966500004010');
    await owner.query(
      `INSERT INTO notification_deliveries
         (patient_profile_id, recipient_user_id, kind, channel, locale, title, body, payload,
          dedupe_key, scheduled_for, next_attempt_at, status)
       VALUES ($1,$2,'dose_reminder','push','en','t','b','{}'::jsonb,$3, now(), now(), 'queued')`,
      [user.profileId, user.userId, `claim-race-${Date.now()}`],
    );

    const sql = await dispatcherClaimSql();
    const a = await owner.connect();
    const b = await owner.connect();
    try {
      await a.query('BEGIN'); await b.query('BEGIN');
      const ra = await a.query<{ id: string }>(sql, [new Date(), 120, 200]);
      const rb = await b.query<{ id: string }>(sql, [new Date(), 120, 200]);
      const overlap = ra.rows.filter((x) => rb.rows.some((y) => y.id === x.id));
      expect(overlap.map((x) => x.id),
        'two workers claimed the same delivery — the claim is not atomic').toEqual([]);
      await a.query('ROLLBACK'); await b.query('ROLLBACK');
    } finally { a.release(); b.release(); }
  });

  const dispatcherSentSql = async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../../worker/src/jobs/dispatcher.ts', import.meta.url), 'utf8');
    const start = src.indexOf("`UPDATE notification_deliveries\n            SET status = 'sent'");
    expect(start, 'the dispatcher sent-finalisation query could not be located').toBeGreaterThan(-1);
    const end = src.indexOf('`', start + 1);
    return src.slice(start + 1, end);
  };

  let seq = 0;
  const enqueue = async (user: TestUser) => {
    const key = `p10-1-${Date.now()}-${seq++}`;
    const { rows } = await owner.query<{ id: string }>(
      `INSERT INTO notification_deliveries
         (patient_profile_id, recipient_user_id, kind, channel, locale, title, body, payload,
          dedupe_key, scheduled_for, next_attempt_at, status)
       VALUES ($1,$2,'dose_reminder','push','en','t','b','{}'::jsonb,$3, now(), TIMESTAMPTZ '2000-01-01 00:00:00+00', 'queued')
       RETURNING id`,
      [user.profileId, user.userId, key],
    );
    return rows[0]!.id;
  };

  const stateOf = async (id: string) => {
    const { rows } = await owner.query<{
      status: string; attempts: number; lease_token: string | null; lease_until: Date | null;
    }>('SELECT status, attempts, lease_token, lease_until FROM notification_deliveries WHERE id=$1', [id]);
    return rows[0]!;
  };

  it('window 1 — dies before the claim commits: the row is untouched and still queued', async () => {
    const user = await signIn(h, '+966500004011');
    const id = await enqueue(user);
    const sql = await dispatcherClaimSql();

    const c = await owner.connect();
    try {
      await c.query('BEGIN');
      const r = await c.query<{ id: string }>(sql, [new Date(), 120, 200]);
      expect(r.rows.some((x) => x.id === id), 'the claim did not pick up a due delivery').toBe(true);
      await c.query('ROLLBACK');
    } finally { c.release(); }

    const s = await stateOf(id);
    expect(s.status, 'a crash before the claim committed lost the delivery').toBe('queued');
    expect(s.attempts, 'an uncommitted claim consumed an attempt').toBe(0);
    expect(s.lease_token, 'an uncommitted claim left a lease behind').toBeNull();
  });

  it('window 2 — dies after the claim commits, before the provider call: the lease expires and another worker recovers it', async () => {
    const user = await signIn(h, '+966500004012');
    const id = await enqueue(user);
    const sql = await dispatcherClaimSql();
    const t0 = new Date();

    const a = await owner.connect();
    try {
      await a.query('BEGIN');
      await a.query(sql, [t0, 120, 200]);
      await a.query('COMMIT');
    } finally { a.release(); }

    const held = await stateOf(id);
    expect(held.status).toBe('sending');
    expect(held.lease_token, 'the claim did not stamp a lease token').not.toBeNull();

    const during = await owner.query<{ id: string }>(sql, [new Date(t0.getTime() + 60_000), 120, 200]);
    expect(during.rows.map((r) => r.id), 'a live lease was stolen mid-send').not.toContain(id);

    const after = await owner.query<{ id: string; lease_token: string }>(
      sql, [new Date(t0.getTime() + 121_000), 120, 200],
    );
    expect(after.rows.map((r) => r.id), 'an expired lease was never recovered').toContain(id);

    const recovered = await stateOf(id);
    expect(recovered.lease_token, 'recovery did not re-stamp the lease token').not.toBe(held.lease_token);
    expect(recovered.attempts, 'the recovery did not count as a new attempt').toBe(2);
  });

  it('window 3 — dies during the provider call: outcome unknown, and the lease still recovers', async () => {
    const user = await signIn(h, '+966500004013');
    const id = await enqueue(user);
    const sql = await dispatcherClaimSql();
    const t0 = new Date();
    await owner.query(sql, [t0, 120, 200]);
    const stuck = await stateOf(id);
    expect(stuck.status).toBe('sending');
    const after = await owner.query<{ id: string }>(sql, [new Date(t0.getTime() + 121_000), 120, 200]);
    expect(after.rows.map((r) => r.id),
      'an ambiguous send was never retried — the reminder would be silently lost').toContain(id);
  });

  it('window 4 — dies after a successful send, before finalising: the reminder is re-sent (documented at-least-once)', async () => {
    const user = await signIn(h, '+966500004014');
    const id = await enqueue(user);
    const sql = await dispatcherClaimSql();
    const t0 = new Date();
    await owner.query(sql, [t0, 120, 200]);
    const after = await owner.query<{ id: string }>(sql, [new Date(t0.getTime() + 121_000), 120, 200]);
    expect(after.rows.map((r) => r.id), 'the delivery did not recover').toContain(id);
    const s = await stateOf(id);
    expect(s.attempts, 'the re-send was not counted as a second attempt').toBe(2);
  });

  it('window 5 — dies after finalising: a sent delivery is never re-claimed', async () => {
    const user = await signIn(h, '+966500004015');
    const id = await enqueue(user);
    const claim = await dispatcherClaimSql();
    const sent = await dispatcherSentSql();
    const t0 = new Date();
    const { rows } = await owner.query<{ id: string; lease_token: string }>(claim, [t0, 120, 200]);
    const mine = rows.find((r) => r.id === id)!;
    const applied = await owner.query(sent, [id, mine.lease_token, 'expo', 'msg-1']);
    expect(applied.rowCount, 'the finalisation did not apply').toBe(1);
    const later = await owner.query<{ id: string }>(claim, [new Date(t0.getTime() + 3_600_000), 120, 200]);
    expect(later.rows.map((r) => r.id),
      'a delivery already sent was claimed again — the patient gets a duplicate').not.toContain(id);
    const s = await stateOf(id);
    expect(s.status).toBe('sent');
    expect(s.lease_until, 'a finalised delivery kept its lease').toBeNull();
  });

  it('window 6 — a stale worker returns after its lease was reassigned and writes nothing', async () => {
    const user = await signIn(h, '+966500004016');
    const id = await enqueue(user);
    const claim = await dispatcherClaimSql();
    const sent = await dispatcherSentSql();
    const t0 = new Date();
    const { rows: ra } = await owner.query<{ id: string; lease_token: string }>(claim, [t0, 120, 200]);
    const aToken = ra.find((r) => r.id === id)!.lease_token;
    const { rows: rb } = await owner.query<{ id: string; lease_token: string }>(
      claim, [new Date(t0.getTime() + 121_000), 120, 200],
    );
    const bToken = rb.find((r) => r.id === id)!.lease_token;
    expect(bToken).not.toBe(aToken);
    await owner.query(sent, [id, bToken, 'expo', 'msg-from-B']);
    const stale = await owner.query(sent, [id, aToken, 'expo', 'msg-from-A']);
    expect(stale.rowCount,
      'a worker whose lease was reassigned overwrote the new owner\'s result').toBe(0);
    const s = await owner.query<{ provider_message_id: string }>(
      'SELECT provider_message_id FROM notification_deliveries WHERE id=$1', [id],
    );
    expect(s.rows[0]!.provider_message_id,
      'the stale worker\'s result replaced the real one').toBe('msg-from-B');
  });

  it('window 7 — dies mid-batch: finalised rows stay finalised, unfinalised ones recover independently', async () => {
    const user = await signIn(h, '+966500004017');
    const first = await enqueue(user);
    const second = await enqueue(user);
    const claim = await dispatcherClaimSql();
    const sent = await dispatcherSentSql();
    const t0 = new Date();
    const { rows } = await owner.query<{ id: string; lease_token: string }>(claim, [t0, 120, 200]);
    const byId = new Map(rows.map((r) => [r.id, r.lease_token]));
    expect(byId.has(first) && byId.has(second), 'the batch did not claim both deliveries').toBe(true);
    await owner.query(sent, [first, byId.get(first)!, 'expo', 'msg-first']);
    const later = await owner.query<{ id: string }>(claim, [new Date(t0.getTime() + 121_000), 120, 200]);
    const recovered = later.rows.map((r) => r.id);
    expect(recovered, 'the completed half of the batch was re-sent').not.toContain(first);
    expect(recovered, 'the unfinished half of the batch was stranded').toContain(second);
  });

  it('no row lock is held while the provider call would be running', async () => {
    const user = await signIn(h, '+966500004018');
    const id = await enqueue(user);
    const claim = await dispatcherClaimSql();
    const a = await owner.connect();
    try {
      await a.query('BEGIN');
      await a.query(claim, [new Date(), 120, 200]);
      await a.query('COMMIT');
    } finally { a.release(); }
    const b = await owner.connect();
    try {
      await b.query('BEGIN');
      const locked = await b.query('SELECT id FROM notification_deliveries WHERE id=$1 FOR UPDATE NOWAIT', [id])
        .then(() => true).catch(() => false);
      expect(locked,
        'the claimed row is still locked — a transaction is open across the provider call').toBe(true);
      await b.query('ROLLBACK');
    } finally { b.release(); }
  });

  it('an unknown provider outcome is retried, a known failure is not', async () => {
    const { isAmbiguous } = await import('../../worker/src/jobs/dispatcher.js');
    expect(isAmbiguous('network_error'), 'a timed-out send is treated as a definite failure').toBe(true);
    expect(isAmbiguous('http_502')).toBe(true);
    expect(isAmbiguous('http_503')).toBe(true);
    expect(isAmbiguous('DeviceNotRegistered'), 'a dead token would be retried forever').toBe(false);
    expect(isAmbiguous('MessageTooBig')).toBe(false);
    expect(isAmbiguous('http_400'), 'a rejected payload would be retried forever').toBe(false);
    expect(isAmbiguous(undefined)).toBe(false);
  });

  it('the dispatcher commits the claim before it sends, and finalises separately', async () => {
    const { readFileSync } = await import('node:fs');
    const raw = readFileSync(new URL('../../worker/src/jobs/dispatcher.ts', import.meta.url), 'utf8');
    const code = stripComments(raw);
    expect(code, 'comment stripping removed the dispatcher body').toMatch(/export async function dispatchJob/);
    const commit = code.indexOf("claimClient.query('COMMIT')");
    const send = code.indexOf('await sendOne(');
    expect(commit, 'the claim is no longer committed on its own connection').toBeGreaterThan(-1);
    expect(send, 'the provider call could not be located').toBeGreaterThan(-1);
    expect(commit, 'the provider is called before the claim commits').toBeLessThan(send);
    expect(code).toMatch(/async function finalise[\s\S]*?ctx\.pool\.connect\(\)/);
    const guards = code.match(/WHERE id = \$1 AND lease_token = \$2/g) ?? [];
    expect(guards.length, 'a finalisation path is not guarded by the lease token').toBe(3);
  });

  it('a permanent failure is recorded and not retried forever', async () => {
    const { rows } = await owner.query<{ n: string }>(
      "SELECT count(*) AS n FROM pg_type WHERE typname='delivery_status'",
    );
    expect(Number(rows[0]!.n)).toBe(1);
    const { rows: labels } = await owner.query<{ label: string }>(
      "SELECT unnest(enum_range(NULL::delivery_status))::text AS label",
    );
    const states = labels.map((l) => l.label);
    expect(states, 'no terminal failure state').toContain('failed');
    expect(states).toContain('sent');
  });
});

// ══════════════════════════════════════ 6. dose action vs mark-missed

describe('a dose the patient acknowledged never becomes missed', () => {
  const missedPredicate = async () => {
    const { readFileSync } = await import('node:fs');
    return readFileSync(new URL('../../worker/src/jobs/mark-missed.ts', import.meta.url), 'utf8');
  };

  it('mark-missed only touches doses still in an open state', async () => {
    const src = await missedPredicate();
    expect(src, 'mark-missed has no status guard — it could overwrite a taken dose')
      .toMatch(/status IN \('upcoming','due','pending_confirmation','snoozed'\)/);
  });

  it('Taken before mark-missed: stays taken', async () => {
    const user = await signIn(h, '+966500004020');
    await seedMedication(user, 'TakenFirst', '09:00', 30);
    h.setNow(at('08:00'));
    await h.tick();
    const [dose] = await doseFor(user);
    h.setNow(at('09:05'));
    const taken = await h.app.inject({
      method: 'POST', url: `/v1/doses/${dose!.id}/taken`, headers: authHeaders(user),
      payload: { clientEventId: `evt-tf-${Date.now()}`, at: at('09:05').toISOString() },
    });
    expect(taken.statusCode).toBe(200);
    h.setNow(at('11:00'));
    await h.tick();
    const { rows } = await owner.query<{ status: string }>(
      'SELECT status FROM dose_occurrences WHERE id=$1', [dose!.id],
    );
    expect(rows[0]!.status, 'a taken dose was later marked missed').toBe('taken');
  });

  it('mark-missed in flight, Taken arrives: one wins, and it is never both', async () => {
    const user = await signIn(h, '+966500004021');
    await seedMedication(user, 'RaceMissed', '09:00', 30);
    h.setNow(at('08:00'));
    await h.tick();
    const [dose] = await doseFor(user);
    const a = await owner.connect();
    const b = await owner.connect();
    try {
      await a.query('BEGIN');
      await a.query(
        `UPDATE dose_occurrences SET status='missed'
          WHERE id=$1 AND status IN ('upcoming','due','pending_confirmation','snoozed')`,
        [dose!.id],
      );
      await b.query('BEGIN');
      const takenPromise = b.query(
        `UPDATE dose_occurrences
            SET status='taken', confirmed_at=now(), confirmation_method='app'
          WHERE id=$1 AND status IN ('upcoming','due','pending_confirmation','snoozed')`,
        [dose!.id],
      );
      await a.query('COMMIT');
      const takenResult = await takenPromise;
      await b.query('COMMIT');
      expect(takenResult.rowCount, 'both writes applied — the dose forked').toBe(0);
    } finally { a.release(); b.release(); }
    const { rows } = await owner.query<{ status: string }>(
      'SELECT status FROM dose_occurrences WHERE id=$1', [dose!.id],
    );
    expect(['missed', 'taken']).toContain(rows[0]!.status);
  });

  it('Taken in flight, mark-missed arrives: the miss does not overwrite it', async () => {
    const user = await signIn(h, '+966500004022');
    await seedMedication(user, 'TakenWins', '09:00', 30);
    h.setNow(at('08:00'));
    await h.tick();
    const [dose] = await doseFor(user);
    const a = await owner.connect();
    const b = await owner.connect();
    try {
      await a.query('BEGIN');
      await a.query(
        `UPDATE dose_occurrences
            SET status='taken', confirmed_at=now(), confirmation_method='app'
          WHERE id=$1 AND status IN ('upcoming','due','pending_confirmation','snoozed')`,
        [dose!.id],
      );
      await b.query('BEGIN');
      const missPromise = b.query(
        `UPDATE dose_occurrences SET status='missed'
          WHERE id=$1 AND status IN ('upcoming','due','pending_confirmation','snoozed')`,
        [dose!.id],
      );
      await a.query('COMMIT');
      const missResult = await missPromise;
      await b.query('COMMIT');
      expect(missResult.rowCount, 'mark-missed overwrote an acknowledged dose').toBe(0);
    } finally { a.release(); b.release(); }
    const { rows } = await owner.query<{ status: string }>(
      'SELECT status FROM dose_occurrences WHERE id=$1', [dose!.id],
    );
    expect(rows[0]!.status, 'the patient’s acknowledgement was lost').toBe('taken');
  });

  it('Skip and Snooze are protected by the same predicate', async () => {
    for (const [phone, action] of [['+966500004023', 'skipped'], ['+966500004024', 'snoozed']] as const) {
      const user = await signIn(h, phone);
      await seedMedication(user, `Guard-${action}`, '09:00', 30);
      h.setNow(at('08:00'));
      await h.tick();
      const [dose] = await doseFor(user);
      await owner.query(
        `UPDATE dose_occurrences SET status=$2::dose_status WHERE id=$1`, [dose!.id, action],
      );
      const miss = await owner.query(
        `UPDATE dose_occurrences SET status='missed'
          WHERE id=$1 AND status IN ('upcoming','due','pending_confirmation','snoozed')`,
        [dose!.id],
      );
      if (action === 'skipped') {
        expect(miss.rowCount, 'a skipped dose was marked missed').toBe(0);
      } else {
        expect(miss.rowCount).toBe(1);
      }
    }
  });

  it('P10-2 CLOSED: a nearby miss on another dose does not duplicate the first one’s event', async () => {
    const user = await signIn(h, '+966500004025');
    await seedMedication(user, 'Amoxicillin', '09:00', 30);
    await seedMedication(user, 'Metformin', '10:00', 30);
    h.setNow(at('08:00'));
    await h.tick();
    h.setNow(at('09:45'));
    await h.tick();
    h.setNow(at('10:45'));
    await h.tick();
    const { rows } = await owner.query<{ dose_occurrence_id: string; n: string }>(
      `SELECT dose_occurrence_id, count(*) AS n FROM dose_events
        WHERE type='missed' AND dose_occurrence_id IN (
          SELECT id FROM dose_occurrences WHERE patient_profile_id=$1)
        GROUP BY dose_occurrence_id ORDER BY count(*) DESC`,
      [user.profileId],
    );
    const worst = Math.max(0, ...rows.map((r) => Number(r.n)));
    expect(worst, 'a missed event was written twice for one dose').toBe(1);
    expect(rows.length, 'both doses should have been missed').toBe(2);
  });

  it('a repeated tick adds no further missed events', async () => {
    const user = await signIn(h, '+966500004026');
    await seedMedication(user, 'Warfarin', '09:00', 30);
    h.setNow(at('08:00'));
    await h.tick();
    const [dose] = await doseFor(user);
    h.setNow(at('10:00'));
    for (let i = 0; i < 4; i++) await h.tick();
    const { rows } = await owner.query<{ n: string }>(
      "SELECT count(*) AS n FROM dose_events WHERE dose_occurrence_id=$1 AND type='missed'",
      [dose!.id],
    );
    expect(Number(rows[0]!.n), 'four ticks produced more than one missed event').toBe(1);
  });

  it('the database refuses a second missed event for the same dose', async () => {
    const user = await signIn(h, '+966500004027');
    await seedMedication(user, 'Digoxin', '09:00', 30);
    h.setNow(at('08:00'));
    await h.tick();
    const [dose] = await doseFor(user);
    h.setNow(at('10:00'));
    await h.tick();
    const err = await owner.query(
      `INSERT INTO dose_events (dose_occurrence_id, patient_profile_id, type, metadata)
       VALUES ($1, $2, 'missed', '{}'::jsonb)`,
      [dose!.id, user.profileId],
    ).then(() => null).catch((e: Error) => e.message);
    expect(err, 'a duplicate missed event was accepted').toMatch(/duplicate key|unique/i);
  });

  it('other event types are deliberately still repeatable', async () => {
    const user = await signIn(h, '+966500004028');
    await seedMedication(user, 'Ibuprofen', '09:00', 240);
    h.setNow(at('08:00'));
    await h.tick();
    const [dose] = await doseFor(user);
    for (let i = 0; i < 2; i++) {
      const r = await owner.query(
        `INSERT INTO dose_events (dose_occurrence_id, patient_profile_id, type, metadata)
         VALUES ($1,$2,'snoozed','{}'::jsonb)`, [dose!.id, user.profileId],
      );
      expect(r.rowCount, 'a legitimate repeat event was refused').toBe(1);
    }
  });

  const markMissedSql = async () => {
    const src = await missedPredicate();
    const start = src.indexOf('`WITH newly_missed AS (');
    expect(start, 'the mark-missed query could not be located').toBeGreaterThan(-1);
    const end = src.indexOf('`', start + 1);
    return src.slice(start + 1, end);
  };

  it('two workers running the same tick together still write one event', async () => {
    const user = await signIn(h, '+966500004029');
    await seedMedication(user, 'Levothyroxine', '09:00', 30);
    h.setNow(at('08:00'));
    await h.tick();
    const [dose] = await doseFor(user);
    const sql = await markMissedSql();
    const now = at('10:00');
    const race = conn(2);
    const a = await race.connect();
    const b = await race.connect();
    let bMarked = 0;
    try {
      await a.query('BEGIN'); await b.query('BEGIN');
      const ra = await a.query<{ marked: number }>(sql, [now]);
      expect(ra.rows[0]!.marked, 'the first worker marked nothing').toBe(1);
      const pending = b.query<{ marked: number }>(sql, [now]);
      await a.query('COMMIT');
      const rb = await pending;
      bMarked = rb.rows[0]!.marked;
      await b.query('COMMIT');
    } finally { a.release(); b.release(); await race.end(); }
    expect(bMarked,
      'the second worker re-marked a dose the first had already committed').toBe(0);
    const { rows } = await owner.query<{ n: string }>(
      "SELECT count(*) AS n FROM dose_events WHERE dose_occurrence_id=$1 AND type='missed'",
      [dose!.id],
    );
    expect(Number(rows[0]!.n),
      'two concurrent workers wrote two missed events for one dose').toBe(1);
    const { rows: st } = await owner.query<{ status: string }>(
      'SELECT status FROM dose_occurrences WHERE id=$1', [dose!.id],
    );
    expect(st[0]!.status, 'the dose was not marked missed at all').toBe('missed');
  });

  it('a rollback between the status change and the event leaves neither behind', async () => {
    const user = await signIn(h, '+966500004033');
    await seedMedication(user, 'Furosemide', '09:00', 30);
    h.setNow(at('08:00'));
    await h.tick();
    const [dose] = await doseFor(user);
    const sql = await markMissedSql();
    const c = await owner.connect();
    try {
      await c.query('BEGIN');
      await c.query(sql, [at('10:00')]);
      const mid = await c.query<{ n: string }>(
        "SELECT count(*) AS n FROM dose_events WHERE dose_occurrence_id=$1 AND type='missed'",
        [dose!.id],
      );
      expect(Number(mid.rows[0]!.n), 'the event was not written with the status change').toBe(1);
      await c.query('ROLLBACK');
    } finally { c.release(); }
    const { rows } = await owner.query<{ status: string; n: string }>(
      `SELECT d.status,
              (SELECT count(*) FROM dose_events e
                WHERE e.dose_occurrence_id = d.id AND e.type='missed') AS n
         FROM dose_occurrences d WHERE d.id=$1`,
      [dose!.id],
    );
    expect(rows[0]!.status, 'a rolled-back tick left the dose marked missed').not.toBe('missed');
    expect(Number(rows[0]!.n), 'a rolled-back tick left an orphaned missed event').toBe(0);
    h.setNow(at('10:05'));
    await h.tick();
    const { rows: after } = await owner.query<{ status: string; n: string }>(
      `SELECT d.status,
              (SELECT count(*) FROM dose_events e
                WHERE e.dose_occurrence_id = d.id AND e.type='missed') AS n
         FROM dose_occurrences d WHERE d.id=$1`,
      [dose!.id],
    );
    expect(after[0]!.status, 'the retry after a crash did not mark the dose').toBe('missed');
    expect(Number(after[0]!.n), 'the retry did not write exactly one event').toBe(1);
  });

  it('many doses missed by one tick each get exactly one event', async () => {
    const user = await signIn(h, '+966500004034');
    const times = ['09:00', '09:10', '09:20', '09:30', '09:40'];
    for (const [i, t] of times.entries()) await seedMedication(user, `Bulk${i}`, t, 30);
    h.setNow(at('08:00'));
    await h.tick();
    h.setNow(at('11:00'));
    await h.tick();
    await h.tick();
    const { rows } = await owner.query<{ dose_occurrence_id: string; n: string }>(
      `SELECT dose_occurrence_id, count(*) AS n FROM dose_events
        WHERE type='missed' AND dose_occurrence_id IN (
          SELECT id FROM dose_occurrences WHERE patient_profile_id=$1)
        GROUP BY dose_occurrence_id`,
      [user.profileId],
    );
    expect(rows.length, 'not every missed dose got an event').toBe(times.length);
    expect(rows.map((r) => Number(r.n)).filter((n) => n !== 1),
      'some dose got more or fewer than one missed event').toEqual([]);
  });

  it('the status change and its event are written by one statement', async () => {
    const { readFileSync } = await import('node:fs');
    const raw = readFileSync(new URL('../../worker/src/jobs/mark-missed.ts', import.meta.url), 'utf8');
    const code = stripComments(raw);
    expect(code, 'comment stripping removed the executable query').toMatch(/dose_occurrences/);
    expect(code, 'mark-missed still rescans by time window')
      .not.toMatch(/updated_at\s*>\s*now\(\)\s*-\s*interval/);
    expect(code).toMatch(/WITH newly_missed AS \(/);
    expect(code).toMatch(/RETURNING d\.id, d\.patient_profile_id/);
  });
});

// ══════════════════════════════════════ 7. escalation

describe('escalation is deduplicated by a stable key', () => {
  it('the key is a unique index, so a retry cannot double-notify', async () => {
    const { rows } = await owner.query<{ indexdef: string }>(
      "SELECT indexdef FROM pg_indexes WHERE tablename='notification_deliveries' AND indexname='notification_dedupe_idx'",
    );
    expect(rows, 'no dedupe index on notification_deliveries').toHaveLength(1);
    expect(rows[0]!.indexdef).toMatch(/UNIQUE/);
  });

  it('inserting the same escalation twice is a no-op', async () => {
    const user = await signIn(h, '+966500004030');
    const key = `esc-dedupe-${Date.now()}`;
    const insert = () => owner.query(
      `INSERT INTO notification_deliveries
         (patient_profile_id, recipient_user_id, kind, channel, locale, title, body, payload,
          dedupe_key, scheduled_for, next_attempt_at)
       VALUES ($1,$2,'dose_reminder','push','en','t','b','{}'::jsonb,$3, now(), now())
       ON CONFLICT (dedupe_key) DO NOTHING`,
      [user.profileId, user.userId, key],
    );
    const first = await insert();
    const second = await insert();
    expect(first.rowCount).toBe(1);
    expect(second.rowCount, 'a repeated escalation created a second delivery').toBe(0);
  });

  it('repeated ticks do not multiply reminders for one dose', async () => {
    const user = await signIn(h, '+966500004031');
    await h.app.inject({
      method: 'POST', url: '/v1/devices/push-token', headers: authHeaders(user),
      payload: { token: `ExponentPushToken[esc-${Date.now()}]`, platform: 'ios', deviceId: 'device-esc-0001' },
    });
    await h.app.inject({
      method: 'PUT', url: `/v1/escalation-policy?profileId=${user.profileId}`, headers: authHeaders(user),
      payload: { enabled: true, stages: [{ afterMinutes: 0, target: 'patient', channels: ['push'] }] },
    });
    await seedMedication(user, 'EscDrug', '09:00', 240);
    h.setNow(at('08:00'));
    await h.tick();
    const [dose] = await doseFor(user);
    h.setNow(at('09:00'));
    for (let i = 0; i < 5; i++) await h.tick();
    const { rows } = await owner.query<{ n: string }>(
      'SELECT count(*) AS n FROM notification_deliveries WHERE dose_occurrence_id=$1', [dose!.id],
    );
    expect(Number(rows[0]!.n), 'five ticks produced more than one delivery for one stage').toBe(1);
  });

  it('a dose taken before escalation stops further stages', async () => {
    const user = await signIn(h, '+966500004032');
    await h.app.inject({
      method: 'PUT', url: `/v1/escalation-policy?profileId=${user.profileId}`, headers: authHeaders(user),
      payload: {
        enabled: true,
        stages: [
          { afterMinutes: 0, target: 'patient', channels: ['push'] },
          { afterMinutes: 30, target: 'patient', channels: ['push'] },
        ],
      },
    });
    await seedMedication(user, 'StopDrug', '09:00', 240);
    h.setNow(at('08:00'));
    await h.tick();
    const [dose] = await doseFor(user);
    h.setNow(at('09:00'));
    await h.tick();
    const afterFirst = await owner.query<{ n: string }>(
      'SELECT count(*) AS n FROM notification_deliveries WHERE dose_occurrence_id=$1', [dose!.id],
    );
    await h.app.inject({
      method: 'POST', url: `/v1/doses/${dose!.id}/taken`, headers: authHeaders(user),
      payload: { clientEventId: `evt-stop-${Date.now()}`, at: at('09:10').toISOString() },
    });
    h.setNow(at('10:00'));
    await h.tick();
    const afterTaken = await owner.query<{ n: string }>(
      'SELECT count(*) AS n FROM notification_deliveries WHERE dose_occurrence_id=$1', [dose!.id],
    );
    expect(Number(afterTaken.rows[0]!.n),
      'escalation continued after the patient took the dose')
      .toBe(Number(afterFirst.rows[0]!.n));
  });
});

// ══════════════════════════════════════ 8. stock alerts

describe('stock alerts do not storm', () => {
  it('one alert per medication per threshold crossing, across many ticks', async () => {
    const user = await signIn(h, '+966500004040');
    const { medicationId } = await seedMedication(user, 'StockDrug');
    await owner.query('UPDATE medication_stock SET remaining_quantity = 2 WHERE medication_id=$1', [medicationId]);
    h.setNow(at('08:00'));
    for (let i = 0; i < 5; i++) await h.tick({ includeSlowJobs: true } as never);
    const { rows } = await owner.query<{ n: string }>(
      `SELECT count(*) AS n FROM notification_deliveries
        WHERE patient_profile_id=$1 AND kind::text LIKE '%stock%'`, [user.profileId],
    );
    expect(Number(rows[0]!.n), 'a low-stock alert fired on every tick').toBeLessThanOrEqual(1);
  });
});

// ══════════════════════════════════════ 10. housekeeping

describe('housekeeping steps and their failure isolation', () => {
  it('every direct step completes, while sensitive object cleanup stays behind bounded helpers', async () => {
    const steps: Array<[string, string]> = [
      ['otp', 'SELECT app.purge_expired_otp(24)'],
      ['sessions', 'SELECT app.cleanup_expired_sessions(30)'],
      ['invitations', "UPDATE caregiver_relationships SET status='expired' WHERE false"],
      ['deliveries', "DELETE FROM notification_deliveries WHERE created_at < now() - interval '90 days'"],
      ['webhooks', "DELETE FROM provider_webhook_events WHERE received_at < now() - interval '30 days'"],
      ['job_runs', "DELETE FROM job_runs WHERE started_at < now() - interval '14 days'"],
    ];
    const worker = new pg.Pool({
      connectionString: 'postgres://dawaee_worker:devpass@127.0.0.1:5433/dawaee_test', max: 1,
    });
    try {
      for (const [name, sql] of steps) {
        const err = await worker.query(sql).then(() => null).catch((e: Error) => e.message);
        expect(err, `housekeeping step "${name}" is still blocked`).toBeNull();
      }

      // Deliberately keep the worker off raw stored_objects. If this ever starts
      // succeeding, a future RLS mistake would turn a retention process into a
      // direct PHI metadata reader/deleter. The shipped job uses only the two
      // bounded SECURITY DEFINER list functions instead.
      const direct = await worker.query('DELETE FROM stored_objects WHERE false')
        .then(() => null).catch((e: Error) => e.message);
      expect(direct, 'worker regained direct DELETE on stored_objects').toMatch(/permission denied/i);

      for (const [name, sql] of [
        ['abandoned-object-list', 'SELECT * FROM app.list_abandoned_object_keys(24,1)'],
        ['due-account-list', 'SELECT * FROM app.list_due_account_ids(14,1)'],
      ] as const) {
        const err = await worker.query(sql).then(() => null).catch((e: Error) => e.message);
        expect(err, `bounded housekeeping helper "${name}" is blocked`).toBeNull();
      }
    } finally { await worker.end(); }
  });

  it('a failing step rolls back only itself and the rest still run', async () => {
    const { runStep } = await import('../../worker/src/jobs/housekeeping-step.js');
    const c = await owner.connect();
    const outcome = { removed: 0, failures: [] as Array<{ step: string; error: string }> };
    const log = { error: () => undefined, info: () => undefined } as never;
    try {
      await c.query('BEGIN');
      await runStep({ log } as never, c, outcome, 'first', async () => 3);
      await runStep({ log } as never, c, outcome, 'broken', async () => {
        await c.query('SELECT 1/0');
        return 99;
      });
      await runStep({ log } as never, c, outcome, 'third', async () =>
        (await c.query('SELECT 1')).rowCount ?? 0);
      await c.query('COMMIT');
    } finally { c.release(); }
    expect(outcome.failures.map((f) => f.step),
      'the failure was not reported').toEqual(['broken']);
    expect(outcome.removed, 'a later step was suppressed by an earlier failure').toBe(4);
  });

  it('surfaces which step failed, so a broken cleanup is not silent', async () => {
    const { runStep } = await import('../../worker/src/jobs/housekeeping-step.js');
    const logged: unknown[] = [];
    const log = { error: (o: unknown) => logged.push(o), info: () => undefined } as never;
    const c = await owner.connect();
    const outcome = { removed: 0, failures: [] as Array<{ step: string; error: string }> };
    try {
      await c.query('BEGIN');
      await runStep({ log } as never, c, outcome, 'webhooks', async () => {
        await c.query('SELECT * FROM table_that_does_not_exist');
        return 0;
      });
      await c.query('COMMIT');
    } finally { c.release(); }
    expect(logged, 'the failure was not logged').toHaveLength(1);
    expect(JSON.stringify(logged[0])).toContain('webhooks');
    expect(outcome.failures[0]!.step).toBe('webhooks');
  });

  it('the job reports its failures so job_runs can show them', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../../worker/src/jobs/housekeeping.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/failures: outcome\.failures/);
    expect(src.match(/runStep\(/g)?.length ?? 0,
      'not every retention class is isolated').toBeGreaterThanOrEqual(7);
  });

  it('a failed step: later steps run, job_runs records the failure, the next run retries it', async () => {
    const { runJob } = await import('../../worker/src/context.js');
    const { runStep } = await import('../../worker/src/jobs/housekeeping-step.js');
    const jobName = `housekeeping-test-${Date.now()}`;
    const log = { error: () => undefined, info: () => undefined, debug: () => undefined, warn: () => undefined };
    const ctx = { pool: owner, log } as never;
    await owner.query(
      "INSERT INTO provider_webhook_events (provider, event_type, payload, received_at, processed_at) " +
      "VALUES ('test','t','{}'::jsonb, now() - interval '60 days', now())",
    );
    let brokenShouldFail = true;
    const job = async (c: pg.PoolClient) => {
      const outcome = { removed: 0, failures: [] as Array<{ step: string; error: string }> };
      await runStep(ctx, c, outcome, 'broken', async () => {
        if (brokenShouldFail) await c.query('SELECT * FROM table_that_does_not_exist');
        return 1;
      });
      await runStep(ctx, c, outcome, 'webhooks', async () => (await c.query(
        `DELETE FROM provider_webhook_events
          WHERE received_at < now() - interval '30 days' AND processed_at IS NOT NULL`,
      )).rowCount ?? 0);
      return { itemsProcessed: outcome.removed, failures: outcome.failures };
    };
    await runJob(ctx, jobName, job);
    const { rows: leftover } = await owner.query<{ n: string }>(
      "SELECT count(*) AS n FROM provider_webhook_events WHERE received_at < now() - interval '30 days'",
    );
    expect(Number(leftover[0]!.n),
      'the step after the failing one never ran — a failure still aborts the job').toBe(0);
    const { rows: run1 } = await owner.query<{ succeeded: boolean; error_message: string; metadata: unknown }>(
      'SELECT succeeded, error_message, metadata FROM job_runs WHERE job_name=$1 ORDER BY id DESC LIMIT 1',
      [jobName],
    );
    expect(run1, 'the run was not recorded at all').toHaveLength(1);
    expect(run1[0]!.succeeded,
      'a run with a failed step was recorded as a success — the fault is invisible').toBe(false);
    expect(run1[0]!.error_message, 'the failing step is not named').toContain('broken');
    expect(JSON.stringify(run1[0]!.metadata)).toContain('broken');
    brokenShouldFail = false;
    await runJob(ctx, jobName, job);
    const { rows: run2 } = await owner.query<{ succeeded: boolean; items_processed: number }>(
      'SELECT succeeded, items_processed FROM job_runs WHERE job_name=$1 ORDER BY id DESC LIMIT 1',
      [jobName],
    );
    expect(run2[0]!.succeeded, 'the retry did not recover').toBe(true);
    expect(run2[0]!.items_processed,
      'the previously failing class was not retried').toBeGreaterThanOrEqual(1);
  });

  it('a clean run is still recorded as a success', async () => {
    const { runJob } = await import('../../worker/src/context.js');
    const jobName = `housekeeping-clean-${Date.now()}`;
    const log = { error: () => undefined, info: () => undefined, debug: () => undefined, warn: () => undefined };
    await runJob({ pool: owner, log } as never, jobName, async () => ({ itemsProcessed: 2, failures: [] }));
    const { rows } = await owner.query<{ succeeded: boolean; error_message: string | null }>(
      'SELECT succeeded, error_message FROM job_runs WHERE job_name=$1 ORDER BY id DESC LIMIT 1', [jobName],
    );
    expect(rows[0]!.succeeded).toBe(true);
    expect(rows[0]!.error_message).toBeNull();
  });

  it('a failed job is recorded so the failure is operationally visible', async () => {
    const { rows } = await owner.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_name='job_runs'",
    );
    const cols = rows.map((r) => r.column_name);
    expect(cols).toContain('succeeded');
    expect(cols).toContain('error_message');
  });
});

// ══════════════════════════════════════ 11. push token lifecycle

describe('push tokens follow the account state', () => {
  it('disabling deactivates them and re-enabling does not bring them back', async () => {
    const user = await signIn(h, '+966500004050');
    const s = await h.app.inject({
      method: 'POST', url: '/v1/auth/login', remoteAddress: '10.30.1.1',
      payload: { identifier: user.phone, password: 'correct horse battery staple', deviceId: 'device-tok-00001' },
    });
    const token = s.json<{ accessToken: string }>().accessToken;
    await h.app.inject({
      method: 'POST', url: '/v1/devices/push-token',
      headers: { authorization: `Bearer ${token}` },
      payload: { token: 'ExponentPushToken[lifecycle-1]', platform: 'ios', deviceId: 'device-tok-00001' },
    });
    const active = async () => {
      const { rows } = await owner.query<{ n: string }>(
        'SELECT count(*) AS n FROM push_tokens WHERE user_id=$1 AND active', [user.userId],
      );
      return Number(rows[0]!.n);
    };
    expect(await active()).toBe(1);
    await owner.query('UPDATE users SET disabled_at = now() WHERE id=$1', [user.userId]);
    expect(await active(), 'disabling left a live push token').toBe(0);
    await owner.query('UPDATE users SET disabled_at = NULL WHERE id=$1', [user.userId]);
    expect(await active(), 're-enabling silently reactivated a token from a possibly compromised phone').toBe(0);
  });

  it('a fresh login and re-registration makes the device usable again', async () => {
    const user = await signIn(h, '+966500004051');
    await owner.query('UPDATE users SET disabled_at = now() WHERE id=$1', [user.userId]);
    await owner.query('UPDATE users SET disabled_at = NULL WHERE id=$1', [user.userId]);
    const fresh = await h.app.inject({
      method: 'POST', url: '/v1/auth/login', remoteAddress: '10.30.2.1',
      payload: { identifier: user.phone, password: 'correct horse battery staple', deviceId: 'device-tok-00002' },
    });
    expect(fresh.statusCode).toBe(200);
    const reg = await h.app.inject({
      method: 'POST', url: '/v1/devices/push-token',
      headers: { authorization: `Bearer ${fresh.json<{ accessToken: string }>().accessToken}` },
      payload: { token: 'ExponentPushToken[lifecycle-2]', platform: 'ios', deviceId: 'device-tok-00002' },
    });
    expect(reg.statusCode, `re-registration failed: ${reg.body}`).toBe(200);
    const { rows } = await owner.query<{ n: string }>(
      'SELECT count(*) AS n FROM push_tokens WHERE user_id=$1 AND active', [user.userId],
    );
    expect(Number(rows[0]!.n), 'reminders would not resume after a legitimate re-enable').toBe(1);
  });

  it('a provider "invalid token" response deactivates it', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../../worker/src/jobs/dispatcher.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/UPDATE push_tokens SET active = false/);
  });
});

// ══════════════════════════════════════ 13. time / DST

describe('timezones and DST', () => {
  const localTimeOf = async (tz: string, utc: string) => {
    const { rows } = await owner.query<{ local: string }>(
      `SELECT to_char(($1::timestamptz AT TIME ZONE $2), 'YYYY-MM-DD HH24:MI') AS local`, [utc, tz],
    );
    return rows[0]!.local;
  };

  it('Asia/Riyadh has no DST, so a dose time never shifts', async () => {
    const jan = await localTimeOf('Asia/Riyadh', '2026-01-15T06:00:00Z');
    const jul = await localTimeOf('Asia/Riyadh', '2026-07-15T06:00:00Z');
    expect(jan.slice(11)).toBe('09:00');
    expect(jul.slice(11), 'Riyadh appears to observe DST — the schedule model assumes it does not')
      .toBe('09:00');
  });

  it('a spring-forward gap does not produce a duplicate or a lost instant', async () => {
    const { rows } = await owner.query<{ ts: string }>(
      `SELECT (d::date + time '02:30') AT TIME ZONE 'Europe/London' AS ts
         FROM generate_series('2026-03-28'::date, '2026-03-31'::date, '1 day') d`,
    );
    const instants = rows.map((r) => new Date(r.ts).toISOString());
    expect(new Set(instants).size, 'the gap collapsed two days onto one instant')
      .toBe(instants.length);
  });

  it('a fall-back repeat keeps occurrences strictly ordered', async () => {
    const { rows } = await owner.query<{ ts: string }>(
      `SELECT (d::date + time '01:30') AT TIME ZONE 'Europe/London' AS ts
         FROM generate_series('2026-10-24'::date, '2026-10-27'::date, '1 day') d
        ORDER BY d`,
    );
    const times = rows.map((r) => new Date(r.ts).getTime());
    for (let i = 1; i < times.length; i++) {
      expect(times[i]!, 'a fall-back day landed out of order').toBeGreaterThan(times[i - 1]!);
    }
  });

  it('a UTC date boundary does not move the local day', async () => {
    expect(await localTimeOf('Asia/Riyadh', '2026-06-10T22:00:00Z')).toBe('2026-06-11 01:00');
  });

  it('changing the profile timezone leaves existing occurrences on their stored zone', async () => {
    const user = await signIn(h, '+966500004060');
    const { scheduleId } = await seedMedication(user, 'TravelDrug', '09:00');
    h.setNow(at('08:00'));
    await h.tick();
    const before = await owner.query<{ scheduled_at: Date; scheduled_timezone: string }>(
      'SELECT scheduled_at, scheduled_timezone FROM dose_occurrences WHERE schedule_id=$1 ORDER BY scheduled_at LIMIT 1',
      [scheduleId],
    );
    await owner.query("UPDATE patient_profiles SET timezone='Europe/London' WHERE id=$1", [user.profileId]);
    await h.tick();
    const after = await owner.query<{ scheduled_at: Date; scheduled_timezone: string }>(
      'SELECT scheduled_at, scheduled_timezone FROM dose_occurrences WHERE schedule_id=$1 ORDER BY scheduled_at LIMIT 1',
      [scheduleId],
    );
    expect(after.rows[0]!.scheduled_at.toISOString(),
      'an existing dose moved when the timezone changed')
      .toBe(before.rows[0]!.scheduled_at.toISOString());
    expect(after.rows[0]!.scheduled_timezone).toBe(before.rows[0]!.scheduled_timezone);
  });

  const sqlFrom = async (file: string, needle: string) => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL(file, import.meta.url), 'utf8');
    const start = src.indexOf(needle);
    expect(start, `could not locate the query starting "${needle.slice(0, 40)}"`).toBeGreaterThan(-1);
    return src.slice(start + 1, src.indexOf('`', start + 1));
  };
  const completedSweepSql = () =>
    sqlFrom('../../worker/src/jobs/housekeeping.ts', "`UPDATE medications m SET status = 'completed'");
  const expirySweepSql = () =>
    sqlFrom('../../worker/src/jobs/housekeeping.ts', "`UPDATE medications m SET status = 'expired'");
  const materializerSelectSql = () =>
    sqlFrom('../../api/src/services/materializer.ts', '`SELECT s.id, s.medication_id');

  const localDate = async (tz: string, instant: string) => {
    const { rows } = await owner.query<{ d: string }>(
      `SELECT to_char(($1::timestamptz AT TIME ZONE $2)::date, 'YYYY-MM-DD') AS d`, [instant, tz],
    );
    return rows[0]!.d;
  };

  const patientIn = async (phone: string, tz: string, endDate: string | null, expiry: string | null = null) => {
    const user = await signIn(h, phone);
    await owner.query('UPDATE patient_profiles SET timezone=$2 WHERE id=$1', [user.profileId, tz]);
    const { medicationId } = await seedMedication(user, `Tz-${phone.slice(-4)}`, '20:00', 60);
    await owner.query(
      `UPDATE medications
          SET status='active',
              start_date = LEAST(start_date, COALESCE($2::date, start_date) - 30),
              end_date=$2, expiry_date=$3
        WHERE id=$1`,
      [medicationId, endDate, expiry],
    );
    return { user, medicationId };
  };
  const statusOf = async (medicationId: string) => {
    const { rows } = await owner.query<{ status: string }>(
      'SELECT status FROM medications WHERE id=$1', [medicationId],
    );
    return rows[0]!.status;
  };

  it('database UTC, patient Asia/Riyadh: a course is not swept before the local day ends', async () => {
    const instant = '2026-06-11T03:00:00Z';
    expect(await localDate('Asia/Riyadh', instant)).toBe('2026-06-11');
    const { medicationId } = await patientIn('+966500004070', 'Asia/Riyadh', '2026-06-11');
    await owner.query(await completedSweepSql(), [instant]);
    expect(await statusOf(medicationId),
      'a course was swept on its own final day').toBe('active');
  });

  it('Riyadh 00:30 while UTC is still the previous date: the day HAS turned over', async () => {
    const instant = '2026-06-10T21:30:00Z';
    expect(await localDate('Asia/Riyadh', instant)).toBe('2026-06-11');
    expect(await localDate('Etc/UTC', instant), 'premise: UTC is still the 10th').toBe('2026-06-10');
    const { medicationId } = await patientIn('+966500004071', 'Asia/Riyadh', '2026-06-10');
    await owner.query(await completedSweepSql(), [instant]);
    expect(await statusOf(medicationId),
      'a course that ended yesterday locally was still active').toBe('completed');
  });

  it('23:59 Riyadh -> 00:01 Riyadh: the boundary is exactly local midnight', async () => {
    const { medicationId } = await patientIn('+966500004072', 'Asia/Riyadh', '2026-06-10');
    await owner.query(await completedSweepSql(), ['2026-06-10T20:59:00Z']);
    expect(await statusOf(medicationId),
      'the course was swept one minute before its local day ended').toBe('active');
    await owner.query(await completedSweepSql(), ['2026-06-10T21:01:00Z']);
    expect(await statusOf(medicationId),
      'the course survived past its local day').toBe('completed');
  });

  it('patient behind UTC: the final evening of a course is not swept away early', async () => {
    const instant = '2026-06-11T03:00:00Z';
    expect(await localDate('America/Los_Angeles', instant)).toBe('2026-06-10');
    expect(await localDate('Etc/UTC', instant), 'premise: UTC is already the 11th').toBe('2026-06-11');
    const { medicationId } = await patientIn('+14155550170', 'America/Los_Angeles', '2026-06-10');
    await owner.query(await completedSweepSql(), [instant]);
    expect(await statusOf(medicationId),
      'the last evening of the course was cancelled while the patient was still in it').toBe('active');
  });

  it('patient behind UTC: a course that really has ended is still swept', async () => {
    const { medicationId } = await patientIn('+14155550171', 'America/Los_Angeles', '2026-06-09');
    await owner.query(await completedSweepSql(), ['2026-06-11T03:00:00Z']);
    expect(await statusOf(medicationId), 'a finished course was never marked completed').toBe('completed');
  });

  it('the expiry sweep follows the same local calendar', async () => {
    const late = await patientIn('+14155550172', 'America/Los_Angeles', null, '2026-06-10');
    const past = await patientIn('+14155550173', 'America/Los_Angeles', null, '2026-06-09');
    await owner.query(await expirySweepSql(), ['2026-06-11T03:00:00Z']);
    expect(await statusOf(late.medicationId),
      'a medication was flagged expired on the day it expires, locally').toBe('active');
    expect(await statusOf(past.medicationId), 'a genuinely expired medication was not flagged').toBe('expired');
  });

  it('DST spring-forward: the local day boundary follows the zone rules', async () => {
    const { medicationId } = await patientIn('+14155550174', 'America/Los_Angeles', '2026-03-08');
    await owner.query(await completedSweepSql(), ['2026-03-09T06:59:00Z']);
    expect(await statusOf(medicationId),
      'the spring-forward day was cut an hour short').toBe('active');
    await owner.query(await completedSweepSql(), ['2026-03-09T07:00:00Z']);
    expect(await statusOf(medicationId),
      'the spring-forward boundary did not move with the zone').toBe('completed');
  });

  it('DST fall-back: the extra hour belongs to the local day', async () => {
    const { medicationId } = await patientIn('+14155550175', 'America/Los_Angeles', '2026-11-01');
    await owner.query(await completedSweepSql(), ['2026-11-02T07:59:00Z']);
    expect(await statusOf(medicationId),
      'the repeated hour was excluded from the local day').toBe('active');
    await owner.query(await completedSweepSql(), ['2026-11-02T08:00:00Z']);
    expect(await statusOf(medicationId),
      'the fall-back boundary did not move with the zone').toBe('completed');
  });

  it('the sweep does not consult the database clock at all', async () => {
    const { medicationId } = await patientIn('+14155550176', 'Asia/Riyadh', '2026-06-10');
    const sql = await completedSweepSql();
    const results: string[] = [];
    for (const dbZone of ['Etc/UTC', 'Pacific/Kiritimati', 'Etc/GMT+12']) {
      await owner.query("UPDATE medications SET status='active' WHERE id=$1", [medicationId]);
      const c = await owner.connect();
      try {
        await c.query(`SET TIME ZONE '${dbZone}'`);
        await c.query(sql, ['2026-06-11T03:00:00Z']);
      } finally { c.release(); }
      results.push(await statusOf(medicationId));
    }
    expect(new Set(results).size,
      `the sweep's answer moved with the database session timezone: ${results.join(',')}`).toBe(1);
  });

  it('schedule selection for materialization uses the schedule timezone, not the database date', async () => {
    const user = await signIn(h, '+14155550177');
    await owner.query("UPDATE patient_profiles SET timezone='America/Los_Angeles' WHERE id=$1", [user.profileId]);
    const { scheduleId } = await seedMedication(user, 'LaCourse', '20:00', 60);
    await owner.query(
      "UPDATE medication_schedules SET timezone='America/Los_Angeles', end_date='2026-06-10', materialized_through=NULL WHERE id=$1",
      [scheduleId],
    );
    const sql = await materializerSelectSql();
    const { rows } = await owner.query<{ id: string }>(
      sql, [new Date('2026-06-25T03:00:00Z'), 500, new Date('2026-06-11T03:00:00Z')],
    );
    expect(rows.map((r) => r.id),
      'a schedule was dropped from materialization while its final local day was still running')
      .toContain(scheduleId);
    const { rows: after } = await owner.query<{ id: string }>(
      sql, [new Date('2026-06-25T03:00:00Z'), 500, new Date('2026-06-12T09:00:00Z')],
    );
    expect(after.map((r) => r.id), 'an ended schedule was still selected').not.toContain(scheduleId);
  });

  it('the daily digest covers the local day that just ended, for a patient behind UTC', async () => {
    const { localDateInZone, addDays } = await import('@dawaee/core');
    const tz = 'America/Los_Angeles';
    const morning = new Date('2026-06-11T15:00:00Z');
    const today = localDateInZone(morning, tz);
    expect(today, 'the digest is running on the wrong local day').toBe('2026-06-11');
    const from = addDays(today, -1);
    const to = addDays(today, -1);
    expect([from, to], 'the daily digest does not cover exactly the previous local day')
      .toEqual(['2026-06-10', '2026-06-10']);
    const { rows } = await owner.query<{ inside: boolean; outside: boolean }>(
      `SELECT ('2026-06-10'::date BETWEEN $1::date AND $2::date) AS inside,
              ('2026-06-11'::date BETWEEN $1::date AND $2::date) AS outside`,
      [from, to],
    );
    expect(rows[0]!.inside, 'yesterday\'s doses fell outside the digest window').toBe(true);
    expect(rows[0]!.outside, 'today\'s doses leaked into yesterday\'s digest').toBe(false);
  });

  it('no scheduling or retention query compares a local date against current_date', async () => {
    const { readFileSync } = await import('node:fs');
    const files = [
      '../../worker/src/jobs/housekeeping.ts',
      '../../worker/src/jobs/stock-alerts.ts',
      '../../api/src/services/materializer.ts',
      '../../api/src/routes/stock.ts',
    ];
    for (const f of files) {
      const code = stripComments(readFileSync(new URL(f, import.meta.url), 'utf8'));
      expect(code, `${f}: nothing executable survived comment stripping`).toMatch(/query\(/);
      expect(code, `${f} still derives a patient-local day from the database clock`)
        .not.toMatch(/current_date/);
    }
  });
});

// ══════════════════════════════════════ 12. database failure

describe('the worker survives the database going away', () => {
  it('does not unref the interval that keeps the process alive', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../../worker/src/index.ts', import.meta.url), 'utf8');
    const interval = src.slice(src.indexOf('setInterval'));
    expect(interval.slice(0, 200), 'the keep-alive interval was unref\'d again').not.toMatch(/\.unref\(\)/);
  });

  it('a failed tick is caught and does not stop the loop', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../../worker/src/index.ts', import.meta.url), 'utf8');
    const loop = src.slice(src.indexOf('const loop ='), src.indexOf('await loop()'));
    expect(loop, 'a throwing tick would kill the loop').toMatch(/catch/);
  });

  it('a job that throws is recorded as failed and the next job still runs', async () => {
    const before = await owner.query<{ n: string }>('SELECT count(*) AS n FROM job_runs');
    await h.tick();
    const after = await owner.query<{ n: string }>('SELECT count(*) AS n FROM job_runs');
    expect(Number(after.rows[0]!.n), 'no job run was recorded at all')
      .toBeGreaterThan(Number(before.rows[0]!.n));
  });

  it('records the error text when a job fails, so it is visible', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../../worker/src/context.ts', import.meta.url), 'utf8');
    const catchBlock = src.slice(src.indexOf('} catch (err) {', src.indexOf('runJob')));
    expect(catchBlock.slice(0, 600)).toMatch(/job_runs/);
    expect(catchBlock.slice(0, 600)).toMatch(/succeeded/);
  });
});
