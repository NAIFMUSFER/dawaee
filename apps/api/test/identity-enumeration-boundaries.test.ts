import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetDatabase, startHarness, type Harness } from './harness.js';

/** Remaining identity-boundary regressions split from identity-enumeration.test.ts. */
let h: Harness;
let owner: pg.Pool;
const PW = ['correct', 'horse', 'battery', 'staple'].join(' ');
let seq = 0;
const fromNewClient = () => ({
  'x-forwarded-for': `198.19.${Math.floor(seq / 250) % 250}.${(seq++ % 250) + 1}`,
});
const register = (payload: Record<string, unknown>) => h.app.inject({
  method: 'POST', url: '/v1/auth/register', remoteAddress: '10.55.0.1',
  headers: fromNewClient(), payload,
});
const login = (identifier: string, password: string) => h.app.inject({
  method: 'POST', url: '/v1/auth/login', remoteAddress: '10.55.0.1',
  headers: fromNewClient(), payload: { identifier, password, deviceId: 'enum-boundary-device' },
});
let n = 0;
const newPhone = () => `+9665${String(4100000 + n++).padStart(8, '0')}`;
async function makeAccount(phone: string, email?: string) {
  const r = await register({
    phone, ...(email ? { email } : {}), displayName: 'Test', password: PW, locale: 'ar',
    deviceId: `enum-boundary-${n}-${Date.now() % 100000}`,
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
          phone: `+9665${String(90000000 + run * 100 + i)}`.slice(0, 13),
          displayName: 'B', password: PW, locale: 'ar',
          deviceId: `burst-${run}-${i}-${Date.now() % 100000}`,
        },
      });
      if (r.statusCode === 429) blocked++; else ok++;
    }
    return { ok, blocked };
  };

  it('limits one client when no proxy header is present', async () => {
    const { ok, blocked } = await burst(() => undefined);
    expect(ok).toBeLessThanOrEqual(6);
    expect(blocked).toBeGreaterThan(0);
  });
  it('a forged header cannot mint a fresh bucket once a proxy has appended the real address', async () => {
    const { ok, blocked } = await burst((i) => ({
      'x-forwarded-for': `203.0.113.${i + 1}, 10.66.0.9`,
    }));
    expect(ok).toBeLessThanOrEqual(6);
    expect(blocked).toBeGreaterThan(0);
  });
  it('the trusted address is taken from the right of the chain, not the left', async () => {
    const varyLeft = await burst((i) => ({
      'x-forwarded-for': `192.0.2.${i + 1}, 10.66.0.77`,
    }));
    expect(varyLeft.blocked).toBeGreaterThan(0);
    const varyRight = await burst((i) => ({
      'x-forwarded-for': `192.0.2.99, 10.66.1.${i + 1}`,
    }));
    expect(varyRight.blocked).toBe(0);
  });
});

describe('one phone number is one identity however it is written', () => {
  it('local, international and punctuated forms all collapse to the same value', async () => {
    const { normalizePhone } = await import('../src/lib/crypto.js');
    const same = [
      '+966512345678', '00966512345678', '0512345678', '966512345678',
      '+966 51 234 5678', '+966-51-234-5678', ' +966512345678 ',
    ];
    const normalised = same.map((v) => normalizePhone(v));
    expect(new Set(normalised).size).toBe(1);
    expect(normalised[0]).toBe('+966512345678');
  });
  it('a form that cannot be normalised is refused, never treated as a new identity', async () => {
    const { normalizePhone } = await import('../src/lib/crypto.js');
    for (const odd of ['+٩٦٦٥١٢٣٤٥٦٧٨', '٠٥١٢٣٤٥٦٧٨', '+966512345678​']) {
      expect(normalizePhone(odd)).toBeNull();
    }
  });
  it('the same number in two spellings cannot register twice', async () => {
    const first = await register({
      phone: '0598765432', displayName: 'N1', password: PW, locale: 'ar',
      deviceId: `norm-a-${Date.now() % 100000}`,
    });
    expect(first.statusCode).toBe(200);
    const second = await register({
      phone: '+966598765432', displayName: 'N2', password: PW, locale: 'ar',
      deviceId: `norm-b-${Date.now() % 100000}`,
    });
    expect(second.statusCode).toBe(409);
  });
  it('email case does not create a second account', async () => {
    const first = await register({
      email: 'Case.Test@Example.COM', displayName: 'E1', password: PW, locale: 'ar',
      deviceId: `mail-a-${Date.now() % 100000}`,
    });
    expect(first.statusCode).toBe(200);
    const second = await register({
      email: 'case.test@example.com', displayName: 'E2', password: PW, locale: 'ar',
      deviceId: `mail-b-${Date.now() % 100000}`,
    });
    expect(second.statusCode).toBe(409);
  });
  it('a pasted address with surrounding whitespace is the same account, not a rejection', async () => {
    const padded = await register({
      email: '  case.test@example.com  ', displayName: 'E3', password: PW, locale: 'ar',
      deviceId: `mail-c-${Date.now() % 100000}`,
    });
    expect(padded.statusCode).toBe(409);
  });
  it('registration and sign-in agree on the spelling of an address', async () => {
    const email = `Agree.${Date.now() % 100000}@Example.com`;
    const made = await register({
      email, displayName: 'E4', password: PW, locale: 'ar',
      deviceId: `mail-d-${Date.now() % 100000}`,
    });
    expect(made.statusCode).toBe(200);
    for (const spelling of [email, email.toLowerCase(), `  ${email}  `, email.toUpperCase()]) {
      expect((await login(spelling, PW)).statusCode).toBe(200);
    }
  });
  it('plus-addressing stays distinct, because it identifies a different mailbox owner', async () => {
    const a = await register({
      email: 'plus@example.com', displayName: 'P1', password: PW, locale: 'ar',
      deviceId: `plus-a-${Date.now() % 100000}`,
    });
    const b = await register({
      email: 'plus+tag@example.com', displayName: 'P2', password: PW, locale: 'ar',
      deviceId: `plus-b-${Date.now() % 100000}`,
    });
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
  });
});

describe('invitation states are gated behind holding the token', () => {
  it('an invented token is refused without naming anyone', async () => {
    const acct = await makeAccount(newPhone());
    const token = acct.json<{ accessToken: string }>().accessToken;
    const r = await h.app.inject({
      method: 'POST', url: '/v1/caregivers/accept',
      headers: { authorization: `Bearer ${token}`, ...fromNewClient() },
      payload: { token: 'x'.repeat(48) },
    });
    expect(r.statusCode).toBe(404);
    expect(r.body).not.toMatch(/patient|display_name|displayName|profile/i);
  });
  it('the invitation token is stored hashed, never in the clear', async () => {
    const { rows } = await owner.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_name='caregiver_relationships' AND column_name LIKE '%token%'",
    );
    expect(rows.map((r) => r.column_name)).toEqual(['invitation_token_hash']);
  });
});

describe('the profile-update conflict is an oracle, and it is throttled', () => {
  it('still refuses to take an address another account holds', async () => {
    const victimEmail = `victim-${Date.now() % 1000000}@example.com`;
    await makeAccount(newPhone(), victimEmail);
    const attacker = await makeAccount(newPhone());
    const token = attacker.json<{ accessToken: string }>().accessToken;
    const taken = await h.app.inject({
      method: 'PATCH', url: '/v1/me',
      headers: { authorization: `Bearer ${token}`, ...fromNewClient() },
      payload: { email: victimEmail },
    });
    expect(taken.statusCode).toBe(409);
  });
  it('cannot be asked at a rate that makes enumeration worthwhile', async () => {
    const attacker = await makeAccount(newPhone());
    const token = attacker.json<{ accessToken: string }>().accessToken;
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
    expect(answered).toBeLessThanOrEqual(10);
    expect(throttled).toBeGreaterThan(0);
  });
});
