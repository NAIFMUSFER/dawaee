import { afterAll, beforeAll, expect, it } from 'vitest';
import { createEmailAccount, resetDatabase, signIn, startHarness, type Harness } from './harness.js';

let h: Harness;
beforeAll(async () => { resetDatabase(); h = await startHarness(); });
afterAll(async () => { await h.close(); });

it('logs into the email account even when its digits identify a different phone account', async () => {
  const device = { deviceId: 'email-identifier-regression' };
  const phone = await signIn(h,'0501234567','email-identifier-phone');
  const email = 'audit-0501234567@example.invalid';
  const password = 'Email fixture password!42';
  const registered = await createEmailAccount(h,email,'Email fixture',password,device.deviceId);
  const login = await h.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { ...device, identifier: email, password } });
  expect(login.statusCode, login.body).toBe(200);
  const profiles = async (token: string) => (await h.app.inject({ method: 'GET', url: '/v1/profiles', headers: { authorization: `Bearer ${token}` } })).json();
  expect(await profiles(login.json().accessToken)).toEqual(await profiles(registered.token));
  expect(await profiles(login.json().accessToken)).not.toEqual(await profiles(phone.token));
});
