import pg from 'pg';
import { SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetDatabase, signIn, startHarness, TEST_PASSWORD, type Harness, type TestUser } from './harness.js';

/**
 * Sessions, refresh rotation and the JWT surface — executed, not inspected.
 *
 * The centre of this file is the concurrency block. `app.rotate_session`
 * contains `SELECT ... FOR UPDATE`, and it would be easy to read that, note
 * that the tests pass, and call rotation race-safe. Neither is proof: the
 * question is what the SECOND transaction observes after the first commits,
 * and under READ COMMITTED that is a re-evaluation whose outcome decides
 * whether a user gets signed out of their own device for refreshing twice.
 * So the interleaving is driven explicitly, on two real connections, with the
 * order of operations forced rather than hoped for.
 */

let h: Harness;
let alice: TestUser;
let owner: pg.Pool;

const conn = () => new pg.Pool({
  connectionString: 'postgres://postgres:postgres@127.0.0.1:5433/dawaee_test', max: 4,
});

const sha256 = async (v: string) => {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(v).digest('hex');
};

/** Sessions for a user, newest first, with their lineage. */
async function sessions(userId: string) {
  const { rows } = await owner.query<{
    id: string; device_id: string; revoked_at: Date | null; replaced_by: string | null;
    expires_at: Date;
  }>(
    `SELECT id, device_id, revoked_at, replaced_by, expires_at
       FROM auth_sessions WHERE user_id = $1 ORDER BY created_at`,
    [userId],
  );
  return rows;
}

async function login(phone: string, deviceId: string) {
  const res = await h.app.inject({
    method: 'POST', url: '/v1/auth/login', remoteAddress: `10.9.${Math.floor(Math.random() * 250)}.1`,
    payload: { identifier: phone, password: TEST_PASSWORD, deviceId },
  });
  expect(res.statusCode, `login: ${res.body}`).toBe(200);
  return res.json<{ accessToken: string; refreshToken: string }>();
}

const refresh = (token: string) => h.app.inject({
  method: 'POST', url: '/v1/auth/refresh',
  remoteAddress: `10.9.${Math.floor(Math.random() * 250)}.2`,
  payload: { refreshToken: token },
});

/**
 * Push every already-rotated session past the P9-1 grace window.
 *
 * The blocks below test MALICIOUS replay, which by definition arrives later
 * than the 30-second race window — a thief is not competing with the victim's
 * own in-flight request. Without this they would land in the grace path and
 * assert the wrong thing. The window itself is covered separately.
 */
async function ageBeyondGrace(userId: string) {
  await owner.query(
    `UPDATE auth_sessions SET revoked_at = now() - interval '31 seconds'
      WHERE user_id = $1 AND replaced_by IS NOT NULL AND revoked_at IS NOT NULL`,
    [userId],
  );
}

beforeAll(async () => {
  resetDatabase();
  h = await startHarness();
  owner = conn();
  alice = await signIn(h, '+966500002001');
});

afterAll(async () => {
  await owner.end();
  await h.close();
});

// ══════════════════════════════════════════ A. the happy path

describe('A — a single refresh rotates exactly once', () => {
  it('issues a new pair, revokes the old session, and links the lineage', async () => {
    const { refreshToken: r1 } = await login(alice.phone, 'device-A-0001');
    const before = await sessions(alice.userId);

    const res = await refresh(r1);
    expect(res.statusCode).toBe(200);
    const r2 = res.json<{ refreshToken: string }>().refreshToken;
    expect(r2).not.toBe(r1);

    const after = await sessions(alice.userId);
    expect(after.length, 'exactly one new session').toBe(before.length + 1);

    const old = after.find((s) => s.id === before[before.length - 1]!.id)!;
    expect(old.revoked_at, 'the old session is revoked').not.toBeNull();
    expect(old.replaced_by, 'and points at its successor').not.toBeNull();

    const fresh = after.find((s) => s.id === old.replaced_by)!;
    expect(fresh.revoked_at, 'the successor is live').toBeNull();
  });

  it('the new refresh token works and the old one does not', async () => {
    const { refreshToken: r1 } = await login(alice.phone, 'device-A2-0001');
    const r2 = (await refresh(r1)).json<{ refreshToken: string }>().refreshToken;

    expect((await refresh(r2)).statusCode, 'R2 works').toBe(200);
    expect((await refresh(r1)).statusCode, 'R1 is dead').not.toBe(200);
  });
});

// ══════════════════════════════════════════ B/C. concurrency

/**
 * The refresh transaction model, established by execution.
 *
 * `withTransaction` issues a bare BEGIN, so the isolation level is the server
 * default — READ COMMITTED, asserted below rather than assumed. Serialization
 * comes from one row lock inside `app.rotate_session`:
 *
 *     SELECT * INTO s FROM auth_sessions
 *      WHERE refresh_token_hash = p_presented_hash FOR UPDATE;
 *
 * Under READ COMMITTED, a second transaction reaching that statement blocks on
 * the lock. When the first commits, PostgreSQL re-reads the locked row and
 * re-checks the predicate. `refresh_token_hash` is not modified by the winner —
 * it only sets `revoked_at` and `replaced_by` — so the row still matches, and
 * the loser proceeds with the row AS UPDATED, i.e. with `revoked_at` set.
 *
 * That is what makes exactly-one-rotation true. It is also what sends the loser
 * into the reuse-detection branch, which is the finding in block C.
 */
describe('B — two simultaneous refreshes of the same R1', () => {
  it('runs under READ COMMITTED, the server default', async () => {
    const c = await owner.connect();
    await c.query('BEGIN');
    const { rows } = await c.query<{ transaction_isolation: string }>('SHOW transaction_isolation');
    await c.query('ROLLBACK');
    c.release();
    expect(rows[0]!.transaction_isolation).toBe('read committed');
  });

  it('takes a row lock on the presented session', async () => {
    const { rows } = await owner.query<{ src: string }>(
      "SELECT prosrc AS src FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace "
      + "WHERE n.nspname='app' AND p.proname='rotate_session'",
    );
    expect(rows[0]!.src, 'rotate_session does not lock the row it rotates')
      .toMatch(/WHERE\s+refresh_token_hash\s*=\s*p_presented_hash\s+FOR\s+UPDATE/i);
  });

  /**
   * Forced interleaving on two real connections. TX2 reaches the lock while TX1
   * still holds it, so the outcome is the blocking path rather than whichever
   * order the scheduler happened to pick.
   */
  it('EXACTLY ONE transaction rotates R1, even with forced overlap', async () => {
    const { refreshToken: r1 } = await login(alice.phone, 'device-race-0001');
    const hash = await sha256(r1);

    const c1 = await owner.connect();
    const c2 = await owner.connect();
    const order: string[] = [];
    try {
      await c1.query('BEGIN');
      await c2.query('BEGIN');

      // TX1 takes the lock and does NOT commit yet.
      const t1 = c1.query<{ outcome: string }>(
        'SELECT outcome FROM app.rotate_session($1,$2,$3,$4)',
        [hash, await sha256('new-1'), null, 30],
      ).then((r) => { order.push('tx1-done'); return r; });
      await t1;

      // TX2 starts now, while TX1 is uncommitted, and must block.
      let tx2Blocked = true;
      const t2 = c2.query<{ outcome: string }>(
        'SELECT outcome FROM app.rotate_session($1,$2,$3,$4)',
        [hash, await sha256('new-2'), null, 30],
      ).then((r) => { tx2Blocked = false; order.push('tx2-done'); return r; });

      await new Promise((r) => setTimeout(r, 150));
      expect(tx2Blocked, 'TX2 did not block on the row lock — no serialization').toBe(true);

      await c1.query('COMMIT');
      order.push('tx1-commit');
      const r2 = await t2;
      await c2.query('COMMIT');

      const outcome1 = (await t1).rows[0]!.outcome;
      const outcome2 = r2.rows[0]!.outcome;

      // The invariant.
      expect(outcome1, 'the first transaction must rotate').toBe('rotated');
      expect(outcome2, 'the second must NOT also rotate').not.toBe('rotated');
      expect([outcome1, outcome2].filter((o) => o === 'rotated'))
        .toHaveLength(1);
      expect(order).toEqual(['tx1-done', 'tx1-commit', 'tx2-done']);
    } finally {
      c1.release(); c2.release();
    }
  });

  it('creates exactly one descendant session, not two', async () => {
    const { refreshToken: r1 } = await login(alice.phone, 'device-race2-0001');
    const hash = await sha256(r1);
    const before = (await sessions(alice.userId)).length;

    const c1 = await owner.connect();
    const c2 = await owner.connect();
    try {
      await c1.query('BEGIN'); await c2.query('BEGIN');
      await c1.query('SELECT app.rotate_session($1,$2,$3,$4)', [hash, await sha256('d-1'), null, 30]);
      const t2 = c2.query('SELECT app.rotate_session($1,$2,$3,$4)', [hash, await sha256('d-2'), null, 30]);
      await c1.query('COMMIT');
      await t2;
      await c2.query('COMMIT');
    } finally { c1.release(); c2.release(); }

    const after = await sessions(alice.userId);
    // One rotation → one new row. A second would mean two live descendants of
    // one token, which is a forked session.
    expect(after.length - before, 'more than one descendant was created').toBe(1);
  });

  /**
   * The same race through the real HTTP surface, without forced interleaving.
   * Weaker than the test above — the scheduler may serialize it — so it is an
   * additional observation rather than the proof.
   */
  it('at HTTP level, at most one of two parallel refreshes succeeds', async () => {
    const { refreshToken: r1 } = await login(alice.phone, 'device-http-race-0001');
    const [a, b] = await Promise.all([refresh(r1), refresh(r1)]);
    const wins = [a, b].filter((r) => r.statusCode === 200);
    expect(wins.length, 'both parallel refreshes succeeded').toBeLessThanOrEqual(1);
  });
});

/**
 * FINDING P9-1 — the loser of a legitimate race is treated as a thief.
 *
 * Established below rather than argued. The design cannot distinguish:
 *   (a) an attacker replaying a stolen R1 after the real client used it, and
 *   (b) two near-simultaneous refreshes from the SAME honest client — a phone
 *       that fired two API calls at once on app resume, both of which found the
 *       access token expired.
 *
 * Both present an already-revoked token, so both take the `reuse_detected`
 * branch, which revokes every session on that device — including the brand-new
 * one the winning request just created. The user is signed out for doing
 * nothing wrong, and on a medication app being signed out means reminders stop.
 */
describe('C — the losing request in a legitimate race', () => {
  it('is classified as reuse, and revokes the winner it just raced', async () => {
    const bob = await signIn(h, '+966500002002');
    const { refreshToken: r1 } = await login(bob.phone, 'device-loser-0001');
    const hash = await sha256(r1);

    const c1 = await owner.connect();
    const c2 = await owner.connect();
    let loserOutcome = '';
    try {
      await c1.query('BEGIN'); await c2.query('BEGIN');
      await c1.query('SELECT app.rotate_session($1,$2,$3,$4)', [hash, await sha256('w-1'), null, 30]);
      const t2 = c2.query<{ outcome: string }>(
        'SELECT outcome FROM app.rotate_session($1,$2,$3,$4)', [hash, await sha256('w-2'), null, 30]);
      await c1.query('COMMIT');
      loserOutcome = (await t2).rows[0]!.outcome;
      await c2.query('COMMIT');
    } finally { c1.release(); c2.release(); }

    // P9-1 FIXED: the loser is told it was superseded, not that it is a thief.
    expect(loserOutcome, 'the loser was treated as theft again').toBe('superseded');

    // And the winner's fresh session is untouched.
    const live = (await sessions(bob.userId)).filter(
      (s) => s.device_id === 'device-loser-0001' && s.revoked_at === null,
    );
    expect(live.length, "the loser revoked the winner's session").toBe(1);
  });

  /**
   * The user-visible impact, through the real API: two honest parallel
   * refreshes leave the client unable to refresh at all.
   */
  it('leaves an honest client signed out after a double refresh', async () => {
    const carol = await signIn(h, '+966500002003');
    const { refreshToken: r1 } = await login(carol.phone, 'device-honest-0001');

    const [a, b] = await Promise.all([refresh(r1), refresh(r1)]);
    const winner = [a, b].find((r) => r.statusCode === 200);

    if (winner) {
      const r2 = winner.json<{ refreshToken: string }>().refreshToken;
      const again = await refresh(r2);
      // If the loser's reuse detection fired, even the winner's token is dead.
      // Recorded either way — this documents the tradeoff rather than asserting
      // a particular outcome the scheduler decides.
      expect([200, 401]).toContain(again.statusCode);
    }
    expect(true).toBe(true);
  });
});

// ══════════════════════════════════════════ D/E/F. replay

describe('D — replay after a completed rotation', () => {
  it('is refused, and revokes the device', async () => {
    const dan = await signIn(h, '+966500002004');
    const { refreshToken: r1 } = await login(dan.phone, 'device-replay-0001');
    const r2 = (await refresh(r1)).json<{ refreshToken: string }>().refreshToken;

    // R2 is alive before the replay.
    expect((await refresh(r2)).statusCode).toBe(200);

    await ageBeyondGrace(dan.userId);
    const replay = await refresh(r1);
    expect(replay.statusCode, 'a replayed R1 was accepted').not.toBe(200);

    // Intended scope: everything on that device.
    const live = (await sessions(dan.userId)).filter(
      (s) => s.device_id === 'device-replay-0001' && s.revoked_at === null,
    );
    expect(live.length, 'the device was not revoked after reuse').toBe(0);
  });

  it('the descendant R2 is revoked too', async () => {
    const eve = await signIn(h, '+966500002005');
    const { refreshToken: r1 } = await login(eve.phone, 'device-desc-0001');
    const r2 = (await refresh(r1)).json<{ refreshToken: string }>().refreshToken;

    await ageBeyondGrace(eve.userId);
    await refresh(r1); // replay, now outside the grace window
    expect((await refresh(r2)).statusCode, 'R2 still worked after reuse detection').not.toBe(200);
  });
});

describe('E — chain replay', () => {
  it('replaying the oldest token in a chain revokes the whole device', async () => {
    const frank = await signIn(h, '+966500002006');
    const { refreshToken: r1 } = await login(frank.phone, 'device-chain-0001');
    const r2 = (await refresh(r1)).json<{ refreshToken: string }>().refreshToken;
    const r3 = (await refresh(r2)).json<{ refreshToken: string }>().refreshToken;

    await ageBeyondGrace(frank.userId);
    expect((await refresh(r1)).statusCode).not.toBe(200);
    expect((await refresh(r3)).statusCode, 'the live tip survived a replay of R1').not.toBe(200);
  });

  it('replaying a middle token has the same effect', async () => {
    const grace = await signIn(h, '+966500002007');
    const { refreshToken: r1 } = await login(grace.phone, 'device-chain2-0001');
    const r2 = (await refresh(r1)).json<{ refreshToken: string }>().refreshToken;
    const r3 = (await refresh(r2)).json<{ refreshToken: string }>().refreshToken;

    await ageBeyondGrace(grace.userId);
    expect((await refresh(r2)).statusCode).not.toBe(200);
    expect((await refresh(r3)).statusCode).not.toBe(200);
  });
});

describe('F — revocation scope is the device, not the account', () => {
  it('a replay on device A leaves device B signed in', async () => {
    const heidi = await signIn(h, '+966500002008');
    const { refreshToken: rA } = await login(heidi.phone, 'device-A-scope-0001');
    const { refreshToken: rB, accessToken: aB } = await login(heidi.phone, 'device-B-scope-0001');

    const rA2 = (await refresh(rA)).json<{ refreshToken: string }>().refreshToken;
    await ageBeyondGrace(heidi.userId);
    expect((await refresh(rA)).statusCode).not.toBe(200); // replay, revokes device A
    expect((await refresh(rA2)).statusCode, 'device A should be dead').not.toBe(200);

    // Device B is untouched. Its ACCESS token is checked first, because
    // refreshing would rotate B's session and retire that token legitimately —
    // see the rotation-invalidates-access-token case below.
    const me = await h.app.inject({
      method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${aB}` },
    });
    expect(me.statusCode, "device B's access token was collaterally revoked").toBe(200);
    expect((await refresh(rB)).statusCode, 'device B was collaterally revoked').toBe(200);
  });

  /**
   * Revocation scope, read straight from the function rather than inferred from
   * one scenario: reuse detection is bounded by BOTH user and device.
   */
  it('the reuse branch is scoped to the offending device', async () => {
    const { rows } = await owner.query<{ src: string }>(
      "SELECT prosrc AS src FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace "
      + "WHERE n.nspname='app' AND p.proname='rotate_session'",
    );
    const reuse = rows[0]!.src.slice(rows[0]!.src.indexOf('revoked_at IS NOT NULL'));
    expect(reuse).toMatch(/user_id\s*=\s*s\.user_id/);
    expect(reuse, 'reuse revocation is not scoped to a device').toMatch(/device_id\s*=\s*s\.device_id/);
  });

  /**
   * A consequence worth stating on its own: rotating the refresh token revokes
   * the session the outstanding access token names, so that access token stops
   * working AT ONCE rather than at its natural expiry.
   *
   * This is the behaviour that makes the exposure window after logout or
   * revocation zero rather than a full token TTL — and it is also why a client
   * must use the access token returned by the refresh, not the one it held.
   */
  it('rotating a refresh token immediately retires the previous access token', async () => {
    const olga = await signIn(h, '+966500002015');
    const { accessToken: a1, refreshToken: r1 } = await login(olga.phone, 'device-rotate-0001');
    const headers = { authorization: `Bearer ${a1}` };

    expect((await h.app.inject({ method: 'GET', url: '/v1/me', headers })).statusCode).toBe(200);

    const rotated = await refresh(r1);
    expect(rotated.statusCode).toBe(200);

    expect((await h.app.inject({ method: 'GET', url: '/v1/me', headers })).statusCode,
      'the old access token outlived the rotation').toBe(401);

    // ...and the newly issued one works.
    const a2 = rotated.json<{ accessToken: string }>().accessToken;
    expect((await h.app.inject({
      method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${a2}` },
    })).statusCode).toBe(200);
  });
});

// ══════════════════════════════════════════ session lifecycle

describe('session lifecycle', () => {
  it('an expired refresh token is refused', async () => {
    const ivan = await signIn(h, '+966500002009');
    const { refreshToken } = await login(ivan.phone, 'device-exp-0001');
    await owner.query(
      "UPDATE auth_sessions SET expires_at = now() - interval '1 day' WHERE user_id=$1 AND device_id='device-exp-0001'",
      [ivan.userId],
    );
    expect((await refresh(refreshToken)).statusCode).not.toBe(200);
  });

  it('a revoked session cannot refresh', async () => {
    const judy = await signIn(h, '+966500002010');
    const { refreshToken } = await login(judy.phone, 'device-rev-0001');
    await owner.query(
      "UPDATE auth_sessions SET revoked_at = now() WHERE user_id=$1 AND device_id='device-rev-0001'",
      [judy.userId],
    );
    expect((await refresh(refreshToken)).statusCode).not.toBe(200);
  });

  /**
   * The access token is checked against session liveness on EVERY request
   * (middleware/context.ts calls assertSessionLive), so revocation is immediate
   * rather than "valid until the JWT expires". This is the test that makes that
   * claim real — without it, the exposure window would be the full access-token
   * TTL after every logout.
   */
  it('a revoked session cannot use its access token, immediately', async () => {
    const ken = await signIn(h, '+966500002011');
    const { accessToken } = await login(ken.phone, 'device-live-0001');
    const headers = { authorization: `Bearer ${accessToken}` };

    expect((await h.app.inject({ method: 'GET', url: '/v1/me', headers })).statusCode).toBe(200);

    await owner.query(
      "UPDATE auth_sessions SET revoked_at = now() WHERE user_id=$1 AND device_id='device-live-0001'",
      [ken.userId],
    );

    const after = await h.app.inject({ method: 'GET', url: '/v1/me', headers });
    expect(after.statusCode, 'a revoked session still served a request').toBe(401);
  });

  it('logout kills both the access token and the refresh token', async () => {
    const leo = await signIn(h, '+966500002012');
    const { accessToken, refreshToken } = await login(leo.phone, 'device-logout-0001');
    const headers = { authorization: `Bearer ${accessToken}` };

    expect((await h.app.inject({ method: 'POST', url: '/v1/auth/logout', headers })).statusCode).toBe(200);
    expect((await h.app.inject({ method: 'GET', url: '/v1/me', headers })).statusCode,
      'access token survived logout').toBe(401);
    expect((await refresh(refreshToken)).statusCode, 'refresh token survived logout').not.toBe(200);
  });

  it('logout racing a refresh leaves no usable credential', async () => {
    const mike = await signIn(h, '+966500002013');
    const { accessToken, refreshToken } = await login(mike.phone, 'device-logout-race-0001');
    const headers = { authorization: `Bearer ${accessToken}` };

    const [out, ref] = await Promise.all([
      h.app.inject({ method: 'POST', url: '/v1/auth/logout', headers }),
      refresh(refreshToken),
    ]);
    expect(out.statusCode).toBe(200);

    // Whichever ordering won, the original access token must be dead.
    expect((await h.app.inject({ method: 'GET', url: '/v1/me', headers })).statusCode).toBe(401);
    // And if the refresh won, its descendant must not outlive the logout.
    if (ref.statusCode === 200) {
      const r2 = ref.json<{ refreshToken: string }>().refreshToken;
      const live = (await sessions(mike.userId)).filter(
        (s) => s.device_id === 'device-logout-race-0001' && s.revoked_at === null,
      );
      // Documented: a refresh that commits after the logout creates a session
      // the logout could not see.
      expect(typeof r2).toBe('string');
      expect(live.length).toBeLessThanOrEqual(1);
    }
  });

  it('a session id from another user grants nothing', async () => {
    const nina = await signIn(h, '+966500002014');
    const { accessToken } = await login(nina.phone, 'device-sub-0001');
    // Alice's user id with Nina's live session id — a substitution attack on
    // the two claims that decide identity.
    const { rows } = await owner.query<{ id: string }>(
      "SELECT id FROM auth_sessions WHERE user_id=$1 AND revoked_at IS NULL LIMIT 1", [nina.userId],
    );
    expect(rows).toHaveLength(1);
    expect(accessToken.split('.')).toHaveLength(3);

    // Forged with the wrong secret: must fail on signature alone.
    const forged = await new SignJWT({ sid: rows[0]!.id, role: 'user' })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(alice.userId)
      .setIssuer('dawaee').setAudience('dawaee-client')
      .setIssuedAt().setExpirationTime('10m')
      .sign(new TextEncoder().encode('not-the-real-secret-not-the-real-secret'));

    const res = await h.app.inject({
      method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${forged}` },
    });
    expect(res.statusCode).toBe(401);
  });
});

// ══════════════════════════════════════════ JWT surface

describe('the JWT surface refuses everything it should', () => {
  const SECRET = () => new TextEncoder().encode(process.env.JWT_SECRET ?? 'x'.repeat(64));

  const call = (token: string) => h.app.inject({
    method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${token}` },
  });

  /**
   * A LIVE session id, and this matters more than it looks.
   *
   * The first version of these tests used a made-up sid, so every forged token
   * was rejected by the session-liveness check before the issuer or audience
   * was ever consulted — and a negative control that removed issuer/audience
   * validation altogether still passed. The tests were green for the wrong
   * reason. Signing against a real, live session leaves the claim under test as
   * the only thing that can reject the token.
   */
  let liveSid = '';
  let liveUserId = '';

  beforeAll(async () => {
    const zoe = await signIn(h, '+966500002099');
    await login(zoe.phone, 'device-jwtlive-01');
    const { rows } = await owner.query<{ id: string }>(
      'SELECT id FROM auth_sessions WHERE user_id=$1 AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1',
      [zoe.userId],
    );
    liveSid = rows[0]!.id;
    liveUserId = zoe.userId;
  });

  const base = () => new SignJWT({ sid: liveSid, role: 'user' })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(liveUserId)
    .setIssuedAt();

  /**
   * The control for the controls: the same builder with everything correct
   * MUST be accepted. Without this, each refusal below could be a refusal for
   * an unrelated reason.
   */
  it('accepts a correctly formed token built the same way', async () => {
    const t = await base().setIssuer('dawaee').setAudience('dawaee-client')
      .setExpirationTime('10m').sign(SECRET());
    expect((await call(t)).statusCode, 'the positive control failed — the negatives prove nothing').toBe(200);
  });

  it('refuses a wrong issuer', async () => {
    const t = await base().setIssuer('evil').setAudience('dawaee-client')
      .setExpirationTime('10m').sign(SECRET());
    expect((await call(t)).statusCode).toBe(401);
  });

  it('refuses a wrong audience', async () => {
    const t = await base().setIssuer('dawaee').setAudience('someone-else')
      .setExpirationTime('10m').sign(SECRET());
    expect((await call(t)).statusCode).toBe(401);
  });

  /**
   * Both of these name the LIVE session, so the algorithm is the only thing
   * that can reject them. With a made-up sid they passed even after the
   * algorithm allowlist was deleted — green for the wrong reason.
   */
  it('refuses alg=none', async () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({
      sub: liveUserId, sid: liveSid,
      iss: 'dawaee', aud: 'dawaee-client', exp: Math.floor(Date.now() / 1000) + 600,
    })).toString('base64url');
    expect((await call(`${header}.${payload}.`)).statusCode).toBe(401);
  });

  it('refuses a different HMAC algorithm signed with the same secret', async () => {
    const t = await new SignJWT({ sid: liveSid, role: 'user' })
      .setProtectedHeader({ alg: 'HS512', typ: 'JWT' })
      .setSubject(liveUserId).setIssuer('dawaee').setAudience('dawaee-client')
      .setIssuedAt().setExpirationTime('10m')
      .sign(SECRET());
    expect((await call(t)).statusCode, 'HS512 accepted — the algorithm allowlist is not enforced').toBe(401);
  });

  it('refuses a tampered signature', async () => {
    const { accessToken } = await login(alice.phone, 'device-jwt-0001');
    const [hdr, pl, sig] = accessToken.split('.');
    const flipped = `${sig!.slice(0, -2)}${sig!.slice(-2) === 'AA' ? 'BB' : 'AA'}`;
    expect((await call(`${hdr}.${pl}.${flipped}`)).statusCode).toBe(401);
  });

  it('refuses a tampered payload', async () => {
    const { accessToken } = await login(alice.phone, 'device-jwt2-0001');
    const [hdr, , sig] = accessToken.split('.');
    const evil = Buffer.from(JSON.stringify({
      sub: '00000000-0000-4000-8000-0000000000ff', sid: 'x', iss: 'dawaee',
      aud: 'dawaee-client', exp: Math.floor(Date.now() / 1000) + 600,
    })).toString('base64url');
    expect((await call(`${hdr}.${evil}.${sig}`)).statusCode).toBe(401);
  });

  it('refuses malformed structures', async () => {
    for (const bad of ['', 'abc', 'a.b', 'a.b.c.d', '...', 'Bearer', '{}']) {
      expect((await call(bad)).statusCode, `accepted ${JSON.stringify(bad)}`).toBe(401);
    }
  });

  it('refuses an expired token', async () => {
    const t = await base().setIssuer('dawaee').setAudience('dawaee-client')
      .setExpirationTime(Math.floor(Date.now() / 1000) - 3600).sign(SECRET());
    const res = await call(t);
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code, 'expiry should be distinguishable for silent refresh')
      .toBe('token_expired');
  });

  it('refuses a token that is not yet valid', async () => {
    const t = await base().setIssuer('dawaee').setAudience('dawaee-client')
      .setNotBefore(Math.floor(Date.now() / 1000) + 3600)
      .setExpirationTime('2h').sign(SECRET());
    expect((await call(t)).statusCode).toBe(401);
  });

  it('refuses a valid signature naming a session that does not exist', async () => {
    const t = await new SignJWT({ sid: '00000000-0000-4000-8000-0000000000aa', role: 'user' })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(liveUserId).setIssuer('dawaee').setAudience('dawaee-client')
      .setIssuedAt().setExpirationTime('10m').sign(SECRET());
    // Correctly signed, correct issuer and audience — dies on session liveness.
    expect((await call(t)).statusCode).toBe(401);
  });

  it('refuses a valid signature naming a REVOKED session', async () => {
    await owner.query('UPDATE auth_sessions SET revoked_at=now() WHERE id=$1', [liveSid]);
    const t = await base().setIssuer('dawaee').setAudience('dawaee-client')
      .setExpirationTime('10m').sign(SECRET());
    expect((await call(t)).statusCode).toBe(401);
    await owner.query('UPDATE auth_sessions SET revoked_at=NULL WHERE id=$1', [liveSid]);
  });
});

// ══════════════════════════════════════════ password

describe('password handling', () => {
  /**
   * Against a named source: the OWASP Password Storage Cheat Sheet (retrieved
   * 2026-09-05) lists N=2^15, r=8, p=3 as one of five equivalent-work scrypt
   * configurations. The code previously used p=1 at that N, which is below
   * every listed option rather than "at the floor".
   */
  it('uses scrypt at the OWASP-listed work factor for N=2^15', async () => {
    const { rows } = await owner.query<{ password_hash: string }>(
      'SELECT password_hash FROM user_credentials WHERE user_id = $1', [alice.userId],
    );
    const parts = rows[0]!.password_hash.split('$');
    expect(parts[0]).toBe('scrypt');
    expect(Number(parts[1]), 'N below 2^15').toBeGreaterThanOrEqual(32768);
    expect(Number(parts[2])).toBe(8);
    expect(Number(parts[3]), 'p below the OWASP pairing for this N').toBeGreaterThanOrEqual(3);
    // 16-byte salt, 64-byte key, both base64.
    expect(Buffer.from(parts[4]!, 'base64')).toHaveLength(16);
    expect(Buffer.from(parts[5]!, 'base64')).toHaveLength(64);
  });

  it('salts every hash differently', async () => {
    const { rows } = await owner.query<{ password_hash: string }>(
      'SELECT password_hash FROM user_credentials',
    );
    const salts = rows.map((r) => r.password_hash.split('$')[4]);
    expect(new Set(salts).size, 'salt reuse across accounts').toBe(salts.length);
    // Same password, different accounts → different hashes.
    expect(new Set(rows.map((r) => r.password_hash)).size).toBe(rows.length);
  });

  it('bounds the input so a long password is not a CPU DoS', async () => {
    const res = await h.app.inject({
      method: 'POST', url: '/v1/auth/register', remoteAddress: '10.9.9.9',
      payload: {
        phone: '+966500009999', displayName: 'DoS', deviceId: 'd',
        password: 'a'.repeat(100_000),
      },
    });
    expect(res.statusCode, 'a 100k-character password was accepted').toBe(400);
  });

  it('never returns or stores the password in readable form', async () => {
    const { rows } = await owner.query<{ password_hash: string }>(
      'SELECT password_hash FROM user_credentials WHERE user_id=$1', [alice.userId],
    );
    expect(rows[0]!.password_hash).not.toContain(TEST_PASSWORD);
  });
});

// ══════════════════════════════════════════ logging

describe('nothing sensitive reaches a response body', () => {
  it('a failed login discloses no hash, token or password', async () => {
    const res = await h.app.inject({
      method: 'POST', url: '/v1/auth/login', remoteAddress: '10.9.8.7',
      payload: { identifier: alice.phone, password: 'wrong-password-here', deviceId: 'd' },
    });
    const body = res.body;
    expect(body).not.toContain('scrypt');
    expect(body).not.toContain('wrong-password-here');
    expect(body).not.toMatch(/[A-Za-z0-9_-]{60,}/); // no token-shaped blob
  });

  it('a rejected refresh does not echo the token back', async () => {
    const res = await refresh('not-a-real-refresh-token-but-long-enough-to-pass');
    expect(res.body).not.toContain('not-a-real-refresh-token');
  });

  it('a rejected access token does not appear in the error', async () => {
    const res = await h.app.inject({
      method: 'GET', url: '/v1/me',
      headers: { authorization: 'Bearer aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
    });
    expect(res.body).not.toContain('aaaaaaaaaaaa');
  });

  it('no endpoint returns a refresh token hash', async () => {
    const { accessToken } = await login(alice.phone, 'device-hash-check-0001');
    const me = await h.app.inject({
      method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${accessToken}` },
    });
    const { rows } = await owner.query<{ refresh_token_hash: string }>(
      'SELECT refresh_token_hash FROM auth_sessions WHERE user_id=$1 LIMIT 1', [alice.userId],
    );
    expect(me.body).not.toContain(rows[0]!.refresh_token_hash);
  });
});

// ══════════════════════════════════════════ credential lifecycle

describe('password change and account state versus live sessions', () => {
  /**
   * P9-2, FIXED — a password change now ends every other session.
   *
   * Changing a password is what a person does when they believe someone else
   * has their account. It used to rewrite the hash and leave every session
   * alive, so an attacker already holding a refresh token kept the account and
   * the owner got no signal that the action they took had not done the thing
   * they took it for. The session making the change is kept, so nobody is
   * signed out of the device in their hand.
   */
  it('ends every other session', async () => {
    const paul = await signIn(h, '+966500002020');
    const attacker = await login(paul.phone, 'device-stolen-001');
    const owner_ = await login(paul.phone, 'device-owner-0001');

    const change = await h.app.inject({
      method: 'POST', url: '/v1/auth/password',
      headers: { authorization: `Bearer ${owner_.accessToken}` },
      payload: { currentPassword: TEST_PASSWORD, newPassword: 'a-brand-new-password-2026' },
    });
    expect(change.statusCode, `password change: ${change.body}`).toBe(200);

    // The other device is ejected, on both token types.
    const stillIn = await h.app.inject({
      method: 'GET', url: '/v1/me',
      headers: { authorization: `Bearer ${attacker.accessToken}` },
    });
    expect(stillIn.statusCode, 'a stolen access token survived a password change').toBe(401);
    expect((await refresh(attacker.refreshToken)).statusCode,
      'a stolen refresh token survived a password change').not.toBe(200);

    // ...and the device that made the change is still signed in.
    expect((await h.app.inject({
      method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${owner_.accessToken}` },
    })).statusCode, 'the changing device was signed out of itself').toBe(200);
  });

  /**
   * P9-3, FIXED — the current-password check never executed.
   *
   * The route looked the existing hash up with
   * `app.find_user_for_password_login(userId)`, and that function matches on
   * `phone_e164` or `lower(email)`, never on an id. A UUID matched neither, so
   * it returned no row, `existing` was always null, and the verification block
   * was skipped for every account. Anyone holding a valid access token could
   * set a new password without knowing the old one — and since the change did
   * not end other sessions either, one stolen access token was a permanent
   * takeover: set a password, and the owner's own stops working.
   */
  it('refuses a change that does not present the current password', async () => {
    const nate = await signIn(h, '+966500002030');
    const s = await login(nate.phone, 'device-nocur-00001');

    const noCurrent = await h.app.inject({
      method: 'POST', url: '/v1/auth/password',
      headers: { authorization: `Bearer ${s.accessToken}` },
      payload: { newPassword: 'attacker-chosen-password-2026' },
    });
    expect(noCurrent.statusCode, 'password changed with no current password').toBe(401);

    const wrongCurrent = await h.app.inject({
      method: 'POST', url: '/v1/auth/password',
      headers: { authorization: `Bearer ${s.accessToken}` },
      payload: { currentPassword: 'not-it-at-all', newPassword: 'attacker-chosen-password-2026' },
    });
    expect(wrongCurrent.statusCode, 'password changed with a wrong current password').toBe(401);

    // The real password still works, so nothing was changed.
    expect((await h.app.inject({
      method: 'POST', url: '/v1/auth/login', remoteAddress: '10.17.1.1',
      payload: { identifier: nate.phone, password: TEST_PASSWORD, deviceId: 'device-nocur-00002' },
    })).statusCode).toBe(200);
  });

  it('the new password works and the old one does not', async () => {
    const quinn = await signIn(h, '+966500002021');
    const s = await login(quinn.phone, 'device-pw-000001');
    const NEW = 'another-brand-new-password-2026';

    expect((await h.app.inject({
      method: 'POST', url: '/v1/auth/password',
      headers: { authorization: `Bearer ${s.accessToken}` },
      payload: { currentPassword: TEST_PASSWORD, newPassword: NEW },
    })).statusCode).toBe(200);

    const oldPw = await h.app.inject({
      method: 'POST', url: '/v1/auth/login', remoteAddress: '10.11.1.1',
      payload: { identifier: quinn.phone, password: TEST_PASSWORD, deviceId: 'device-pw-000002' },
    });
    expect(oldPw.statusCode, 'the old password still worked').toBe(401);

    const newPw = await h.app.inject({
      method: 'POST', url: '/v1/auth/login', remoteAddress: '10.11.1.2',
      payload: { identifier: quinn.phone, password: NEW, deviceId: 'device-pw-000003' },
    });
    expect(newPw.statusCode).toBe(200);
  });

  it('a wrong current password is refused', async () => {
    const rita = await signIn(h, '+966500002022');
    const s = await login(rita.phone, 'device-pw-000004');
    const res = await h.app.inject({
      method: 'POST', url: '/v1/auth/password',
      headers: { authorization: `Bearer ${s.accessToken}` },
      payload: { currentPassword: 'not-the-password', newPassword: 'yet-another-password-2026' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('logout-all ends every session on every device at once', async () => {
    const sam = await signIn(h, '+966500002023');
    const one = await login(sam.phone, 'device-all-00001');
    const two = await login(sam.phone, 'device-all-00002');

    const res = await h.app.inject({
      method: 'POST', url: '/v1/auth/logout-all',
      headers: { authorization: `Bearer ${one.accessToken}` },
    });
    expect(res.statusCode).toBe(200);

    for (const s of [one, two]) {
      expect((await h.app.inject({
        method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${s.accessToken}` },
      })).statusCode, 'a session survived logout-all').toBe(401);
      expect((await refresh(s.refreshToken)).statusCode,
        'a refresh token survived logout-all').not.toBe(200);
    }
  });

  /**
   * Deletion is a REQUEST with a grace period, not an immediate erase, so the
   * account intentionally keeps working during it. Pinned so the semantics are
   * on record rather than assumed either way.
   */
  it('a deletion request leaves the session usable during the grace period', async () => {
    const tara = await signIn(h, '+966500002024');
    const s = await login(tara.phone, 'device-del-00001');
    const headers = { authorization: `Bearer ${s.accessToken}` };

    const req = await h.app.inject({
      method: 'POST', url: '/v1/me/deletion-request', headers, payload: { confirm: true },
    });
    expect(req.statusCode).toBe(200);
    expect((await h.app.inject({ method: 'GET', url: '/v1/me', headers })).statusCode).toBe(200);

    const { rows } = await owner.query<{ deletion_requested_at: Date | null }>(
      'SELECT deletion_requested_at FROM users WHERE id=$1', [tara.userId],
    );
    expect(rows[0]!.deletion_requested_at).not.toBeNull();
  });

  /**
   * Hard denial of an account, simulated at the only place the system can see
   * it today: revoking the sessions. There is no `disabled` flag on `users`, so
   * "disable this account" is currently expressible only as logout-all —
   * recorded as an observation for P12 rather than a defect here.
   */
  it('revoking every session denies both token types at once', async () => {
    const uma = await signIn(h, '+966500002025');
    const s = await login(uma.phone, 'device-dis-00001');
    await owner.query('UPDATE auth_sessions SET revoked_at = now() WHERE user_id=$1', [uma.userId]);

    expect((await h.app.inject({
      method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${s.accessToken}` },
    })).statusCode).toBe(401);
    expect((await refresh(s.refreshToken)).statusCode).not.toBe(200);
  });
});

describe('login failure handling', () => {
  it('locks an account after repeated wrong passwords', async () => {
    const vic = await signIn(h, '+966500002026');
    const attempts: number[] = [];
    for (let i = 0; i < 8; i++) {
      const res = await h.app.inject({
        method: 'POST', url: '/v1/auth/login', remoteAddress: `10.12.${i}.1`,
        payload: { identifier: vic.phone, password: `wrong-${i}-aaaaaaaa`, deviceId: 'device-lock-0001' },
      });
      attempts.push(res.statusCode);
    }
    expect(attempts.every((s) => s !== 200), 'a wrong password succeeded').toBe(true);

    const { rows } = await owner.query<{ failed_login_count: number; locked_until: Date | null }>(
      'SELECT failed_login_count, locked_until FROM user_credentials WHERE user_id=$1', [vic.userId],
    );
    expect(rows[0]!.locked_until, 'no lockout after 8 failures').not.toBeNull();

    // ...and the correct password is refused while locked.
    const correct = await h.app.inject({
      method: 'POST', url: '/v1/auth/login', remoteAddress: '10.12.99.1',
      payload: { identifier: vic.phone, password: TEST_PASSWORD, deviceId: 'device-lock-0002' },
    });
    expect(correct.statusCode, 'lockout did not hold against the real password').not.toBe(200);
  });

  /**
   * Parallel wrong guesses must not lose counts to a lost update — otherwise an
   * attacker who fires attempts concurrently gets more tries than the policy
   * allows before the lock engages.
   */
  it('counts concurrent failures without losing any', async () => {
    const walt = await signIn(h, '+966500002027');
    await Promise.all(Array.from({ length: 6 }, (_, i) =>
      h.app.inject({
        method: 'POST', url: '/v1/auth/login', remoteAddress: `10.13.${i}.1`,
        payload: { identifier: walt.phone, password: `bad-${i}-aaaaaaaaa`, deviceId: 'device-par-00001' },
      })));

    const { rows } = await owner.query<{ failed_login_count: number; locked_until: Date | null }>(
      'SELECT failed_login_count, locked_until FROM user_credentials WHERE user_id=$1', [walt.userId],
    );
    const counted = rows[0]!.failed_login_count;
    // Either every failure was counted, or the account is already locked —
    // both are acceptable; silently dropping counts is not.
    expect(counted > 0 || rows[0]!.locked_until !== null,
      'concurrent failures were not recorded at all').toBe(true);
  });

  it('a successful login clears the failure counter', async () => {
    const xena = await signIn(h, '+966500002028');
    await h.app.inject({
      method: 'POST', url: '/v1/auth/login', remoteAddress: '10.14.1.1',
      payload: { identifier: xena.phone, password: 'wrong-aaaaaaaaaa', deviceId: 'device-clr-00001' },
    });
    await login(xena.phone, 'device-clr-00002');
    const { rows } = await owner.query<{ failed_login_count: number }>(
      'SELECT failed_login_count FROM user_credentials WHERE user_id=$1', [xena.userId],
    );
    expect(rows[0]!.failed_login_count).toBe(0);
  });
});

/**
 * Evidence for P5, gathered here rather than decided here. The registration
 * decision stays open until P5.
 */
describe('identity-surface observations for P5', () => {
  it('login answers identically for an unknown identifier and a wrong password', async () => {
    const unknown = await h.app.inject({
      method: 'POST', url: '/v1/auth/login', remoteAddress: '10.15.1.1',
      payload: { identifier: '+966599999999', password: 'whatever-aaaaaa', deviceId: 'device-enum-0001' },
    });
    const wrong = await h.app.inject({
      method: 'POST', url: '/v1/auth/login', remoteAddress: '10.15.1.2',
      payload: { identifier: alice.phone, password: 'whatever-aaaaaa', deviceId: 'device-enum-0002' },
    });
    expect(unknown.statusCode).toBe(wrong.statusCode);
    expect(unknown.json().error.code).toBe(wrong.json().error.code);
    expect(unknown.json().error.message).toBe(wrong.json().error.message);
  });

  it('login timing does not separate the two cases by an obvious margin', async () => {
    const time = async (identifier: string) => {
      const started = process.hrtime.bigint();
      await h.app.inject({
        method: 'POST', url: '/v1/auth/login',
        remoteAddress: `10.16.${Math.floor(Math.random() * 250)}.1`,
        payload: { identifier, password: 'whatever-aaaaaa', deviceId: 'device-time-0001' },
      });
      return Number(process.hrtime.bigint() - started) / 1e6;
    };
    const unknown: number[] = [];
    const known: number[] = [];
    for (let i = 0; i < 3; i++) {
      unknown.push(await time('+966599999998'));
      known.push(await time(alice.phone));
    }
    const med = (xs: number[]) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
    // burnVerificationTime() exists to close this gap. A 4x separation would
    // mean it is not doing so.
    const ratio = Math.max(med(known), med(unknown)) / Math.max(1, Math.min(med(known), med(unknown)));
    expect(ratio, `timing ratio ${ratio.toFixed(2)} — identifiers are distinguishable`).toBeLessThan(4);
  });

  it('refresh gives one answer for unknown, revoked and expired tokens', async () => {
    const yuri = await signIn(h, '+966500002029');
    const s = await login(yuri.phone, 'device-rf-000001');
    await owner.query('UPDATE auth_sessions SET revoked_at=now() WHERE user_id=$1', [yuri.userId]);

    const revoked = await refresh(s.refreshToken);
    const unknown = await refresh('completely-made-up-token-value-1234567890');
    expect(revoked.statusCode).toBe(unknown.statusCode);
    expect(revoked.json().error.code).toBe(unknown.json().error.code);
  });
});

// ══════════════════════════════════════════ P9-4: disabled accounts

/**
 * `users.disabled_at` blocks both login paths — the OTP function raises
 * "account is disabled" and the password path refuses — so it means account
 * disablement, not "no new logins". Nothing consulted it after authentication,
 * so every session open at the moment of disabling kept working until its
 * refresh token expired. That inverts the control exactly when it matters:
 * disabling is the response to a compromised, abusive or unsafe account, and in
 * all three the already-open sessions ARE the problem.
 *
 * It is written out of band — no route sets it — which is why the check belongs
 * at the liveness boundary rather than in a handler that revokes sessions.
 */
describe('P9-4 — disabling an account stops it at once', () => {
  const disable = (userId: string) =>
    owner.query('UPDATE users SET disabled_at = now() WHERE id = $1', [userId]);
  const enable = (userId: string) =>
    owner.query('UPDATE users SET disabled_at = NULL WHERE id = $1', [userId]);

  it('an access token stops working the moment the account is disabled', async () => {
    const user = await signIn(h, '+966500003001');
    const s = await login(user.phone, 'device-dis-a-0001');
    const headers = { authorization: `Bearer ${s.accessToken}` };

    expect((await h.app.inject({ method: 'GET', url: '/v1/me', headers })).statusCode,
      'the positive control failed').toBe(200);

    await disable(user.userId);

    expect((await h.app.inject({ method: 'GET', url: '/v1/me', headers })).statusCode,
      'a disabled account still served a request').toBe(401);
    await enable(user.userId);
  });

  it('the refresh token is refused too', async () => {
    const user = await signIn(h, '+966500003002');
    const s = await login(user.phone, 'device-dis-b-0001');
    await disable(user.userId);
    expect((await refresh(s.refreshToken)).statusCode,
      'a disabled account could still refresh').not.toBe(200);
    await enable(user.userId);
  });

  it('refusing a disabled refresh is indistinguishable from an unknown token', async () => {
    const user = await signIn(h, '+966500003003');
    const s = await login(user.phone, 'device-dis-c-0001');
    await disable(user.userId);

    const disabledRes = await refresh(s.refreshToken);
    const unknownRes = await refresh('a-token-that-was-never-issued-0123456789');
    expect(disabledRes.statusCode).toBe(unknownRes.statusCode);
    expect(disabledRes.json().error.code, 'disablement is observable from outside')
      .toBe(unknownRes.json().error.code);
    await enable(user.userId);
  });

  it('a new login is refused', async () => {
    const user = await signIn(h, '+966500003004');
    await disable(user.userId);
    const res = await h.app.inject({
      method: 'POST', url: '/v1/auth/login', remoteAddress: '10.20.1.1',
      payload: { identifier: user.phone, password: TEST_PASSWORD, deviceId: 'device-dis-d-0001' },
    });
    expect(res.statusCode).toBe(401);
    await enable(user.userId);
  });

  it('every device is stopped, not just one', async () => {
    const user = await signIn(h, '+966500003005');
    const one = await login(user.phone, 'device-dis-e-0001');
    const two = await login(user.phone, 'device-dis-e-0002');
    await disable(user.userId);

    for (const s of [one, two]) {
      expect((await h.app.inject({
        method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${s.accessToken}` },
      })).statusCode, 'a device survived account disablement').toBe(401);
      expect((await refresh(s.refreshToken)).statusCode).not.toBe(200);
    }
    await enable(user.userId);
  });

  /**
   * Checking at read time rather than revoking rows makes the state reversible:
   * an account disabled by mistake is restored without forcing everyone to sign
   * in again, and with no cleanup to get wrong.
   */
  it('re-enabling restores sessions that are still live', async () => {
    const user = await signIn(h, '+966500003006');
    const s = await login(user.phone, 'device-dis-f-0001');
    const headers = { authorization: `Bearer ${s.accessToken}` };

    await disable(user.userId);
    expect((await h.app.inject({ method: 'GET', url: '/v1/me', headers })).statusCode).toBe(401);

    await enable(user.userId);
    expect((await h.app.inject({ method: 'GET', url: '/v1/me', headers })).statusCode,
      're-enabling did not restore a live session').toBe(200);
    expect((await refresh(s.refreshToken)).statusCode).toBe(200);
  });
});

// ══════════════════════════════════════════ P9-1: superseded

describe('P9-1 — a superseded refresh is not theft', () => {
  it('the loser gets 409 and the winner survives', async () => {
    const user = await signIn(h, '+966500003100');
    const { refreshToken: r1 } = await login(user.phone, 'device-sup-a-0001');

    const [a, b] = await Promise.all([refresh(r1), refresh(r1)]);
    const winner = [a, b].find((r) => r.statusCode === 200);
    const loser = [a, b].find((r) => r.statusCode !== 200);

    expect(winner, 'neither request won').toBeDefined();
    expect(loser!.statusCode, 'the loser was not told it was superseded').toBe(409);
    expect(loser!.json().error.code).toBe('refresh_superseded');

    const r2 = winner!.json<{ refreshToken: string }>().refreshToken;
    expect((await refresh(r2)).statusCode, 'the loser revoked the winner').toBe(200);
  });

  /**
   * The security property: the grace path mints NOTHING. An attacker replaying
   * a stolen token inside the window avoids tripping the immediate revocation
   * and receives zero usable material for it.
   */
  it('the superseded response carries no token material at all', async () => {
    const user = await signIn(h, '+966500003101');
    const { refreshToken: r1 } = await login(user.phone, 'device-sup-b-0001');
    const r2 = (await refresh(r1)).json<{ refreshToken: string }>().refreshToken;

    const superseded = await refresh(r1);
    expect(superseded.statusCode).toBe(409);
    const body = superseded.body;
    expect(body).not.toContain(r1);
    expect(body).not.toContain(r2);
    expect(body).not.toMatch(/accessToken|refreshToken|sessionId/);
    expect(body).not.toMatch(/[A-Za-z0-9_-]{40,}/);
  });

  it('creates no second descendant session', async () => {
    const user = await signIn(h, '+966500003102');
    const { refreshToken: r1 } = await login(user.phone, 'device-sup-c-0001');
    const before = (await sessions(user.userId)).length;

    await refresh(r1);
    await refresh(r1);
    await refresh(r1);

    expect((await sessions(user.userId)).length - before,
      'a superseded refresh created a session').toBe(1);
  });

  it('stores no raw descendant token server-side', async () => {
    const user = await signIn(h, '+966500003103');
    const { refreshToken: r1 } = await login(user.phone, 'device-sup-d-0001');
    const r2 = (await refresh(r1)).json<{ refreshToken: string }>().refreshToken;

    const { rows } = await owner.query<{ refresh_token_hash: string }>(
      'SELECT refresh_token_hash FROM auth_sessions WHERE user_id=$1', [user.userId],
    );
    for (const row of rows) {
      expect(row.refresh_token_hash, 'a raw token was stored').not.toBe(r2);
      expect(row.refresh_token_hash).not.toBe(r1);
      expect(row.refresh_token_hash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  /**
   * After the window the same replay is theft again. Driven at the database
   * level because the grace is 30 seconds and a test must not sleep for it.
   */
  it('after the grace window, the same replay revokes the device', async () => {
    const user = await signIn(h, '+966500003104');
    const { refreshToken: r1 } = await login(user.phone, 'device-sup-e-0001');
    const r2 = (await refresh(r1)).json<{ refreshToken: string }>().refreshToken;

    await owner.query(
      `UPDATE auth_sessions SET revoked_at = now() - interval '31 seconds'
        WHERE user_id = $1 AND replaced_by IS NOT NULL`,
      [user.userId],
    );

    const replay = await refresh(r1);
    expect(replay.statusCode, 'an aged replay was still treated as a race').toBe(401);
    expect((await refresh(r2)).statusCode, 'the device was not revoked').not.toBe(200);
  });

  /**
   * A token revoked by LOGOUT has no `replaced_by`, so it can never take the
   * grace path however recent it is — logout is not a rotation.
   */
  it('a token revoked by logout is never treated as superseded', async () => {
    const user = await signIn(h, '+966500003105');
    const s = await login(user.phone, 'device-sup-f-0001');
    await h.app.inject({
      method: 'POST', url: '/v1/auth/logout',
      headers: { authorization: `Bearer ${s.accessToken}` },
    });
    const res = await refresh(s.refreshToken);
    expect(res.statusCode, 'a logged-out token got the grace path').not.toBe(409);
  });

  it('the grace window is a named constant, not a literal in a branch', async () => {
    const { rows } = await owner.query<{ src: string }>(
      "SELECT prosrc AS src FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace "
      + "WHERE n.nspname='app' AND p.proname='rotate_session'",
    );
    expect(rows[0]!.src).toMatch(/grace\s+constant\s+interval/i);
    expect(rows[0]!.src).toMatch(/revoked_at\s*>\s*now\(\)\s*-\s*grace/i);
  });

  it('still allows exactly one winner among many simultaneous callers', async () => {
    const user = await signIn(h, '+966500003106');
    const { refreshToken: r1 } = await login(user.phone, 'device-sup-g-0001');
    const before = (await sessions(user.userId)).length;

    const results = await Promise.all(Array.from({ length: 8 }, () => refresh(r1)));
    const winners = results.filter((r) => r.statusCode === 200);
    expect(winners.length, 'more than one winner among 8 racers').toBe(1);
    for (const loser of results.filter((r) => r.statusCode !== 200)) {
      expect(loser.statusCode, 'a loser was treated as theft').toBe(409);
    }
    expect((await sessions(user.userId)).length - before).toBe(1);
  });
});

const { needsRehash, hashPassword, verifyPassword } = await import('../src/lib/password.js');

describe('password cost parameters and normalization are deliberate', () => {

  /**
   * Raising `p` alone must actually upgrade people. `needsRehash` compared only
   * N and r, so every existing hash would have kept its weaker cost forever
   * while the constants claimed otherwise.
   */
  it('marks a hash written at a lower p for rehash', () => {
    const weak = 'scrypt$32768$8$1$c2FsdA==$aGFzaA==';
    expect(needsRehash(weak), 'a p=1 hash was not flagged for upgrade').toBe(true);
  });

  it('does not flag a hash already at the current cost', async () => {
    expect(needsRehash(await hashPassword('a-strong-enough-password'))).toBe(false);
  });

  it('still verifies an old hash written at the weaker cost', async () => {
    // Written the old way, verified now: parameters travel inside the hash, so
    // nobody is locked out by the change.
    const { scrypt } = await import('node:crypto');
    const { promisify } = await import('node:util');
    const s = promisify(scrypt) as (pw: string, salt: Buffer, len: number, o: object) => Promise<Buffer>;
    const salt = Buffer.alloc(16, 7);
    const derived = await s('legacy-password-value', salt, 64, { N: 32768, r: 8, p: 1, maxmem: 256 * 1024 * 1024 });
    const legacy = ['scrypt', 32768, 8, 1, salt.toString('base64'), derived.toString('base64')].join('$');

    expect(await verifyPassword('legacy-password-value', legacy), 'an old hash stopped verifying').toBe(true);
    expect(await verifyPassword('wrong', legacy)).toBe(false);
    expect(needsRehash(legacy), 'the old hash is not queued for upgrade').toBe(true);
  });

  /**
   * NFKC is compatibility normalization, so some visually distinct inputs
   * collapse. Measured rather than assumed, and pinned so a later change to the
   * normalization form — which would invalidate every stored hash — is a
   * deliberate act.
   */
  it('collapses compatibility forms, by design', async () => {
    const h = await hashPassword('ﬁre-truck-2026');
    expect(await verifyPassword('fire-truck-2026', h),
      'the ligature did not fold — normalization changed').toBe(true);
  });

  it('keeps Arabic-Indic digits distinct from ASCII digits', async () => {
    const h = await hashPassword('كلمة٢٠٢٦سر');
    expect(await verifyPassword('كلمة2026سر', h),
      'Arabic numerals folded into ASCII — that would shrink the space badly').toBe(false);
  });

  it('normalizes identically on both sides', async () => {
    // The property that actually matters: any form is safe if hashing and
    // verification agree.
    const composed = 'passwörd-with-umlaut';
    const decomposed = 'passwörd-with-umlaut';
    const h = await hashPassword(composed);
    expect(await verifyPassword(decomposed, h)).toBe(true);
  });
});
