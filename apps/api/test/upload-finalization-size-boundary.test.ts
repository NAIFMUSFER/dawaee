import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StorageProvider, UploadTicket } from '../src/providers/index.js';
import { authHeaders, resetDatabase, signIn, startHarness, type Harness } from './harness.js';

class SizeLeaseStorage implements StorageProvider {
  readonly name = 's3';
  readonly deleted: string[] = [];
  readonly bodies = new Map<string, Buffer>();

  async createUploadTicket(input: { objectKey: string; contentType: string; byteSize: number }): Promise<UploadTicket> {
    return {
      objectKey: input.objectKey,
      uploadUrl: `https://objects.example.test/${encodeURIComponent(input.objectKey)}`,
      method: 'PUT',
      headers: { 'content-type': input.contentType },
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
  }

  async createReadUrl(objectKey: string): Promise<string> {
    return `https://objects.example.test/read/${encodeURIComponent(objectKey)}`;
  }

  async getObject(objectKey: string, expectedBytes?: number): Promise<Buffer> {
    const body = this.bodies.get(objectKey);
    if (!body) throw new Error('object missing');
    if (expectedBytes !== undefined && body.length !== expectedBytes) {
      throw new Error('object size does not match declared upload size');
    }
    return body;
  }

  async deleteObject(objectKey: string): Promise<void> {
    this.deleted.push(objectKey);
    this.bodies.delete(objectKey);
  }
}

let h: Harness;
let storage: SizeLeaseStorage;

beforeAll(async () => {
  resetDatabase();
  h = await startHarness();
  storage = new SizeLeaseStorage();
  h.worker.providers.storage = storage;
}, 120_000);

afterAll(async () => {
  if (h) await h.close();
});

describe('direct S3/R2 uploads are finalized against the approved byte lease', () => {
  it('rejects and removes a larger object before it can become a retained application upload', async () => {
    const user = await signIn(h, '+966500097794');
    const declaredBytes = 16;
    const ticket = await h.app.inject({
      method: 'POST',
      url: '/v1/uploads/request',
      headers: authHeaders(user),
      payload: {
        purpose: 'medication_image',
        contentType: 'image/png',
        byteSize: declaredBytes,
        patientProfileId: user.profileId,
      },
    });
    expect(ticket.statusCode, ticket.body).toBe(200);
    const objectKey = ticket.json<{ objectKey: string }>().objectKey;

    // This models the production-only gap: direct S3/R2 PUT bytes bypass
    // Fastify, so a bearer can store more bytes than were declared to the API.
    storage.bodies.set(objectKey, Buffer.alloc(declaredBytes + 8, 0x41));

    const finalized = await h.app.inject({
      method: 'POST',
      url: '/v1/uploads/finalize',
      headers: authHeaders(user),
      payload: { objectKey },
    });

    expect(finalized.statusCode, finalized.body).toBe(400);
    expect(finalized.json<{ error: { code: string } }>().error.code).toBe('upload_rejected');
    expect(storage.deleted).toEqual([objectKey]);

    // The rejected lease must not remain reachable through the normal private
    // read flow. A second finalize is safe and does not create a second delete.
    const read = await h.app.inject({
      method: 'GET',
      url: '/v1/uploads/url',
      headers: { ...authHeaders(user), 'x-dawaee-object-key': objectKey },
    });
    expect(read.statusCode).toBe(404);

    const replay = await h.app.inject({
      method: 'POST',
      url: '/v1/uploads/finalize',
      headers: authHeaders(user),
      payload: { objectKey },
    });
    expect(replay.statusCode).toBe(404);
    expect(storage.deleted).toEqual([objectKey]);
  });

  it('accepts an exact-size object and makes that finalized upload usable', async () => {
    const user = await signIn(h, '+966500097795');
    const declaredBytes = 16;
    const ticket = await h.app.inject({
      method: 'POST',
      url: '/v1/uploads/request',
      headers: authHeaders(user),
      payload: {
        purpose: 'medication_image',
        contentType: 'image/png',
        byteSize: declaredBytes,
        patientProfileId: user.profileId,
      },
    });
    expect(ticket.statusCode, ticket.body).toBe(200);
    const objectKey = ticket.json<{ objectKey: string }>().objectKey;
    storage.bodies.set(objectKey, Buffer.alloc(declaredBytes, 0x42));

    const finalized = await h.app.inject({
      method: 'POST',
      url: '/v1/uploads/finalize',
      headers: authHeaders(user),
      payload: { objectKey },
    });
    expect(finalized.statusCode, finalized.body).toBe(200);
    expect(finalized.json<{ ok: boolean }>().ok).toBe(true);

    const read = await h.app.inject({
      method: 'GET',
      url: '/v1/uploads/url',
      headers: { ...authHeaders(user), 'x-dawaee-object-key': objectKey },
    });
    expect(read.statusCode, read.body).toBe(200);
    expect(storage.deleted).not.toContain(objectKey);
  });
});
