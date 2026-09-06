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

describe('OTP challenge RLS activation', () => {
  it('enables and forces RLS on auth_otp_challenges', async () => {
    const { rows } = await owner.query<{ enabled: boolean; forced: boolean }>(
      `SELECT c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = 'auth_otp_challenges'`,
    );
    expect(rows).toEqual([{ enabled: true, forced: true }]);
  });

  it('has no public table with FORCE RLS while RLS is disabled', async () => {
    const { rows } = await owner.query<{ relname: string }>(
      `SELECT c.relname
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relkind = 'r'
          AND c.relforcerowsecurity
          AND NOT c.relrowsecurity
        ORDER BY c.relname`,
    );
    expect(rows).toEqual([]);
  });

  it('keeps the OTP table unreachable by both runtime roles directly', async () => {
    for (const role of ['dawaee_app', 'dawaee_worker']) {
      const pool = new pg.Pool({
        connectionString: `postgres://${role}:devpass@127.0.0.1:5433/dawaee_test`,
        max: 1,
      });
      try {
        const err = await pool.query('SELECT 1 FROM auth_otp_challenges LIMIT 1')
          .then(() => null)
          .catch((e: Error) => e.message);
        expect(err, `${role} gained direct OTP-table access`).toMatch(/permission denied/i);
      } finally {
        await pool.end();
      }
    }
  });
});
