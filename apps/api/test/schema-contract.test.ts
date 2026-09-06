import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import {
  assertSchemaContract, checkSchemaContract, migrationsDir, requiredMigrations,
  requiredSchemaRevision, SchemaContractError, LedgerMissingError,
} from '../src/lib/schema-contract.js';
import { resetDatabase, startHarness, type Harness } from './harness.js';

/**
 * The deploy safety gate.
 *
 * P18 pointed this build at the schema production actually runs (0019) and
 * measured what happened:
 *
 *   process boots            yes
 *   GET /health              200  {"status":"ok"}     <- render.yaml checks this
 *   GET /health/ready        200  {"status":"ready"}
 *   POST /v1/auth/register   500
 *   POST /v1/auth/login      500, twelve times out of twelve
 *
 * It failed closed, which is the right direction — no login succeeded, no
 * limiter was bypassed. But nothing noticed: Render would have marked the
 * instance live and routed traffic to an API where every authentication request
 * returned 500. The contract below is what makes that state impossible to reach.
 */

const OWNER_URL = `postgres://dawaee_migrator:${process.env.DAWAEE_MIGRATOR_PASSWORD ?? 'migratorpw'}@127.0.0.1:5433/dawaee_test`;

let owner: pg.Pool;
let harness: Harness;

beforeAll(async () => {
  resetDatabase();
  owner = new pg.Pool({ connectionString: OWNER_URL, max: 2 });
  harness = await startHarness();
}, 120_000);

afterAll(async () => {
  await owner?.end().catch(() => undefined);
  await harness?.close().catch(() => undefined);
});

describe('the contract is the migration ledger, not a guess', () => {
  it('reads the migrations this build ships with', () => {
    const required = requiredMigrations();
    expect(required.length).toBeGreaterThan(25);
    expect(required[0]!.filename).toMatch(/^0001_/);
    // Every entry carries an md5, because that is what scripts/migrate.sh
    // writes into the ledger. The comparison has to use the same function the
    // deploy script uses or it is comparing nothing.
    for (const m of required) expect(m.checksum).toMatch(/^[0-9a-f]{32}$/);
    expect(migrationsDir()).toMatch(/db\/migrations$/);
  });

  it('names the highest migration as the required revision', () => {
    const rev = requiredSchemaRevision();
    expect(rev).toBe(requiredMigrations().at(-1)!.filename);
    expect(rev).toMatch(/^\d{4}_[a-z0-9_]+\.sql$/);
  });

  it('is satisfied by a database this build migrated', async () => {
    const check = await checkSchemaContract(owner);
    expect(check.ok, `missing=${check.missing.join(',')} mismatched=${check.mismatched.join(',')}`).toBe(true);
    expect(check.missing).toEqual([]);
    expect(check.mismatched).toEqual([]);
    expect(check.applied).toBeGreaterThanOrEqual(check.required);
  });
});

describe('a schema that is behind is refused', () => {
  /**
   * The exact production state at the time of writing: ledger stops at 0019,
   * build requires 0030. Modelled by removing the ledger rows this build added,
   * inside a transaction, so the database is unchanged afterwards.
   */
  it('a missing migration is named and refused', async () => {
    const client = await owner.connect();
    try {
      await client.query('BEGIN');
      await client.query("DELETE FROM schema_migrations WHERE filename >= '0020'");
      const check = await checkSchemaContract(client as unknown as { query: typeof client.query });
      expect(check.ok).toBe(false);
      expect(check.missing.length).toBeGreaterThan(5);
      expect(check.missing).toContain('0029_shared_auth_rate_limit.sql');
      expect(check.missing).toContain('0030_definer_privilege_model.sql');
      expect(check.mismatched).toEqual([]);

      await expect(assertSchemaContract(client as unknown as { query: typeof client.query }, { attempts: 1 }))
        .rejects.toBeInstanceOf(SchemaContractError);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });

  it('a migration whose contents changed after it shipped is refused', async () => {
    const client = await owner.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        "UPDATE schema_migrations SET checksum = '00000000000000000000000000000000' WHERE filename LIKE '0008%'",
      );
      const check = await checkSchemaContract(client as unknown as { query: typeof client.query });
      expect(check.ok).toBe(false);
      expect(check.mismatched).toEqual(['0008_security_rls.sql']);
      expect(check.missing).toEqual([]);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });

  it('a database that has never been migrated is refused distinctly', async () => {
    const client = await owner.connect();
    try {
      await client.query('BEGIN');
      await client.query('DROP TABLE schema_migrations');
      await expect(checkSchemaContract(client as unknown as { query: typeof client.query }))
        .rejects.toBeInstanceOf(LedgerMissingError);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });

  /**
   * The other direction is ALLOWED, and has to be: a migrate-first deploy runs
   * migrations while the old build is still serving, so for a few minutes the
   * database is ahead of the code. P18 proved the old build keeps working
   * correctly in that window. Refusing here would forbid the only safe order.
   */
  it('a schema AHEAD of the build is accepted', async () => {
    const client = await owner.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        "INSERT INTO schema_migrations (filename, checksum) VALUES ('9999_from_the_future.sql', 'ffffffffffffffffffffffffffffffff')",
      );
      const check = await checkSchemaContract(client as unknown as { query: typeof client.query });
      expect(check.ok, 'a newer schema was rejected, which forbids migrate-first deploys').toBe(true);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });
});

describe('the refusal is safe to print and useful to act on', () => {
  it('names filenames and nothing else', () => {
    // Deliberately includes the migration whose NAME contains "password". The
    // smoke script's first leak check grepped for that word and flagged its own
    // correct output; a check that cries wolf gets deleted by the next person.
    // What must not appear is a value, a connection string, or a path.
    const err = new SchemaContractError(
      ['0022_password_change_by_user_id.sql', '0029_shared_auth_rate_limit.sql'],
      ['0008_security_rls.sql'],
    );
    expect(err.message).toContain('0029_shared_auth_rate_limit.sql');
    expect(err.message).toContain('0008_security_rls.sql');
    for (const leak of ['postgres://', 'dawaee_migrator', 'devpass', '@127.0.0.1', '/home/', process.env.JWT_SECRET ?? 'JWT_SECRET_UNSET']) {
      expect(err.message, `the refusal disclosed ${leak}`).not.toContain(leak);
    }
    // And it is short enough to read in a deploy log.
    expect(err.message.length).toBeLessThan(500);
  });
});

describe('an unreachable database is retried; a behind one is not', () => {
  it('retries a connection failure and then gives up with the original error', async () => {
    let attempts = 0;
    const broken = {
      query: async () => {
        attempts += 1;
        throw new Error('connect ECONNREFUSED 127.0.0.1:5433');
      },
    };
    const err = await assertSchemaContract(broken, { attempts: 3, delayMs: 1 }).catch((e: Error) => e);
    expect(attempts, 'the connection was not retried').toBe(3);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(SchemaContractError);
    expect(String((err as Error).message)).toContain('ECONNREFUSED');
  });

  it('does NOT retry a schema verdict, because waiting cannot fix it', async () => {
    let attempts = 0;
    const behind = {
      query: async (sql: string) => {
        attempts += 1;
        if (sql.includes('to_regclass')) return { rows: [{ present: true }] };
        return { rows: [] as Array<Record<string, unknown>> };
      },
    };
    const err = await assertSchemaContract(behind, { attempts: 5, delayMs: 1 }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(SchemaContractError);
    // Two queries for one attempt: the ledger probe and the ledger read.
    expect(attempts, 'a hopeless verdict was retried').toBe(2);
  });
});

describe('readiness reports the schema, and degrades when it is wrong', () => {
  it('reports the applied revision when the contract holds', async () => {
    const res = await harness.app.inject({ method: 'GET', url: '/health/ready' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ status: string; checks: Record<string, { ok: boolean; detail?: string }> }>();
    expect(body.status).toBe('ready');
    expect(body.checks.schema?.ok, JSON.stringify(body.checks)).toBe(true);
    expect(body.checks.schema?.detail).toBe(requiredSchemaRevision());
  });

  /**
   * Startup refuses outright when the schema is behind, so in practice this
   * catches a database that moved BACKWARDS under a running instance — a
   * restore, or a failover onto a stale replica. Committed and then restored,
   * because readiness uses the application's own pool and cannot see an
   * uncommitted change on somebody else's connection.
   */
  it('returns 503 when the ledger loses a migration under a running instance', async () => {
    const { rows } = await owner.query<{ filename: string; checksum: string }>(
      "SELECT filename, checksum FROM schema_migrations WHERE filename LIKE '0030%'",
    );
    expect(rows).toHaveLength(1);
    try {
      await owner.query("DELETE FROM schema_migrations WHERE filename LIKE '0030%'");
      const res = await harness.app.inject({ method: 'GET', url: '/health/ready' });
      expect(res.statusCode).toBe(503);
      const body = res.json<{ status: string; checks: Record<string, { ok: boolean; detail?: string }> }>();
      expect(body.status).toBe('degraded');
      expect(body.checks.schema?.ok).toBe(false);
      expect(body.checks.schema?.detail).toContain('0030_definer_privilege_model.sql');
      // The database itself is still reachable; the two are reported separately
      // so an operator can tell "cannot reach Postgres" from "wrong schema".
      expect(body.checks.database?.ok).toBe(true);
    } finally {
      await owner.query('INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)',
        [rows[0]!.filename, rows[0]!.checksum]);
    }
    const restored = await harness.app.inject({ method: 'GET', url: '/health/ready' });
    expect(restored.statusCode, 'readiness did not recover').toBe(200);
  });
});
