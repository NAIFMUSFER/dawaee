import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import { closePool, withTransaction, withUser } from '../src/lib/db.js';
import { buildProviders } from '../src/providers/index.js';
import { loadConfig } from '../src/config.js';
import type { MockPushProvider } from '../src/providers/index.js';
import { createWorkerContext, type WorkerContext } from '../../worker/src/context.js';
import { runTick } from '../../worker/src/index.js';
import { resetClockSource, setClockSource } from '../src/lib/clock.js';
import { normalizePhone } from '../src/lib/crypto.js';
import { hashPassword } from '../src/lib/password.js';

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

/** Owner-proof is exercised by the account-email suites. Clinical fixtures
 * start from the post-proof definer operation so thousands of unrelated tests
 * do not depend on an email provider or scrape a bearer token from a mailbox. */
export async function createEmailAccount(
  h: Harness,
  email: string,
  displayName: string,
  password = TEST_PASSWORD,
  deviceId = `device-${email}`,
  locale: 'ar' | 'en' = 'ar',
): Promise<{ userId: string; token: string; refreshToken: string; profileId: string }> {
  const passwordHash = await hashPassword(password);
  const created = await withTransaction(tx => tx.query<{ user_id: string }>(
    'SELECT * FROM app.register_email_account($1,$2,$3,$4,$5)',
    [null, email.toLowerCase(), displayName, passwordHash, locale],
  ));
  const userId=created.rows[0]!.user_id;
  confirmTestEmail(userId);
  const login = await h.app.inject({ method: 'POST', url: '/v1/auth/login',
    remoteAddress: nextRemoteAddress(), payload: { identifier: email, password, deviceId } });
  if (login.statusCode !== 200) throw new Error(`fixture sign-in failed for ${email}: ${login.body}`);
  const auth=login.json<{accessToken:string;refreshToken:string}>();
  const profiles=await h.app.inject({url:'/v1/profiles',headers:{authorization:`Bearer ${auth.accessToken}`}});
  const profileId=profiles.json<{profiles:Array<{id:string}>}>().profiles[0]!.id;
  return {userId,token:auth.accessToken,refreshToken:auth.refreshToken,profileId};
}

/**
 * Creates a fixture through the restricted auth-plane function, then signs in.
 *
 * Password, not OTP. The one-time-code path has no delivery channel left —
 * both SMS and WhatsApp need a Saudi commercial registration — so the request
 * endpoint refuses, and a suite that signed in through it would be testing a
 * route no real user can take. This is the way in that actually exists.
 */
export async function signIn(h: Harness, phone: string, deviceId = `device-${phone}`, options: { verifiedPhone?: boolean } = {}): Promise<TestUser> {
  const canonicalPhone = normalizePhone(phone);
  if (!canonicalPhone) throw new Error(`Invalid fixture phone: ${phone}`);
  const fixtureEmail = `fixture-${canonicalPhone.replace(/\D/g, '')}@example.test`;

  const created=await createEmailAccount(h,fixtureEmail,phone,TEST_PASSWORD,deviceId);
  const auth = {accessToken:created.token,refreshToken:created.refreshToken};

  const me = await h.app.inject({
    method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${auth.accessToken}` },
  });

  const account = me.json<{ user: { id: string; phoneE164: string | null } }>().user;
  const userId = account.id;
  confirmTestEmail(userId);
  // Ordinary clinical scenarios attach their synthetic phone through the
  // auth-plane function. Production registration never reserves this number:
  // the real route calls the same function only after Firebase proof succeeds.
  await withUser(userId, async (tx) => {
    const credential = await tx.query<{ hash: string | null }>('SELECT app.password_hash_for_user($1) AS hash', [userId]);
    const attached = await tx.query<{ linked: boolean }>('SELECT app.attach_account_phone($1,$2,$3) AS linked',
      [userId, canonicalPhone, credential.rows[0]?.hash]);
    if (!attached.rows[0]?.linked) throw new Error('Phone fixture setup failed');
    if (options.verifiedPhone !== false) {
      const proof = await tx.query<{ verified: boolean }>(
        'SELECT app.record_verified_phone($1,$2,now()) AS verified', [userId, canonicalPhone],
      );
      if (!proof.rows[0]?.verified) throw new Error('Verified phone fixture setup failed');
    }
  });

  const profiles = await h.app.inject({
    method: 'GET', url: '/v1/profiles', headers: { authorization: `Bearer ${auth.accessToken}` },
  });
  const profile = profiles.json<{ profiles: Array<{ id: string }> }>().profiles[0]!;

  return {
    userId,
    phone: canonicalPhone,
    token: auth.accessToken,
    refreshToken: auth.refreshToken,
    profileId: profile.id,
  };
}

/** Owner-only fixture for clinical tests; real email confirmation is exercised
 * separately by account-email SQL/HTTP and onboarding boundary suites. */
export function confirmTestEmail(userId: string): void {
  if (!/^[a-f0-9-]{36}$/i.test(userId)) throw new Error('Invalid fixture user id');
  execFileSync('psql', ['-d', 'dawaee_test', '-v', 'ON_ERROR_STOP=1', '-c',
    `INSERT INTO user_email_verifications(user_id,email) SELECT id,lower(email) FROM users WHERE id='${userId}' AND email IS NOT NULL ON CONFLICT(user_id) DO UPDATE SET email=excluded.email`], {
    env: { ...process.env, PGHOST: '127.0.0.1', PGPORT: '5433', PGUSER: 'postgres' }, stdio: 'pipe',
  });
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
