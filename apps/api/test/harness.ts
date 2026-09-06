import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import { closePool } from '../src/lib/db.js';
import { buildProviders } from '../src/providers/index.js';
import { loadConfig } from '../src/config.js';
import type { MockPushProvider } from '../src/providers/index.js';
import { createWorkerContext, type WorkerContext } from '../../worker/src/context.js';
import { runTick } from '../../worker/src/index.js';
import { resetClockSource, setClockSource } from '../src/lib/clock.js';

const ROOT = resolve(import.meta.dirname, '../../..');

export interface Harness {
  app: FastifyInstance;
  push: MockPushProvider;
  worker: WorkerContext;
  /** Lets a test drive the clock the worker sees. */
  setWorkerNow: (d: Date) => void;
  /**
   * Lets a test drive the clock the API sees, so a scenario can place the
   * server at the moment it is about. Moving both clocks together is what
   * makes a timed scenario (late confirmation, expiry, escalation) assertable.
   */
  setServerNow: (d: Date) => void;
  /** Moves the API and worker clocks together. */
  setNow: (d: Date) => void;
  tick: () => ReturnType<typeof runTick>;
  close: () => Promise<void>;
}

let harness: Harness | null = null;

/**
 * Rebuilds the test database from scratch. Called once per suite file.
 *
 * The database it produces is owned by `dawaee_migrator`, which is deliberately
 * NOSUPERUSER and NOBYPASSRLS. That is not incidental: when this database was
 * owned by `postgres`, every `app.*` SECURITY DEFINER function ran with an
 * unconditional row-level-security bypass that no managed PostgreSQL grants,
 * and the whole suite proved its properties against a configuration production
 * does not have. Registration was broken on a realistic owner while 1013 tests
 * passed. See db/maintenance/definer_policies.sql.
 */
export function resetDatabase(): void {
  execFileSync(resolve(ROOT, 'scripts/db-reset.sh'), ['dawaee_test'], {
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
    push: providers.push as MockPushProvider,
    worker,
    setWorkerNow: (d) => {
      workerNow = d;
    },
    setServerNow: (d) => {
      setClockSource(() => d);
    },
    setNow: (d) => {
      workerNow = d;
      setClockSource(() => d);
    },
    tick: () => runTick(worker),
    close: async () => {
      resetClockSource();
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
 * Distinct source address per test user. Registration and sign-in are rate
 * limited per caller — correctly — so a suite that signed several users in
 * from one address would otherwise trip its own defences and fail in a way
 * that looks like a bug in whatever it was actually testing.
 */
function nextRemoteAddress(): string {
  ipCounter += 1;
  return `10.${Math.floor(ipCounter / 254) % 254}.${ipCounter % 254}.2`;
}

/**
 * The password every test account is created with.
 *
 * Long enough to pass the strength check, and deliberately not a phrase the
 * common-password list would reject.
 */
export const TEST_PASSWORD = 'correct horse battery staple';

/**
 * Registers (or signs in) a user and returns everything a test needs.
 *
 * Password, not OTP. The one-time-code path has no delivery channel left —
 * both SMS and WhatsApp need a Saudi commercial registration — so the request
 * endpoint refuses, and a suite that signed in through it would be testing a
 * route no real user can take. This is the way in that actually exists.
 */
export async function signIn(h: Harness, phone: string, deviceId = `device-${phone}`): Promise<TestUser> {
  const remoteAddress = nextRemoteAddress();

  const registered = await h.app.inject({
    method: 'POST', url: '/v1/auth/register', remoteAddress,
    payload: { phone, displayName: phone, password: TEST_PASSWORD, deviceId },
  });

  // A suite may sign the same number in twice; the second time it is a login.
  const auth = registered.statusCode === 200
    ? registered.json<{ accessToken: string; refreshToken: string }>()
    : await (async () => {
        const login = await h.app.inject({
          method: 'POST', url: '/v1/auth/login', remoteAddress,
          payload: { identifier: phone, password: TEST_PASSWORD, deviceId },
        });
        if (login.statusCode !== 200) {
          throw new Error(`sign-in failed for ${phone}: ${registered.body} / ${login.body}`);
        }
        return login.json<{ accessToken: string; refreshToken: string }>();
      })();

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
