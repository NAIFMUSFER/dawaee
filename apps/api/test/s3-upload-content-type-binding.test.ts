import { describe, expect, it } from 'vitest';
import { loadConfig, resetConfigCache } from '../src/config.js';
import { S3StorageProvider } from '../src/providers/storage.js';

function provider(): S3StorageProvider {
  resetConfigCache();
  return new S3StorageProvider(loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://test:test@127.0.0.1/test',
    JWT_SECRET: 'x'.repeat(64),
    STORAGE_PROVIDER: 's3',
    STORAGE_ENDPOINT: 'https://objects.example.test',
    STORAGE_BUCKET: 'private-medication-images',
    STORAGE_ACCESS_KEY_ID: 'AKIDEXAMPLE',
    STORAGE_SECRET_ACCESS_KEY: 'test-secret-key-for-signing-only',
    STORAGE_REGION: 'eu-central-1',
    UPLOAD_MAX_BYTES: '1048576',
  }));
}

describe('production S3 upload tickets bind the declared image type', () => {
  it('cryptographically signs Content-Type instead of leaving it caller-mutable', async () => {
    const ticket = await provider().createUploadTicket({
      objectKey: 'medication_image/2026-09-09/account/example.png',
      contentType: 'image/png',
      byteSize: 128,
    });

    expect(ticket.headers).toEqual({ 'content-type': 'image/png' });

    // SigV4 only authenticates headers named by X-Amz-SignedHeaders. If
    // Content-Type is absent here, a client holding this PUT URL can replace the
    // advertised image type with text/html (or another value) without changing
    // the signature. The direct S3/R2 upload path then stores that attacker-
    // chosen response Content-Type and /v1/uploads/url later issues a signed GET
    // URL for it. This test is deliberately provider-only: it proves the
    // cryptographic ticket contract without making a paid/live object-store call.
    const signedHeaders = new URL(ticket.uploadUrl).searchParams.get('X-Amz-SignedHeaders');
    expect(signedHeaders?.split(';')).toContain('content-type');
  });
});
