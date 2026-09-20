import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../src/server.js';
import { buildProviders } from '../src/providers/index.js';
import { loadConfig } from '../src/config.js';
import { resetDatabase } from './harness.js';
import { BUDGETS, clientAddressUnit, consumeBudget } from '../src/auth/rate-budget.js';
import type { FastifyInstance } from 'fastify';
import { hashPassword } from '../src/lib/password.js';

/**
 * Authentication limits that hold when the service is more than one process.
 *
 * The in-process limiter cannot do this, and on Render's free plan the gap is
 * not theoretical in either direction: an idle service is spun down and cold
 * starts on the next request, which is a counter reset an attacker can provoke
 * by waiting rather than by finding a deploy.
 *
 * TWO REAL SERVER INSTANCES are built below, each with its own Fastify app and
 * its own in-process limiter, sharing one database — which is what a second
 * replica actually is. Anything less than that tests the limiter against
 * itself.
 */

let alpha: FastifyInstance;
let beta: FastifyInstance;
let owner: pg.Pool;
const PW = 'correct horse battery staple';

let seq = 0;
const from = (addr: string) => ({ 'x-forwarded-for': `10.55.0.1, ${addr}` });
let n = 0;
const newPhone = () => `+9665${String(7100000 + n++).padStart(8, '0')}`;

const login = (app: FastifyInstance, identifier: string, addr: string, password = 'wrong password here') =>
  app.inject({
    method: 'POST', url: '/v1/auth/login', remoteAddress: '10.55.0.1', headers: from(addr),
    payload: { identifier, password, deviceId: `srl-dev-${seq++}` },
  });

const register = (app: FastifyInstance, payload: Record<string, unknown>, addr: string) =>
  app.inject({ method: 'POST', url: '/v1/auth/register', remoteAddress: '10.55.0.1', headers: from(addr), payload: { ...(payload.phone ? { email: `auth-${String(payload.phone).replace(/\D/g, '')}@example.test` } : {}), ...payload } });

async function loginHits(keyHash: string): Promise<number> {
  const { rows } = await owner.query<{ hits: string }>(
    "SELECT coalesce(sum(count), 0) AS hits FROM auth_rate_buckets WHERE scope='login:identifier' AND key_hash=$1",
    [keyHash],
  );
  return Number(rows[0]!.hits);
}

async function seedSpentLoginWindows(keyHash: string, firstOffset = 0): Promise<void> {
  const budget = BUDGETS['login:identifier'];
  // Persistence assertions must not accidentally assert a sliding window.
  // Derive both adjacent fixed windows from the database clock in one statement.
  // Only this synthetic identifier is touched; production limits are unchanged.
  await owner.query(
    `WITH boundary AS (
       SELECT to_timestamp(floor(extract(epoch FROM now()) / $2::int) * $2::int) AS start
     )
     INSERT INTO auth_rate_buckets (scope, key_hash, window_start, count)
     SELECT 'login:identifier', $1, start + make_interval(secs => $2::int * step), $3::int
       FROM boundary CROSS JOIN generate_series($4::int, $4::int + 1) AS offsets(step)
     ON CONFLICT (scope, key_hash, window_start)
     DO UPDATE SET count = greatest(auth_rate_buckets.count, excluded.count)`,
    [keyHash, budget.windowSeconds, budget.max, firstOffset],
  );
}

async function spentLoginFixture(phone: string, addressPrefix: string): Promise<string> {
  const before = await owner.query<{ key_hash: string }>(
    "SELECT DISTINCT key_hash FROM auth_rate_buckets WHERE scope='login:identifier'",
  );
  const max = BUDGETS['login:identifier'].max;
  for (let i = 0; i < max; i++) {
    const response = await login(alpha, phone, `${addressPrefix}.${i + 1}`);
    expect(response.statusCode, response.body).toBe(401);
  }
  // Discover the opaque key made by the real login path, without duplicating
  // the application's HMAC or clearing any unrelated fixture's buckets.
  const { rows } = await owner.query<{ key_hash: string }>(
    "SELECT DISTINCT key_hash FROM auth_rate_buckets WHERE scope='login:identifier' AND NOT (key_hash = ANY($1::text[]))",
    [before.rows.map(row => row.key_hash)],
  );
  expect(rows).toHaveLength(1);
  const keyHash = rows[0]!.key_hash;
  expect(await loginHits(keyHash), 'some login attempts bypassed the database counter').toBe(max);
  // Ten requests can straddle a ten-minute boundary. Top up the current AND
  // next bucket so the following replica/restart probes test persistence, not
  // whether the wall clock happens to cross a legitimate expiry between them.
  await seedSpentLoginWindows(keyHash);
  return keyHash;
}

async function authenticatedAccount(app: FastifyInstance, addr: string) {
  const email = `api-budget-${seq++}-${Date.now()}@example.test`;
  const made=await owner.query<{user_id:string}>('SELECT * FROM app.register_email_account($1,$2,$3,$4,$5)',
    [null,email,'API budget fixture',await hashPassword(PW),'ar']);
  await owner.query('INSERT INTO user_email_verifications(user_id,email) VALUES($1,$2)',[made.rows[0]!.user_id,email]);
  const created=await app.inject({method:'POST',url:'/v1/auth/login',remoteAddress:'10.55.0.1',headers:from(addr),
    payload:{identifier:email,password:PW,deviceId:`api-budget-device-${seq++}`}});
  expect(created.statusCode, created.body).toBe(200);
  const accessToken = created.json<{ accessToken: string }>().accessToken;
  const headers = { authorization: `Bearer ${accessToken}` };
  const me = await app.inject({ method: 'GET', url: '/v1/me', headers });
  expect(me.statusCode, me.body).toBe(200);
  return { accessToken, headers, email, userId: me.json().user.id as string };
}

beforeAll(async () => {
  resetDatabase();
  const cfg = loadConfig();
  alpha = (await buildServer({ providers: buildProviders(cfg) })).app;
  beta = (await buildServer({ providers: buildProviders(cfg) })).app;
  await alpha.ready(); await beta.ready();
  owner = new pg.Pool({ connectionString: 'postgres://postgres:postgres@127.0.0.1:5433/dawaee_test', max: 6 });
});
afterAll(async () => { await owner.end(); await alpha.close(); await beta.close(); });

// ══════════════════════════════════════ multi-instance

describe('two API instances share one authentication budget', () => {
  it('two replicas spend the same database-backed fixed windows', async () => {
    const phone = newPhone();
    const max = BUDGETS['login:identifier'].max;

    // Split the attempts across the two instances. With per-process counters
    // each would spend an independent budget. The authoritative control here is
    // the shared Postgres fixed-window counter, so prove all requests landed in
    // it and that the HTTP decisions match each actual window.
    let allowed = 0;
    for (let i = 0; i < max * 2; i++) {
      const app = i % 2 === 0 ? alpha : beta;
      // A different client address every time, so ONLY the identifier budget
      // can be doing the work.
      const r = await login(app, phone, `198.51.100.${i + 1}`);
      if (r.statusCode !== 429) allowed++;
    }

    const { rows: windows } = await owner.query<{ count: number }>(
      `SELECT count
         FROM auth_rate_buckets
        WHERE scope = 'login:identifier'
        ORDER BY window_start`,
    );
    const counts = windows.map((row) => Number(row.count));
    expect(counts.reduce((sum, count) => sum + count, 0), 'some attempts bypassed the shared store').toBe(max * 2);
    expect(windows.length, 'twenty quick requests crossed more than one fixed-window seam').toBeLessThanOrEqual(2);

    // The implementation deliberately uses absolute fixed windows. If this
    // test starts just before the ten-minute seam, both adjacent windows may
    // legitimately admit up to `max`; expecting exactly `max` across the seam
    // is a flaky sliding-window assertion and contradicts migration 0029.
    const expectedAllowed = counts.reduce((sum, count) => sum + Math.min(count, max), 0);
    expect(allowed, `${allowed} allowed; window counts were ${counts.join(',')}`).toBe(expectedAllowed);
  });

  it('a registration budget for one identifier is shared too', async () => {
    const phone = newPhone();
    const max = BUDGETS['register:identifier'].max;
    let allowed = 0;
    for (let i = 0; i < max * 2; i++) {
      const app = i % 2 === 0 ? alpha : beta;
      const r = await register(app, {
        phone, displayName: 'S', password: PW, locale: 'ar', deviceId: `srl-reg-${seq++}-${Date.now() % 10000}`,
      }, `203.0.113.${i + 1}`);
      if (r.statusCode !== 429) allowed++;
    }
    expect(allowed, `${allowed} registrations allowed against a budget of ${max}`).toBe(max);
  });

  it('one instance sees the attempts the other already counted', async () => {
    const identifier = `+9665${String(7900000 + n++).padStart(8, '0')}`;
    const keyHash = await spentLoginFixture(identifier, '198.51.100');
    const hits = await loginHits(keyHash);

    // Beta has never seen this identifier in its own memory. If the counters
    // were per-process it would happily start again from zero.
    const onBeta = await login(beta, identifier, '198.51.100.199');
    expect(onBeta.statusCode, 'the second instance did not see the first instance\'s attempts').toBe(429);
    expect(await loginHits(keyHash), 'the second instance did not commit the refused attempt').toBe(hits + 1);
  });
});

// ══════════════════════════════════════ restart

describe('a restart does not hand back a fresh budget', () => {
  it('a fresh server inherits the count the old one accumulated', async () => {
    const phone = newPhone();
    const keyHash = await spentLoginFixture(phone, '192.0.2');
    const hits = await loginHits(keyHash);
    expect((await login(alpha, phone, '192.0.2.99')).statusCode, 'the budget never closed').toBe(429);
    expect(await loginHits(keyHash)).toBe(hits + 1);

    // A brand-new Fastify server and in-memory limiter, with the same database.
    // This exercises application reconstruction, not an OS process restart.
    const cfg = loadConfig();
    const restarted = (await buildServer({ providers: buildProviders(cfg) })).app;
    await restarted.ready();
    try {
      const after = await login(restarted, phone, '192.0.2.100');
      expect(after.statusCode, 'restarting the service reset the attacker\'s budget').toBe(429);
      expect(await loginHits(keyHash), 'the fresh server did not commit the refused attempt').toBe(hits + 2);
    } finally { await restarted.close(); }
  });

  it('expired fixed windows legitimately give back a budget without a restart', async () => {
    const phone = newPhone();
    const keyHash = await spentLoginFixture(phone, '192.0.2');
    await owner.query("DELETE FROM auth_rate_buckets WHERE scope='login:identifier' AND key_hash=$1", [keyHash]);
    await seedSpentLoginWindows(keyHash, -2);
    const hits = await loginHits(keyHash);
    expect(hits).toBe(BUDGETS['login:identifier'].max * 2);

    const afterExpiry = await login(alpha, phone, '192.0.2.199');
    expect(afterExpiry.statusCode, 'expired windows were treated as a permanent lock').toBe(401);
    expect(await loginHits(keyHash)).toBe(hits + 1);
  });
});

// ══════════════════════════════════════ authenticated API

describe('a verified session receives a shared account budget after the address guard', () => {
  it('one account spends one database-backed bucket across replicas and caller-controlled identity hints', async () => {
    const account = await authenticatedAccount(alpha, '198.51.100.210');
    await owner.query("DELETE FROM auth_rate_buckets WHERE scope='api:account'");

    for (const [app, forged] of [[alpha, 'victim-a'], [beta, 'victim-b']] as const) {
      const response = await app.inject({
        method: 'GET', url: '/v1/me', remoteAddress: '10.55.0.1',
        headers: { ...account.headers, ...from(`198.51.100.${211 + Number(forged.endsWith('b'))}`), 'x-user-id': forged },
      });
      expect(response.statusCode, response.body).toBe(200);
    }

    const { rows } = await owner.query<{ key_hash: string; count: number }>(
      "SELECT key_hash,count FROM auth_rate_buckets WHERE scope='api:account'",
    );
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]!.count)).toBe(2);
    expect(rows[0]!.key_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(rows)).not.toContain(account.userId);
  });

  it('two accounts behind one address do not share their post-authentication budget', async () => {
    const first = await authenticatedAccount(alpha, '198.51.100.220');
    const second = await authenticatedAccount(alpha, '198.51.100.220');
    await owner.query("DELETE FROM auth_rate_buckets WHERE scope='api:account'");
    for (const account of [first, second]) {
      expect((await beta.inject({ method:'GET', url:'/v1/me', headers: account.headers })).statusCode).toBe(200);
    }
    const { rows } = await owner.query<{ key_hash: string }>(
      "SELECT key_hash FROM auth_rate_buckets WHERE scope='api:account'",
    );
    expect(new Set(rows.map((row) => row.key_hash)).size).toBe(2);
  });

  it('commits the refused hit, reports retry guidance, and never blocks session teardown', async () => {
    await owner.query("DELETE FROM auth_rate_buckets WHERE scope='api:account'");
    const account = await authenticatedAccount(alpha, '198.51.100.230');
    const budget = BUDGETS['api:account'];
    const { rows } = await owner.query<{ key_hash: string; window_start: Date }>(
      "SELECT key_hash,window_start FROM auth_rate_buckets WHERE scope='api:account'",
    );
    expect(rows).toHaveLength(1);
    await owner.query(
      "UPDATE auth_rate_buckets SET count=$2 WHERE scope='api:account' AND key_hash=$1",
      [rows[0]!.key_hash, budget.max],
    );
    // Cover the immediately following fixed window as well. Without this, a
    // test starting in the final millisecond of a minute legitimately receives
    // a fresh production window between setup and request.
    await owner.query(
      `INSERT INTO auth_rate_buckets(scope,key_hash,window_start,count)
       VALUES('api:account',$1,$2::timestamptz+make_interval(secs=>$3),$4)
       ON CONFLICT(scope,key_hash,window_start) DO UPDATE SET count=EXCLUDED.count`,
      [rows[0]!.key_hash, rows[0]!.window_start, budget.windowSeconds, budget.max],
    );

    const refused = await beta.inject({ method:'GET', url:'/v1/me', headers: account.headers });
    expect(refused.statusCode, refused.body).toBe(429);
    expect(refused.json()).toMatchObject({
      error: { code: 'rate_limited' },
      meta: { retryAfterSeconds: expect.any(Number) },
    });
    const persisted = await owner.query<{ count: number }>(
      "SELECT count FROM auth_rate_buckets WHERE scope='api:account' AND key_hash=$1", [rows[0]!.key_hash],
    );
    expect(persisted.rows.map((row) => Number(row.count))).toContain(budget.max + 1);

    const logout = await alpha.inject({ method:'POST', url:'/v1/auth/logout', headers: account.headers });
    expect(logout.statusCode, logout.body).toBe(200);
    expect((await beta.inject({ method:'GET', url:'/v1/me', headers: account.headers })).statusCode).toBe(401);
  });

  it('charges a route with overlapping auth hooks once and never trusts an invalid bearer as an account', async () => {
    const account = await authenticatedAccount(alpha, '198.51.100.240');
    await owner.query('INSERT INTO user_email_verifications(user_id,email) VALUES($1,$2) ON CONFLICT DO NOTHING', [account.userId, account.email]);
    await owner.query("DELETE FROM auth_rate_buckets WHERE scope='api:account'");

    const invalid = await alpha.inject({ method:'GET', url:'/v1/me', headers:{authorization:'Bearer not-a-jwt'} });
    expect(invalid.statusCode).toBe(401);
    expect(Number((await owner.query("SELECT count(*) AS n FROM auth_rate_buckets WHERE scope='api:account'")).rows[0].n)).toBe(0);

    const overlap = await alpha.inject({
      method:'POST', url:'/v1/caregivers/notification/resolve', headers:account.headers, payload:{},
    });
    expect(overlap.statusCode).toBe(400);
    const { rows } = await owner.query<{ count: number }>("SELECT count FROM auth_rate_buckets WHERE scope='api:account'");
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]!.count), 'one request was charged by both auth hooks').toBe(1);
  });
});

// ══════════════════════════════════════ concurrency

describe('the counter is atomic', () => {
  it('twenty simultaneous attempts are counted twenty times', async () => {
    const key = `concurrent-${Date.now()}`;
    const results = await Promise.all(Array.from({ length: 20 }, () => consumeBudget('login:identifier', key)));
    // Asserted on what the function RETURNED for this key, rather than by
    // re-reading the table: another test's bucket can be the newest row, and a
    // limiter test that can pick up someone else's count is not a test.
    //
    // A read-then-write limiter loses increments here, which is exactly the
    // window an attacker parallelises into.
    const hits = results.map((r) => r.hits).sort((a, b) => a - b);
    expect(hits, `counts seen: ${hits.join(',')}`).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });

  it('a spent budget reports when to come back, and the window does expire', async () => {
    const key = `retry-${Date.now()}`;
    const budget = BUDGETS['login:identifier'];
    let last = await consumeBudget('login:identifier', key);
    for (let i = 1; i <= budget.max; i++) last = await consumeBudget('login:identifier', key);
    expect(last.allowed).toBe(false);
    expect(last.retryAfterSeconds).toBeGreaterThan(0);
    expect(last.retryAfterSeconds).toBeLessThanOrEqual(budget.windowSeconds);
  });
});

// ══════════════════════════════════════ addressing

describe('what counts as one client', () => {
  it('an IPv4 address is used whole and never truncated', () => {
    expect(clientAddressUnit('203.0.113.7')).toBe('203.0.113.7');
    expect(clientAddressUnit('10.0.0.1')).toBe('10.0.0.1');
  });

  it('an IPv4-mapped IPv6 address is the same client as its IPv4 form', () => {
    expect(clientAddressUnit('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(clientAddressUnit('::FFFF:203.0.113.7')).toBe('203.0.113.7');
  });

  /**
   * A residential IPv6 line is handed a whole /64 or more. Keying on the full
   * address would let one attacker present billions of distinct "clients"
   * without leaving their own connection.
   */
  it('IPv6 addresses in one /64 are one client', () => {
    const a = clientAddressUnit('2001:db8:1234:5678:0000:0000:0000:0001');
    const b = clientAddressUnit('2001:db8:1234:5678:ffff:ffff:ffff:fffe');
    const c = clientAddressUnit('2001:db8:1234:5678::abcd');
    expect(a).toBe(b);
    expect(a).toBe(c);
    expect(a).toMatch(/\/64$/);
  });

  it('a different /64 is a different client', () => {
    expect(clientAddressUnit('2001:db8:1234:5678::1'))
      .not.toBe(clientAddressUnit('2001:db8:1234:5679::1'));
  });

  it('compressed and expanded spellings of one address agree', () => {
    expect(clientAddressUnit('2001:0db8:0000:0000:0000:0000:0000:0001'))
      .toBe(clientAddressUnit('2001:db8::1'));
  });

  it('rotating the host part of a /64 does not buy extra attempts', async () => {
    const max = BUDGETS['login:ip'].max;
    await owner.query("DELETE FROM auth_rate_buckets WHERE scope='login:ip'");
    let allowed = 0;
    for (let i = 0; i < max + 6; i++) {
      // A DIFFERENT identifier each time, so the identifier budget cannot be
      // what stops this — only the address budget can. Same subscriber line,
      // a fresh address within it on every request.
      const r = await login(alpha, newPhone(), `2001:db8:aaaa:bbbb::${(i + 1).toString(16)}`);
      if (r.statusCode !== 429) allowed++;
    }

    const { rows: windows } = await owner.query<{ key_hash: string; count: number }>(
      `SELECT key_hash, count
         FROM auth_rate_buckets
        WHERE scope = 'login:ip'
        ORDER BY window_start`,
    );
    const counts = windows.map((row) => Number(row.count));
    expect(new Set(windows.map((row) => row.key_hash)).size,
      'rotating the host part created a second address key').toBe(1);
    expect(counts.reduce((sum, count) => sum + count, 0),
      'some rotated-address attempts bypassed the shared store').toBe(max + 6);
    expect(windows.length, 'the requests crossed more than one fixed-window seam').toBeLessThanOrEqual(2);

    // Fixed windows can legitimately admit another budget after the absolute
    // ten-minute seam. Assert the limit independently for every observed window
    // instead of treating the two windows as one sliding window.
    const expectedAllowed = counts.reduce((sum, count) => sum + Math.min(count, max), 0);
    expect(allowed, `${allowed} allowed; window counts were ${counts.join(',')}`).toBe(expectedAllowed);
  });
});

// ══════════════════════════════════════ privacy

describe('the limiter stores nothing that identifies anyone', () => {
  it('no phone number, email address or IP address appears in the table', async () => {
    const phone = newPhone();
    await login(alpha, phone, '198.51.100.77');
    await register(alpha, { email: 'privacy-probe@example.com', displayName: 'P', password: PW, locale: 'ar', deviceId: `srl-p-${seq++}` }, '198.51.100.78');

    const { rows } = await owner.query<{ scope: string; key_hash: string }>('SELECT scope, key_hash FROM auth_rate_buckets');
    expect(rows.length).toBeGreaterThan(0);
    const blob = JSON.stringify(rows);
    expect(blob, 'a phone number is stored in the limiter').not.toContain(phone);
    expect(blob, 'an email address is stored in the limiter').not.toContain('privacy-probe@example.com');
    expect(blob, 'a client address is stored in the limiter').not.toContain('198.51.100.77');
    for (const r of rows) expect(r.key_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('the key is keyed, so a phone number cannot be confirmed by hashing it', async () => {
    const { createHash } = await import('node:crypto');
    const phone = newPhone();
    await login(alpha, phone, '198.51.100.79');
    const { rows } = await owner.query<{ key_hash: string }>('SELECT key_hash FROM auth_rate_buckets');
    const hashes = new Set(rows.map((r) => r.key_hash));
    // Saudi mobile numbers are a space of about 10^8. An unkeyed digest would
    // let anyone holding this table confirm a specific number in milliseconds.
    for (const guess of [phone, `login:identifier:${phone}`]) {
      expect(hashes.has(createHash('sha256').update(guess).digest('hex')),
        'the bucket key is an unkeyed digest of the identifier').toBe(false);
    }
  });
});

// ══════════════════════════════════════ retention and failure

describe('bounded growth and a stated failure mode', () => {
  it('old windows are purged without rewriting unrelated live buckets', async () => {
    const { createHash } = await import('node:crypto');
    const marker = Date.now().toString();
    const staleKey = createHash('sha256').update(`retention-stale-${marker}`).digest('hex');
    const freshKey = createHash('sha256').update(`retention-fresh-${marker}`).digest('hex');

    // Own only this fixture. The previous test globally rewrote window_start on
    // every bucket, which can collapse two legitimate windows for one key onto
    // the table's (scope,key_hash,window_start) primary key and fail before it
    // ever tests purge_rate_buckets.
    await owner.query(
      `INSERT INTO auth_rate_buckets (scope, key_hash, window_start, count)
       VALUES ('login:ip', $1, now() - interval '48 hours', 1),
              ('login:ip', $2, now(), 1)`,
      [staleKey, freshKey],
    );

    const { rows } = await owner.query<{ purge_rate_buckets: number }>('SELECT app.purge_rate_buckets(24)');
    expect(rows[0]!.purge_rate_buckets).toBeGreaterThan(0);

    const { rows: markers } = await owner.query<{ key_hash: string }>(
      'SELECT key_hash FROM auth_rate_buckets WHERE key_hash = ANY($1::text[]) ORDER BY key_hash',
      [[staleKey, freshKey]],
    );
    expect(markers.map((row) => row.key_hash)).toEqual([freshKey]);
  });

  /**
   * FAIL CLOSED, and it costs nothing: every route this guards needs the same
   * database to look up a credential or write a session, so a caller who cannot
   * reach the limiter could not have signed in either way. Failing open would
   * remove brute-force protection exactly when the system is degraded — which
   * is when an attacker is most likely to be the cause.
   */
  it('an unreachable limiter refuses the sign-in rather than waving it through', async () => {
    const { rows } = await owner.query<{ has: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='app' AND p.proname='consume_rate_budget') AS has",
    );
    expect(rows[0]!.has).toBe(true);
    await owner.query('ALTER FUNCTION app.consume_rate_budget(text,text,int,int) RENAME TO consume_rate_budget_hidden');
    try {
      const r = await login(alpha, newPhone(), '198.51.100.90');
      expect([429, 500, 503], `an unreachable limiter answered ${r.statusCode}`).toContain(r.statusCode);
      expect(r.statusCode, 'the sign-in proceeded with no rate limiting at all').not.toBe(200);
      expect(r.statusCode).not.toBe(401);
    } finally {
      await owner.query('ALTER FUNCTION app.consume_rate_budget_hidden(text,text,int,int) RENAME TO consume_rate_budget');
    }
  });
});

// ══════════════════════════════════════ what the app believes about the client

/**
 * TRUST_PROXY_HOPS decides which entry of X-Forwarded-For becomes `req.ip`, and
 * that single value feeds every address-keyed limit and every `ipHash` in the
 * audit trail. These cases pin the semantics so a change to the setting, or to
 * Fastify's interpretation of it, fails here rather than in production.
 *
 * The app is configured for ONE proxy, so the trusted value is the entry that
 * proxy appended — the rightmost — and everything to its left is whatever the
 * client chose to write.
 */
describe('the client address the app derives from a proxy chain', () => {
  /**
   * Behavioural rather than introspective: two requests whose derived address
   * differs land in different buckets, two whose derived address agrees land in
   * one. That is the property the limits actually depend on.
   */
  const bucketsFor = async (chains: string[]) => {
    await owner.query("DELETE FROM auth_rate_buckets WHERE scope='refresh:ip'");
    for (const chain of chains) {
      await alpha.inject({
        method: 'POST', url: '/v1/auth/refresh', remoteAddress: '10.55.0.1',
        headers: { 'x-forwarded-for': chain },
        payload: { refreshToken: 'y'.repeat(40) },
      });
    }
    const { rows } = await owner.query<{ n: string }>(
      "SELECT count(*) AS n FROM auth_rate_buckets WHERE scope='refresh:ip'",
    );
    return Number(rows[0]!.n);
  };

  it('a forged left-hand entry does not change the client the app sees', async () => {
    // Same proxy-appended address, three different forged prefixes: one client.
    expect(await bucketsFor([
      '1.2.3.4, 203.0.113.50',
      '5.6.7.8, 203.0.113.50',
      '9.9.9.9, 203.0.113.50',
    ]), 'a client-written entry chose the bucket').toBe(1);
  });

  it('different proxy-appended addresses are different clients', async () => {
    expect(await bucketsFor([
      '1.2.3.4, 203.0.113.60',
      '1.2.3.4, 203.0.113.61',
    ])).toBe(2);
  });

  it('a long forged chain still resolves to the appended entry', async () => {
    expect(await bucketsFor([
      '1.1.1.1, 2.2.2.2, 3.3.3.3, 4.4.4.4, 203.0.113.70',
      '9.9.9.9, 203.0.113.70',
    ]), 'chain length changed the derived client').toBe(1);
  });

  it('an IPv6 client behind the proxy is grouped by its /64', async () => {
    expect(await bucketsFor([
      '1.2.3.4, 2001:db8:cafe:1111::1',
      '1.2.3.4, 2001:db8:cafe:1111::2',
    ]), 'two addresses in one /64 became two clients').toBe(1);
  });

  it('a malformed header does not crash the request or vanish the limit', async () => {
    const n = await bucketsFor(['not-an-ip-at-all', 'still, not, an, ip']);
    // Whatever it resolves to, the request is still counted against something.
    expect(n).toBeGreaterThan(0);
  });

  it('no proxy header at all falls back to the socket address', async () => {
    await owner.query("DELETE FROM auth_rate_buckets WHERE scope='refresh:ip'");
    await alpha.inject({
      method: 'POST', url: '/v1/auth/refresh', remoteAddress: '198.51.100.250',
      payload: { refreshToken: 'z'.repeat(40) },
    });
    const { rows } = await owner.query<{ n: string }>(
      "SELECT count(*) AS n FROM auth_rate_buckets WHERE scope='refresh:ip'",
    );
    expect(Number(rows[0]!.n)).toBe(1);
  });
});
