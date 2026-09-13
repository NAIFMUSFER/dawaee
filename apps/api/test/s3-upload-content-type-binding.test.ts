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

describe('production S3 upload tickets bind the immutable image contract', () => {
  it('cryptographically signs Content-Type and the create-only precondition', async () => {
    const ticket = await provider().createUploadTicket({
      objectKey: 'medication_image/2026-09-09/account/example.png',
      contentType: 'image/png',
      byteSize: 128,
    });

    expect(ticket.headers).toEqual({
      'content-type': 'image/png',
      'if-none-match': '*',
    });

    // SigV4 only authenticates headers named by X-Amz-SignedHeaders. Content-
    // Type prevents type substitution; If-None-Match: * makes PutObject fail if
    // this randomized key already exists. That is the production S3/R2
    // counterpart to the local O_EXCL regression: a still-live presigned URL
    // cannot replace bytes after /v1/uploads/finalize has verified them.
    const signedHeaders = new URL(ticket.uploadUrl).searchParams.get('X-Amz-SignedHeaders');
    expect(signedHeaders?.split(';')).toContain('content-type');
    expect(signedHeaders?.split(';')).toContain('if-none-match');
  });
});
