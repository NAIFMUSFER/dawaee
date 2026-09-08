import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { AppError, ERROR_CODES } from '@dawaee/shared';
import type { StorageProvider, UploadTicket } from './types.js';
import type { Config } from '../config.js';

/**
 * Private object storage for medication and prescription images.
 *
 * Security posture required by the brief, enforced here and in the upload
 * route: private buckets only, randomized keys (never the user's filename),
 * validated content type and size, and time-limited signed URLs for both
 * upload and read. Nothing is ever served from a public bucket.
 */

export const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic']);

/** Magic-byte check. The bytes, not the caller's Content-Type, decide. */
export function sniffImageType(buf: Buffer): string | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  const brand = buf.subarray(4, 8).toString('ascii');
  if (brand === 'ftyp') {
    const sub = buf.subarray(8, 12).toString('ascii');
    if (['heic', 'heix', 'hevc', 'heim', 'heis', 'hevm', 'mif1', 'msf1'].includes(sub)) return 'image/heic';
  }
  return null;
}

/** Keys are opaque and unguessable; the original filename never survives. */
export function buildObjectKey(purpose: string, profileId: string | null, contentType: string): string {
  const ext = contentType.split('/')[1]?.replace('jpeg', 'jpg') ?? 'bin';
  const scope = profileId ? profileId.slice(0, 8) : 'account';
  const today = new Date().toISOString().slice(0, 10);
  return `${purpose}/${today}/${scope}/${randomUUID()}.${ext}`;
}

/** Local disk. Development and tests only — refused in production by config. */
export class LocalStorageProvider implements StorageProvider {
  readonly name = 'local';
  private readonly root: string;
  private readonly secret: string;
  private readonly maxBytes: number;

  constructor(cfg: Config) {
    this.root = resolve(cfg.STORAGE_LOCAL_DIR);
    this.secret = cfg.JWT_SECRET;
    this.maxBytes = cfg.UPLOAD_MAX_BYTES;
  }

  private path(objectKey: string): string {
    const target = resolve(join(this.root, objectKey));
    if (!target.startsWith(this.root + '/') && target !== this.root) {
      throw new Error('object key escapes the storage root');
    }
    return target;
  }

  private sign(objectKey: string, expiresAt: number, op: string): string {
    return createHmac('sha256', this.secret).update(`${op}:${objectKey}:${expiresAt}`).digest('hex');
  }

  async createUploadTicket(input: { objectKey: string; contentType: string }): Promise<UploadTicket> {
    const expires = Date.now() + 15 * 60 * 1000;
    const sig = this.sign(input.objectKey, expires, 'put');
    return {
      objectKey: input.objectKey,
      uploadUrl: `/v1/uploads/local/${encodeURIComponent(input.objectKey)}?expires=${expires}&sig=${sig}`,
      method: 'PUT',
      headers: { 'content-type': input.contentType },
      expiresAt: new Date(expires).toISOString(),
    };
  }

  verifyLocalSignature(objectKey: string, expires: number, sig: string, op: string): boolean {
    if (!Number.isFinite(expires) || Date.now() > expires) return false;
    const expected = Buffer.from(this.sign(objectKey, expires, op), 'utf8');
    const given = Buffer.from(sig, 'utf8');
    if (expected.length !== given.length) return false;
    return timingSafeEqual(expected, given);
  }

  async createReadUrl(objectKey: string, ttlSeconds: number): Promise<string> {
    const expires = Date.now() + ttlSeconds * 1000;
    return `/v1/uploads/local/${encodeURIComponent(objectKey)}?expires=${expires}&sig=${this.sign(objectKey, expires, 'get')}`;
  }

  async putObject(objectKey: string, body: Buffer): Promise<void> {
    if (body.length > this.maxBytes) throw new Error('object exceeds configured upload limit');
    const target = this.path(objectKey);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, body);
  }

  async getObject(objectKey: string): Promise<Buffer> {
    const target = this.path(objectKey);
    const info = await stat(target);
    if (info.size > this.maxBytes) throw new Error('object exceeds configured upload limit');
    return readFile(target);
  }

  async deleteObject(objectKey: string): Promise<void> {
    await rm(this.path(objectKey), { force: true });
  }
}

/**
 * S3-compatible storage (AWS S3, Cloudflare R2) with SigV4 presigned URLs
 * generated in-process, so no AWS SDK is pulled into the runtime image.
 */
export class S3StorageProvider implements StorageProvider {
  readonly name: string;
  private readonly bucket: string;
  private readonly endpoint: string;
  private readonly region: string;
  private readonly accessKeyId: string;
  private readonly secretAccessKey: string;
  private readonly maxBytes: number;

  constructor(cfg: Config) {
    if (!cfg.STORAGE_BUCKET || !cfg.STORAGE_ACCESS_KEY_ID || !cfg.STORAGE_SECRET_ACCESS_KEY) {
      throw new Error('S3/R2 storage requires STORAGE_BUCKET, STORAGE_ACCESS_KEY_ID and STORAGE_SECRET_ACCESS_KEY');
    }
    this.name = cfg.STORAGE_PROVIDER;
    this.bucket = cfg.STORAGE_BUCKET;
    this.region = cfg.STORAGE_REGION;
    this.accessKeyId = cfg.STORAGE_ACCESS_KEY_ID;
    this.secretAccessKey = cfg.STORAGE_SECRET_ACCESS_KEY;
    this.maxBytes = cfg.UPLOAD_MAX_BYTES;
    this.endpoint = (cfg.STORAGE_ENDPOINT ?? `https://s3.${cfg.STORAGE_REGION}.amazonaws.com`).replace(/\/$/, '');
  }

  /**
   * The HTTP method is part of SigV4's canonical request. A URL signed for PUT
   * cannot authorize DELETE, even if every path/query byte is identical.
   */
  private presign(method: 'PUT' | 'GET' | 'DELETE', objectKey: string, ttlSeconds: number, extraQuery: Record<string, string> = {}): string {
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);
    const credentialScope = `${dateStamp}/${this.region}/s3/aws4_request`;
    const host = new URL(this.endpoint).host;
    const canonicalUri = `/${this.bucket}/${objectKey.split('/').map(encodeURIComponent).join('/')}`;

    const query: Record<string, string> = {
      'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
      'X-Amz-Credential': `${this.accessKeyId}/${credentialScope}`,
      'X-Amz-Date': amzDate,
      'X-Amz-Expires': String(ttlSeconds),
      'X-Amz-SignedHeaders': 'host',
      ...extraQuery,
    };
    const canonicalQuery = Object.keys(query)
      .sort()
      .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(query[k]!)}`)
      .join('&');

    const canonicalRequest = [
      method, canonicalUri, canonicalQuery, `host:${host}\n`, 'host', 'UNSIGNED-PAYLOAD',
    ].join('\n');

    const stringToSign = [
      'AWS4-HMAC-SHA256', amzDate, credentialScope,
      createHash('sha256').update(canonicalRequest).digest('hex'),
    ].join('\n');

    const hmac = (key: Buffer | string, data: string) => createHmac('sha256', key).update(data).digest();
    const signingKey = hmac(hmac(hmac(hmac(`AWS4${this.secretAccessKey}`, dateStamp), this.region), 's3'), 'aws4_request');
    const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');

    return `${this.endpoint}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
  }

  async createUploadTicket(input: { objectKey: string; contentType: string }): Promise<UploadTicket> {
    const ttl = 900;
    return {
      objectKey: input.objectKey,
      uploadUrl: this.presign('PUT', input.objectKey, ttl),
      method: 'PUT',
      headers: { 'content-type': input.contentType },
      expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
    };
  }

  async createReadUrl(objectKey: string, ttlSeconds: number): Promise<string> {
    return this.presign('GET', objectKey, ttlSeconds);
  }

  /**
   * Never buffer an unbounded remote object.
   *
   * The upload ticket is a direct S3/R2 PUT. The API validates the size the
   * caller DECLARES before issuing it, but the bucket receives the actual bytes
   * without passing through Fastify. Before this guard, a caller could declare
   * a small image, PUT a very large body, then ask OCR to fetch it. arrayBuffer()
   * allocated the entire object before any byte check existed, making one
   * authenticated request enough to put memory pressure on the API process.
   *
   * Content-Length rejects the common case before reading. The streaming count
   * is the authoritative guard for chunked/missing/lying metadata.
   */
  async getObject(objectKey: string): Promise<Buffer> {
    const res = await fetch(this.presign('GET', objectKey, 120), { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`object fetch failed with ${res.status}`);

    const length = Number(res.headers.get('content-length'));
    if (Number.isFinite(length) && length > this.maxBytes) {
      await res.body?.cancel().catch(() => undefined);
      throw new Error('object exceeds configured upload limit');
    }
    if (!res.body) return Buffer.alloc(0);

    const reader = res.body.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > this.maxBytes) {
          await reader.cancel().catch(() => undefined);
          throw new Error('object exceeds configured upload limit');
        }
        chunks.push(Buffer.from(value));
      }
    } finally {
      reader.releaseLock();
    }
    return Buffer.concat(chunks, total);
  }

  async deleteObject(objectKey: string): Promise<void> {
    const res = await fetch(this.presign('DELETE', objectKey, 120), {
      method: 'DELETE',
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok && res.status !== 404) throw new Error(`object delete failed with ${res.status}`);
  }
}

/** No object storage configured. */
export class UnconfiguredStorageProvider implements StorageProvider {
  readonly name = 'unconfigured';

  private refuse(): never {
    throw new AppError(
      ERROR_CODES.PROVIDER_UNAVAILABLE,
      503,
      'Image storage is not configured on this deployment.',
    );
  }

  createUploadTicket(): Promise<UploadTicket> {
    this.refuse();
  }

  createReadUrl(): Promise<string> {
    this.refuse();
  }

  getObject(): Promise<Buffer> {
    this.refuse();
  }

  deleteObject(): Promise<void> {
    this.refuse();
  }
}
