import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, resetConfigCache } from '../src/config.js';
import { S3StorageProvider } from '../src/providers/storage.js';

function provider(maxBytes = 1024): S3StorageProvider {
  resetConfigCache();
  const cfg = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://test:test@127.0.0.1/test',
    JWT_SECRET: 'x'.repeat(64),
    STORAGE_PROVIDER: 's3',
    STORAGE_ENDPOINT: 'https://objects.example.test',
    STORAGE_BUCKET: 'private-medication-images',
    STORAGE_ACCESS_KEY_ID: 'AKIDEXAMPLE',
    STORAGE_SECRET_ACCESS_KEY: 'test-secret-key-for-signing-only',
    STORAGE_REGION: 'eu-central-1',
    UPLOAD_MAX_BYTES: String(maxBytes),
  });
  return new S3StorageProvider(cfg);
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetConfigCache();
});

describe('red team — declared upload size is part of the OCR trust boundary', () => {
  it('rejects an object whose actual size differs from the size accepted for its upload lease', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6]);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(bytes, {
      status: 200,
      headers: { 'content-length': String(bytes.byteLength) },
    })));

    // Model the contract OCR needs: the database recorded four bytes when the
    // upload lease was issued, but the direct object-store PUT actually landed
    // six. A max-size-only check accepts this today; that is the defect.
    const storage = provider(1024) as S3StorageProvider & {
      getObject(objectKey: string, expectedBytes: number): Promise<Buffer>;
    };

    await expect(storage.getObject('medication_image/lease-mismatch.png', 4))
      .rejects.toThrow(/declared|expected|size.*match/i);
  });
});
