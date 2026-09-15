import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetDatabase, startHarness, type Harness } from './harness.js';
import { attemptPasswordLogin, MAX_LOGIN_ATTEMPTS } from '../src/auth/password-service.js';
import { withTransaction } from '../src/lib/db.js';
import { hashPassword } from '../src/lib/password.js';

let h: Harness;

const PHONE = '+966566000055';
const PASSWORD = 'correct horse battery';
const DEVICE = { deviceId: 'device-password-lock-oracle', deviceName: 'Lock oracle regression' };

async function seedLockedAccount(): Promise<void> {
  const hash = await hashPassword(PASSWORD);
  await withTransaction(async (tx) => {
    await tx.query(
      'SELECT * FROM app.register_with_password($1,$2,$3,$4,$5)',
      [PHONE, null, 'Locked account', hash, 'en'],
    );
  });

  let locked = false;
  for (let i = 0; i <= MAX_LOGIN_ATTEMPTS; i += 1) {
    const result = await withTransaction((tx) =>
      attemptPasswordLogin(tx, PHONE, `wrong-before-lock-${i}`));
    if (result.outcome === 'locked') {
      locked = true;
      break;
    }
  }
  expect(locked).toBe(true);
}

const login = (password: string, remoteAddress: string) =>
  h.app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    remoteAddress,
    headers: { 'accept-language': 'en' },
    payload: { identifier: PHONE, password, ...DEVICE },
  });

beforeAll(async () => {
  resetDatabase();
  h = await startHarness();
});

afterAll(async () => {
  await h.close();
});

describe('password lock response privacy', () => {
  it('does not reveal whether a password guess is correct while the account is locked', async () => {
    await seedLockedAccount();

    // Before the fix these two probes were distinguishable:
    // correct -> 429 account_locked, wrong -> 401 invalid_credentials.
    // That made the lock a password-correctness oracle.
    const correct = await login(PASSWORD, '10.210.0.1');
    const wrong = await login('still not the password', '10.210.0.2');

    expect(correct.statusCode).toBe(401);
    expect(wrong.statusCode).toBe(401);
    expect(correct.json().error.code).toBe('invalid_credentials');
    expect(wrong.json().error.code).toBe(correct.json().error.code);
    expect(wrong.json().error.message).toBe(correct.json().error.message);
  });
});
