import { createHash, createHmac } from 'node:crypto';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, resetConfigCache } from '../src/config.js';
import { LocalStorageProvider, S3StorageProvider } from '../src/providers/storage.js';

const ACCESS = 'AKIDEXAMPLE';
const SECRET = 'test-secret-key-for-signing-only';
const ENDPOINT = 'https://objects.example.test';
const BUCKET = 'private-medication-images';
const REGION = 'eu-central-1';
const tempRoots: string[] = [];

function provider(maxBytes = 32): S3StorageProvider {
  resetConfigCache();
  const cfg = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://test:test@127.0.0.1/test',
    JWT_SECRET: 'x'.repeat(64),
    STORAGE_PROVIDER: 's3',
    STORAGE_ENDPOINT: ENDPOINT,
    STORAGE_BUCKET: BUCKET,
    STORAGE_ACCESS_KEY_ID: ACCESS,
    STORAGE_SECRET_ACCESS_KEY: SECRET,
    STORAGE_REGION: REGION,
    UPLOAD_MAX_BYTES: String(maxBytes),
  });
  return new S3StorageProvider(cfg);
}

async function localProvider(maxBytes = 32): Promise<{ provider: LocalStorageProvider; root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dawaee-local-storage-'));
  tempRoots.push(root);
  resetConfigCache();
  const cfg = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://test:test@127.0.0.1/test',
    JWT_SECRET: 'x'.repeat(64),
    STORAGE_PROVIDER: 'local',
    STORAGE_LOCAL_DIR: root,
    UPLOAD_MAX_BYTES: String(maxBytes),
  });
  return { provider: new LocalStorageProvider(cfg), root };
}

function physicalLocalPath(root: string, objectKey: string): string {
  const digest = createHash('sha256').update(objectKey, 'utf8').digest('hex');
  return join(root, digest.slice(0, 2), digest);
}

function expectedPresignedDelete(objectKey: string, now: Date): string {
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const credentialScope = `${dateStamp}/${REGION}/s3/aws4_request`;
  const host = new URL(ENDPOINT).host;
  const canonicalUri = `/${BUCKET}/${objectKey.split('/').map(encodeURIComponent).join('/')}`;
  const query: Record<string, string> = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${ACCESS}/${credentialScope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': '120',
    'X-Amz-SignedHeaders': 'host',
  };
  const canonicalQuery = Object.keys(query).sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(query[k]!)}`).join('&');
  const canonicalRequest = [
    'DELETE', canonicalUri, canonicalQuery, `host:${host}\n`, 'host', 'UNSIGNED-PAYLOAD',
  ].join('\n');
  const stringToSign = [
    'AWS4-HMAC-SHA256', amzDate, credentialScope,
    createHash('sha256').update(canonicalRequest).digest('hex'),
  ].join('\n');
  const hmac = (key: Buffer | string, data: string) => createHmac('sha256', key).update(data).digest();
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${SECRET}`, dateStamp), REGION), 's3'), 'aws4_request');
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');
  return `${ENDPOINT}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  resetConfigCache();
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('P20 local object storage treats keys as identifiers, not host paths', () => {
  it('maps even traversal-shaped logical keys to a fixed hash path under the configured root', async () => {
    const { provider: local, root } = await localProvider();
    const key = '../../outside/prescription.png';
    const bytes = Buffer.from([1, 2, 3, 4]);

    await local.putObject(key, bytes);
    await expect(local.getObject(key)).resolves.toEqual(bytes);

    const expected = physicalLocalPath(root, key);
    expect(expected.startsWith(root)).toBe(true);
    await expect(import('node:fs/promises').then(({ readFile }) => readFile(expected))).resolves.toEqual(bytes);
  });

  it('refuses a symlink planted at the hashed object path instead of following it', async () => {
    const { provider: local, root } = await localProvider();
    const key = 'medication_image/2026-09-09/account/symlink-test.png';
    const target = physicalLocalPath(root, key);
    await mkdir(join(root, createHash('sha256').update(key).digest('hex').slice(0, 2)), { recursive: true });

    const outside = join(tmpdir(), `dawaee-outside-${Date.now()}-${Math.random()}.txt`);
    tempRoots.push(outside);
    await writeFile(outside, Buffer.from('sensitive-outside-file'));
    await symlink(outside, target);

    await expect(local.getObject(key)).rejects.toThrow();
  });

  it('checks size and reads bytes through one file descriptor', async () => {
    const { provider: local } = await localProvider(4);
    const key = 'medication_image/2026-09-09/account/too-large.png';
    // The write path rejects the oversized object before it can land.
    await expect(local.putObject(key, Buffer.alloc(5))).rejects.toThrow(/configured upload limit/i);
  });
});

describe('P20 S3 object storage fails closed on actual bytes', () => {
  it('rejects an oversized Content-Length without requesting a reader', async () => {
    let cancelled = false;
    let readerRequested = false;

    // Do not use a real WHATWG ReadableStream for this assertion. Its scheduler
    // may call pull() as soon as Response wraps the stream, before application
    // code has touched response.body at all. That would test the runtime's
    // eager stream scheduling rather than this provider's control flow.
    const oversizedResponse = {
      ok: true,
      headers: {
        get(name: string) { return name.toLowerCase() === 'content-length' ? '64' : null; },
      },
      body: {
        async cancel() { cancelled = true; },
        getReader() {
          readerRequested = true;
          throw new Error('reader must not be requested for a known oversized body');
        },
      },
    } as unknown as Response;
    vi.stubGlobal('fetch', vi.fn(async () => oversizedResponse));

    await expect(provider(32).getObject('medication_image/x.png'))
      .rejects.toThrow(/configured upload limit/i);
    expect(cancelled).toBe(true);
    expect(readerRequested).toBe(false);
  });

  it('also stops a chunked body whose Content-Length is absent', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(20));
        controller.enqueue(new Uint8Array(20));
        controller.close();
      },
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 200 })));

    await expect(provider(32).getObject('medication_image/x.png'))
      .rejects.toThrow(/configured upload limit/i);
  });

  it('still returns an ordinary object below the cap', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(bytes, { status: 200 })));
    await expect(provider(32).getObject('medication_image/x.png'))
      .resolves.toEqual(Buffer.from(bytes));
  });
});

describe('P20 S3 deletion signs the method it actually sends', () => {
  it('uses a DELETE SigV4 canonical request, not the old PUT signature', async () => {
    const now = new Date('2026-09-09T00:00:00.000Z');
    vi.useFakeTimers();
    vi.setSystemTime(now);
    let requestedUrl = '';
    let requestedMethod = '';
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      requestedUrl = String(input);
      requestedMethod = init?.method ?? 'GET';
      return new Response(null, { status: 204 });
    }));

    const key = 'prescription_image/2026-09-09/abcd1234/deadbeef.jpg';
    await provider().deleteObject(key);

    expect(requestedMethod).toBe('DELETE');
    expect(requestedUrl).toBe(expectedPresignedDelete(key, now));
  });
});
