import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isKnownMigrationHistory } from '../../../scripts/migration-history.mjs';
import { checkSchemaContract, requiredMigrations } from '../src/lib/schema-contract.js';

const filename = '0078_push_receipt_token_generation.sql';
const md5 = (path: string) => createHash('md5').update(readFileSync(new URL(path, import.meta.url))).digest('hex');

describe('explicit shipped migration history', () => {
  it('requires a matching 0085 at API startup before accepting original 0078', async () => {
    const rows = requiredMigrations().map(m => ({ ...m }));
    rows.find(m => m.filename === filename)!.checksum = 'ec497f38ff1917c25496d7b5e60b26c9';
    const db = { query: async (sql: string) => ({ rows: sql.includes('to_regclass') ? [{ present: true }] : rows }) };
    expect((await checkSchemaContract(db)).ok).toBe(true);
    rows.find(m => m.filename === '0085_push_receipt_portable_hash.sql')!.checksum = '0'.repeat(32);
    expect((await checkSchemaContract(db)).ok).toBe(false);
    rows.splice(rows.findIndex(m => m.filename === '0085_push_receipt_portable_hash.sql'), 1);
    expect((await checkSchemaContract(db)).ok).toBe(false);
  });

  it('accepts only the archived original paired with the exact current 0078', () => {
    const old = md5('../../../db/history/0078_push_receipt_token_generation.original.sql');
    const current = md5(`../../../db/migrations/${filename}`);
    expect(isKnownMigrationHistory(filename, old, current)).toBe(true);
    expect(isKnownMigrationHistory(filename, '0'.repeat(32), current)).toBe(false);
    expect(isKnownMigrationHistory(filename, old, '0'.repeat(32))).toBe(false);
    expect(isKnownMigrationHistory('0084_password_recovery.sql', old, current)).toBe(false);
  });
});
