import { execFileSync } from 'node:child_process';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sanitizeOperationalError, OPERATIONAL_ERROR_MAX } from '@dawaee/shared';
import { createWorkerContext, runJob, type WorkerContext } from '../../worker/src/context.js';
import { resetDatabase } from './harness.js';

/**
 * P13 — what a failing job writes to the database.
 *
 * `job_runs` is not a log file. It is a table inside the same database that
 * holds the medical records, it is read by operators debugging a bad night of
 * reminders, and — unlike stdout — nothing purges it on a schedule. So the
 * question is what a raw `Error.message` can contain by the time it gets
 * there, and the only honest way to answer it is to raise real failures
 * through the real path and read the rows back.
 *
 * Two sinks, both of which were storing the message verbatim:
 *
 *   job_runs.error_message               — the top-level catch, capped at 500
 *   job_runs.metadata.failedSteps[].error — per-step failures, uncapped
 *
 * The comment above the second one said "Step names and error text only. No
 * row contents". The step names were true. "Error text" was doing more work
 * than it looked: measured below, an error raised by this schema's own
 * triggers reads `medication <uuid> not found`, and a provider is free to put
 * whatever it likes in the message this code re-throws.
 */

let ctx: WorkerContext;
let pool: pg.Pool;
/**
 * A superuser pool, used only to PRODUCE the two database errors below.
 * The worker role deliberately cannot insert into `users` or
 * `medication_schedules` — that is P8's least-privilege result and it is
 * correct — so raising a genuine unique violation or trigger exception needs a
 * connection that can write. The errors are then handed to the real worker
 * path, which is what is under test.
 */
let owner: pg.Pool;

const psql = (sql: string) => execFileSync('psql', ['-d', 'dawaee_test', '-tAc', sql], {
  env: { ...process.env, PGHOST: '127.0.0.1', PGPORT: '5433', PGUSER: 'postgres' },
}).toString().trim();

/** The last row `job_runs` received, as the operator would read it. */
function lastJobRun(): { error_message: string | null; metadata: string } {
  const row = psql(
    `SELECT coalesce(error_message,'<null>') || E'\\x01' || coalesce(metadata::text,'<null>')
       FROM job_runs ORDER BY id DESC LIMIT 1`,
  );
  const [error_message, metadata] = row.split('\x01');
  return { error_message: error_message ?? null, metadata: metadata ?? '' };
}

beforeAll(async () => {
  resetDatabase();
  ctx = createWorkerContext();
  pool = ctx.pool;
  owner = new pg.Pool({
    connectionString: 'postgres://postgres:postgres@127.0.0.1:5433/dawaee_test', max: 2,
  });
}, 180_000);

afterAll(async () => {
  await pool.end().catch(() => undefined);
  await owner.end().catch(() => undefined);
});

beforeEach(() => {
  psql('DELETE FROM job_runs');
});

/**
 * Errors a worker job can realistically raise, each carrying something that
 * must not reach a table. The values are distinctive so a match cannot be
 * coincidence, and no real credential is used anywhere.
 */
const HAZARDS: Array<{ what: string; needle: string; make: () => Promise<Error> | Error }> = [
  {
    what: 'a patient phone quoted by a unique violation',
    needle: '+966500888111',
    make: async () => {
      const c = await owner.connect();
      try {
        await c.query('BEGIN');
        await c.query("INSERT INTO users (phone_e164, display_name) VALUES ('+966500888111','Probe')");
        await c.query("INSERT INTO users (phone_e164, display_name) VALUES ('+966500888111','Probe2')");
        throw new Error('unreachable');
      } catch (e) { return e as Error; } finally {
        await c.query('ROLLBACK').catch(() => undefined); c.release();
      }
    },
  },
  {
    what: 'a medication id quoted by this schema’s own trigger',
    needle: '11111111-2222-4333-8444-555555555555',
    make: async () => {
      // `app.assert_profile_matches_medication` (migration 0003) raises
      // `medication % not found` with the id interpolated.
      const c = await owner.connect();
      try {
        await c.query('BEGIN');
        await c.query(
          `INSERT INTO medication_schedules
             (medication_id, patient_profile_id, rule, rule_kind, dose_quantity, dose_unit, timezone, start_date)
           VALUES ('11111111-2222-4333-8444-555555555555','11111111-2222-4333-8444-555555555555',
                   '{"kind":"fixed_times","times":["08:00"]}','fixed_times',1,'tablet','Asia/Riyadh','2026-09-01')`,
        );
        throw new Error('unreachable');
      } catch (e) { return e as Error; } finally {
        await c.query('ROLLBACK').catch(() => undefined); c.release();
      }
    },
  },
  {
    what: 'a provider URL carrying an API key in its query string',
    needle: 'PROBE-VISION-KEY-abcdefghijklmnop',
    // Not hypothetical: the Google Vision client builds
    // `…/images:annotate?key=${GOOGLE_VISION_API_KEY}`. Node's own fetch does
    // not echo that URL (measured — its cause names the host only), but this
    // code re-throws `first.error.message` straight from the provider's body,
    // and nothing stops a provider putting the request URL in it.
    make: () => new Error(
      'Request failed: POST https://vision.googleapis.com/v1/images:annotate?key=PROBE-VISION-KEY-abcdefghijklmnop returned 403',
    ),
  },
  {
    what: 'a bearer token echoed by a provider',
    needle: 'PROBE-BEARER-zzzzzzzzzzzzzzzzzzzz',
    make: () => new Error('upstream rejected Authorization: Bearer PROBE-BEARER-zzzzzzzzzzzzzzzzzzzz'),
  },
  {
    what: 'a medication name in a provider payload echo',
    needle: 'Zoprexa-Probe-Med',
    make: () => new Error('Expo push rejected message {"title":"Zoprexa-Probe-Med","to":"ExponentPushToken[x]"}'),
  },
  {
    what: 'the database host and credentials',
    needle: 'PROBE-DB-PASSWORD',
    make: () => new Error('connect ECONNREFUSED postgres://dawaee_app:PROBE-DB-PASSWORD@db.internal:5432/dawaee'),
  },
  {
    what: 'a filesystem path',
    needle: '/srv/dawaee/secrets',
    make: () => new Error("ENOENT: no such file or directory, open '/srv/dawaee/secrets/service-account.json'"),
  },
  {
    what: 'an emergency capability token',
    needle: 'PROBE-EMERGENCY-TOKEN-0123456789abcdef',
    make: () => new Error('failed to revoke card PROBE-EMERGENCY-TOKEN-0123456789abcdef'),
  },
];

describe('P13-5 setup: the hazards are real, not straw men', () => {
  it('each one really does appear in the raw error message', async () => {
    const missing: string[] = [];
    for (const h of HAZARDS) {
      const err = await h.make();
      // The whole error, not just `.message`: a unique violation puts the
      // patient's phone in `detail`, which is precisely why `detail` is the
      // field the log serializer drops.
      const whole = JSON.stringify(err, Object.getOwnPropertyNames(err));
      if (!whole.includes(h.needle)) missing.push(`${h.what}: ${err.message.slice(0, 120)}`);
    }
    expect(missing, 'these hazards do not actually contain what they claim').toEqual([]);
  }, 60_000);

  it('and the two database-raised ones are produced by the real schema', async () => {
    const unique = await HAZARDS[0]!.make();
    expect((unique as { code?: string }).code).toBe('23505');
    expect((unique as { detail?: string }).detail).toContain('+966500888111');

    const trigger = await HAZARDS[1]!.make();
    expect((trigger as { code?: string }).code).toBe('P0001');
    expect(trigger.message).toMatch(/medication .* not found/);
  }, 60_000);
});

describe('P13-6 job_runs.error_message carries none of them', () => {
  it('a failing job stores a sanitized message, whatever it threw', async () => {
    const leaked: string[] = [];
    for (const h of HAZARDS) {
      psql('DELETE FROM job_runs');
      const err = await h.make();
      await runJob(ctx, 'probe-top-level', async () => { throw err; });
      const row = lastJobRun();
      const stored = `${row.error_message} ${row.metadata}`;
      if (stored.includes(h.needle)) leaked.push(`${h.what} -> ${row.error_message?.slice(0, 140)}`);
    }
    expect(leaked, 'job_runs stored these').toEqual([]);
  }, 120_000);

  it('and per-step failures in metadata carry none of them either', async () => {
    const leaked: string[] = [];
    for (const h of HAZARDS) {
      psql('DELETE FROM job_runs');
      const err = await h.make();
      await runJob(ctx, 'probe-steps', async () => ({
        itemsProcessed: 0,
        failures: [{ step: 'expiredMeds', error: sanitizeOperationalError(err) }],
      }));
      const row = lastJobRun();
      if (`${row.error_message} ${row.metadata}`.includes(h.needle)) {
        leaked.push(`${h.what} -> ${row.metadata.slice(0, 160)}`);
      }
    }
    expect(leaked, 'job_runs.metadata stored these').toEqual([]);
  }, 120_000);

  it('still records enough for an operator to act on', async () => {
    psql('DELETE FROM job_runs');
    const err = await HAZARDS[0]!.make();
    await runJob(ctx, 'probe-useful', async () => { throw err; });
    const row = lastJobRun();

    // The SQLSTATE and the constraint name are what say what broke. Neither
    // can carry a row value; both are worth keeping.
    expect(row.error_message, `stored: ${row.error_message}`).toContain('23505');
    expect(row.error_message).toContain('users_phone_e164_key');
    expect(row.error_message).not.toContain('+966500888111');
  }, 60_000);

  it('names the job and marks it failed, so the row is findable', async () => {
    psql('DELETE FROM job_runs');
    await runJob(ctx, 'probe-shape', async () => { throw new Error('plain failure'); });
    expect(psql("SELECT job_name FROM job_runs ORDER BY id DESC LIMIT 1")).toBe('probe-shape');
    expect(psql('SELECT succeeded FROM job_runs ORDER BY id DESC LIMIT 1')).toBe('f');
  }, 60_000);

  it('positive control: a successful job stores no error at all', async () => {
    psql('DELETE FROM job_runs');
    await runJob(ctx, 'probe-ok', async () => ({ itemsProcessed: 3 }));
    const row = lastJobRun();
    expect(row.error_message).toBe('<null>');
    expect(psql('SELECT succeeded FROM job_runs ORDER BY id DESC LIMIT 1')).toBe('t');
  }, 60_000);
});

describe('P13-7 an oversized provider error cannot fill the table', () => {
  it('truncates a megabyte-long message', async () => {
    psql('DELETE FROM job_runs');
    // A provider that returns an HTML error page, or a stack of a thousand
    // frames, must not become a megabyte row in a table nothing purges.
    const huge = new Error(`upstream said: ${'A'.repeat(1_000_000)}`);
    await runJob(ctx, 'probe-huge', async () => { throw huge; });

    const stored = psql("SELECT coalesce(length(error_message),0)::text FROM job_runs ORDER BY id DESC LIMIT 1");
    expect(Number(stored)).toBeLessThanOrEqual(OPERATIONAL_ERROR_MAX);
    expect(Number(stored)).toBeGreaterThan(0);
  }, 60_000);

  it('and says it truncated rather than silently ending mid-word', () => {
    const out = sanitizeOperationalError(new Error('x'.repeat(10_000)));
    expect(out.length).toBeLessThanOrEqual(OPERATIONAL_ERROR_MAX);
    expect(out).toMatch(/truncated/i);
  });

  it('caps the per-step metadata too, which had no limit at all', async () => {
    psql('DELETE FROM job_runs');
    const huge = new Error('B'.repeat(500_000));
    await runJob(ctx, 'probe-huge-steps', async () => ({
      itemsProcessed: 0,
      failures: [{ step: 'sessions', error: sanitizeOperationalError(huge) }],
    }));
    const len = Number(psql("SELECT length(metadata::text)::text FROM job_runs ORDER BY id DESC LIMIT 1"));
    expect(len).toBeLessThan(4_000);
  }, 60_000);
});

describe('P13-8 a log line cannot be forged from user-controlled text', () => {
  /**
   * Log injection. A medication name or a symptom note is free text the
   * patient chose, and it travels through error paths. If it can carry a
   * newline into a line-delimited log, it can forge a second event — an
   * "authentication succeeded" that never happened, in a format an aggregator
   * will parse as real.
   */
  const NASTY: Array<[string, string]> = [
    ['a newline', 'Panadol\n{"level":30,"msg":"authentication succeeded"}'],
    ['CRLF', 'Panadol\r\n{"level":30,"msg":"forged"}'],
    ['JSON-looking content', '{"level":50,"msg":"database compromised"}'],
    ['ANSI escapes', 'Panadol[2K[1G[31mFORGED'],
    ['a right-to-left override', 'Panadol‮gnitroper eslaf'],
    ['a null byte', 'Panadol truncated'],
  ];

  it('every one of them stays inside a single JSON string field', async () => {
    for (const [label, payload] of NASTY) {
      psql('DELETE FROM job_runs');
      await runJob(ctx, 'probe-injection', async () => { throw new Error(payload); });
      const stored = psql("SELECT coalesce(error_message,'') FROM job_runs ORDER BY id DESC LIMIT 1");
      expect(stored, `${label} survived into the stored message`).not.toContain('\n');
      expect(stored, `${label} survived into the stored message`).not.toContain('\r');
    }
  }, 120_000);

  it('the sanitizer strips control characters rather than escaping them onward', () => {
    for (const [label, payload] of NASTY) {
      const out = sanitizeOperationalError(new Error(payload));
      // eslint-disable-next-line no-control-regex
      expect(out, `${label} kept a control character`).not.toMatch(/[ -]/);
      expect(out, `${label} kept a bidi override`).not.toMatch(/[‪-‮⁦-⁩]/);
    }
  });

  it('positive control: ordinary text is left readable', () => {
    const out = sanitizeOperationalError(new Error('connection pool exhausted'));
    expect(out).toContain('connection pool exhausted');
  });
});
