import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import { closePool } from '../src/lib/db.js';
import { buildProviders } from '../src/providers/index.js';
import { loadConfig } from '../src/config.js';
import type { MockSmsProvider, MockWhatsAppProvider, MockPushProvider } from '../src/providers/index.js';
import { createWorkerContext, type WorkerContext } from '../../worker/src/context.js';
import { runTick } from '../../worker/src/index.js';

const ROOT = resolve(import.meta.dirname, '../../..');

export interface Harness {
  app: FastifyInstance;
  sms: MockSmsProvider;
  whatsapp: MockWhatsAppProvider;
  push: MockPushProvider;
  worker: WorkerContext;
  /** Lets a test drive the clock the worker sees. */
  setWorkerNow: (d: Date) => void;
  tick: () => ReturnType<typeof runTick>;
  close: () => Promise<void>;
}

let harness: Harness | null = null;

/** Rebuilds the test database from scratch. Called once per suite file. */
export function resetDatabase(): void {
  execFileSync(resolve(ROOT, 'scripts/db-reset.sh'), ['dawaee_test'], {
    env: { ...process.env, PGHOST: '127.0.0.1', PGPORT: '5433', PGUSER: 'postgres' },
    stdio: 'pipe',
  });
  execFileSync(resolve(ROOT, 'scripts/db-bootstrap-roles.sh'), ['dawaee_test'], {
    env: {
      ...process.env, PGHOST: '127.0.0.1', PGPORT: '5433', PGUSER: 'postgres',
      DAWAEE_APP_PASSWORD: 'devpass', DAWAEE_WORKER_PASSWORD: 'devpass',
    },
    stdio: 'pipe',
  });
}

export async function startHarness(): Promise<Harness> {
  if (harness) return harness;
  const cfg = loadConfig();
  const providers = buildProviders(cfg);
  const { app } = await buildServer({ providers });
  await app.ready();

  let workerNow = new Date();
  const worker = createWorkerContext({ providers, now: () => workerNow });

  harness = {
    app,
    sms: providers.sms as MockSmsProvider,
    whatsapp: providers.whatsapp as MockWhatsAppProvider,
    push: providers.push as MockPushProvider,
    worker,
    setWorkerNow: (d) => {
      workerNow = d;
    },
    tick: () => runTick(worker),
    close: async () => {
      await app.close();
      await worker.pool.end().catch(() => undefined);
      await closePool();
      harness = null;
    },
  };
  return harness;
}

export interface TestUser {
  userId: string;
  phone: string;
  token: string;
  refreshToken: string;
  profileId: string;
}

let ipCounter = 0;
/**
 * Distinct source address per test user. The OTP endpoints are rate limited
 * per IP — correctly — so a suite that signs several users in from one address
 * would otherwise trip its own defences.
 */
function nextRemoteAddress(): string {
  ipCounter += 1;
  return `10.${Math.floor(ipCounter / 254) % 254}.${ipCounter % 254}.2`;
}

/** Registers (or signs in) a user and returns everything a test needs. */
export async function signIn(h: Harness, phone: string, deviceId = `device-${phone}`): Promise<TestUser> {
  const remoteAddress = nextRemoteAddress();
  const request = await h.app.inject({
    method: 'POST', url: '/v1/auth/otp/request', payload: { phone }, remoteAddress,
  });
  const parsed = request.json<{ debugCode?: string; error?: { code: string } }>();
  if (!parsed.debugCode) {
    throw new Error(`OTP request failed for ${phone}: ${JSON.stringify(parsed)}`);
  }
  const code = parsed.debugCode;

  const verify = await h.app.inject({
    method: 'POST', url: '/v1/auth/otp/verify', payload: { phone, code, deviceId }, remoteAddress,
  });
  if (verify.statusCode !== 200) {
    throw new Error(`OTP verify failed for ${phone}: ${verify.body}`);
  }
  const auth = verify.json<{ accessToken: string; refreshToken: string }>();

  const profiles = await h.app.inject({
    method: 'GET', url: '/v1/profiles', headers: { authorization: `Bearer ${auth.accessToken}` },
  });
  const profile = profiles.json<{ profiles: Array<{ id: string }> }>().profiles[0]!;

  const me = await h.app.inject({
    method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${auth.accessToken}` },
  });

  return {
    userId: me.json<{ user: { id: string } }>().user.id,
    phone,
    token: auth.accessToken,
    refreshToken: auth.refreshToken,
    profileId: profile.id,
  };
}

export function authHeaders(user: TestUser) {
  return { authorization: `Bearer ${user.token}` };
}

/**
 * Bypasses the OTP resend cooldown so a suite can sign several users in fast.
 * Runs as the superuser via psql because the application role deliberately
 * cannot touch `auth_otp_challenges` at all.
 */
export async function clearOtpCooldown(phone?: string): Promise<void> {
  const where = phone ? `WHERE phone_e164 = '${phone.replace(/'/g, "''")}'` : '';
  execFileSync('psql', ['-d', 'dawaee_test', '-c',
    `UPDATE auth_otp_challenges SET created_at = created_at - interval '10 minutes' ${where}`], {
    env: { ...process.env, PGHOST: '127.0.0.1', PGPORT: '5433', PGUSER: 'postgres' },
    stdio: 'pipe',
  });
}

export const PANADOL = {
  name: 'Panadol',
  genericName: 'Paracetamol',
  form: 'tablet' as const,
  strengthValue: 500,
  strengthUnit: 'mg' as const,
  foodInstruction: 'after_food' as const,
};
