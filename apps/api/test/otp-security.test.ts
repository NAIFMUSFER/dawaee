import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetDatabase, startHarness, type Harness } from './harness.js';
import { generateOtp, otpVerifier, sha256 } from '../src/lib/crypto.js';

/**
 * One-time codes: what is stored, what can be guessed, and what a code buys.
 *
 * The request route is refused outright in this deployment — there is no SMS or
 * WhatsApp provider to carry a code — so a challenge cannot be created through
 * the API at all. These tests create challenges the way a configured provider
 * path would, by calling `app.issue_otp` directly, because the verification
 * half IS live and the whole path comes back the day a provider is added. Code
 * that only runs later still has to be right now.
 */

let h: Harness;
let owner: pg.Pool;
const PW = 'correct horse battery staple';

let seq = 0;
/** The proxy-appended entry is what the app trusts, so vary the RIGHT side. */
const client = () => ({ 'x-forwarded-for': `10.55.0.1, 198.18.${Math.floor(seq / 250) % 250}.${(seq++ % 250) + 1}` });
let n = 0;
const newPhone = () => `+9665${String(6100000 + n++).padStart(8, '0')}`;

/** Issue a challenge exactly as `issueOtp` would, without a provider. */
const issue = (phone: string, code: string, opts: { ttl?: number; cooldown?: number } = {}) =>
  owner.query<{ outcome: string }>(
    'SELECT * FROM app.issue_otp($1,$2,$3,5,NULL,15,5,$4)',
    [phone, otpVerifier(phone, code), opts.ttl ?? 5, opts.cooldown ?? 0],
  ).then((r) => r.rows[0]!);

const verify = (phone: string, code: string) =>
  h.app.inject({
    method: 'POST', url: '/v1/auth/otp/verify', remoteAddress: '10.55.0.1', headers: client(),
    payload: { phone, code, deviceId: `otp-dev-${seq}-${Date.now() % 100000}` },
  });

/** Resolves once some backend is waiting on a lock, or after a short ceiling. */
async function waitForBlockedQuery(): Promise<void> {
  for (let i = 0; i < 50; i++) {
    const { rows } = await owner.query<{ n: string }>(
      "SELECT count(*) AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock'",
    );
    if (Number(rows[0]!.n) > 0) return;
    await new Promise((r) => setTimeout(r, 20));
  }
}

const shape = (r: { statusCode: number; body: string }) => {
  let code: string | null = null;
  try { code = (JSON.parse(r.body) as { error?: { code?: string } }).error?.code ?? null; } catch { /* success */ }
  return { status: r.statusCode, code };
};

beforeAll(async () => {
  resetDatabase();
  h = await startHarness();
  owner = new pg.Pool({ connectionString: 'postgres://postgres:postgres@127.0.0.1:5433/dawaee_test', max: 8 });
});
afterAll(async () => { await owner.end(); await h.close(); });

// ══════════════════════════════════════ generation

describe('the code itself', () => {
  it('comes from the CSPRNG and is uniform across the digit range', () => {
    const counts = new Map<string, number>();
    for (let i = 0; i < 20_000; i++) {
      const c = generateOtp(6);
      expect(c, 'the code is not six digits').toMatch(/^\d{6}$/);
      for (const d of c) counts.set(d, (counts.get(d) ?? 0) + 1);
    }
    // 120,000 digits over ten values: ~12,000 each. A modulo-biased generator
    // skews the low digits, which this range would catch.
    expect(counts.size).toBe(10);
    for (const [digit, count] of counts) {
      expect(count, `digit ${digit} appeared ${count} times`).toBeGreaterThan(10_500);
      expect(count, `digit ${digit} appeared ${count} times`).toBeLessThan(13_500);
    }
  });

  it('is not derived from Math.random or the clock', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../src/lib/crypto.ts', import.meta.url), 'utf8');
    const body = src.slice(src.indexOf('export function generateOtp'), src.indexOf('export function normalizePhone'));
    expect(body, 'the code generator uses a non-cryptographic source').not.toMatch(/Math\.random|Date\.now|hrtime/);
    expect(body).toMatch(/randomInt/);
  });
});

// ══════════════════════════════════════ stored verifier

/**
 * The point that matters most here: "not stored in plaintext" is not the same
 * as "safe if the database leaks". A six-digit code has a million values, and a
 * fast unkeyed digest of it can be reversed by trying all of them.
 */
describe('what is stored cannot be turned back into a code', () => {
  it('the stored verifier is not the plaintext and not an unkeyed digest of it', async () => {
    const phone = newPhone();
    await issue(phone, '123456');
    const { rows } = await owner.query<{ code_hash: string }>(
      'SELECT code_hash FROM auth_otp_challenges WHERE phone_e164=$1', [phone],
    );
    const stored = rows[0]!.code_hash;
    expect(stored).not.toBe('123456');
    expect(stored, 'the verifier is a plain SHA-256 of the code — reversible in under a second')
      .not.toBe(sha256('123456'));
    expect(stored).toBe(otpVerifier(phone, '123456'));
  });

  it('exhausting every six-digit code against the stored value finds nothing', async () => {
    const phone = newPhone();
    await issue(phone, '246813');
    const { rows } = await owner.query<{ code_hash: string }>(
      'SELECT code_hash FROM auth_otp_challenges WHERE phone_e164=$1', [phone],
    );
    const stored = rows[0]!.code_hash;

    // The whole search space, the way someone holding a stolen backup would.
    let recovered: string | null = null;
    for (let i = 0; i < 1_000_000; i++) {
      if (sha256(String(i).padStart(6, '0')) === stored) { recovered = String(i).padStart(6, '0'); break; }
    }
    expect(recovered, 'the code was recovered from the database row alone').toBeNull();
  });

  it('the same code issued to two people stores two different values', async () => {
    const a = newPhone(); const b = newPhone();
    await issue(a, '135790');
    await issue(b, '135790');
    const { rows } = await owner.query<{ code_hash: string }>(
      'SELECT code_hash FROM auth_otp_challenges WHERE phone_e164 = ANY($1)', [[a, b]],
    );
    expect(rows).toHaveLength(2);
    // Otherwise a reader of the table could group accounts by identical hash,
    // and one recovered plaintext would give away every match for free.
    expect(rows[0]!.code_hash, 'two accounts sharing a code share a stored value')
      .not.toBe(rows[1]!.code_hash);
  });

  it('a code is bound to its phone number and verifies for no other', async () => {
    const a = newPhone(); const b = newPhone();
    await issue(a, '777777');
    expect(shape(await verify(b, '777777'))).toEqual({ status: 401, code: 'otp_invalid' });
    expect((await verify(a, '777777')).statusCode).toBe(200);
  });
});

// ══════════════════════════════════════ single use and counters

describe('a code is spent exactly once', () => {
  it('three simultaneous submissions of the right code produce one session', async () => {
    const phone = newPhone();
    await issue(phone, '333333');
    const results = await Promise.all([verify(phone, '333333'), verify(phone, '333333'), verify(phone, '333333')]);
    const wins = results.filter((r) => r.statusCode === 200);
    expect(wins, `${wins.length} of three concurrent submissions succeeded`).toHaveLength(1);
  });

  /**
   * The same claim, forced at the database rather than left to whatever
   * interleaving the HTTP layer happens to produce. Three requests through
   * `inject` share one event loop and can serialize by accident, which would
   * make the test above pass even with the row lock removed — it did.
   */
  it('two connections presenting the right code at once: exactly one verifies', async () => {
    const phone = newPhone();
    await issue(phone, '353535');
    const race = new pg.Pool({ connectionString: 'postgres://postgres:postgres@127.0.0.1:5433/dawaee_test', max: 2 });
    const a = await race.connect(); const b = await race.connect();
    let outcomes: string[] = [];
    try {
      await a.query('BEGIN'); await b.query('BEGIN');
      // A runs and holds its transaction open, so B blocks on the row lock
      // rather than reading around it.
      const ra = await a.query<{ outcome: string }>('SELECT * FROM app.verify_otp($1,$2)', [phone, otpVerifier(phone, '353535')]);
      const pending = b.query<{ outcome: string }>('SELECT * FROM app.verify_otp($1,$2)', [phone, otpVerifier(phone, '353535')]);
      // B must reach its SELECT while A's transaction is still open — that is
      // the window the row lock closes. Waiting for B to actually block is what
      // makes this reproduce; without the wait, B can start after the COMMIT
      // and the test passes whether the lock is there or not.
      await waitForBlockedQuery();
      await a.query('COMMIT');
      const rb = await pending;
      await b.query('COMMIT');
      outcomes = [ra.rows[0]!.outcome, rb.rows[0]!.outcome];
    } finally { a.release(); b.release(); await race.end(); }
    expect(outcomes.filter((o) => o === 'verified'),
      `both connections consumed the same code: ${outcomes.join(',')}`).toHaveLength(1);
  });

  it('a consumed code is refused, and says only that it is wrong', async () => {
    const phone = newPhone();
    await issue(phone, '444444');
    expect((await verify(phone, '444444')).statusCode).toBe(200);
    expect(shape(await verify(phone, '444444'))).toEqual({ status: 401, code: 'otp_invalid' });
  });

  it('an expired code is refused even when correct', async () => {
    const phone = newPhone();
    await issue(phone, '555555');
    await owner.query("UPDATE auth_otp_challenges SET expires_at = now() - interval '1 minute' WHERE phone_e164=$1", [phone]);
    expect(shape(await verify(phone, '555555'))).toEqual({ status: 401, code: 'otp_expired' });
  });

  it('concurrent wrong guesses all count — none is lost to a race', async () => {
    const phone = newPhone();
    await issue(phone, '666666');
    // Separate connections, so the increments genuinely contend. Five guesses
    // recorded as one would multiply the guessing budget by however many
    // requests an attacker can put in flight at once.
    //
    // What protects this is the UPDATE itself — `attempts = attempts + 1`
    // re-reads the row under the lock the UPDATE takes, so no increment can be
    // lost. Not the SELECT's FOR UPDATE: removing that leaves this test passing
    // (verified), because the two guard different things. FOR UPDATE guards the
    // decision to CONSUME a code; this guards the count.
    const conns = await Promise.all(Array.from({ length: 5 }, () => owner.connect()));
    try {
      await Promise.all(conns.map((c, i) =>
        c.query('SELECT * FROM app.verify_otp($1,$2)', [phone, otpVerifier(phone, `9999${String(i).padStart(2, '0')}`)])));
    } finally { for (const c of conns) c.release(); }
    const { rows } = await owner.query<{ attempts: number }>(
      'SELECT attempts FROM auth_otp_challenges WHERE phone_e164=$1 ORDER BY created_at DESC LIMIT 1', [phone],
    );
    expect(rows[0]!.attempts, 'attempts were lost to concurrent updates').toBe(5);
  });

  it('the attempt limit closes the challenge', async () => {
    const phone = newPhone();
    await issue(phone, '888888');
    for (let i = 0; i < 5; i++) await verify(phone, `1111${String(i).padStart(2, '0')}`);
    // Even the right code is now refused: the challenge is spent.
    expect((await verify(phone, '888888')).statusCode).not.toBe(200);
  });
});

// ══════════════════════════════════════ one live challenge

describe('only the newest code is live', () => {
  it('issuing again retires the previous code', async () => {
    const phone = newPhone();
    await issue(phone, '121212');
    await issue(phone, '343434');
    const { rows } = await owner.query<{ live: string }>(
      'SELECT count(*) AS live FROM auth_otp_challenges WHERE phone_e164=$1 AND consumed_at IS NULL', [phone],
    );
    expect(Number(rows[0]!.live), 'more than one code was left usable').toBe(1);
    expect(shape(await verify(phone, '121212'))).toEqual({ status: 401, code: 'otp_invalid' });
    expect((await verify(phone, '343434')).statusCode).toBe(200);
  });

  it('two codes issued at the same instant still leave one live', async () => {
    const phone = newPhone();
    const a = await owner.connect(); const b = await owner.connect();
    try {
      await Promise.all([
        a.query('SELECT * FROM app.issue_otp($1,$2,5,5,NULL,15,5,0)', [phone, otpVerifier(phone, '565656')]),
        b.query('SELECT * FROM app.issue_otp($1,$2,5,5,NULL,15,5,0)', [phone, otpVerifier(phone, '676767')]),
      ]);
    } finally { a.release(); b.release(); }
    const { rows } = await owner.query<{ live: string }>(
      'SELECT count(*) AS live FROM auth_otp_challenges WHERE phone_e164=$1 AND consumed_at IS NULL', [phone],
    );
    expect(Number(rows[0]!.live), 'a race left two codes usable at once').toBe(1);
  });
});

// ══════════════════════════════════════ what a code authorises

describe('a code does not outrank an operator', () => {
  it('a disabled account looks exactly like a wrong code', async () => {
    const phone = newPhone();
    const reg = await h.app.inject({
      method: 'POST', url: '/v1/auth/register', remoteAddress: '10.55.0.1', headers: client(),
      payload: { phone, displayName: 'D', password: PW, locale: 'ar', deviceId: `otp-reg-${seq}-${Date.now() % 10000}` },
    });
    expect(reg.statusCode).toBe(200);
    await owner.query('UPDATE users SET disabled_at = now() WHERE phone_e164=$1', [phone]);

    await issue(phone, '191919');
    const disabled = shape(await verify(phone, '191919'));

    // It used to answer 404 "Resource not found" — a different response from
    // both success and a wrong code, so anyone holding a valid code could read
    // off that the number is registered AND has been suspended.
    expect(disabled, 'a disabled account is distinguishable').toEqual({ status: 401, code: 'otp_invalid' });

    const active = newPhone();
    await issue(active, '191919');
    expect(shape(await verify(active, '202020')), 'baseline for a wrong code')
      .toEqual({ status: 401, code: 'otp_invalid' });
  });

  it('a disabled account is not signed in and gets no session', async () => {
    const phone = newPhone();
    await h.app.inject({
      method: 'POST', url: '/v1/auth/register', remoteAddress: '10.55.0.1', headers: client(),
      payload: { phone, displayName: 'D2', password: PW, locale: 'ar', deviceId: `otp-reg2-${seq}-${Date.now() % 10000}` },
    });
    await owner.query('UPDATE users SET disabled_at = now() WHERE phone_e164=$1', [phone]);
    const before = await owner.query<{ n: string }>(
      'SELECT count(*) AS n FROM auth_sessions WHERE user_id=(SELECT id FROM users WHERE phone_e164=$1) AND revoked_at IS NULL', [phone],
    );
    await issue(phone, '212121');
    await verify(phone, '212121');
    const after = await owner.query<{ n: string }>(
      'SELECT count(*) AS n FROM auth_sessions WHERE user_id=(SELECT id FROM users WHERE phone_e164=$1) AND revoked_at IS NULL', [phone],
    );
    expect(after.rows[0]!.n, 'a disabled account gained a session').toBe(before.rows[0]!.n);
  });

  /**
   * A deliberate policy, asserted so it cannot drift: a code proves possession
   * of the phone, which outranks knowing the password, so signing in with one
   * clears a password lockout rather than being blocked by it.
   */
  it('signing in with a code clears a password lockout', async () => {
    const phone = newPhone();
    await h.app.inject({
      method: 'POST', url: '/v1/auth/register', remoteAddress: '10.55.0.1', headers: client(),
      payload: { phone, displayName: 'L', password: PW, locale: 'ar', deviceId: `otp-lk-${seq}-${Date.now() % 10000}` },
    });
    for (let i = 0; i < 9; i++) {
      await h.app.inject({
        method: 'POST', url: '/v1/auth/login', remoteAddress: '10.55.0.1', headers: client(),
        payload: { identifier: phone, password: `bad-${i}`, deviceId: 'otp-lock-dev' },
      });
    }
    const read = async () => (await owner.query<{ failed_login_count: number; locked_until: Date | null }>(
      'SELECT failed_login_count, locked_until FROM user_credentials WHERE user_id=(SELECT id FROM users WHERE phone_e164=$1)', [phone],
    )).rows[0]!;
    expect((await read()).locked_until, 'the account never locked, so this proves nothing').not.toBeNull();

    await issue(phone, '232323');
    expect((await verify(phone, '232323')).statusCode).toBe(200);

    const after = await read();
    expect(after.locked_until, 'the lock survived a successful code sign-in').toBeNull();
    expect(after.failed_login_count).toBe(0);
  });
});

// ══════════════════════════════════════ flood control

/**
 * Per-identifier limits live in the database, not in the per-process limiter
 * P5 found. That matters here more than anywhere else: a code request costs the
 * VICTIM a message, so an attacker spread across many addresses could otherwise
 * flood one phone at will.
 */
describe('one phone cannot be flooded with codes', () => {
  it('the per-identifier limit is enforced in the database, independent of the caller', async () => {
    const phone = newPhone();
    const outcomes: string[] = [];
    for (let i = 0; i < 8; i++) outcomes.push((await issue(phone, String(100000 + i))).outcome);
    expect(outcomes.filter((o) => o === 'issued').length, 'more codes were issued than the window allows').toBe(5);
    expect(outcomes.slice(5), 'the window did not close').toEqual(['rate_limited', 'rate_limited', 'rate_limited']);
  });

  it('a resend cooldown stands between two codes', async () => {
    const phone = newPhone();
    expect((await issue(phone, '303030', { cooldown: 45 })).outcome).toBe('issued');
    expect((await issue(phone, '313131', { cooldown: 45 })).outcome, 'a second code was issued immediately').toBe('cooldown');
  });
});

// ══════════════════════════════════════ leakage and retention

describe('codes do not leak, and challenges do not linger', () => {
  it('no route or service writes a code to a log or a response', async () => {
    const { readFileSync } = await import('node:fs');
    for (const f of ['../src/auth/otp-service.ts', '../src/routes/auth.ts']) {
      const src = readFileSync(new URL(f, import.meta.url), 'utf8');
      const logLines = src.split('\n').filter((l) => /log\.(info|warn|error|debug|trace)|console\./.test(l));
      for (const line of logLines) {
        expect(line, `${f}: a log call references a code variable`).not.toMatch(/\bcode\b|otp\.code|body\.code/);
      }
    }
  });

  it('the code is never returned to the caller', async () => {
    const phone = newPhone();
    await issue(phone, '414141');
    const r = await verify(phone, '414141');
    expect(r.body).not.toContain('414141');
  });

  it('debug echo cannot be switched on in production', async () => {
    const { loadConfig, resetConfigCache } = await import('../src/config.js');
    const base = {
      NODE_ENV: 'production', IP_HASH_SALT: 'p6-real-salt-value', PUSH_PROVIDER: 'expo', STORAGE_PROVIDER: 's3',
      JWT_SECRET: 'p6_secret_at_least_forty_eight_characters_long_0123456789',
      DATABASE_SSL: 'true', DATABASE_URL: 'postgres://u:p@127.0.0.1:5433/d',
    } as NodeJS.ProcessEnv;
    try {
      resetConfigCache();
      expect(() => loadConfig({ ...base, OTP_DEBUG_ECHO: 'true' })).toThrow(/OTP_DEBUG_ECHO/);
      // And the same environment without it boots, so the test proves the flag
      // is the cause rather than the rest of the config being invalid.
      resetConfigCache();
      expect(() => loadConfig({ ...base, OTP_DEBUG_ECHO: 'false' })).not.toThrow();
    } finally { resetConfigCache(); loadConfig(); }
  });

  it('challenges are purged once they are old enough', async () => {
    const phone = newPhone();
    await issue(phone, '515151');
    await owner.query("UPDATE auth_otp_challenges SET created_at = now() - interval '48 hours' WHERE phone_e164=$1", [phone]);
    await owner.query('SELECT app.purge_expired_otp(24)');
    const { rows } = await owner.query<{ n: string }>(
      'SELECT count(*) AS n FROM auth_otp_challenges WHERE phone_e164=$1', [phone],
    );
    expect(Number(rows[0]!.n), 'an old challenge, with its phone number, was kept').toBe(0);
  });
});

// ══════════════════════════════════════ no provider

describe('there is no delivery provider, and the API says so', () => {
  it('requesting a code is refused identically for any number', async () => {
    const known = newPhone();
    await h.app.inject({
      method: 'POST', url: '/v1/auth/register', remoteAddress: '10.55.0.1', headers: client(),
      payload: { phone: known, displayName: 'R', password: PW, locale: 'ar', deviceId: `otp-req-${seq}-${Date.now() % 10000}` },
    });
    const ask = (p: string) => h.app.inject({
      method: 'POST', url: '/v1/auth/otp/request', remoteAddress: '10.55.0.1', headers: client(),
      payload: { phone: p, locale: 'ar' },
    });
    const a = await ask(known);
    const b = await ask(newPhone());
    // Refused before any lookup, so channel health cannot become an
    // account-existence oracle.
    // requestId is a per-request UUID and is the only part that may differ.
    const strip = (body: string) => body.replace(/"requestId":"[^"]+"/, '"requestId":"<id>"');
    expect(a.statusCode).toBe(503);
    expect({ s: a.statusCode, b: strip(a.body) }).toEqual({ s: b.statusCode, b: strip(b.body) });
  });

  it('no SMS or WhatsApp adapter is shipped, so nothing can claim a code was sent', async () => {
    const { readdirSync } = await import('node:fs');
    const providers = readdirSync(new URL('../src/providers/', import.meta.url));
    expect(providers.filter((f) => /sms|whatsapp|twilio|unifonic/i.test(f)),
      'a delivery adapter appeared — its failure semantics need auditing').toEqual([]);
  });
});

/**
 * A control byte in a source file is invisible in a diff, breaks grep and
 * survives review. One got into the OTP verifier's MAC separator during this
 * audit — the toolchain compiled it, the tests passed, and nothing said a word.
 */
describe('the source of the auth primitives is plain text', () => {
  it('contains no NUL or other control bytes', async () => {
    const { readFileSync } = await import('node:fs');
    for (const f of ['../src/lib/crypto.ts', '../src/lib/password.ts', '../src/auth/otp-service.ts']) {
      const bytes = readFileSync(new URL(f, import.meta.url));
      const bad = [...bytes].filter((b) => b < 0x09 || (b > 0x0d && b < 0x20) || b === 0x7f);
      expect(bad, `${f} contains ${bad.length} control byte(s)`).toEqual([]);
    }
  });
});
