import { describe, expect, it } from 'vitest';
import { loadConfig, resetConfigCache } from '../src/config.js';

const base = {
  DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/x',
  DATABASE_SSL: 'true',
  JWT_SECRET: 'x'.repeat(64),
  IP_HASH_SALT: 'not-the-dev-salt',
  STORAGE_PROVIDER: 'r2',
  PUSH_PROVIDER: 'expo',
} as NodeJS.ProcessEnv;

function load(extra: NodeJS.ProcessEnv) {
  resetConfigCache();
  return loadConfig({ ...base, ...extra });
}

describe('PUBLIC_APP_URL transport safety', () => {
  it('rejects a malformed public application URL', () => {
    expect(() => load({ PUBLIC_APP_URL: 'not a URL' })).toThrow(/PUBLIC_APP_URL/i);
  });

  it('requires HTTPS in production because emergency QR capabilities live in the fragment', () => {
    expect(() => load({ NODE_ENV: 'production', PUBLIC_APP_URL: 'http://dawaee.app' }))
      .toThrow(/PUBLIC_APP_URL.*https|https.*PUBLIC_APP_URL/i);
    expect(() => load({ NODE_ENV: 'production', PUBLIC_APP_URL: 'https://dawaee.app' }))
      .not.toThrow();
  });
});
