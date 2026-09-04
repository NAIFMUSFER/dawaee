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
} as NodeJS.ProcessEnv;

const load = (extra: NodeJS.ProcessEnv) => {
  resetConfigCache();
  return loadConfig({ ...base, ...extra });
};

describe('boolean environment variables', () => {
  it('reads the words operators actually write', () => {
    for (const off of ['false', 'FALSE', 'False', ' false ', '0', 'no', 'off']) {
      expect(load({ OTP_DEBUG_ECHO: off }).OTP_DEBUG_ECHO, off).toBe(false);
      expect(load({ TRUST_PROXY: off }).TRUST_PROXY, off).toBe(false);
    }
    for (const on of ['true', 'TRUE', '1', 'yes', 'on']) {
      expect(load({ OTP_DEBUG_ECHO: on }).OTP_DEBUG_ECHO, on).toBe(true);
      expect(load({ TRUST_PROXY: on }).TRUST_PROXY, on).toBe(true);
    }
  });

  it('falls back to the default when unset or blank', () => {
    expect(load({}).TRUST_PROXY).toBe(true);
    expect(load({ TRUST_PROXY: '' }).TRUST_PROXY).toBe(true);
    expect(load({}).OTP_DEBUG_ECHO).toBe(false);
    expect(load({ OTP_DEBUG_ECHO: '' }).OTP_DEBUG_ECHO).toBe(false);
  });

  it('boots in production when the debug flag is the string "false"', () => {
    expect(() => load({ NODE_ENV: 'production', OTP_DEBUG_ECHO: 'false' })).not.toThrow();
    expect(() => load({ NODE_ENV: 'production', OTP_DEBUG_ECHO: 'true' })).toThrow(/OTP_DEBUG_ECHO/);
  });
});
