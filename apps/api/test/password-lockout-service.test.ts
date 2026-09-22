import type { PoolClient } from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const password = vi.hoisted(() => ({ verify: vi.fn(), burn: vi.fn() }));
vi.mock('../src/lib/password.js', async original => ({
  ...await original<typeof import('../src/lib/password.js')>(),
  verifyPassword: password.verify,
  burnVerificationTime: password.burn,
}));
import { attemptPasswordLogin, LOCK_MINUTES, MAX_LOGIN_ATTEMPTS } from '../src/auth/password-service.js';

beforeEach(() => { vi.clearAllMocks(); password.burn.mockResolvedValue(undefined); });
describe('locked password candidates never reach the stored-credential verifier', () => {
  it.each([false, true])('uses decoy work and the same refusal even if disabled=%s', async disabled => {
    const row = { user_id:'synthetic-user', password_hash:'stored-secret-hash', locked_until:new Date(Date.now()+60_000), failed_login_count:8, disabled };
    const query = vi.fn(async (sql: string) => ({ rows: sql.includes('find_user_for_password_login') ? [row] : [] }));
    const tx = { query } as unknown as PoolClient;
    for (const candidate of ['correct candidate', 'wrong candidate']) {
      expect(await attemptPasswordLogin(tx, 'synthetic@example.test', candidate)).toEqual({outcome:'invalid'});
    }
    expect(password.verify).not.toHaveBeenCalled();
    expect(password.burn).toHaveBeenCalledTimes(2);
    expect(query.mock.calls.filter(([sql]) => sql.includes('record_login_failure'))).toHaveLength(2);
    expect(query).toHaveBeenCalledWith('SELECT app.record_login_failure($1,$2,$3)', [row.user_id,MAX_LOGIN_ATTEMPTS,LOCK_MINUTES]);
    expect(query.mock.calls.some(([sql]) => /clear_login_failures|set_password/.test(sql))).toBe(false);
  });
});
