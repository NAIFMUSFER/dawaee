import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeaders, resetDatabase, signIn, startHarness, type Harness } from './harness.js';

let h: Harness;

function png(fill: number): Buffer {
  const body = Buffer.alloc(24, fill);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(body);
  return body;
}

beforeAll(async () => {
  resetDatabase();
  h = await startHarness();
}, 120_000);

afterAll(async () => {
  if (h) await h.close();
});

describe('a finalized upload lease is immutable even while its original PUT capability has time left', () => {
  it('refuses replay of the original upload ticket and preserves the bytes that were finalized', async () => {
    const user = await signIn(h, '+966500097796');
    const original = png(0x41);
    const replacement = png(0x42);

    // Both payloads are valid PNGs with the exact same approved size. This
    // isolates capability replay from the independent size and magic-byte
    // guards: a failure here means the already-verified object can be replaced.
    expect(replacement.length).toBe(original.length);

    const requested = await h.app.inject({
      method: 'POST',
      url: '/v1/uploads/request',
      headers: authHeaders(user),
      payload: {
        purpose: 'medication_image',
        contentType: 'image/png',
        byteSize: original.length,
        patientProfileId: user.profileId,
      },
    });
    expect(requested.statusCode, requested.body).toBe(200);
    const ticket = requested.json<{
      objectKey: string;
      upload: { uploadUrl: string; method: 'PUT' | 'POST'; headers: Record<string, string> };
    }>();

    const firstPut = await h.app.inject({
      method: ticket.upload.method,
      url: ticket.upload.uploadUrl,
      headers: ticket.upload.headers,
      payload: original,
    });
    expect(firstPut.statusCode, firstPut.body).toBe(200);

    const finalized = await h.app.inject({
      method: 'POST',
      url: '/v1/uploads/finalize',
      headers: authHeaders(user),
      payload: { objectKey: ticket.objectKey },
    });
    expect(finalized.statusCode, finalized.body).toBe(200);
    expect(await h.worker.providers.storage.getObject(ticket.objectKey, original.length)).toEqual(original);

    // RED control: the original capability is still cryptographically valid at
    // this clock. It must nevertheless be one-shot. Otherwise an attacker can
    // validate benign bytes, replace them afterwards, and finalize replay exits
    // early because uploaded_at is already set.
    const replayPut = await h.app.inject({
      method: ticket.upload.method,
      url: ticket.upload.uploadUrl,
      headers: ticket.upload.headers,
      payload: replacement,
    });
    expect(replayPut.statusCode, replayPut.body).toBe(409);
    expect(await h.worker.providers.storage.getObject(ticket.objectKey, original.length)).toEqual(original);

    const finalizeReplay = await h.app.inject({
      method: 'POST',
      url: '/v1/uploads/finalize',
      headers: authHeaders(user),
      payload: { objectKey: ticket.objectKey },
    });
    expect(finalizeReplay.statusCode, finalizeReplay.body).toBe(200);
    expect(await h.worker.providers.storage.getObject(ticket.objectKey, original.length)).toEqual(original);
  });
});
