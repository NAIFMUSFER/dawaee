import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, resetConfigCache } from '../src/config.js';
import { S3StorageProvider } from '../src/providers/storage.js';

const KEY = 'medication_image/2026-09-09/account/example.png';
const NOW = new Date('2026-09-09T12:34:56.000Z');

// Independent reference: botocore 1.43.18 S3SigV4QueryAuth, fixed timestamp,
// endpoint/bucket/key/region/credentials below, PUT expiry 900, with the
// create-only If-None-Match: * precondition. These are synthetic credentials;
// generating the vectors makes no network call. Literal SDK-derived signatures
// catch a signer that lists either signed header but omits its VALUE from the
// canonical request.
const IMAGE_SIGNATURES = [
  ['image/jpeg', 'fec24d191803a12c96dd0331bebd313936fe01a2d4a76fc212f48d7c637b5ca1'],
  ['image/png', 'ab67495289ac3189b883e9e6b76fa603c52e98686f3534603ebe8511d96fe327'],
  ['image/webp', '012b0be9e87363048b318d9f22a626ea632a2252c218b440546e0bab292fec44'],
  ['image/heic', '50726c05d84aace4104c6e92185b2faf511338dd3cc064b80301c2ba348fa252'],
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
    it.each(IMAGE_SIGNATURES)('binds %s and create-only semantics to its canonical request', async (contentType, signature) => {
      const ticket = await provider(kind).createUploadTicket({ objectKey: KEY, contentType });
      const url = new URL(ticket.uploadUrl);
      expect(ticket.headers).toEqual({
        'content-type': contentType,
        'if-none-match': '*',
      });
      expect(ticket.method).toBe('PUT');
      expect(ticket.objectKey).toBe(KEY);
      expect(ticket.expiresAt).toBe('2026-09-09T12:49:56.000Z');
      expect(url.searchParams.get('X-Amz-Expires')).toBe('900');
      expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('content-type;host;if-none-match');
      expect(url.searchParams.get('X-Amz-Signature')).toBe(signature);
    });

    it('does not authenticate a changed or omitted upload contract with the PNG signature', async () => {
      const ticket = await provider(kind).createUploadTicket({ objectKey: KEY, contentType: 'image/png' });
      const signature = new URL(ticket.uploadUrl).searchParams.get('X-Amz-Signature');
      expect(signature).toBe(IMAGE_SIGNATURES[1][1]);
      // Independent SDK references for the same key/time/credentials/method and
      // expiry, with text/html + If-None-Match, no Content-Type, or no
      // If-None-Match respectively. None may authenticate as the issued ticket.
      expect(signature).not.toBe('23a76529ef3eaf6f09bc18b97158e15f02b933506f30c4ba357f4453f5ce62ed');
      expect(signature).not.toBe('ed7eea08cd81d9d8667859d0d4065dd69189bbf20d97c1d5d2d058ae4379c7eb');
      expect(signature).not.toBe('c7f8bcfe5d142f77c00ed420ca02a0247e924d477fb623b6c2d4dda0bdfedf5d');
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
