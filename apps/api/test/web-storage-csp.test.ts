import { describe, expect, it } from 'vitest';
import { buildCsp } from '../src/routes/web-app.js';

const directive = (csp: string, name: string) => csp.split('; ').find(value => value.startsWith(`${name} `));

describe('private medication images under the app CSP', () => {
  it('allows only the configured R2 origin for upload and display', () => {
    const csp = buildCsp('hash', { STORAGE_PROVIDER: 'r2', STORAGE_ENDPOINT: 'https://synthetic.r2.cloudflarestorage.com/', STORAGE_REGION: 'auto' });
    expect(directive(csp, 'connect-src')).toBe("connect-src 'self' data: blob: https://synthetic.r2.cloudflarestorage.com");
    expect(directive(csp, 'img-src')).toBe("img-src 'self' data: blob: https://synthetic.r2.cloudflarestorage.com");
    expect(directive(csp, 'script-src')).toBe("script-src 'self' 'sha256-hash'");
    expect(csp).not.toContain('https:;');
    expect(csp).not.toContain('*');
  });
  it('uses the same default regional S3 endpoint as the signer', () => {
    expect(directive(buildCsp('hash', { STORAGE_PROVIDER: 's3', STORAGE_REGION: 'me-south-1' }), 'img-src'))
      .toContain('https://s3.me-south-1.amazonaws.com');
  });
  it('local storage retains same-origin network access and picker data/blob access', () => {
    expect(directive(buildCsp('hash', { STORAGE_PROVIDER: 'local', STORAGE_REGION: 'auto' }), 'connect-src'))
      .toBe("connect-src 'self' data: blob:");
  });
  it('does not interpolate an endpoint query/path into the policy', () => {
    const csp = buildCsp('hash', { STORAGE_PROVIDER: 'r2', STORAGE_REGION: 'auto', STORAGE_ENDPOINT: 'https://images.invalid/path?x=;script-src%20*' });
    expect(csp).not.toContain('/path');
    expect(csp.match(/script-src/g)).toHaveLength(1);
  });
  it('refuses non-network or credential-bearing storage origins', () => {
    for (const endpoint of ['data:text/plain,hello', 'https://user:pass@images.invalid']) {
      expect(() => buildCsp('hash', { STORAGE_PROVIDER: 's3', STORAGE_REGION: 'auto', STORAGE_ENDPOINT: endpoint })).toThrow('invalid image storage origin');
    }
  });
});
