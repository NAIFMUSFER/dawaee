import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ connections: [] as string[], ended: [] as string[], mismatch: false }));
vi.mock('pg', () => ({ default: { Client: class {
  role: string;
  constructor(options: { connectionString: string }) { this.role = new URL(options.connectionString).username; }
  async connect() {
    h.connections.push(this.role);
    if (h.mismatch && this.role !== 'dawaee_audit_db_user') throw new Error('synthetic-private-credential');
  }
  async query(sql: string) {
    if (sql.includes('current_database()')) return { rows: [{ db: 'dawaee_audit_db', role: this.role,
      owner: this.role, super: false, bypass: false, create_role: true, version: 170000 }] };
    if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }] };
    if (sql.includes('to_regclass')) return { rows: [{ ledger: true, tables: 40 }] };
    if (sql.includes('count(*) FROM public.schema_migrations')) return { rows: [{ count: 96 }] };
    if (sql.includes('pg_advisory_unlock')) return { rows: [] };
    throw new Error('unexpected synthetic query');
  }
  async end() { h.ended.push(this.role); }
} } }));
vi.mock('../dist/lib/db-tls.js', () => ({ databaseTlsOptions: () => false }));
import { bootstrap } from '../../../scripts/audit-preview-start.mjs';

const env = {
  RENDER_SERVICE_ID: 'srv-daipkbuk1f9s73952trg', NODE_ENV: 'test',
  RENDER_EXTERNAL_URL: 'https://dawaee-audit-preview.onrender.com',
  DATABASE_URL: 'postgresql://dawaee_audit_db_user:synthetic@dpg-daipq80jo6nc73fsmhhg-a/dawaee_audit_db',
  JWT_SECRET: 'synthetic'.repeat(8), IP_HASH_SALT: 'synthetic-salt-value',
};

beforeEach(() => { h.connections = []; h.ended = []; h.mismatch = false; });
describe('preview restarts do not rotate runtime credentials', () => {
  it.each([{}, { DAWAEE_APP_PASSWORD: 'synthetic-app' }, { DAWAEE_WORKER_PASSWORD: 'synthetic-worker' }])(
    'refuses missing supplied passwords before opening any connection', async passwords => {
      await expect(bootstrap({ ...env, ...passwords }, true)).rejects.toThrow('AUDIT_RUNTIME_PASSWORDS_REQUIRED');
      expect(h.connections).toEqual([]);
    },
  );
  it('checks supplied credentials against an existing database before invoking migrations', async () => {
    h.mismatch = true;
    await expect(bootstrap({ ...env, DAWAEE_APP_PASSWORD: 'synthetic-app',
      DAWAEE_WORKER_PASSWORD: 'synthetic-worker' }, true)).rejects.toThrow('AUDIT_EXISTING_RUNTIME_CREDENTIALS_INVALID');
    expect(h.connections).toEqual(['dawaee_audit_db_user', 'dawaee_app']);
    expect(h.ended).toContain('dawaee_app');
    expect(h.ended).toContain('dawaee_audit_db_user');
  });
  it('keeps the read-only preflight available without runtime passwords', async () => {
    expect(await bootstrap(env, false)).toBeNull();
    expect(h.connections).toEqual(['dawaee_audit_db_user']);
  });
});
