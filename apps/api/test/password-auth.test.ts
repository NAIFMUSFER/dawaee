import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetDatabase, startHarness, type Harness } from './harness.js';
import { attemptPasswordLogin, MAX_LOGIN_ATTEMPTS } from '../src/auth/password-service.js';
import { withTransaction } from '../src/lib/db.js';
import { hashPassword } from '../src/lib/password.js';

/**
 * Password sign-in.
 *
 * Both code-based channels turned out to need a Saudi commercial registration —
 * SMS for its Sender ID, WhatsApp for an approved AUTHENTICATION template — so
 * a password is the only route in that does not wait on someone's approval.
 */
let h: Harness;

const DEVICE = { deviceId: 'device-password-tests', deviceName: 'Test' };

/**
 * Each call comes from its own address.
 *
 * Registration is rate limited per caller, which is correct in production and
 * wrong for a suite: without this the sixth `it` in the file starts failing
 * because of what the first five did, and the failure looks like a bug in
 * whatever that sixth test was checking. The limit itself is asserted
 * deliberately further down.
 */
let caller = 0;
const fromNewAddress = () => `10.0.${Math.floor(caller / 250)}.${(caller++ % 250) + 1}`;

const register = (payload: Record<string, unknown>) =>
  h.app.inject({
    method: 'POST', url: '/v1/auth/register',
    remoteAddress: fromNewAddress(),
    payload: { ...DEVICE, ...payload },
  });

const login = (identifier: string, password: string) =>
  h.app.inject({
    method: 'POST', url: '/v1/auth/login',
    payload: { identifier, password, ...DEVICE },
  });

/**
 * Creates an account through the auth plane rather than a direct INSERT. Row
 * level security refuses the latter — users may only be created by the
 * SECURITY DEFINER surface — which is the isolation working, not an obstacle
 * to route around.
 */
async function seedAccount(phone: string, name: string, password: string | null): Promise<void> {
  const hash = password === null ? null : await hashPassword(password);
  await withTransaction(async (tx) => {
    await tx.query('SELECT * FROM app.register_with_password($1,$2,$3,$4,$5)',
      [phone, null, name, hash, 'ar']);
  });
}

beforeAll(async () => {
  resetDatabase();
  h = await startHarness();
});
afterAll(async () => { await h.close(); });

describe('registration', () => {
  it('creates an account with a phone and signs it in immediately', async () => {
    const res = await register({
      phone: '0566000001', displayName: 'محمد', password: 'correct horse battery',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().accessToken).toBeTruthy();
    expect(res.json().isNewUser).toBe(true);
  });

  /**
   * The registration that shipped created the user row and nothing else. The
   * API answered 200, the app stored the tokens, and then every screen sat on
   * a loading spinner forever, because a profile is what medications, doses
   * and reminders all hang from. An account is not created until it is usable.
   */
  it('creates the account with its own patient profile and preferences', async () => {
    const res = await register({
      phone: '0566000009', displayName: 'سارة', password: 'correct horse battery',
    });
    expect(res.statusCode).toBe(200);
    const token = res.json().accessToken as string;

    const profiles = await h.app.inject({
      method: 'GET', url: '/v1/profiles', headers: { authorization: `Bearer ${token}` },
    });
    expect(profiles.statusCode).toBe(200);
    const list = profiles.json().profiles as Array<{ isSelf: boolean; displayName: string }>;
    expect(list).toHaveLength(1);
    expect(list[0]?.isSelf).toBe(true);
    expect(list[0]?.displayName).toBe('سارة');

    // Preferences too — the locale chosen at sign-up is what every reminder
    // and notification is written in from the first dose onward.
    const me = await h.app.inject({
      method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${token}` },
    });
    expect(me.json().preferences.locale).toBe('ar');
  });

  it('carries the chosen language onto the new account', async () => {
    const res = await register({
      email: 'english@example.com', displayName: 'Sara', password: 'correct horse battery',
      locale: 'en',
    });
    expect(res.statusCode).toBe(200);
    const me = await h.app.inject({
      method: 'GET', url: '/v1/me',
      headers: { authorization: `Bearer ${res.json().accessToken}` },
    });
    expect(me.json().user.locale).toBe('en');
    expect(me.json().preferences.locale).toBe('en');
  });

  it('creates an account with an email instead of a phone', async () => {
    const res = await register({
      email: 'Naif@Example.com', displayName: 'Naif', password: 'correct horse battery',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().accessToken).toBeTruthy();
  });

  it('refuses an identifier that already exists', async () => {
    const res = await register({
      phone: '0566000001', displayName: 'Someone else', password: 'another good passphrase',
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('identifier_taken');
  });

  it('refuses a password that is too short or trivially guessable', async () => {
    const short = await register({ phone: '0566000009', displayName: 'x', password: 'short1' });
    expect(short.statusCode).toBe(400);

    const common = await register({ phone: '0566000009', displayName: 'x', password: 'password123' });
    expect(common.statusCode).toBe(400);
    expect(common.json().error.code).toBe('weak_password');
  });

  it('requires a phone or an email — not neither', async () => {
    const res = await register({ displayName: 'Nobody', password: 'correct horse battery' });
    expect(res.statusCode).toBe(400);
  });

  /**
   * The limit answered 500 "an unexpected error occurred" for its entire
   * existence: the plugin throws its payload, that payload carried no status,
   * and the error handler treated it as a crash. A client cannot back off from
   * a 500, and a person told the server is broken tries again immediately —
   * which is exactly the traffic the limit exists to stop.
   */
  it('says it is rate limiting, rather than reporting a crash', async () => {
    const address = '10.99.99.99';
    const attempt = (n: number) =>
      h.app.inject({
        method: 'POST', url: '/v1/auth/register',
        remoteAddress: address,
        payload: { ...DEVICE, phone: `05670000${String(n).padStart(2, '0')}`,
          displayName: 'x', password: 'correct horse battery' },
      });

    let limited: Awaited<ReturnType<typeof attempt>> | null = null;
    for (let n = 0; n < 12 && !limited; n++) {
      const res = await attempt(n);
      if (res.statusCode !== 200) limited = res;
    }

    expect(limited?.statusCode).toBe(429);
    expect(limited?.json().error.code).toBe('rate_limited');
  });
});

describe('sign-in', () => {
  it('accepts the phone in local or international form', async () => {
    for (const form of ['0566000001', '+966566000001', '966566000001']) {
      const res = await login(form, 'correct horse battery');
      expect(res.statusCode, form).toBe(200);
      expect(res.json().accessToken).toBeTruthy();
    }
  });

  it('accepts the email regardless of case', async () => {
    const res = await login('naif@example.com', 'correct horse battery');
    expect(res.statusCode).toBe(200);
  });

  it('issues a token that actually works', async () => {
    const res = await login('0566000001', 'correct horse battery');
    const me = await h.app.inject({
      method: 'GET', url: '/v1/me',
      headers: { authorization: `Bearer ${res.json().accessToken}` },
    });
    expect(me.statusCode).toBe(200);
  });

  it('refuses a wrong password', async () => {
    const res = await login('0566000001', 'not the right passphrase');
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('invalid_credentials');
  });

  /**
   * The property that matters most for a medication app: the response must not
   * reveal whether a phone number has an account. That would let anyone test
   * whether a person uses a medication app, which is a disclosure about their
   * health before a single medical field is read.
   */
  it('answers identically for an unknown account and a wrong password', async () => {
    const unknown = await login('0599999999', 'not the right passphrase');
    const wrong = await login('0566000001', 'not the right passphrase');

    expect(unknown.statusCode).toBe(wrong.statusCode);
    expect(unknown.json().error.code).toBe(wrong.json().error.code);
    expect(unknown.json().error.message).toBe(wrong.json().error.message);
  });
});

describe('brute-force resistance', () => {
  /**
   * Exercised at the service layer on purpose. Two independent defences guard
   * this endpoint — a per-IP request limit and a per-account lockout — and over
   * HTTP the IP limit trips first, hiding the one under test. That ordering is
   * correct in production (a single-IP attacker is stopped sooner); it just
   * means the account lockout has to be asserted directly.
   */
  it('locks the account after repeated failures, and the counter survives the refusal', async () => {
    const phone = '+966566000002';
    await seedAccount(phone, 'Locked', 'correct horse battery');

    let locked: Date | null = null;
    for (let i = 0; i < MAX_LOGIN_ATTEMPTS + 1; i += 1) {
      // Each attempt runs in its OWN transaction, exactly as the route does.
      // If the failure counter were rolled back by the refusal it reports, this
      // loop would never lock — an unlimited guessing budget.
      const r = await withTransaction((tx) => attemptPasswordLogin(tx, phone, `guess-${i}`));
      if (r.outcome === 'locked') { locked = r.until; break; }
    }
    expect(locked).not.toBeNull();

    // The correct password is refused too, while the lock stands.
    const correct = await withTransaction((tx) =>
      attemptPasswordLogin(tx, phone, 'correct horse battery'));
    expect(correct.outcome).toBe('locked');
  });

  it('a successful sign-in clears the failure count', async () => {
    const phone = '+966566000003';
    await seedAccount(phone, 'Recovers', 'correct horse battery');

    for (let i = 0; i < MAX_LOGIN_ATTEMPTS - 1; i += 1) {
      await withTransaction((tx) => attemptPasswordLogin(tx, phone, 'wrong'));
    }

    const ok = await withTransaction((tx) => attemptPasswordLogin(tx, phone, 'correct horse battery'));
    expect(ok.outcome).toBe('ok');

    // Those earlier failures must not carry over towards a later lockout.
    const after = await withTransaction((tx) => attemptPasswordLogin(tx, phone, 'wrong again'));
    expect(after.outcome).toBe('invalid');
  });

  it('an account with no password never signs in, however it is probed', async () => {
    // No password at all — an account from when the only way in was a code.
    const phone = '+966566000004';
    await seedAccount(phone, 'OTP era', null);
    for (const guess of ['', 'password', 'correct horse battery']) {
      const r = await withTransaction((tx) => attemptPasswordLogin(tx, phone, guess));
      expect(r.outcome, guess).toBe('invalid');
    }
  });
});

describe('the password never leaves the server', () => {
  it('is absent from every auth response', async () => {
    const res = await login('0566000001', 'correct horse battery');
    const body = JSON.stringify(res.json()).toLowerCase();
    expect(body).not.toContain('correct horse battery');
    expect(body).not.toContain('password_hash');
    expect(body).not.toContain('scrypt');
  });
});
