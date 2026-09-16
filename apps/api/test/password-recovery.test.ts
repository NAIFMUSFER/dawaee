import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
const boundary = vi.hoisted(() => ({ verify: vi.fn(), afterLogin: null as null | (() => Promise<void>) }));
vi.mock('../src/auth/firebase-phone-proof.js', async (original) => ({
  ...await original<typeof import('../src/auth/firebase-phone-proof.js')>(), verifyFirebasePhoneIdToken: boundary.verify,
}));
vi.mock('../src/lib/db.js', async (original) => {
  const actual = await original<typeof import('../src/lib/db.js')>();
  return { ...actual, withTransaction: async (fn: any) => {
    const result: any = await actual.withTransaction(fn);
    // Pause after the real verification transaction COMMITTED, not while it
    // holds the account lock. This reproduces the session-minting race.
    if (result?.outcome === 'ok' && boundary.afterLogin) await boundary.afterLogin();
    return result;
  } };
});
import { FirebasePhoneProofInvalid, FirebasePhoneProofUnavailable } from '../src/auth/firebase-phone-proof.js';
import { withTransaction } from '../src/lib/db.js';
import { authHeaders, resetDatabase, signIn, startHarness, TEST_PASSWORD, type Harness } from './harness.js';

let h: Harness;
let owner: pg.Pool;
let sequence = 0;
const NEW_PASSWORD = 'New recovery password 948!';
const proofs = new Map<string, object>();
beforeAll(async () => {
  resetDatabase(); h = await startHarness();
  owner = new pg.Pool({ connectionString: 'postgres://postgres:postgres@127.0.0.1:5433/dawaee_test', max: 3 });
  boundary.verify.mockImplementation(async (token: string) => {
    if (!proofs.has(token)) throw new FirebasePhoneProofInvalid();
    return proofs.get(token);
  });
});
afterAll(async () => { await owner?.end(); await h?.close(); });
const post = (url: string, payload: object, headers?: object) => h.app.inject({
  method: 'POST', url, payload, headers, remoteAddress: `198.51.100.${++sequence}`,
});
async function fixture() {
  const user = await signIn(h, `+96650009${String(4100 + sequence++).padStart(4, '0')}`);
  // Proof is issued after registration. Millisecond precision of the password
  // timestamp must not reject a legitimate same-second provider auth_time.
  const idToken = `synthetic-recovery-${sequence}-`.repeat(8);
  proofs.set(idToken, { phoneE164: user.phone, firebaseUid: `fixture-${sequence}`, authenticatedAt: Math.floor(Date.now() / 1000) });
  return { user, idToken };
}
const recover = (idToken: string, newPassword = NEW_PASSWORD) => post('/v1/auth/password/recover', { idToken, newPassword });
const login = (phone: string, password: string) => post('/v1/auth/login', { identifier: phone, password, deviceId: 'recovery-login' });

describe('password recovery on real PostgreSQL with provider boundary fixtures', () => {
  it('rejects absent/invalid proof and a provider outage without changing credentials', async () => {
    expect((await recover('invalid')).statusCode).toBe(400);
    expect((await recover('invalid-proof-'.repeat(10))).statusCode).toBe(403);
    boundary.verify.mockRejectedValueOnce(new FirebasePhoneProofUnavailable());
    expect((await recover('unavailable-'.repeat(10))).statusCode).toBe(503);
  });
  it('saves once under concurrent/lost-response retry, revokes sessions and push, and permits new-password login', async () => {
    const { user, idToken } = await fixture();
    const pushed = await post('/v1/devices/push-token', {
      deviceId: `device-${user.phone}`, platform: 'android', token: 'ExponentPushToken[synthetic-recovery]',
    }, authHeaders(user));
    expect(pushed.statusCode, pushed.body).toBe(200);
    const results = await Promise.all([recover(idToken), recover(idToken)]);
    for (const result of results) expect(result.statusCode, result.body).toBe(200);
    expect((await recover(idToken)).json()).toEqual({ updated: true });
    const rows = (await owner.query('SELECT * FROM password_recovery_receipts WHERE user_id=$1', [user.userId])).rows;
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(NEW_PASSWORD);
    expect(JSON.stringify(rows)).not.toContain(idToken);
    expect((await h.app.inject({ method: 'GET', url: '/v1/me', headers: authHeaders(user) })).statusCode).toBe(401);
    expect((await post('/v1/auth/refresh', { refreshToken: user.refreshToken })).statusCode).toBe(401);
    expect((await owner.query('SELECT id FROM push_tokens WHERE user_id=$1 AND active', [user.userId])).rows).toHaveLength(0);
    expect((await login(user.phone, TEST_PASSWORD)).statusCode).toBe(401);
    expect((await login(user.phone, NEW_PASSWORD)).statusCode).toBe(200);
    expect((await recover(idToken, 'Different replay password!')).statusCode).toBe(403);
    const refreshedProof = `${idToken}-refreshed`;
    proofs.set(refreshedProof, proofs.get(idToken)!);
    expect((await recover(refreshedProof, 'Different replay password!')).statusCode).toBe(403);
    expect((await login(user.phone, NEW_PASSWORD)).statusCode).toBe(200);
  });
  it('does not report an old recovery as successful after an intentional later password change', async () => {
    const { user, idToken } = await fixture();
    expect((await recover(idToken)).statusCode).toBe(200);
    const signedIn = await login(user.phone, NEW_PASSWORD);
    expect(signedIn.statusCode).toBe(200);
    const nextPassword = 'Later intentional password 345!';
    const changed = await post('/v1/auth/password', { currentPassword: NEW_PASSWORD, newPassword: nextPassword },
      { authorization: `Bearer ${signedIn.json().accessToken}` });
    expect(changed.statusCode, changed.body).toBe(200);
    expect((await recover(idToken)).statusCode).toBe(403);
    expect((await login(user.phone, nextPassword)).statusCode).toBe(200);
  });
  it('rejects expired proof at the SQL boundary, weak passwords and client-supplied account IDs', async () => {
    const { user, idToken } = await fixture();
    expect((await recover(idToken, 'short')).statusCode).toBe(400);
    expect((await post('/v1/auth/password/recover', { idToken, newPassword: NEW_PASSWORD, userId: user.userId })).statusCode).toBe(400);
    proofs.set(idToken, { ...proofs.get(idToken), authenticatedAt: Math.floor(Date.now() / 1000) - 360 });
    expect((await recover(idToken)).statusCode).toBe(403);
    expect((await login(user.phone, TEST_PASSWORD)).statusCode).toBe(200);
  });
  it('does not create unknown users or recover disabled accounts', async () => {
    const { user, idToken } = await fixture();
    await owner.query('UPDATE users SET disabled_at=now() WHERE id=$1', [user.userId]);
    const disabled = await recover(idToken);
    proofs.set(idToken, { ...proofs.get(idToken), phoneE164: '+966500000099' });
    const unknown = await recover(idToken);
    expect(disabled.statusCode).toBe(403); expect(unknown.statusCode).toBe(403);
    expect(disabled.json().error).toEqual(unknown.json().error);
    expect((await owner.query('SELECT id FROM users WHERE phone_e164=$1', ['+966500000099'])).rows).toHaveLength(0);
  });
  it('rolls back the receipt and password if session revocation fails, then retries safely', async () => {
    const { user, idToken } = await fixture();
    await owner.query(`CREATE FUNCTION public.recovery_test_reject_revoke() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'synthetic revocation failure'; END $$;
      CREATE TRIGGER recovery_test_reject BEFORE UPDATE OF revoked_at ON auth_sessions
      FOR EACH ROW EXECUTE FUNCTION public.recovery_test_reject_revoke()`);
    try { expect((await recover(idToken)).statusCode).toBe(500); }
    finally { await owner.query('DROP TRIGGER recovery_test_reject ON auth_sessions; DROP FUNCTION public.recovery_test_reject_revoke()'); }
    expect((await owner.query('SELECT user_id FROM password_recovery_receipts WHERE user_id=$1', [user.userId])).rows).toHaveLength(0);
    expect((await login(user.phone, TEST_PASSWORD)).statusCode).toBe(200);
    expect((await recover(idToken)).statusCode).toBe(200);
  });
  it('prevents a login verified before recovery from minting an old-password session afterwards', async () => {
    const { user, idToken } = await fixture();
    let entered!: () => void; let resume!: () => void;
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    const release = new Promise<void>((resolve) => { resume = resolve; });
    boundary.afterLogin = async () => { entered(); await release; };
    const pending = login(user.phone, TEST_PASSWORD).then((r) => r);
    try {
      await waiting;
      expect((await recover(idToken)).statusCode).toBe(200);
    } finally { boundary.afterLogin = null; resume(); }
    expect((await pending).statusCode).toBe(401);
    expect((await login(user.phone, NEW_PASSWORD)).statusCode).toBe(200);
  });
  it('serializes recovery with refresh so no refreshed descendant remains live', async () => {
    const { user, idToken } = await fixture();
    const [reset, refreshed] = await Promise.all([recover(idToken), post('/v1/auth/refresh', { refreshToken: user.refreshToken })]);
    expect(reset.statusCode, reset.body).toBe(200);
    expect([200, 401]).toContain(refreshed.statusCode);
    if (refreshed.statusCode === 200) {
      expect((await h.app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${refreshed.json().accessToken}` } })).statusCode).toBe(401);
    }
    expect((await owner.query('SELECT id FROM auth_sessions WHERE user_id=$1 AND revoked_at IS NULL', [user.userId])).rows).toHaveLength(0);
  });
  it('keeps recovery receipts inaccessible to application table reads and the worker', async () => {
    await expect(withTransaction((tx) => tx.query('SELECT * FROM password_recovery_receipts'))).rejects.toMatchObject({ code: '42501' });
    await expect(h.worker.pool.query('SELECT app.recover_password($1,now(),$2,$3,$4)',
      ['+966500000099', 'a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64)])).rejects.toMatchObject({ code: '42501' });
  });
});
