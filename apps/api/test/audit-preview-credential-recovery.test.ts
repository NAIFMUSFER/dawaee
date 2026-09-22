import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  mismatch: new Set<string>(), queries: [] as string[], opened: [] as string[], ended: [] as string[],
  locked: true, otherDatabase: false, unsafe: false, ownerUnsafe: false, ledger: 97,
  network: false, failSecond: false, failVerification: false, committed: false,
}));
vi.mock('pg', () => ({ default: { Client: class {
  role: string;
  constructor(options: { connectionString: string }) { this.role = new URL(options.connectionString).username; }
  async connect() {
    h.opened.push(this.role);
    if (this.role !== 'dawaee_audit_db_user') {
      if (h.network) throw Object.assign(new Error('private-provider-error'), { code: 'ETIMEDOUT' });
      if (h.mismatch.has(this.role) && (!h.committed || h.failVerification)) {
        throw Object.assign(new Error('private-password-error'), { code: '28P01' });
      }
    }
  }
  async query(sql: string, params?: string[]) {
    h.queries.push(sql);
    if (sql.includes('current_database()')) return { rows: [{ db: 'dawaee_audit_db',
      role: this.role, owner: this.role, super: h.ownerUnsafe, bypass: false, create_role: true, version: 170000 }] };
    if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: h.locked }] };
    if (sql.includes('SELECT datname')) return { rows: h.otherDatabase ? [{ datname: 'other' }] : [] };
    if (sql.includes('schema_migrations')) return { rows: [{ count: h.ledger }] };
    if (sql.includes('FROM pg_roles WHERE')) return { rows: [{ role: params?.[0], super: false,
      bypass: h.unsafe, create_role: false, create_db: false, owner_member: false, sibling_member: false }] };
    if (sql === 'SELECT current_user AS role') return { rows: [{ role: this.role }] };
    if (sql.startsWith('ALTER ROLE dawaee_worker') && h.failSecond) throw new Error('private-SQL-error');
    if (sql === 'COMMIT') h.committed = true;
    return { rows: [] };
  }
  async end() { h.ended.push(this.role); }
} } }));
vi.mock('../dist/lib/db-tls.js', () => ({ databaseTlsOptions: () => false }));
import { recoverPreviewCredentials } from '../../../scripts/audit-preview-recover-credentials.mjs';

const env = {
  RENDER_SERVICE_ID: 'srv-daipkbuk1f9s73952trg', NODE_ENV: 'test',
  RENDER_EXTERNAL_URL: 'https://dawaee-audit-preview.onrender.com',
  DATABASE_URL: 'postgresql://dawaee_audit_db_user:synthetic@dpg-daipq80jo6nc73fsmhhg-a/dawaee_audit_db',
  JWT_SECRET: 'synthetic'.repeat(8), IP_HASH_SALT: 'synthetic-salt-value',
  DAWAEE_APP_PASSWORD: 'a'.repeat(64), DAWAEE_WORKER_PASSWORD: 'b'.repeat(64),
};
beforeEach(() => {
  h.mismatch = new Set(['dawaee_app', 'dawaee_worker']); h.queries = []; h.opened = []; h.ended = [];
  h.locked = true; h.otherDatabase = false; h.unsafe = false; h.ownerUnsafe = false; h.ledger = 97;
  h.network = false; h.failSecond = false; h.failVerification = false; h.committed = false;
});
const writes = () => h.queries.filter(q => /^(ALTER|GRANT|DELETE|UPDATE|INSERT|DROP)/.test(q));

describe('explicit isolated-preview credential recovery', () => {
  it('defaults to read-only diagnosis and closes every connection', async () => {
    expect(await recoverPreviewCredentials(env)).toEqual({ repaired: [], mismatched: ['dawaee_app', 'dawaee_worker'] });
    expect(writes()).toEqual([]); expect(h.ended.sort()).toEqual(h.opened.sort());
  });
  it('restores only mismatched roles, commits and authenticates again', async () => {
    h.mismatch.delete('dawaee_app');
    expect(await recoverPreviewCredentials(env, true)).toEqual({ repaired: ['dawaee_worker'], mismatched: [] });
    expect(writes()).toEqual([`ALTER ROLE dawaee_worker WITH PASSWORD '${env.DAWAEE_WORKER_PASSWORD}'`]);
    expect(h.opened.filter(r => r === 'dawaee_worker')).toHaveLength(2);
    expect(h.queries.indexOf('COMMIT')).toBeLessThan(h.queries.lastIndexOf('SELECT current_user AS role'));
  });
  it('is a no-op when both stored credentials already work', async () => {
    h.mismatch.clear(); await recoverPreviewCredentials(env, true);
    expect(writes()).toEqual([]); expect(h.queries).not.toContain('BEGIN');
  });
  it.each([{ NODE_ENV: 'production' }, { RENDER_SERVICE_ID: 'other-service' },
    { DAWAEE_APP_PASSWORD: "unsafe'password" }, { DAWAEE_WORKER_PASSWORD: '' }])(
    'refuses a wrong target or invalid supplied credential before connecting', async patch => {
      await expect(recoverPreviewCredentials({ ...env, ...patch }, true)).rejects.toThrow(/^AUDIT_/);
      expect(h.opened).toEqual([]);
    },
  );
  it.each(['locked', 'otherDatabase', 'unsafe', 'ownerUnsafe', 'ledger'] as const)(
    'refuses unsafe precondition %s without changing a role', async key => {
      if (key === 'locked') h.locked = false;
      else if (key === 'ledger') h.ledger = 96;
      else h[key] = true;
      await expect(recoverPreviewCredentials(env, true)).rejects.toThrow(/^AUDIT_/);
      expect(writes()).toEqual([]); expect(h.ended).toContain('dawaee_audit_db_user');
    },
  );
  it('does not treat a network outage as evidence of a wrong password', async () => {
    h.network = true;
    await expect(recoverPreviewCredentials(env, true)).rejects.toThrow('AUDIT_RECOVERY_CONNECTION_FAILED');
    expect(writes()).toEqual([]);
  });
  it('rolls back both role changes if the second one fails', async () => {
    h.failSecond = true;
    await expect(recoverPreviewCredentials(env, true)).rejects.toThrow();
    expect(h.queries).toContain('ROLLBACK'); expect(h.queries).not.toContain('COMMIT');
    expect(h.ended).toContain('dawaee_audit_db_user');
  });
  it('reports failed post-commit verification instead of claiming recovery', async () => {
    h.failVerification = true;
    await expect(recoverPreviewCredentials(env, true)).rejects.toThrow('AUDIT_RECOVERY_VERIFICATION_FAILED');
  });
});
