import Fastify from 'fastify';
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

describe('Fastify client-IP derivation after Render binding', () => {
  function makeApp() {
    const app = Fastify({
      trustProxy: (_address: string, hop: number) => hop < 1,
      rewriteUrl: (req) => {
        bindTrustedCloudflareClientIp(req.headers, true);
        return req.url ?? '/';
      },
    });
    app.get('/ip', async (req) => ({ ip: req.ip }));
    return app;
  }

  it('makes req.ip equal the Cloudflare edge-authenticated client address, not a forged X-Forwarded-For entry', async () => {
    const app = makeApp();
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/ip',
        remoteAddress: '10.55.0.1',
        headers: {
          'cf-connecting-ip': '203.0.113.25',
          'x-forwarded-for': '1.2.3.4, 5.6.7.8, 9.9.9.9',
        },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ip: '203.0.113.25' });
    } finally {
      await app.close();
    }
  });

  it('falls back to the socket address when trusted edge metadata is absent, never to the forged forwarded address', async () => {
    const app = makeApp();
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/ip',
        remoteAddress: '10.55.0.1',
        headers: { 'x-forwarded-for': '198.51.100.88' },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ip: '10.55.0.1' });
    } finally {
      await app.close();
    }
  });
});
