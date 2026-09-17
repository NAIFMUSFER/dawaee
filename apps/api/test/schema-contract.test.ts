import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import {
  assertSchemaContract, checkSchemaContract, migrationsDir, requiredMigrations,
  requiredSchemaRevision, SchemaContractError, LedgerMissingError,
} from '../src/lib/schema-contract.js';
import { resetDatabase, startHarness, type Harness } from './harness.js';

/**
 * The deploy safety gate. Startup and readiness must reject an incompatible
 * schema, while the unauthenticated readiness response must not reveal exact
 * migration ids, checksums, provider inventory, or internal diagnostics.
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

function expectMinimalReady(bodyText: string): void {
  const body = JSON.parse(bodyText) as Record<string, unknown>;
  expect(body.status).toBe('ready');
  expect(typeof body.time).toBe('string');
  expect(Object.keys(body).sort()).toEqual(['status', 'time']);
}

function expectMinimalSchemaFailure(bodyText: string): void {
  const body = JSON.parse(bodyText) as Record<string, unknown>;
  expect(body.status).toBe('degraded');
  expect(body.failedChecks).toEqual(['schema']);
  expect(typeof body.time).toBe('string');
  expect(Object.keys(body).sort()).toEqual(['failedChecks', 'status', 'time']);
  expect(bodyText).not.toContain('0030_definer_privilege_model.sql');
  expect(bodyText).not.toContain('checks');
}

describe('the contract is the migration ledger, not a guess', () => {
  it('reads the migrations this build ships with', () => {
    const required = requiredMigrations();
    expect(required.length).toBeGreaterThan(25);
    expect(required[0]!.filename).toMatch(/^0001_/);
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
  it('a missing migration is named internally and refused', async () => {
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
      await client.query("UPDATE schema_migrations SET checksum = '00000000000000000000000000000000' WHERE filename LIKE '0008%'");
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

  it('a schema AHEAD of the build is accepted', async () => {
    const client = await owner.connect();
    try {
      await client.query('BEGIN');
      await client.query("INSERT INTO schema_migrations (filename, checksum) VALUES ('9999_from_the_future.sql', 'ffffffffffffffffffffffffffffffff')");
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
    const err = new SchemaContractError(
      ['0022_password_change_by_user_id.sql', '0029_shared_auth_rate_limit.sql'],
      ['0008_security_rls.sql'],
    );
    expect(err.message).toContain('0029_shared_auth_rate_limit.sql');
    expect(err.message).toContain('0008_security_rls.sql');
    for (const leak of ['postgres://', 'dawaee_migrator', 'devpass', '@127.0.0.1', '/home/', process.env.JWT_SECRET ?? 'JWT_SECRET_UNSET']) {
      expect(err.message, `the refusal disclosed ${leak}`).not.toContain(leak);
    }
    expect(err.message.length).toBeLessThan(500);
  });
});

describe('an unreachable database is retried; a behind one is not', () => {
  it('retries a connection failure and then gives up with the original error', async () => {
    let attempts = 0;
    const broken = { query: async () => { attempts += 1; throw new Error('connect ECONNREFUSED 127.0.0.1:5433'); } };
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
    expect(attempts, 'a hopeless verdict was retried').toBe(2);
  });
});

describe('readiness enforces the schema without publishing schema diagnostics', () => {
  it('reports ready with only the minimal public surface when the contract holds', async () => {
    const res = await harness.app.inject({ method: 'GET', url: '/health/ready' });
    expect(res.statusCode).toBe(200);
    expectMinimalReady(res.body);
    expect(res.body).not.toContain(requiredSchemaRevision());
  });

  it('returns 503 when the ledger loses a migration under a running instance without naming it publicly', async () => {
    const { rows } = await owner.query<{ filename: string; checksum: string }>(
      "SELECT filename, checksum FROM schema_migrations WHERE filename LIKE '0030%'",
    );
    expect(rows).toHaveLength(1);
    try {
      await owner.query("DELETE FROM schema_migrations WHERE filename LIKE '0030%'");
      const res = await harness.app.inject({ method: 'GET', url: '/health/ready' });
      expect(res.statusCode).toBe(503);
      expectMinimalSchemaFailure(res.body);
    } finally {
      await owner.query('INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)',
        [rows[0]!.filename, rows[0]!.checksum]);
    }
    const restored = await harness.app.inject({ method: 'GET', url: '/health/ready' });
    expect(restored.statusCode, 'readiness did not recover').toBe(200);
    expectMinimalReady(restored.body);
  });
});
