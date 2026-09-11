import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withUserReadOnly } from '../src/lib/db.js';
import type { StorageProvider, UploadTicket } from '../src/providers/index.js';
import { authHeaders, resetDatabase, signIn, startHarness, type Harness, type TestUser } from './harness.js';

/** Only the object store is simulated. Requests, authentication, RLS, and
 * finalization state changes run against the ordinary application/harness DB.
 * All bytes are synthetic and no external storage/provider is contacted. */
class ControlledStorage implements StorageProvider {
  readonly name = 's3';
  readonly bodies = new Map<string, Buffer>();
  readonly reads: string[] = [];
  readonly deletions: string[] = [];
  readError: Error | null = null;
  failDelete = false;

  async createUploadTicket(input: { objectKey: string; contentType: string; byteSize: number }): Promise<UploadTicket> {
    return {
      objectKey: input.objectKey,
      uploadUrl: `https://objects.example.test/${encodeURIComponent(input.objectKey)}`,
      method: 'PUT', headers: { 'content-type': input.contentType },
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
  }

  async createReadUrl(key: string): Promise<string> {
    return `https://objects.example.test/read/${encodeURIComponent(key)}`;
  }

  async getObject(key: string, expectedBytes?: number): Promise<Buffer> {
    this.reads.push(key);
    if (this.readError) throw this.readError;
    const body = this.bodies.get(key);
    if (!body) throw new Error('Synthetic object not present');
    if (expectedBytes !== undefined && body.length !== expectedBytes) {
      throw new Error('object size does not match declared upload size');
    }
    return body;
  }

  async deleteObject(key: string): Promise<void> {
    this.deletions.push(key);
    if (this.failDelete) throw new Error('Synthetic cleanup unavailable');
    this.bodies.delete(key);
  }
}

type StoredState = { uploaded_at: Date | null; scan_status: string; reject_reason: string | null };
let h: Harness;
let owner: TestUser;
let storage: ControlledStorage;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0]);

beforeAll(async () => {
  resetDatabase();
  h = await startHarness();
  owner = await signIn(h, '+966500098651');
}, 120_000);

beforeEach(() => {
  storage = new ControlledStorage();
  h.worker.providers.storage = storage;
});

afterAll(async () => { if (h) await h.close(); });

async function stage(): Promise<string> {
  const response = await h.app.inject({
    method: 'POST', url: '/v1/uploads/request', headers: authHeaders(owner),
    payload: { purpose: 'medication_image', contentType: 'image/png', byteSize: PNG.length, patientProfileId: owner.profileId },
  });
  expect(response.statusCode, response.body).toBe(200);
  const { objectKey } = response.json<{ objectKey: string }>();
  storage.bodies.set(objectKey, Buffer.from(PNG));
  return objectKey;
}

function finalize(key: string, user: TestUser = owner) {
  return h.app.inject({
    method: 'POST', url: '/v1/uploads/finalize', headers: authHeaders(user), payload: { objectKey: key },
  });
}

function read(key: string, user: TestUser = owner) {
  return h.app.inject({
    method: 'GET', url: '/v1/uploads/url',
    headers: { ...authHeaders(user), 'x-dawaee-object-key': key },
  });
}

async function state(key: string, user: TestUser = owner): Promise<StoredState | undefined> {
  return withUserReadOnly(user.userId, async (tx) => {
    const { rows } = await tx.query<StoredState>(
      'SELECT uploaded_at, scan_status, reject_reason FROM stored_objects WHERE object_key = $1', [key],
    );
    return rows[0];
  });
}

async function assertDurablyRejected(key: string, reason: string) {
  expect(await state(key)).toEqual({ uploaded_at: null, scan_status: 'rejected', reject_reason: reason });
  const beforeReads = storage.reads.length;
  expect((await read(key)).statusCode).toBe(404);
  expect((await finalize(key)).statusCode).toBe(404);
  expect(storage.reads).toHaveLength(beforeReads);
  expect(storage.deletions).toEqual([key]);
  // Physical cleanup failed deliberately: logical rejection must be enough.
  expect(storage.bodies.has(key)).toBe(true);
}

describe('upload finalization failure recovery and durable rejection', () => {
  it('keeps a size-mismatched object inaccessible when physical deletion fails', async () => {
    const key = await stage();
    storage.bodies.set(key, Buffer.concat([PNG, Buffer.from([0])]));
    storage.failDelete = true;
    const response = await finalize(key);
    expect(response.statusCode, response.body).toBe(400);
    expect(response.json().error.code).toBe('upload_rejected');
    await assertDurablyRejected(key, 'actual_size_mismatch');
  });

  it('keeps an equal-size wrong-type object inaccessible when physical deletion fails', async () => {
    const key = await stage();
    storage.bodies.set(key, Buffer.alloc(PNG.length, 0x41));
    storage.failDelete = true;
    const response = await finalize(key);
    expect(response.statusCode, response.body).toBe(400);
    expect(response.json().error.code).toBe('upload_rejected');
    await assertDurablyRejected(key, 'content_type_mismatch');
  });

  it('also durably rejects a bounded-reader size refusal when cleanup is unavailable', async () => {
    const key = await stage();
    storage.readError = new Error('object exceeds configured upload limit');
    storage.failDelete = true;
    const response = await finalize(key);
    expect(response.statusCode, response.body).toBe(400);
    expect(response.json().error.code).toBe('upload_rejected');
    await assertDurablyRejected(key, 'actual_size_mismatch');
  });

  it('does not finalize or destroy the lease after a transient provider error and allows a valid retry', async () => {
    const key = await stage();
    storage.readError = new Error('SYNTHETIC-PROVIDER-DETAIL-DO-NOT-RETURN');
    const failed = await finalize(key);
    expect(failed.statusCode, failed.body).toBe(503);
    expect(failed.json().error.code).toBe('provider_unavailable');
    expect(failed.body).not.toContain('SYNTHETIC-PROVIDER-DETAIL');
    expect(await state(key)).toEqual({ uploaded_at: null, scan_status: 'pending', reject_reason: null });
    expect(storage.deletions).toEqual([]);
    expect((await read(key)).statusCode).toBe(404);
    storage.readError = null;
    const retry = await finalize(key);
    expect(retry.statusCode, retry.body).toBe(200);
    expect((await read(key)).statusCode).toBe(200);
  });

  it('rejects malformed object routing before provider I/O', async () => {
    for (const payload of [{}, { objectKey: '' }, { objectKey: 7 }, { objectKey: 'x'.repeat(513) }]) {
      const response = await h.app.inject({
        method: 'POST', url: '/v1/uploads/finalize', headers: authHeaders(owner), payload,
      });
      expect(response.statusCode, response.body).toBe(400);
      expect(response.json().error.code).toBe('validation_failed');
    }
    expect(storage.reads).toEqual([]);
    expect(storage.deletions).toEqual([]);
  });
});
