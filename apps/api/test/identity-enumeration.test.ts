import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetDatabase, startHarness, type Harness } from './harness.js';

/** Account-existence disclosure checks for password and one-time-code sign-in. */
let h: Harness;
let owner: pg.Pool;
const PW = ['correct', 'horse', 'battery', 'staple'].join(' ');
let seq = 0;
const fromNewClient = () => ({
  'x-forwarded-for': `198.18.${Math.floor(seq / 250) % 250}.${(seq++ % 250) + 1}`,
});

interface Probe { status: number; code: string | null; message: string | null; bytes: number }
const probe = (r: { statusCode: number; body: string }): Probe => {
  let code: string | null = null;
  let message: string | null = null;
  try {
    const j = JSON.parse(r.body) as { error?: { code?: string; message?: string } };
    code = j.error?.code ?? null;
    message = j.error?.message ?? null;
  } catch { /* success bodies have no error envelope */ }
  return { status: r.statusCode, code, message, bytes: Buffer.byteLength(r.body) };
};

const register = (payload: Record<string, unknown>) => h.app.inject({
  method: 'POST', url: '/v1/auth/register', remoteAddress: '10.55.0.1',
  headers: fromNewClient(), payload,
});
const login = (identifier: string, password: string) => h.app.inject({
  method: 'POST', url: '/v1/auth/login', remoteAddress: '10.55.0.1',
  headers: fromNewClient(), payload: { identifier, password, deviceId: 'enum-test-device' },
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
  owner = new pg.Pool({
    connectionString: 'postgres://postgres:postgres@127.0.0.1:5433/dawaee_test', max: 5,
  });
});
afterAll(async () => { await owner.end(); await h.close(); });

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
    expect(probe(await login(phone, PW))).toEqual(baseline);
    expect(probe(await login(phone, 'not the right password'))).toEqual(baseline);
  });

  it('a locked account looks exactly like a wrong password to someone without it', async () => {
    const phone = newPhone();
    await makeAccount(phone);
    for (let i = 0; i < 9; i++) await login(phone, `wrong-guess-${i}`);
    const { rows } = await owner.query<{ locked_until: Date | null }>(
      'SELECT locked_until FROM user_credentials WHERE user_id = (SELECT id FROM users WHERE phone_e164 = $1)',
      [phone],
    );
    expect(rows[0]!.locked_until).not.toBeNull();
    const lockedWrongPw = probe(await login(phone, 'still the wrong password'));
    const unknown = probe(await login(newPhone(), 'still the wrong password'));
    expect(lockedWrongPw).toEqual(unknown);
    expect(lockedWrongPw.status).toBe(401);
  });

  it('a correct password is still indistinguishable while the account is locked', async () => {
    const phone = newPhone();
    await makeAccount(phone);
    for (let i = 0; i < 9; i++) await login(phone, `wrong-guess-${i}`);
    const holder = probe(await login(phone, PW));
    const wrong = probe(await login(phone, 'still the wrong password'));
    const unknown = probe(await login(newPhone(), 'still the wrong password'));
    expect(holder).toEqual(wrong);
    expect(holder).toEqual(unknown);
    expect(holder.status).toBe(401);
    expect(holder.code).toBe('invalid_credentials');
  });

  it('guesses during a lock are counted but do not push the lock further out', async () => {
    const phone = newPhone();
    await makeAccount(phone);
    for (let i = 0; i < 9; i++) await login(phone, `wrong-guess-${i}`);
    const read = async () => (await owner.query<{ failed_login_count: number; locked_until: Date }>(
      'SELECT failed_login_count, locked_until FROM user_credentials WHERE user_id = (SELECT id FROM users WHERE phone_e164 = $1)',
      [phone],
    )).rows[0]!;
    const before = await read();
    await login(phone, 'another wrong guess');
    const after = await read();
    expect(after.failed_login_count).toBeGreaterThan(before.failed_login_count);
    expect(after.locked_until.getTime()).toBe(before.locked_until.getTime());
  });
});

describe('the one-time-code routes reveal nothing', () => {
  it('requesting a code answers the same for a real and an invented number', async () => {
    const phone = newPhone();
    await makeAccount(phone);
    const ask = (p: string) => h.app.inject({
      method: 'POST', url: '/v1/auth/otp/request', remoteAddress: '10.55.0.2',
      headers: fromNewClient(), payload: { phone: p, locale: 'ar' },
    });
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
