import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeaders, resetDatabase, signIn, startHarness, type Harness, type TestUser } from './harness.js';

let h: Harness;
let user: TestUser;
const client = { 'x-forwarded-for': '198.18.0.20, 198.18.0.10' };

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from([0x00, 0x00, 0x00, 0x0d]), Buffer.from('IHDR'),
  Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]),
]);

async function lease(byteSize: number) {
  const response = await h.app.inject({
    method: 'POST',
    url: '/v1/uploads/request',
    headers: { ...authHeaders(user), ...client },
    payload: {
      purpose: 'medication_image',
      contentType: 'image/png',
      byteSize,
      patientProfileId: user.profileId,
    },
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<{
    objectKey: string;
    upload: { uploadUrl: string; headers: Record<string, string> };
  }>();
}

async function upload(url: string, bytes: Buffer) {
  return h.app.inject({
    method: 'PUT',
    url,
    headers: { 'content-type': 'image/png', ...client },
    payload: bytes,
  });
}

async function finalize(objectKey: string) {
  return h.app.inject({
    method: 'POST',
    url: '/v1/uploads/finalize',
    headers: { ...authHeaders(user), ...client },
    payload: { objectKey },
  });
}

async function analyze(objectKey: string) {
  return h.app.inject({
    method: 'POST',
    url: '/v1/ocr/analyze',
    headers: { ...authHeaders(user), ...client },
    payload: {
      imageKey: objectKey,
      patientProfileId: user.profileId,
      kind: 'medication_label',
    },
  });
}

beforeAll(async () => {
  resetDatabase();
  h = await startHarness();
  user = await signIn(h, '+966500091199');
  const consent = await h.app.inject({
    method: 'PUT',
    url: '/v1/me/consents',
    headers: { ...authHeaders(user), ...client },
    payload: { type: 'ocr_image_processing', granted: true, version: '1' },
  });
  expect(consent.statusCode, consent.body).toBe(200);
}, 120_000);

afterAll(async () => { await h.close(); });

describe('OCR reads exactly the bytes approved by the upload lease', () => {
  it('rejects a valid image when the stored object is larger than the declared lease before OCR can read it', async () => {
    const ticket = await lease(PNG.length);
    const mismatched = Buffer.concat([PNG, Buffer.from([0x00])]);

    // A direct-upload provider may receive bytes that differ from the lease.
    // Finalization is now the trust boundary: it must reject those bytes before
    // any signed read URL or OCR operation can make the object visible.
    const put = await upload(ticket.upload.uploadUrl, mismatched);
    expect(put.statusCode, put.body).toBe(200);

    const completed = await finalize(ticket.objectKey);
    expect(completed.statusCode, completed.body).toBe(400);
    expect(completed.json<{ error: { code: string } }>().error.code).toBe('upload_rejected');

    const result = await analyze(ticket.objectKey);
    expect(result.statusCode, result.body).toBe(404);
    expect(result.body).not.toContain('SYNTHETIC');
  });

  it('keeps the ordinary exact-size finalization and OCR path working', async () => {
    const ticket = await lease(PNG.length);
    const put = await upload(ticket.upload.uploadUrl, PNG);
    expect(put.statusCode, put.body).toBe(200);

    const completed = await finalize(ticket.objectKey);
    expect(completed.statusCode, completed.body).toBe(200);

    const result = await analyze(ticket.objectKey);
    expect(result.statusCode, result.body).toBe(200);
    const body = result.json<{ requiresUserConfirmation: boolean }>();
    expect(body.requiresUserConfirmation).toBe(true);
  });
});
