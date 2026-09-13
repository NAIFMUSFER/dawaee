import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeaders, resetDatabase, signIn, startHarness, type Harness, type TestUser } from './harness.js';

let h: Harness;
let user: TestUser;

beforeAll(async () => {
  resetDatabase();
  h = await startHarness();
  user = await signIn(h, '+966500096858', 'device-note-length-contract');
});

afterAll(async () => {
  await h.close();
});

describe('symptom-note text length contract', () => {
  it('persists text that the public schema accepts up to its 2000-character bound', async () => {
    const text = 'ن'.repeat(1500);

    const created = await h.app.inject({
      method: 'POST',
      url: '/v1/notes',
      headers: authHeaders(user),
      payload: { profileId: user.profileId, tags: [], text },
    });
    expect(created.statusCode, created.body).toBe(200);

    const listed = await h.app.inject({
      method: 'GET',
      url: `/v1/notes?profileId=${user.profileId}`,
      headers: authHeaders(user),
    });
    expect(listed.statusCode, listed.body).toBe(200);
    const body = listed.json<{ notes: Array<{ text: string | null }> }>();
    expect(body.notes[0]?.text).toBe(text);
  });
});
