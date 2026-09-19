import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resetDatabase } from './harness.js';

// Separate native PostgreSQL connections are required here: the PGlite suite
// exercises SQL boundaries but cannot reproduce concurrent transactions.
let owner: pg.Pool;
let app: pg.Pool;
const fixtureIds: string[] = [];
const digest = () => randomBytes(32).toString('hex');
const original = 'synthetic-original-password-hash-that-is-long-enough';
const replacement = 'synthetic-replacement-password-hash-that-is-long-enough';

beforeAll(async () => {
  resetDatabase();
  owner = new pg.Pool({ connectionString: 'postgres://postgres:postgres@127.0.0.1:5433/dawaee_test', max: 3 });
  app = new pg.Pool({
    connectionString: 'postgres://dawaee_app:devpass@127.0.0.1:5433/dawaee_test',
    max: 4, statement_timeout: 15_000,
  });
  const { rows } = await owner.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
    `SELECT r.rolsuper, r.rolbypassrls FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
      WHERE p.oid = 'app.complete_email_action(text,text,text,text)'::regprocedure`,
  );
  expect(rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
});

afterEach(async () => {
  if (owner && fixtureIds.length) await owner.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [fixtureIds.splice(0)]);
});
afterAll(async () => { await Promise.all([app?.end(), owner?.end()]); });

async function fixture(verified = true) {
  const uid = randomUUID(), session = randomUUID(), email = `${uid}@example.com`;
  fixtureIds.push(uid);
  await owner.query('INSERT INTO users(id,email,display_name) VALUES($1,$2,$3)', [uid, email, 'Email concurrency fixture']);
  await owner.query('INSERT INTO user_credentials(user_id,password_hash) VALUES($1,$2)', [uid, original]);
  await owner.query("INSERT INTO auth_sessions(id,user_id,refresh_token_hash,device_id,expires_at) VALUES($1,$2,$3,'device',now()+interval '1 day')", [session, uid, digest()]);
  await owner.query("INSERT INTO push_tokens(user_id,token,platform,device_id) VALUES($1,$2,'android','device')", [uid, digest()]);
  if (verified) await owner.query('INSERT INTO user_email_verifications(user_id,email) VALUES($1,$2)', [uid, email]);
  return { uid, session, email };
}

type Queryable = pg.Pool | pg.PoolClient;
async function finish(db: Queryable, token: string, purpose = 'reset', password: string | null = replacement, request: string | null = digest()) {
  const { rows } = await db.query<{ result: string | null }>(
    'SELECT app.complete_email_action($1,$2,$3,$4) AS result', [token, purpose, password, request],
  );
  return rows[0]!.result;
}
async function requestVerify(db: pg.PoolClient, user: Awaited<ReturnType<typeof fixture>>, token: string, email: string) {
  await db.query("SELECT set_config('app.user_id',$1,true)", [user.uid]);
  const { rows } = await db.query<{ result: boolean }>(
    'SELECT app.request_email_verification($1,$2,$3,$4,$5,$6) AS result',
    [user.uid, user.session, email, token, original, 'encrypted-fixture'],
  );
  return rows[0]!.result;
}
const requestReset = (db: Queryable, email: string, token: string) =>
  db.query('SELECT app.request_email_recovery($1,$2,$3)', [email, token, 'encrypted-fixture']);

async function transaction<T>(action: (db: pg.PoolClient) => Promise<T>): Promise<T> {
  const db = await app.connect();
  try {
    await db.query('BEGIN');
    const result = await action(db);
    await db.query('COMMIT');
    return result;
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally { db.release(); }
}

async function waitForBlock(blocker: number, waiter: number) {
  for (let attempt = 0; attempt < 160; attempt++) {
    const { rows } = await owner.query<{ blocked: boolean }>(
      'SELECT $1::integer = ANY(pg_blocking_pids($2::integer)) AS blocked', [blocker, waiter],
    );
    if (rows[0]?.blocked) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('The second email operation did not reach the forced transaction boundary');
}

// Keep the first result uncommitted until PostgreSQL confirms that the second
// connection is waiting on it. Promise.all alone would permit a serial pass.
async function overlap<A, B>(first: (db: pg.PoolClient) => Promise<A>, second: (db: pg.PoolClient) => Promise<B>): Promise<[A, B]> {
  const a = await app.connect(), b = await app.connect();
  let pending: Promise<B> | undefined;
  try {
    await a.query('BEGIN');
    await b.query('BEGIN');
    const apid = (await a.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
    const bpid = (await b.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
    const left = await first(a);
    pending = second(b);
    void pending.catch(() => undefined);
    await waitForBlock(apid, bpid);
    await a.query('COMMIT');
    const right = await pending;
    await b.query('COMMIT');
    return [left, right];
  } finally {
    // Release the blocker before awaiting a potentially failed waiter, then
    // roll back any open waiter transaction so fixture cleanup never hangs.
    await a.query('ROLLBACK').catch(() => undefined);
    await pending?.catch(() => undefined);
    await b.query('ROLLBACK').catch(() => undefined);
    a.release(); b.release();
  }
}

describe('native account email concurrency', () => {
  it('allows only one account to verify the same previously unclaimed mailbox', async () => {
    const a = await fixture(false), b = await fixture(false);
    const mailbox = `shared-${randomUUID()}@example.com`, at = digest(), bt = digest();
    expect(await transaction(db => requestVerify(db, a, at, mailbox))).toBe(true);
    expect(await transaction(db => requestVerify(db, b, bt, mailbox))).toBe(true);
    const results = await overlap(db => finish(db, at, 'verify', null, null), db => finish(db, bt, 'verify', null, null));
    expect(results).toEqual([a.uid, null]);
    expect((await owner.query('SELECT user_id FROM user_email_verifications WHERE email=$1', [mailbox])).rows).toEqual([{ user_id: a.uid }]);
    expect((await owner.query('SELECT email FROM users WHERE id=$1', [b.uid])).rows).toEqual([{ email: b.email }]);
  });

  it.each([true, false])('serializes concurrent reset completion (identical retry: %s)', async sameRequest => {
    const f = await fixture(), token = digest(), request = digest();
    await requestReset(app, f.email, token);
    const result = await overlap(
      db => finish(db, token, 'reset', replacement, request),
      db => finish(db, token, 'reset', sameRequest ? replacement : `${replacement}-different`, sameRequest ? request : digest()),
    );
    expect(result).toEqual([f.uid, sameRequest ? f.uid : null]);
    expect((await owner.query('SELECT password_hash FROM user_credentials WHERE user_id=$1', [f.uid])).rows).toEqual([{ password_hash: replacement }]);
    expect((await owner.query('SELECT id FROM auth_sessions WHERE user_id=$1 AND revoked_at IS NULL', [f.uid])).rows).toHaveLength(0);
    expect((await owner.query('SELECT id FROM push_tokens WHERE user_id=$1 AND active', [f.uid])).rows).toHaveLength(0);
  });

  it('rejects an email-change request whose password/session were checked before a concurrent reset', async () => {
    const f = await fixture(), token = digest();
    await requestReset(app, f.email, token);
    expect(await overlap(
      db => finish(db, token),
      db => requestVerify(db, f, digest(), `changed-${f.email}`),
    )).toEqual([f.uid, false]);
    expect((await owner.query("SELECT token_hash FROM account_email_challenges WHERE user_id=$1 AND purpose='verify'", [f.uid])).rows).toHaveLength(0);
  });

  it('rejects an old reset link that was read while its replacement was still uncommitted', async () => {
    const f = await fixture(), old = digest(), latest = digest();
    await requestReset(app, f.email, old);
    const [, result] = await overlap(db => requestReset(db, f.email, latest), db => finish(db, old));
    expect(result).toBeNull();
    expect(await finish(app, latest)).toBe(f.uid);
  });

  it('claims disjoint batches before either transaction commits and ignores a stale lease acknowledgement', async () => {
    const tokens: string[] = [];
    for (let i = 0; i < 10; i++) {
      const f = await fixture(), token = digest(); tokens.push(token);
      await requestReset(app, f.email, token);
    }
    const a = await app.connect(), b = await app.connect();
    const leaseA = randomUUID(), leaseB = randomUUID();
    let firstToken = '';
    try {
      await a.query('BEGIN'); await b.query('BEGIN');
      const first = (await a.query<{ token_hash: string }>('SELECT * FROM app.claim_account_emails($1)', [leaseA])).rows;
      // This must complete while A still owns its row locks (SKIP LOCKED).
      const second = (await b.query<{ token_hash: string }>('SELECT * FROM app.claim_account_emails($1)', [leaseB])).rows;
      expect(first).toHaveLength(5); expect(second).toHaveLength(5);
      expect([...first, ...second].map(row => row.token_hash).sort()).toEqual(tokens.sort());
      expect((await app.query('SELECT * FROM app.claim_account_emails($1)', [randomUUID()])).rows).toHaveLength(0);
      firstToken = first[0]!.token_hash;
      await a.query('COMMIT'); await b.query('COMMIT');
    } finally {
      await a.query('ROLLBACK').catch(() => undefined); await b.query('ROLLBACK').catch(() => undefined);
      a.release(); b.release();
    }
    await owner.query("UPDATE account_email_challenges SET leased_until=now()-interval '1 second' WHERE token_hash=$1", [firstToken]);
    const newLease = randomUUID();
    expect((await app.query('SELECT * FROM app.claim_account_emails($1)', [newLease])).rows).toEqual([{ token_hash: firstToken, payload: 'encrypted-fixture' }]);
    await app.query('SELECT app.finish_account_email($1,$2,true)', [firstToken, leaseA]);
    expect((await owner.query('SELECT payload,lease_id,attempts FROM account_email_challenges WHERE token_hash=$1', [firstToken])).rows).toEqual([{ payload: 'encrypted-fixture', lease_id: newLease, attempts: 2 }]);
    await app.query('SELECT app.finish_account_email($1,$2,true)', [firstToken, newLease]);
    expect((await owner.query('SELECT payload FROM account_email_challenges WHERE token_hash=$1', [firstToken])).rows).toEqual([{ payload: null }]);
  });
});
