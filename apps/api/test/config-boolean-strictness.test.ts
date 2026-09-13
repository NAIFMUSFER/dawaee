import { describe, expect, it } from 'vitest';
import { loadConfig, resetConfigCache } from '../src/config.js';

const base = {
  DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/x',
  JWT_SECRET: 'x'.repeat(64),
} as NodeJS.ProcessEnv;

function expectInvalidBoolean(name: string, value: string): void {
  resetConfigCache();
  expect(
    () => loadConfig({ ...base, [name]: value }),
    `${name}=${value} must not silently fall back to its default`,
  ).toThrow(new RegExp(name));
}

describe('strict boolean environment parsing', () => {
  it('rejects misspellings instead of silently changing authentication or proxy policy', () => {
    expectInvalidBoolean('PASSWORD_LOGIN_ENABLED', 'flase');
    expectInvalidBoolean('TRUST_CF_CONNECTING_IP', 'tru');
    expectInvalidBoolean('OTP_DEBUG_ECHO', 'enabled');
  });

  it('rejects arbitrary non-boolean strings and numeric values outside 0/1', () => {
    for (const value of ['disabled', '2', '-1', 'maybe']) {
      expectInvalidBoolean('PASSWORD_LOGIN_ENABLED', value);
    }
  });
});
