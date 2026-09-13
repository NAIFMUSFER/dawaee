import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withUser } from '../src/lib/db.js';
import { authHeaders, resetDatabase, signIn, startHarness, type Harness, type TestUser } from './harness.js';

let h: Harness;
let seq = 0;
const client = () => ({ 'x-forwarded-for': `10.62.0.1, 198.18.62.${(seq++ % 250) + 1}` });
let n = 0;
const phone = () => `+9665${String(8400000 + n++).padStart(8, '0')}`;

beforeAll(async () => {
  resetDatabase();
  h = await startHarness();
});

afterAll(async () => {
  await h.close();
});

async function createPrivateObject(user: TestUser): Promise<string> {
  const ticket = await h.app.inject({
    method: 'POST',
    url: '/v1/uploads/request',
    headers: { ...authHeaders(user), ...client() },
    payload: {
      purpose: 'prescription_image',
      contentType: 'image/jpeg',
      byteSize: 128,
      patientProfileId: user.profileId,
    },
  });
  expect(ticket.statusCode, ticket.body).toBe(200);
  const objectKey = ticket.json<{ objectKey: string }>().objectKey;
  // Routing is the subject here. Represent a lease that already passed the
  // independently-tested finalization boundary so staging state cannot mask it.
  await withUser(user.userId, async (tx) => {
    await tx.query(
      `UPDATE stored_objects SET uploaded_at = now(), scan_status = 'clean'
        WHERE object_key = $1 AND owner_user_id = $2`,
      [objectKey, user.userId],
    );
  });
  return objectKey;
}

describe('private upload object-key transport', () => {
  it('promotes the header to the established signed-read handler without a query key', async () => {
    const a = await signIn(h, phone());
    const objectKey = await createPrivateObject(a);

    const read = await h.app.inject({
      method: 'GET',
      url: '/v1/uploads/url',
      headers: {
        ...authHeaders(a),
        ...client(),
        'x-dawaee-object-key': objectKey,
      },
    });

    expect(read.statusCode, read.body).toBe(200);
    const body = read.json<{ url: string; expiresInSeconds: number }>();
    expect(body.expiresInSeconds).toBe(300);
    expect(body.url).toBeTruthy();
  });

  it('does not let private-header transport bypass cross-account isolation', async () => {
    const a = await signIn(h, phone());
    const b = await signIn(h, phone());
    const objectKey = await createPrivateObject(a);

    const stolen = await h.app.inject({
      method: 'GET',
      url: '/v1/uploads/url',
      headers: {
        ...authHeaders(b),
        ...client(),
        'x-dawaee-object-key': objectKey,
      },
    });

    expect(stolen.statusCode, stolen.body).toBe(404);
  });

  it('rejects ambiguous legacy-query and private-header targets', async () => {
    const a = await signIn(h, phone());
    const first = await createPrivateObject(a);
    const second = await createPrivateObject(a);

    const conflict = await h.app.inject({
      method: 'GET',
      url: `/v1/uploads/url?objectKey=${encodeURIComponent(first)}`,
      headers: {
        ...authHeaders(a),
        ...client(),
        'x-dawaee-object-key': second,
      },
    });

    expect(conflict.statusCode, conflict.body).toBe(400);
    expect(conflict.json<{ error: { code: string } }>().error.code).toBe('validation_failed');
  });
});
