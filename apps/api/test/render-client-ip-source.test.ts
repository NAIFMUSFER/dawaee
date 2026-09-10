import { describe, expect, it } from 'vitest';
import { bindTrustedCloudflareClientIp } from '../src/lib/client-ip.js';

describe('Render trusted client-IP binding', () => {
  it('does nothing unless deployment configuration explicitly enables the trusted edge header', () => {
    const headers = {
      'cf-connecting-ip': '203.0.113.10',
      'x-forwarded-for': '1.2.3.4, 5.6.7.8',
    };

    bindTrustedCloudflareClientIp(headers, false);
    expect(headers['x-forwarded-for']).toBe('1.2.3.4, 5.6.7.8');
  });

  it('replaces a caller-supplied forwarded chain with the edge-authenticated IPv4 address', () => {
    const headers = {
      'cf-connecting-ip': '203.0.113.25',
      'x-forwarded-for': '1.2.3.4, 5.6.7.8, 9.9.9.9',
    };

    bindTrustedCloudflareClientIp(headers, true);
    expect(headers['x-forwarded-for']).toBe('203.0.113.25');
  });

  it('accepts a valid IPv6 client address', () => {
    const headers = {
      'cf-connecting-ip': '2001:db8:1234:5678::99',
      'x-forwarded-for': '1.2.3.4',
    };

    bindTrustedCloudflareClientIp(headers, true);
    expect(headers['x-forwarded-for']).toBe('2001:db8:1234:5678::99');
  });

  it('fails closed when the trusted edge header is malformed', () => {
    const headers: Record<string, string | string[] | undefined> = {
      'cf-connecting-ip': 'not-an-ip',
      'x-forwarded-for': '198.51.100.77',
    };

    bindTrustedCloudflareClientIp(headers, true);
    expect(headers['x-forwarded-for']).toBeUndefined();
  });

  it('fails closed when the trusted edge header is missing instead of trusting X-Forwarded-For', () => {
    const headers: Record<string, string | string[] | undefined> = {
      'x-forwarded-for': '198.51.100.88',
    };

    bindTrustedCloudflareClientIp(headers, true);
    expect(headers['x-forwarded-for']).toBeUndefined();
  });
});
