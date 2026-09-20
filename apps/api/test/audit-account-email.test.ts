import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, resetConfigCache, type Config } from '../src/config.js';
import { auditAccountEmailDeliveryAllowed } from '../src/providers/audit-account-email.js';
import { runtimeEnvironment, validateAccountEmailOptIn } from '../../../scripts/audit-preview-start.mjs';

const io = vi.hoisted(() => ({ drain: vi.fn(async () => undefined) }));
vi.mock('../src/providers/account-email.js', async original => ({
  ...await original<typeof import('../src/providers/account-email.js')>(), drainAccountEmails: io.drain,
}));
import { registerAccountEmailRoutes } from '../src/routes/account-email.js';

const origin = 'https://dawaee-audit-preview.onrender.com';
const ownerUrl = 'postgresql://dawaee_audit_db_user:synthetic-owner-password@dpg-daipq80jo6nc73fsmhhg-a/dawaee_audit_db';
const environment = () => ({
  RENDER_SERVICE_ID: 'srv-daipkbuk1f9s73952trg', RENDER_EXTERNAL_URL: origin, NODE_ENV: 'test', DATABASE_URL: ownerUrl,
  JWT_SECRET: 'synthetic-secret-not-a-real-credential'.repeat(2), IP_HASH_SALT: 'synthetic-salt-for-tests',
  AUDIT_ACCOUNT_EMAIL_DELIVERY: '1', ACCOUNT_EMAIL_PROVIDER: 'resend',
  ACCOUNT_EMAIL_FROM: 'accounts@mail.tadawee.net', ACCOUNT_EMAIL_SENDER_VERIFIED: 'true',
  ACCOUNT_EMAIL_BASE_URL: origin, RESEND_API_KEY: 're_synthetic_never_sent',
});
const emailKeys = ['AUDIT_ACCOUNT_EMAIL_DELIVERY', 'ACCOUNT_EMAIL_PROVIDER', 'ACCOUNT_EMAIL_FROM',
  'ACCOUNT_EMAIL_SENDER_VERIFIED', 'ACCOUNT_EMAIL_BASE_URL', 'RESEND_API_KEY'];
function config(patch: Partial<Config> = {}): Config {
  return { ...loadConfig(), NODE_ENV: 'test',
    DATABASE_URL: ownerUrl.replace('dawaee_audit_db_user', 'dawaee_app'),
    ACCOUNT_EMAIL_PROVIDER: 'resend', ACCOUNT_EMAIL_FROM: 'accounts@mail.tadawee.net',
    ACCOUNT_EMAIL_SENDER_VERIFIED: true, ACCOUNT_EMAIL_BASE_URL: origin,
    RESEND_API_KEY: 're_synthetic_never_sent', ...patch };
}
let app: ReturnType<typeof Fastify> | undefined;
beforeEach(() => { vi.clearAllMocks(); resetConfigCache(); });
afterEach(async () => { await app?.close(); app = undefined; vi.useRealTimers(); vi.unstubAllEnvs(); resetConfigCache(); });

describe('preview email environment boundary', () => {
  it.each([undefined, '0'])('does not forward parent email settings without exact opt-in: %s', flag => {
    const env = { ...environment(), AUDIT_ACCOUNT_EMAIL_DELIVERY: flag };
    for (const role of ['dawaee_app', 'dawaee_worker']) {
      const child = runtimeEnvironment(env, ownerUrl, 'synthetic-runtime-password', role);
      for (const key of emailKeys) expect(child[key]).toBeUndefined();
    }
  });
  it('forwards only the approved email settings to the restricted API, never the worker', () => {
    const env = { ...environment(), UNRELATED_SECRET: 'never-forward', FIREBASE_PRIVATE_KEY: 'never-forward' };
    const api = runtimeEnvironment(env, ownerUrl, 'synthetic-api-password');
    const worker = runtimeEnvironment(env, ownerUrl, 'synthetic-worker-password', 'dawaee_worker');
    for (const key of emailKeys) { expect(api[key]).toBe(env[key as keyof typeof env]); expect(worker[key]).toBeUndefined(); }
    expect(new URL(api.DATABASE_URL).username).toBe('dawaee_app');
    expect(api).toMatchObject({ NODE_ENV: 'test', PUSH_PROVIDER: 'mock', OCR_PROVIDER: 'mock', STORAGE_PROVIDER: 'local', OTP_DEBUG_ECHO: 'false' });
    expect(api.UNRELATED_SECRET).toBeUndefined(); expect(api.FIREBASE_PRIVATE_KEY).toBeUndefined();
    expect(auditAccountEmailDeliveryAllowed(config({ DATABASE_URL: api.DATABASE_URL }), api)).toBe(true);
  });
  it.each([
    { AUDIT_ACCOUNT_EMAIL_DELIVERY: 'true' }, { AUDIT_ACCOUNT_EMAIL_DELIVERY: '' },
    { RENDER_SERVICE_ID: 'production-service' }, { RENDER_EXTERNAL_URL: 'https://dawaee-api.onrender.com' },
    { NODE_ENV: 'production' }, { DATABASE_URL: ownerUrl.replace('dawaee_audit_db', 'production') },
    { ACCOUNT_EMAIL_BASE_URL: 'https://dawaee-api.onrender.com' }, { ACCOUNT_EMAIL_BASE_URL: `${origin}/account-email` },
    { ACCOUNT_EMAIL_PROVIDER: 'disabled' }, { ACCOUNT_EMAIL_FROM: 'unreviewed@example.com' },
    { ACCOUNT_EMAIL_SENDER_VERIFIED: 'false' }, { RESEND_API_KEY: '' },
  ])('rejects an unsafe/partial opt-in before runtime startup: %j', patch => {
    expect(() => validateAccountEmailOptIn({ ...environment(), ...patch })).toThrow(/^AUDIT_[A-Z_]+$/);
  });
  it('rejects a substituted connection even when the environment identifies the preview', () => {
    expect(() => runtimeEnvironment(environment(), ownerUrl.replace('/dawaee_audit_db', '/production'), 'synthetic'))
      .toThrow('AUDIT_ACCOUNT_EMAIL_DATABASE_MISMATCH');
  });
});

describe('API test-mode email exception', () => {
  it.each([
    { NODE_ENV: 'development' }, { NODE_ENV: 'production' }, { ACCOUNT_EMAIL_BASE_URL: 'https://dawaee-api.onrender.com' },
    { ACCOUNT_EMAIL_PROVIDER: 'disabled' }, { ACCOUNT_EMAIL_FROM: 'unreviewed@example.com' },
    { ACCOUNT_EMAIL_SENDER_VERIFIED: false }, { RESEND_API_KEY: '' },
    { DATABASE_URL: ownerUrl },
    { DATABASE_URL: ownerUrl.replace('dawaee_audit_db_user', 'dawaee_worker') },
    { DATABASE_URL: ownerUrl.replace('dawaee_audit_db_user', 'dawaee_app').replace('/dawaee_audit_db', '/production') },
    { DATABASE_URL: ownerUrl.replace('dawaee_audit_db_user', 'dawaee_app').replace('dpg-daipq80jo6nc73fsmhhg-a', 'production.example') },
    { DATABASE_URL: `${ownerUrl.replace('dawaee_audit_db_user', 'dawaee_app')}?options=-crole=postgres` },
    { DATABASE_URL: 'invalid' },
  ])('never authorizes an unbounded API target: %j', patch => {
    expect(auditAccountEmailDeliveryAllowed(config(patch as Partial<Config>), environment())).toBe(false);
  });
  it.each([
    { AUDIT_ACCOUNT_EMAIL_DELIVERY: undefined }, { AUDIT_ACCOUNT_EMAIL_DELIVERY: '0' }, { AUDIT_ACCOUNT_EMAIL_DELIVERY: 'true' },
    { RENDER_SERVICE_ID: 'another-service' }, { RENDER_EXTERNAL_URL: 'https://dawaee-api.onrender.com' },
  ])('requires explicit and exact service identity: %j', patch => {
    expect(auditAccountEmailDeliveryAllowed(config(), { ...environment(), ...patch })).toBe(false);
  });
  it.each(['enabled', 'disabled', 'wrong-target'])('starts the actual route mail timer only for bounded opt-in: %s', async mode => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const env = runtimeEnvironment(environment(), ownerUrl, 'synthetic-runtime-password');
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value as string);
    if (mode === 'disabled') vi.stubEnv('AUDIT_ACCOUNT_EMAIL_DELIVERY', undefined);
    if (mode === 'wrong-target') vi.stubEnv('ACCOUNT_EMAIL_BASE_URL', 'https://dawaee-api.onrender.com');
    resetConfigCache();
    app = Fastify(); registerAccountEmailRoutes(app); await app.ready();
    expect(io.drain).toHaveBeenCalledTimes(mode === 'enabled' ? 1 : 0);
    await vi.advanceTimersByTimeAsync(5000);
    expect(io.drain).toHaveBeenCalledTimes(mode === 'enabled' ? 2 : 0);
    await app.close(); app = undefined;
    expect(vi.getTimerCount()).toBe(0);
  });
});
