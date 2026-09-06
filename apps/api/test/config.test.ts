import { describe, expect, it } from 'vitest';
import { loadConfig, resetConfigCache } from '../src/config.js';

/**
 * These exist because of a real production incident: the API refused to boot
 * with "OTP_DEBUG_ECHO must be false in production" while the environment had
 * it set to exactly that — "false". `z.coerce.boolean()` is `Boolean()`, and
 * `Boolean('false')` is true, so the word turned the flag ON.
 */
const base = {
  DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/x',
  JWT_SECRET: 'x'.repeat(64),
  IP_HASH_SALT: 'not-the-dev-salt',
  STORAGE_PROVIDER: 'r2',
  // A production boot now also requires verified database TLS. This fixture is
  // about the boolean parsing above, so it satisfies that guard rather than
  // working around it — see db-tls.test.ts for the guard's own coverage.
  DATABASE_SSL: 'true',
} as NodeJS.ProcessEnv;

const load = (extra: NodeJS.ProcessEnv) => {
  resetConfigCache();
  return loadConfig({ ...base, ...extra });
};

describe('boolean environment variables', () => {
  it('reads the words operators actually write', () => {
    for (const off of ['false', 'FALSE', 'False', ' false ', '0', 'no', 'off']) {
      expect(load({ OTP_DEBUG_ECHO: off }).OTP_DEBUG_ECHO, off).toBe(false);
      expect(load({ PASSWORD_LOGIN_ENABLED: off }).PASSWORD_LOGIN_ENABLED, off).toBe(false);
    }
    for (const on of ['true', 'TRUE', '1', 'yes', 'on']) {
      expect(load({ OTP_DEBUG_ECHO: on }).OTP_DEBUG_ECHO, on).toBe(true);
      expect(load({ PASSWORD_LOGIN_ENABLED: on }).PASSWORD_LOGIN_ENABLED, on).toBe(true);
    }
  });

  it('falls back to the default when unset or blank', () => {
    expect(load({}).PASSWORD_LOGIN_ENABLED).toBe(true);
    expect(load({ PASSWORD_LOGIN_ENABLED: '' }).PASSWORD_LOGIN_ENABLED).toBe(true);
    expect(load({}).OTP_DEBUG_ECHO).toBe(false);
    expect(load({ OTP_DEBUG_ECHO: '' }).OTP_DEBUG_ECHO).toBe(false);
  });

  it('boots in production when the debug flag is the string "false"', () => {
    expect(() => load({ NODE_ENV: 'production', OTP_DEBUG_ECHO: 'false' })).not.toThrow();
    expect(() => load({ NODE_ENV: 'production', OTP_DEBUG_ECHO: 'true' })).toThrow(/OTP_DEBUG_ECHO/);
  });
});

/**
 * The proxy setting is a HOP COUNT, not a boolean.
 *
 * `trustProxy: true` makes Fastify read the leftmost X-Forwarded-For entry as
 * the client address, and the leftmost entry is written by the client. Every
 * IP-keyed rate limit in the app depends on this value being trustworthy.
 */
describe('TRUST_PROXY_HOPS', () => {
  it('defaults to one hop — Render terminates TLS at exactly one proxy', () => {
    expect(load({}).TRUST_PROXY_HOPS).toBe(1);
  });

  it('is a number, so it can never be the string "true"', () => {
    expect(() => load({ TRUST_PROXY_HOPS: 'true' })).toThrow();
    expect(() => load({ TRUST_PROXY_HOPS: 'yes' })).toThrow();
  });

  it('accepts 0 for a deployment with nothing in front of it', () => {
    expect(load({ TRUST_PROXY_HOPS: '0' }).TRUST_PROXY_HOPS).toBe(0);
  });

  it('refuses a negative or absurd hop count', () => {
    expect(() => load({ TRUST_PROXY_HOPS: '-1' })).toThrow();
    expect(() => load({ TRUST_PROXY_HOPS: '99' })).toThrow();
  });
});
