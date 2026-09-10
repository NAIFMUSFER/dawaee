import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeaders, resetDatabase, signIn, startHarness, type Harness, type TestUser } from './harness.js';

let h: Harness;
let user: TestUser;

beforeAll(async () => {
  resetDatabase();
  h = await startHarness();
  user = await signIn(h, '0511000058');
});

afterAll(async () => {
  await h.close();
});

describe('timezone-check validates the device timezone at the HTTP boundary', () => {
  it('rejects an unknown IANA timezone as a client validation error rather than a server error', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: `/v1/profiles/${user.profileId}/timezone-check`,
      headers: authHeaders(user),
      payload: { deviceTimezone: 'Not/A_Real_Zone' },
    });

    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().error.code).toBe('validation_failed');
  });

  it('still accepts a valid IANA timezone and only reports the proposed change', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: `/v1/profiles/${user.profileId}/timezone-check`,
      headers: authHeaders(user),
      payload: { deviceTimezone: 'Europe/London' },
    });

    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ changed: true, from: 'Asia/Riyadh', to: 'Europe/London' });

    const profile = await h.app.inject({
      method: 'GET',
      url: `/v1/profiles/${user.profileId}`,
      headers: authHeaders(user),
    });
    expect(profile.statusCode, profile.body).toBe(200);
    expect(profile.json().profile.timezone).toBe('Asia/Riyadh');
  });
});
