import { describe, expect, it } from 'vitest';
import { serializeRequest } from '../src/lib/logger.js';

describe('request-log client-address privacy', () => {
  it('keeps route diagnostics while the raw client address never reaches the application log', () => {
    const ip = '203.0.113.42';
    const serialized = serializeRequest({
      method: 'GET',
      url: '/v1/medications?status=active',
      headers: { host: 'dawaee-audit-preview.onrender.com' },
      ip,
    }, 'audit-log-test-salt');

    expect(serialized).toMatchObject({
      method: 'GET',
      url: '/v1/medications?status=active',
      host: 'dawaee-audit-preview.onrender.com',
    });
    expect(serialized.remoteAddress).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.stringify(serialized)).not.toContain(ip);
  });

  it('keeps correlation deterministic inside one environment without making it portable across salts', () => {
    const req = { method: 'POST', url: '/v1/auth/login', headers: { host: 'preview' }, ip: '2001:db8::42' };
    const first = serializeRequest(req, 'environment-a');
    const repeated = serializeRequest(req, 'environment-a');
    const otherEnvironment = serializeRequest(req, 'environment-b');

    expect(first.remoteAddress).toBe(repeated.remoteAddress);
    expect(first.remoteAddress).not.toBe(otherEnvironment.remoteAddress);
    expect(JSON.stringify(first)).not.toContain(req.ip);
  });

  it('does not invent an address fingerprint when Fastify has no client address', () => {
    expect(serializeRequest({ method: 'GET', url: '/health', headers: {} }, 'environment-a').remoteAddress).toBeUndefined();
  });
});
