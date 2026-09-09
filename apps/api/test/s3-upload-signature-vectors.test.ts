import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, resetConfigCache } from '../src/config.js';
import { S3StorageProvider } from '../src/providers/storage.js';

const KEY = 'medication_image/2026-09-09/account/example.png';
const NOW = new Date('2026-09-09T12:34:56.000Z');

// Independent reference: botocore 1.43.18 S3SigV4QueryAuth, fixed timestamp,
// endpoint/bucket/key/region/credentials below, PUT expiry 900. These are
// synthetic test credentials; generating the vectors makes no network call.
// Keeping the SDK-derived signatures literal catches a signer that merely
// lists content-type but omits its VALUE from the canonical request.
const IMAGE_SIGNATURES = [
  ['image/jpeg', 'ebe86406d6000a70922e94e680c68d2c165c05dbf92420b7298787a3ab3e4a13'],
  ['image/png', 'c7f8bcfe5d142f77c00ed420ca02a0247e924d477fb623b6c2d4dda0bdfedf5d'],
  ['image/webp', '3d3d08c6c7974243f5e8be166f94ce4fe0347c28194663b07e61841e887fdc00'],
  ['image/heic', '704ac449f649a10dc1f13274066b92f9580c1559a79f30ab945f330414c26a61'],
] as const;

function provider(kind: 's3' | 'r2'): S3StorageProvider {
  resetConfigCache();
  return new S3StorageProvider(loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://test:test@127.0.0.1/test',
    JWT_SECRET: 'x'.repeat(64),
    STORAGE_PROVIDER: kind,
    STORAGE_ENDPOINT: 'https://objects.example.test',
    STORAGE_BUCKET: 'private-medication-images',
    STORAGE_ACCESS_KEY_ID: 'AKIDEXAMPLE',
    STORAGE_SECRET_ACCESS_KEY: 'test-secret-key-for-signing-only',
    STORAGE_REGION: 'eu-central-1',
    UPLOAD_MAX_BYTES: '1048576',
  }));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  resetConfigCache();
});

for (const kind of ['s3', 'r2'] as const) {
  describe(`${kind} upload signatures match the independent AWS SDK`, () => {
    it.each(IMAGE_SIGNATURES)('binds %s to its canonical request', async (contentType, signature) => {
      const ticket = await provider(kind).createUploadTicket({ objectKey: KEY, contentType });
      const url = new URL(ticket.uploadUrl);
      expect(ticket.headers).toEqual({ 'content-type': contentType });
      expect(ticket.method).toBe('PUT');
      expect(ticket.objectKey).toBe(KEY);
      expect(ticket.expiresAt).toBe('2026-09-09T12:49:56.000Z');
      expect(url.searchParams.get('X-Amz-Expires')).toBe('900');
      expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('content-type;host');
      expect(url.searchParams.get('X-Amz-Signature')).toBe(signature);
    });

    it('does not authenticate a changed or omitted Content-Type with the PNG signature', async () => {
      const ticket = await provider(kind).createUploadTicket({ objectKey: KEY, contentType: 'image/png' });
      const signature = new URL(ticket.uploadUrl).searchParams.get('X-Amz-Signature');
      expect(signature).toBe(IMAGE_SIGNATURES[1][1]);
      // SDK references for the same key, time, credentials, method and expiry,
      // with text/html or no Content-Type, respectively. Not a live S3 rejection.
      expect(signature).not.toBe('406fe4bcf4cde7cb597c911b91289c883693fbf1d5bd6adea90c0d88a4f81df8');
      expect(signature).not.toBe('d07130ff4857e5dee66d3a7e116a119ca35b14e93dbe62bb392f341a1922965f');
    });

    it('keeps signed GET URLs compatible without requiring an upload header', async () => {
      const url = new URL(await provider(kind).createReadUrl(KEY, 300));
      expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('host');
      expect(url.searchParams.get('X-Amz-Expires')).toBe('300');
      expect(url.searchParams.get('X-Amz-Signature'))
        .toBe('07939fd4d18cfd49f48686ad97efe935c05d02579f139a4ca63481b49d5e4e68');
    });

    it('keeps DELETE method and signature compatible with the SDK reference', async () => {
      let requested = '';
      let method = '';
      vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        requested = String(input);
        method = init?.method ?? 'GET';
        return new Response(null, { status: 204 });
      }));
      await provider(kind).deleteObject(KEY);
      const url = new URL(requested);
      expect(method).toBe('DELETE');
      expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('host');
      expect(url.searchParams.get('X-Amz-Expires')).toBe('120');
      expect(url.searchParams.get('X-Amz-Signature'))
        .toBe('ff4afa849dd4b9ad763e5b386dc6e285dddb365dca212e24be774473459cacf1');
    });
  });
}
