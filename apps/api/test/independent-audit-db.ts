import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import type { PoolClient } from 'pg';

const { prepareValue } = createRequire(import.meta.url)('pg/lib/utils.js');

/** Real SQL and RLS, with a single WASM connection. Not native concurrency proof. */
export function auditClient(tx: Pick<PGlite, 'query'>): PoolClient {
  return { query: async (sql: string, values: unknown[] = []) => {
    const result = await tx.query<Record<string, unknown>>(sql,
      values.map(value => Array.isArray(value) ? prepareValue(value) : value));
    for (const row of result.rows) for (const field of result.fields ?? []) {
      const value = row[field.name];
      if (field.dataTypeID === 1082 && value instanceof Date) row[field.name] = value.toISOString().slice(0, 10);
      if ([1114, 1184].includes(field.dataTypeID) && typeof value === 'string') row[field.name] = new Date(value);
    }
    return { ...result, rowCount: result.affectedRows ?? result.rows.length };
  }, release: () => undefined } as unknown as PoolClient;
}

export async function createAuditDatabase(): Promise<PGlite> {
  const db = await PGlite.create({ extensions: { pgcrypto, pg_trgm, btree_gist } });
  await db.exec(`CREATE ROLE dawaee_migrator CREATEDB CREATEROLE NOSUPERUSER NOBYPASSRLS;
    CREATE ROLE dawaee_app; CREATE ROLE dawaee_worker;
    GRANT dawaee_app TO dawaee_migrator WITH ADMIN TRUE, INHERIT FALSE, SET FALSE;
    GRANT dawaee_worker TO dawaee_migrator WITH ADMIN TRUE, INHERIT FALSE, SET FALSE;
    ALTER DATABASE postgres OWNER TO dawaee_migrator; ALTER SCHEMA public OWNER TO dawaee_migrator;
    SET ROLE dawaee_migrator;
    CREATE TABLE schema_migrations(filename text PRIMARY KEY, checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now());`);
  await db.exec(await readFile('db/maintenance/definer_policies.sql', 'utf8'));
  for (const file of (await readdir('db/migrations')).filter(file => file.endsWith('.sql')).sort()) {
    const sql = await readFile(`db/migrations/${file}`, 'utf8');
    await db.exec(sql);
    await db.query('INSERT INTO schema_migrations(filename,checksum) VALUES($1,$2)',
      [file, createHash('md5').update(sql).digest('hex')]);
  }
  await db.exec(await readFile('db/maintenance/definer_policies.sql', 'utf8'));
  await db.exec('RESET ROLE');
  return db;
}

export async function auditTransaction<T>(db: PGlite, role: 'dawaee_app' | 'dawaee_worker' | 'dawaee_migrator',
  fn: (tx: PoolClient) => Promise<T>, userId?: string, readOnly = false): Promise<T> {
  return db.transaction(async tx => {
    if (readOnly) await tx.exec('SET TRANSACTION READ ONLY');
    await tx.exec(`SET LOCAL ROLE ${role}`);
    if (userId) await tx.query("SELECT set_config('app.user_id',$1,true)", [userId]);
    return fn(auditClient(tx as unknown as PGlite));
  });
}
