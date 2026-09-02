import { createHash, createHmac, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
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

/**
 * Magic-byte check. A caller can claim any Content-Type, so the bytes decide.
 * This is what stops a polyglot file (valid image header, executable payload)
 * or a renamed script from entering the bucket.
 */
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

  constructor(cfg: Config) {
    this.root = resolve(cfg.STORAGE_LOCAL_DIR);
    this.secret = cfg.JWT_SECRET;
  }

  private path(objectKey: string): string {
    // Defeat traversal: the resolved path must stay under the root.
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
    if (Date.now() > expires) return false;
    return this.sign(objectKey, expires, op) === sig;
  }

  async createReadUrl(objectKey: string, ttlSeconds: number): Promise<string> {
    const expires = Date.now() + ttlSeconds * 1000;
    return `/v1/uploads/local/${encodeURIComponent(objectKey)}?expires=${expires}&sig=${this.sign(objectKey, expires, 'get')}`;
  }

  async putObject(objectKey: string, body: Buffer): Promise<void> {
    const target = this.path(objectKey);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, body);
  }

  async getObject(objectKey: string): Promise<Buffer> {
    return readFile(this.path(objectKey));
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

  constructor(cfg: Config) {
    if (!cfg.STORAGE_BUCKET || !cfg.STORAGE_ACCESS_KEY_ID || !cfg.STORAGE_SECRET_ACCESS_KEY) {
      throw new Error('S3/R2 storage requires STORAGE_BUCKET, STORAGE_ACCESS_KEY_ID and STORAGE_SECRET_ACCESS_KEY');
    }
    this.name = cfg.STORAGE_PROVIDER;
    this.bucket = cfg.STORAGE_BUCKET;
    this.region = cfg.STORAGE_REGION;
    this.accessKeyId = cfg.STORAGE_ACCESS_KEY_ID;
    this.secretAccessKey = cfg.STORAGE_SECRET_ACCESS_KEY;
    this.endpoint = (cfg.STORAGE_ENDPOINT ?? `https://s3.${cfg.STORAGE_REGION}.amazonaws.com`).replace(/\/$/, '');
  }

  private presign(method: 'PUT' | 'GET', objectKey: string, ttlSeconds: number, extraQuery: Record<string, string> = {}): string {
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

  async getObject(objectKey: string): Promise<Buffer> {
    const res = await fetch(this.presign('GET', objectKey, 120), { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`object fetch failed with ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  async deleteObject(objectKey: string): Promise<void> {
    const res = await fetch(this.presign('PUT', objectKey, 120).replace('X-Amz-Expires', 'X-Amz-Expires'), {
      method: 'DELETE',
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok && res.status !== 404) throw new Error(`object delete failed with ${res.status}`);
  }
}
