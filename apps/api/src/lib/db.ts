import pg from 'pg';
import { createHash } from 'node:crypto';
import { loadConfig } from '../config.js';

const { Pool } = pg;

/**
 * Database access.
 *
 * The single most important rule in this file: every request-scoped query runs
 * inside a transaction that has `app.user_id` set, because the RLS policies in
 * migration 0008 are written against it. `withUser()` is the only sanctioned
 * way to reach patient data, and it sets the value with `set_config(..., true)`
 * so it is scoped to the transaction and cannot leak to the next borrower of
 * the pooled connection.
 */

// Return DATE and TIMESTAMP columns as plain strings rather than JS Dates in
// the server's local zone — that conversion is exactly how timezone bugs get
// into a medication schedule.
pg.types.setTypeParser(1082, (v) => v);            // date
pg.types.setTypeParser(1083, (v) => v.slice(0, 5)); // time -> HH:mm

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (pool) return pool;
  const cfg = loadConfig();
  pool = new Pool({
    connectionString: cfg.DATABASE_URL,
    max: cfg.DATABASE_POOL_MAX,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    ssl:
      cfg.DATABASE_SSL === 'true'
        ? { rejectUnauthorized: true }
        : cfg.DATABASE_SSL === 'no-verify'
          ? { rejectUnauthorized: false }
          : undefined,
    // A runaway query must not hold a connection hostage.
    statement_timeout: 15_000,
    query_timeout: 20_000,
  });
  pool.on('error', (err) => {
    // eslint-disable-next-line no-console
    console.error({ err: err.message }, 'idle postgres client error');
  });
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

export type Queryable = Pick<pg.PoolClient, 'query'>;

/** A transaction with no user identity. Use only for auth and system paths. */
export async function withTransaction<T>(fn: (tx: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * A transaction bound to an authenticated user. RLS does the rest.
 *
 * `set_config(..., is_local => true)` ties the setting to this transaction, so
 * a connection returned to the pool never carries one user's identity into
 * another user's request.
 */
export async function withUser<T>(userId: string, fn: (tx: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1, $2, true)', ['app.user_id', userId]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Read-only variant; the transaction is marked so a stray write fails loudly. */
export async function withUserReadOnly<T>(userId: string, fn: (tx: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query('SELECT set_config($1, $2, true)', ['app.user_id', userId]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export function hashIp(ip: string | undefined): string | null {
  if (!ip) return null;
  const cfg = loadConfig();
  return createHash('sha256').update(`${cfg.IP_HASH_SALT}:${ip}`).digest('hex').slice(0, 32);
}

/** Postgres error codes we translate into meaningful API responses. */
export const PG_ERRORS = {
  UNIQUE_VIOLATION: '23505',
  FOREIGN_KEY_VIOLATION: '23503',
  CHECK_VIOLATION: '23514',
  INSUFFICIENT_PRIVILEGE: '42501',
  RAISE_EXCEPTION: 'P0001',
  INVALID_TEXT_REPRESENTATION: '22P02',
  UNDEFINED_FUNCTION: '42883',
} as const;

export function isPgError(err: unknown, code: string): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === code;
}
