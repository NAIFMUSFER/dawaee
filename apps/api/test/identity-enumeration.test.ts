import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetDatabase, startHarness, type Harness } from './harness.js';

/**
 * Whether an outsider can learn that a given phone number or email address has
 * an account here.
 *
 * For a medication app that question is not idle curiosity. Membership implies
 * someone is managing a medical condition, so "does +9665… have an account"
 * leaks health information before a single record is read. Every assertion
 * below therefore compares a REAL identifier against an invented one and
 * requires the two answers to be indistinguishable — status, error code,
 * message and byte count together, because any one of them alone is a channel.
 *
 * Driven against the real server rather than reasoned about: several of these
 * were passing by inspection and failing in practice.
 */

let h: Harness;
let owner: pg.Pool;
const PW = 'correct horse battery staple';

/**
 * A fresh client address per request.
 *
 * The suite would otherwise rate-limit ITSELF — the register limit is six per
 * ten minutes — and a 429 looks identical for a real and an invented
 * identifier, which would make every comparison below pass for the wrong
 * reason. Two proxy hops are supplied so the value the app trusts is the one an
 * upstream proxy appended, matching TRUST_PROXY_HOPS.
 */
let seq = 0;
const fromNewClient = () => ({ 'x-forwarded-for': `198.18.${Math.floor(seq / 250) % 250}.${(seq++ % 250) + 1}` });

interface Probe { status: number; code: string | null; message: string | null; bytes: number }
const probe = (r: { statusCode: number; body: string }): Probe => {
  let code: string | null = null;
  let message: string | null = null;
  try {
    const j = JSON.parse(r.body) as { error?: { code?: string; message?: string } };
    code = j.error?.code ?? null;
    message = j.error?.message ?? null;
  } catch { /* a success body has no error envelope */ }
  return { status: r.statusCode, code, message, bytes: Buffer.byteLength(r.body) };
};

const register = (payload: Record<string, unknown>) =>
  h.app.inject({ method: 'POST', url: '/v1/auth/register', remoteAddress: '10.55.0.1', headers: fromNewClient(), payload });

const login = (identifier: string, password: string) =>
  h.app.inject({
    method: 'POST', url: '/v1/auth/login', remoteAddress: '10.55.0.1', headers: fromNewClient(),
    payload: { identifier, password, deviceId: 'enum-test-device' },
  });

let n = 0;
const newPhone = () => `+9665${String(3100000 + n++).padStart(8, '0')}`;

async function makeAccount(phone: string, email?: string) {
  const r = await register({
    phone, ...(email ? { email } : {}), displayName: 'Test', password: PW, locale: 'ar',
    deviceId: `enum-dev-${n}-${Date.now() % 100000}`,
  });
  expect(r.statusCode, `account setup failed: ${r.body}`).toBe(200);
  return r;
}

beforeAll(async () => {
  resetDatabase();
  h = await startHarness();
  owner = new pg.Pool({ connectionString: 'postgres://postgres:postgres@127.0.0.1:5433/dawaee_test', max: 5 });
});
afterAll(async () => { await owner.end(); await h.close(); });

// ══════════════════════════════════════ sign-in

describe('sign-in tells nobody which accounts exist', () => {
  it('an unknown identifier and a wrong password are the same answer', async () => {
    const phone = newPhone();
    await makeAccount(phone);
    const unknown = probe(await login(newPhone(), 'not the right password'));
    const wrongPw = probe(await login(phone, 'not the right password'));
    expect(unknown).toEqual(wrongPw);
    expect(unknown.status).toBe(401);
    expect(unknown.code).toBe('invalid_credentials');
  });

  it('an email that exists and one that never did are the same answer', async () => {
    const phone = newPhone();
    await makeAccount(phone, `enum-${n}@example.com`);
    const known = probe(await login(`enum-${n - 1}@example.com`, 'not the right password'));
    const unknown = probe(await login('definitely-nobody@example.com', 'not the right password'));
    expect(known).toEqual(unknown);
  });

  it('a disabled account is not distinguishable, with the right password or the wrong one', async () => {
    const phone = newPhone();
    await makeAccount(phone);
    await owner.query('UPDATE users SET disabled_at = now() WHERE phone_e164 = $1', [phone]);

    const baseline = probe(await login(newPhone(), 'not the right password'));
    const disabledCorrect = probe(await login(phone, PW));
    const disabledWrong = probe(await login(phone, 'not the right password'));

    // Disablement is a suspension. Announcing it would confirm the account is
    // real and tell an attacker their target has been flagged.
    expect(disabledCorrect).toEqual(baseline);
    expect(disabledWrong).toEqual(baseline);
  });

  /**
   * P5-2. The lockout used to answer 429 `account_locked` to anyone who tripped
   * it, and only a real account can be locked — nine unauthenticated requests
   * bought a definitive yes/no on whether a phone number was registered, and
   * locked the owner out for fifteen minutes as a side effect.
   */
  it('a locked account looks exactly like a wrong password to someone without it', async () => {
    const phone = newPhone();
    await makeAccount(phone);
    for (let i = 0; i < 9; i++) await login(phone, `wrong-guess-${i}`);

    const { rows } = await owner.query<{ locked_until: Date | null }>(
      'SELECT locked_until FROM user_credentials WHERE user_id = (SELECT id FROM users WHERE phone_e164 = $1)', [phone],
    );
    expect(rows[0]!.locked_until, 'the account never locked, so this proves nothing').not.toBeNull();

    const lockedWrongPw = probe(await login(phone, 'still the wrong password'));
    const unknown = probe(await login(newPhone(), 'still the wrong password'));
    expect(lockedWrongPw, 'a locked account is distinguishable from one that does not exist').toEqual(unknown);
    expect(lockedWrongPw.status).toBe(401);
  });

  it('the account holder is still told they are locked out', async () => {
    const phone = newPhone();
    await makeAccount(phone);
    for (let i = 0; i < 9; i++) await login(phone, `wrong-guess-${i}`);

    // Whoever can supply the password is the holder in every practical sense,
    // and a password that silently stops working is a support call.
    const holder = probe(await login(phone, PW));
    expect(holder.status, 'the real user gets no explanation for the lockout').toBe(429);
    expect(holder.code).toBe('account_locked');
  });

  /**
   * P5-2b. Recording failures during a lock is what stops the lock window being
   * a free guessing budget; NOT extending it is what stops an outsider holding
   * a patient out of their own reminders indefinitely.
   */
  it('guesses during a lock are counted but do not push the lock further out', async () => {
    const phone = newPhone();
    await makeAccount(phone);
    for (let i = 0; i < 9; i++) await login(phone, `wrong-guess-${i}`);

    const read = async () => (await owner.query<{ failed_login_count: number; locked_until: Date }>(
      'SELECT failed_login_count, locked_until FROM user_credentials WHERE user_id = (SELECT id FROM users WHERE phone_e164 = $1)', [phone],
    )).rows[0]!;
    const before = await read();

    await login(phone, 'another wrong guess');
    const after = await read();

    expect(after.failed_login_count, 'a guess during the lock was free — the counter did not move')
      .toBeGreaterThan(before.failed_login_count);
    expect(after.locked_until.getTime(), 'the lockout slid forward; an outsider could renew it forever')
      .toBe(before.locked_until.getTime());
  });
});

// ══════════════════════════════════════ one-time codes

describe('the one-time-code routes reveal nothing', () => {
  it('requesting a code answers the same for a real and an invented number', async () => {
    const phone = newPhone();
    await makeAccount(phone);
    const ask = (p: string) => h.app.inject({
      method: 'POST', url: '/v1/auth/otp/request', remoteAddress: '10.55.0.2',
      headers: fromNewClient(), payload: { phone: p, locale: 'ar' },
    });
    // The route is refused outright — there is no SMS or WhatsApp provider — so
    // it never performs a lookup and has nothing to leak.
    expect(probe(await ask(phone))).toEqual(probe(await ask(newPhone())));
  });

  it('verifying a code answers the same for a real and an invented number', async () => {
    const phone = newPhone();
    await makeAccount(phone);
    const verify = (p: string) => h.app.inject({
      method: 'POST', url: '/v1/auth/otp/verify', remoteAddress: '10.55.0.3',
      headers: fromNewClient(), payload: { phone: p, code: '000000', deviceId: 'otp-enum-device' },
    });
    expect(probe(await verify(phone))).toEqual(probe(await verify(newPhone())));
  });
});

// ══════════════════════════════════════ rate limiting

/**
 * P5-1. `trustProxy: true` made Fastify read the LEFTMOST X-Forwarded-For entry
 * as the client address, and the leftmost entry is whatever the client typed.
 * Measured before the fix: six registrations from one address were limited as
 * intended, and fourteen from the same address carrying a different forged
 * header each time were all allowed. Every IP-keyed limit in the app was one
 * header away from being decorative.
 */
describe('rate limiting cannot be sidestepped with a header', () => {
  let burstSeq = 0;
  const burst = async (headers: (i: number) => Record<string, string> | undefined) => {
    let ok = 0, blocked = 0;
    const run = burstSeq++;
    for (let i = 0; i < 14; i++) {
      const hdr = headers(i);
      const r = await h.app.inject({
        method: 'POST', url: '/v1/auth/register', remoteAddress: '10.66.0.1',
        ...(hdr ? { headers: hdr } : {}),
        payload: {
          phone: `+9665${String(90000000 + run * 100 + i)}`.slice(0, 13), displayName: 'B', password: PW, locale: 'ar',
          deviceId: `burst-${run}-${i}-${Date.now() % 100000}`,
        },
      });
      if (r.statusCode === 429) blocked++; else ok++;
    }
    return { ok, blocked };
  };

  it('limits one client when no proxy header is present', async () => {
    const { ok, blocked } = await burst(() => undefined);
    expect(ok, 'the registration limit did not apply at all').toBeLessThanOrEqual(6);
    expect(blocked).toBeGreaterThan(0);
  });

  it('a forged header cannot mint a fresh bucket once a proxy has appended the real address', async () => {
    // What the deployment actually looks like: the client writes whatever it
    // likes, and the trusted proxy appends the address it observed. Only the
    // appended value is used, so all of these land in one bucket.
    const { ok, blocked } = await burst((i) => ({ 'x-forwarded-for': `203.0.113.${i + 1}, 10.66.0.9` }));
    expect(ok, 'a client-supplied header still chose the rate-limit bucket').toBeLessThanOrEqual(6);
    expect(blocked).toBeGreaterThan(0);
  });

  /**
   * Which end of the chain is trusted, established from behaviour rather than
   * by reading `req.ip`: hold the RIGHT-hand entry constant and vary the left,
   * and every request must share one bucket; hold the left constant and vary
   * the right, and each must get its own.
   */
  it('the trusted address is taken from the right of the chain, not the left', async () => {
    const varyLeft = await burst((i) => ({ 'x-forwarded-for': `192.0.2.${i + 1}, 10.66.0.77` }));
    expect(varyLeft.blocked, 'varying the left-hand entry escaped the limit — the left is being trusted')
      .toBeGreaterThan(0);

    const varyRight = await burst((i) => ({ 'x-forwarded-for': `192.0.2.99, 10.66.1.${i + 1}` }));
    expect(varyRight.blocked, 'varying the right-hand entry did not produce separate buckets')
      .toBe(0);
  });
});

// ══════════════════════════════════════ identifier normalisation

/**
 * Enumeration and rate-limit controls both assume one person is one identifier.
 * If a number can be written several ways and each is treated as a different
 * identity, an attacker gets a fresh budget per spelling and a duplicate
 * account per spelling.
 */
describe('one phone number is one identity however it is written', () => {
  it('local, international and punctuated forms all collapse to the same value', async () => {
    const { normalizePhone } = await import('../src/lib/crypto.js');
    const same = [
      '+966512345678', '00966512345678', '0512345678', '966512345678',
      '+966 51 234 5678', '+966-51-234-5678', ' +966512345678 ',
    ];
    const normalised = same.map((v) => normalizePhone(v));
    expect(new Set(normalised).size, `variants disagreed: ${JSON.stringify(normalised)}`).toBe(1);
    expect(normalised[0]).toBe('+966512345678');
  });

  it('a form that cannot be normalised is refused, never treated as a new identity', async () => {
    const { normalizePhone } = await import('../src/lib/crypto.js');
    // Arabic-Indic digits and a zero-width space. Neither is accepted as a
    // second spelling of an existing number — they are rejected outright, which
    // is the safe direction: no duplicate account, no second rate-limit bucket.
    for (const odd of ['+٩٦٦٥١٢٣٤٥٦٧٨', '٠٥١٢٣٤٥٦٧٨', '+966512345678​']) {
      expect(normalizePhone(odd), `${JSON.stringify(odd)} was accepted as an identifier`).toBeNull();
    }
  });

  it('the same number in two spellings cannot register twice', async () => {
    const local = '0598765432';
    const international = '+966598765432';
    const first = await register({ phone: local, displayName: 'N1', password: PW, locale: 'ar', deviceId: `norm-a-${Date.now() % 100000}` });
    expect(first.statusCode).toBe(200);
    const second = await register({ phone: international, displayName: 'N2', password: PW, locale: 'ar', deviceId: `norm-b-${Date.now() % 100000}` });
    expect(second.statusCode, 'the same number registered twice under two spellings').toBe(409);
  });

  it('email case does not create a second account', async () => {
    const first = await register({ email: 'Case.Test@Example.COM', displayName: 'E1', password: PW, locale: 'ar', deviceId: `mail-a-${Date.now() % 100000}` });
    expect(first.statusCode).toBe(200);
    const second = await register({ email: 'case.test@example.com', displayName: 'E2', password: PW, locale: 'ar', deviceId: `mail-b-${Date.now() % 100000}` });
    expect(second.statusCode, 'letter case produced a second account').toBe(409);
  });

  /**
   * Registration used to reject a pasted address with a surrounding space,
   * because `z.string().email()` ran before the handler's trim. Sign-in trimmed,
   * so the same value could log in but could not register.
   */
  it('a pasted address with surrounding whitespace is the same account, not a rejection', async () => {
    const padded = await register({ email: '  case.test@example.com  ', displayName: 'E3', password: PW, locale: 'ar', deviceId: `mail-c-${Date.now() % 100000}` });
    expect(padded.statusCode, 'whitespace was rejected instead of trimmed').toBe(409);
  });

  it('registration and sign-in agree on the spelling of an address', async () => {
    const email = `Agree.${Date.now() % 100000}@Example.com`;
    const made = await register({ email, displayName: 'E4', password: PW, locale: 'ar', deviceId: `mail-d-${Date.now() % 100000}` });
    expect(made.statusCode).toBe(200);
    for (const spelling of [email, email.toLowerCase(), `  ${email}  `, email.toUpperCase()]) {
      const r = await login(spelling, PW);
      expect(r.statusCode, `sign-in refused the spelling ${JSON.stringify(spelling)}`).toBe(200);
    }
  });

  it('plus-addressing stays distinct, because it identifies a different mailbox owner', async () => {
    const a = await register({ email: 'plus@example.com', displayName: 'P1', password: PW, locale: 'ar', deviceId: `plus-a-${Date.now() % 100000}` });
    const b = await register({ email: 'plus+tag@example.com', displayName: 'P2', password: PW, locale: 'ar', deviceId: `plus-b-${Date.now() % 100000}` });
    expect(a.statusCode).toBe(200);
    // Collapsing these would let one person seize an address they do not own.
    expect(b.statusCode).toBe(200);
  });
});

// ══════════════════════════════════════ caregiver invitations

describe('invitation states are gated behind holding the token', () => {
  it('an invented token is refused without naming anyone', async () => {
    const phone = newPhone();
    const acct = await makeAccount(phone);
    const token = acct.json<{ accessToken: string }>().accessToken;
    const r = await h.app.inject({
      method: 'POST', url: '/v1/caregivers/accept', headers: { authorization: `Bearer ${token}`, ...fromNewClient() },
      payload: { token: 'x'.repeat(48) },
    });
    expect(r.statusCode).toBe(404);
    const body = r.body;
    // Nothing about a patient, a caregiver or a relationship.
    expect(body).not.toMatch(/patient|display_name|displayName|profile/i);
  });

  it('the invitation token is stored hashed, never in the clear', async () => {
    const { rows } = await owner.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_name='caregiver_relationships' AND column_name LIKE '%token%'",
    );
    const cols = rows.map((r) => r.column_name);
    expect(cols, 'a raw invitation token column exists').toEqual(['invitation_token_hash']);
  });
});

// ══════════════════════════════════════ the authenticated oracle

/**
 * P5-4. Changing your own email answers a question about other people's
 * accounts: a taken address returns 409, a free one returns 200. The conflict
 * has to stay — accepting a duplicate or silently discarding the change would
 * be worse — so what is bounded is how often it can be asked.
 */
describe('the profile-update conflict is an oracle, and it is throttled', () => {
  it('still refuses to take an address another account holds', async () => {
    const victimEmail = `victim-${Date.now() % 1000000}@example.com`;
    await makeAccount(newPhone(), victimEmail);

    const attacker = await makeAccount(newPhone());
    const token = attacker.json<{ accessToken: string }>().accessToken;

    const taken = await h.app.inject({
      method: 'PATCH', url: '/v1/me', headers: { authorization: `Bearer ${token}`, ...fromNewClient() },
      payload: { email: victimEmail },
    });
    expect(taken.statusCode).toBe(409);
  });

  it('cannot be asked at a rate that makes enumeration worthwhile', async () => {
    const attacker = await makeAccount(newPhone());
    const token = attacker.json<{ accessToken: string }>().accessToken;

    // One client address, as production presents it: the trusted proxy appends
    // the address it observed, so an attacker cannot choose their own bucket.
    const fromOneClient = { 'x-forwarded-for': '198.19.7.7, 10.55.0.1' };
    let answered = 0;
    let throttled = 0;
    for (let i = 0; i < 20; i++) {
      const r = await h.app.inject({
        method: 'PATCH', url: '/v1/me', remoteAddress: '10.55.0.1',
        headers: { authorization: `Bearer ${token}`, ...fromOneClient },
        payload: { email: `probe-${i}-${Date.now() % 100000}@example.com` },
      });
      if (r.statusCode === 429) throttled++; else answered++;
    }
    expect(answered, 'the oracle answered far more often than a person edits their profile')
      .toBeLessThanOrEqual(10);
    expect(throttled).toBeGreaterThan(0);
  });
});
