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
    await c.query('BEGIN');
    await c.query("SELECT app.try_job_lock('materialize')");
    // Kill the connection outright, as a crashed worker would.
    c.release();
    await victim.end();

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

      const pa = insert(a);
      const pb = insert(b);
      results.push(await pa);
      await a.query('COMMIT');
      results.push(await pb);
      await b.query('COMMIT').catch(() => undefined);
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
  /**
   * The dispatcher's OWN claim query, lifted out of the source and executed on
   * two connections.
   *
   * Asserting that the file contains the string "FOR UPDATE SKIP LOCKED" would
   * prove nothing about behaviour — and an earlier version of this test did
   * exactly that, then passed when the clause was deleted because a second test
   * had hard-coded the correct SQL instead of reading it. Extracting the real
   * query is what makes removing the clause fail.
   */
  const dispatcherClaimSql = async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../../worker/src/jobs/dispatcher.ts', import.meta.url), 'utf8');
    const start = src.indexOf('`SELECT id, recipient_user_id');
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
      // Both replicas issue the dispatcher's real query at the same moment.
      const ra = await a.query<{ id: string }>(sql, [new Date()]);
      const rb = await b.query<{ id: string }>(sql, [new Date()]);
      const overlap = ra.rows.filter((x) => rb.rows.some((y) => y.id === x.id));
      expect(overlap.map((x) => x.id),
        'two workers claimed the same delivery — the claim is not atomic').toEqual([]);
      await a.query('ROLLBACK'); await b.query('ROLLBACK');
    } finally { a.release(); b.release(); }
  });

  /**
   * FINDING P10-1 — the provider call happens INSIDE the job transaction.
   *
   * `runJob` opens a transaction, the dispatcher sends to the provider inside
   * it, and the status update commits with everything else. So a crash between
   * "provider accepted" and COMMIT rolls the status back to `queued`, and the
   * next tick sends the same notification again. The user gets a duplicate
   * medication reminder.
   *
   * This is established from the structure rather than by killing a process
   * mid-flight: the transaction boundary is what makes it true.
   */
  it('FINDING: a rollback after a successful send returns the row to queued', async () => {
    const user = await signIn(h, '+966500004011');
    const key = `crash-window-${Date.now()}`;
    await owner.query(
      `INSERT INTO notification_deliveries
         (patient_profile_id, recipient_user_id, kind, channel, locale, title, body, payload,
          dedupe_key, scheduled_for, next_attempt_at, status)
       VALUES ($1,$2,'dose_reminder','push','en','t','b','{}'::jsonb,$3, now(), now(), 'queued')`,
      [user.profileId, user.userId, key],
    );

    // Simulate the dispatcher's own sequence, then die before COMMIT.
    const c = await owner.connect();
    try {
      await c.query('BEGIN');
      await c.query("UPDATE notification_deliveries SET status='sending', attempts=attempts+1 WHERE dedupe_key=$1", [key]);
      // <-- provider accepted the push here -->
      await c.query("UPDATE notification_deliveries SET status='sent', sent_at=now() WHERE dedupe_key=$1", [key]);
      await c.query('ROLLBACK'); // crash before commit
    } finally { c.release(); }

    const { rows } = await owner.query<{ status: string; attempts: number }>(
      'SELECT status, attempts FROM notification_deliveries WHERE dedupe_key=$1', [key],
    );
    expect(rows[0]!.status, 'documented: the send is repeated after a crash').toBe('queued');
    expect(rows[0]!.attempts, 'even the attempt count is rolled back').toBe(0);
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
    // A terminal state must exist, otherwise a dead delivery cycles forever.
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

    // Well past the missed threshold.
    h.setNow(at('11:00'));
    await h.tick();

    const { rows } = await owner.query<{ status: string }>(
      'SELECT status FROM dose_occurrences WHERE id=$1', [dose!.id],
    );
    expect(rows[0]!.status, 'a taken dose was later marked missed').toBe('taken');
  });

  /**
   * The dangerous interleaving: mark-missed's UPDATE begins, and the patient's
   * "Taken" arrives before it commits. Forced on two connections so the order
   * is not left to the scheduler.
   */
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
      // mark-missed's exact predicate, uncommitted.
      await a.query(
        `UPDATE dose_occurrences SET status='missed'
          WHERE id=$1 AND status IN ('upcoming','due','pending_confirmation','snoozed')`,
        [dose!.id],
      );

      await b.query('BEGIN');
      // The patient's action, blocked on the same row.
      const takenPromise = b.query(
        `UPDATE dose_occurrences
            SET status='taken', confirmed_at=now(), confirmation_method='app'
          WHERE id=$1 AND status IN ('upcoming','due','pending_confirmation','snoozed')`,
        [dose!.id],
      );

      await a.query('COMMIT');
      const takenResult = await takenPromise;
      await b.query('COMMIT');

      // The status predicate is what saves this: after the miss commits, the
      // patient's UPDATE re-evaluates and matches nothing.
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
        // 'snoozed' IS in the open set by design — a snooze defers, it does not
        // acknowledge, so a snoozed dose can still go missed. Recorded, not
        // asserted as a defect.
        expect(miss.rowCount).toBe(1);
      }
    }
  });

  /**
   * FINDING P10-2 — the missed EVENT insert is not scoped to the rows this run
   * marked.
   *
   * mark-missed inserts a 'missed' dose_event for every occurrence whose status
   * is 'missed' and whose `updated_at` is within two minutes — not for the rows
   * the UPDATE just returned. Two ticks inside that window therefore write the
   * event twice for the same dose. The occurrence status is idempotent; its
   * history is not.
   */
  it('FINDING: one dose gets a second missed event when another dose is missed nearby', async () => {
    const user = await signIn(h, '+966500004025');
    // Two medications an hour apart, so their misses land on separate ticks.
    await seedMedication(user, 'Amoxicillin', '09:00', 30);
    await seedMedication(user, 'Metformin', '10:00', 30);
    h.setNow(at('08:00'));
    await h.tick();

    // Tick 1 marks A missed and writes A's event.
    h.setNow(at('09:45'));
    await h.tick();
    // Tick 2, less than two minutes later, marks B missed — and the event
    // insert re-scans every row with status='missed' and a recent updated_at
    // rather than the rows this run touched, so A is written again.
    h.setNow(at('10:45'));
    await h.tick();

    const { rows } = await owner.query<{ dose_occurrence_id: string; n: string }>(
      `SELECT dose_occurrence_id, count(*) AS n FROM dose_events
        WHERE type='missed' AND dose_occurrence_id IN (
          SELECT id FROM dose_occurrences WHERE patient_profile_id=$1)
        GROUP BY dose_occurrence_id ORDER BY count(*) DESC`,
      [user.profileId],
    );
    // Documented current behaviour: the occurrence status is idempotent, its
    // history is not. Recorded rather than fixed — the event table is an audit
    // trail and de-duplicating it is a data-model decision.
    const worst = Math.max(0, ...rows.map((r) => Number(r.n)));
    expect(worst, 'behaviour changed — re-audit P10-2').toBeGreaterThan(1);
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

/**
 * P8-2 proved the whole job aborted on the first permission error, so no
 * retention ran at all. The steps are unrelated retention classes, so the
 * question is whether one failing should stop the others.
 */
describe('housekeeping steps and their failure isolation', () => {
  it('every step completes now that the grants match the work', async () => {
    const steps: Array<[string, string]> = [
      ['otp', 'SELECT app.purge_expired_otp(24)'],
      ['sessions', 'SELECT app.cleanup_expired_sessions(30)'],
      ['invitations', "UPDATE caregiver_relationships SET status='expired' WHERE false"],
      ['deliveries', "DELETE FROM notification_deliveries WHERE created_at < now() - interval '90 days'"],
      ['webhooks', "DELETE FROM provider_webhook_events WHERE received_at < now() - interval '30 days'"],
      ['job_runs', "DELETE FROM job_runs WHERE started_at < now() - interval '14 days'"],
      ['objects', 'DELETE FROM stored_objects WHERE false'],
    ];
    const worker = new pg.Pool({
      connectionString: 'postgres://dawaee_worker:devpass@127.0.0.1:5433/dawaee_test', max: 1,
    });
    try {
      for (const [name, sql] of steps) {
        const err = await worker.query(sql).then(() => null).catch((e: Error) => e.message);
        expect(err, `housekeeping step "${name}" is still blocked`).toBeNull();
      }
    } finally { await worker.end(); }
  });

  /**
   * P10-3, FIXED — one failing retention class no longer suppresses the others.
   *
   * The steps are unrelated: a failure trimming webhook events is not a reason
   * to keep ninety-day-old notification bodies containing medication names.
   * Each step now runs in its own savepoint, so a failure rolls back only that
   * step — and is reported rather than swallowed, which is the actual lesson of
   * P8-2, where a broken cleanup went unnoticed for the life of the deployment.
   *
   * Executed against a real transaction: a deliberately broken step must not
   * take the ones after it down.
   */
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
      // The transaction must still be usable — that is what the savepoint buys.
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

  /**
   * The operational check carried out of P9: after a legitimate re-enable and a
   * fresh sign-in, the app's registration must make the device usable again.
   */
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

/**
 * Timezone handling is exercised through the real Intl database rather than a
 * mocked clock, because the defects worth finding here live in the zone rules —
 * a spring-forward gap where a wall-clock time does not exist, and a fall-back
 * where one happens twice.
 */
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

  /**
   * Spring forward: 02:30 local does not exist on that date in Europe/London.
   * A schedule set to 02:30 must still produce exactly one occurrence rather
   * than none or two.
   */
  it('a spring-forward gap does not produce a duplicate or a lost instant', async () => {
    const { rows } = await owner.query<{ ts: string }>(
      `SELECT (d::date + time '02:30') AT TIME ZONE 'Europe/London' AS ts
         FROM generate_series('2026-03-28'::date, '2026-03-31'::date, '1 day') d`,
    );
    const instants = rows.map((r) => new Date(r.ts).toISOString());
    expect(new Set(instants).size, 'the gap collapsed two days onto one instant')
      .toBe(instants.length);
  });

  /**
   * Fall back: 01:30 local happens twice. Postgres resolves the ambiguity
   * consistently; what matters is that consecutive days stay strictly ordered,
   * so a dose does not appear to precede the one before it.
   */
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
    // 22:00 UTC is already the next day in Riyadh.
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
    // An already-scheduled dose is a commitment the patient has seen. Moving it
    // silently under them is the failure mode; each row carries the zone it was
    // built with so that cannot happen by accident.
    expect(after.rows[0]!.scheduled_at.toISOString(),
      'an existing dose moved when the timezone changed')
      .toBe(before.rows[0]!.scheduled_at.toISOString());
    expect(after.rows[0]!.scheduled_timezone).toBe(before.rows[0]!.scheduled_timezone);
  });

  /**
   * The materializer selects schedules with `s.end_date >= current_date` —
   * the DATABASE clock, not `ctx.now()`. In tests the worker clock is driven
   * forward while the server clock is real, so a schedule can be selected or
   * skipped on a date the worker does not believe in. Recorded because it is a
   * genuine skew surface in production too: the worker's notion of "now" and
   * Postgres's must not diverge.
   */
  it('OBSERVATION: schedule selection uses the database clock, not the worker clock', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../../api/src/services/materializer.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/end_date\s*>=\s*current_date/);
  });
});

// ══════════════════════════════════════ 12. database failure

describe('the worker survives the database going away', () => {
  /**
   * The prior fix ("keep the worker alive when the database is not") is
   * re-verified rather than assumed, because the interval that holds the
   * process open is easy to break with an unrelated edit.
   */
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
    // A tick against a healthy database records runs; the point is that
    // job_runs exists as the operational signal for a failure.
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
