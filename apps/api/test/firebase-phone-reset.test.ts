import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../src/auth/firebase-phone-proof.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/auth/firebase-phone-proof.js')>();
  return { ...actual, verifyFirebasePhoneIdToken: vi.fn() };
});

import { verifyFirebasePhoneIdToken } from '../src/auth/firebase-phone-proof.js';
import { resetDatabase, startHarness, type Harness } from './harness.js';

let h: Harness;
const mockedVerify = vi.mocked(verifyFirebasePhoneIdToken);
const OLD_PASSWORD = 'old password 12345';
const NEW_PASSWORD = 'new password 67890';
const PHONE = '+966512340987';

beforeAll(async () => { resetDatabase(); h = await startHarness(); });
afterAll(async () => { await h.close(); });

describe('Firebase phone proof password recovery', () => {
  it('resets the verified account and revokes old sessions', async () => {
    const registered = await h.app.inject({
      method: 'POST', url: '/v1/auth/register',
      payload: {
        phone: PHONE, displayName: 'Reset Test', password: OLD_PASSWORD, locale: 'ar',
        deviceId: 'reset-test-device-1',
      },
    });
    expect(registered.statusCode, registered.body).toBe(200);
    const oldRefresh = registered.json<{ refreshToken: string }>().refreshToken;

    mockedVerify.mockResolvedValueOnce({
      phoneE164: PHONE, firebaseUid: 'firebase-reset-test',
      authenticatedAt: Math.floor(Date.now() / 1000),
    });
    const reset = await h.app.inject({
      method: 'POST', url: '/v1/auth/firebase-phone/reset-password',
      payload: { idToken: 't'.repeat(200), newPassword: NEW_PASSWORD },
    });
    expect(reset.statusCode, reset.body).toBe(200);
    expect(reset.json()).toEqual({ ok: true });

    const oldLogin = await h.app.inject({
      method: 'POST', url: '/v1/auth/login',
      payload: { identifier: PHONE, password: OLD_PASSWORD, deviceId: 'reset-test-device-2' },
    });
    expect(oldLogin.statusCode).toBe(401);

    const newLogin = await h.app.inject({
      method: 'POST', url: '/v1/auth/login',
      payload: { identifier: PHONE, password: NEW_PASSWORD, deviceId: 'reset-test-device-3' },
    });
    expect(newLogin.statusCode, newLogin.body).toBe(200);

    const staleRefresh = await h.app.inject({
      method: 'POST', url: '/v1/auth/refresh', payload: { refreshToken: oldRefresh },
    });
    expect(staleRefresh.statusCode).toBe(401);
  });

  it('does not create an account for an unknown verified phone', async () => {
    mockedVerify.mockResolvedValueOnce({
      phoneE164: '+966512349999', firebaseUid: 'firebase-unknown-test',
      authenticatedAt: Math.floor(Date.now() / 1000),
    });
    const reset = await h.app.inject({
      method: 'POST', url: '/v1/auth/firebase-phone/reset-password',
      payload: { idToken: 'u'.repeat(200), newPassword: NEW_PASSWORD },
    });
    expect(reset.statusCode).toBe(404);
  });
});
