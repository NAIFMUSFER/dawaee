import { describe, expect, it, vi } from 'vitest';
import type { FastifyRequest } from 'fastify';

const warn = vi.fn();

vi.mock('../src/auth/tokens.js', () => ({ verifyAccessToken: vi.fn() }));
vi.mock('../src/auth/session-service.js', () => ({ assertSessionLive: vi.fn() }));
vi.mock('../src/lib/db.js', () => ({
  hashIp: (ip: string) => `hash:${ip}`,
  withTransaction: vi.fn(),
}));
vi.mock('../src/config.js', () => ({
  loadConfig: () => ({ TRUST_PROXY_HOPS: 1 }),
}));

const { attachRequestContext } = await import('../src/middleware/context.js');

function request(url: string, ip: string): FastifyRequest {
  return {
    url,
    ip,
    ips: [ip],
    headers: {},
    log: { warn },
    ipHash: null,
  } as unknown as FastifyRequest;
}

describe('proxy-depth production diagnostic', () => {
  it('ignores Render private health probes but still warns on the first private non-health client observation', () => {
    const health = request('/health', '10.216.25.186');
    attachRequestContext(health);

    expect(warn).not.toHaveBeenCalled();
    expect(health.ipHash).toBe('hash:10.216.25.186');

    const firstClient = request('/v1/auth/login', '10.216.25.186');
    attachRequestContext(firstClient);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(firstClient.ipHash).toBe('hash:10.216.25.186');

    const laterClient = request('/v1/profiles', '10.216.25.186');
    attachRequestContext(laterClient);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
