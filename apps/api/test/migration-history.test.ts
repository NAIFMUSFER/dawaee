import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isKnownMigrationHistory } from '../../../scripts/migration-history.mjs';

const filename = '0078_push_receipt_token_generation.sql';
const md5 = (path: string) => createHash('md5').update(readFileSync(new URL(path, import.meta.url))).digest('hex');

describe('explicit shipped migration history', () => {
  it('accepts only the archived original paired with the exact current 0078', () => {
    const old = md5('../../../db/history/0078_push_receipt_token_generation.original.sql');
    const current = md5(`../../../db/migrations/${filename}`);
    expect(isKnownMigrationHistory(filename, old, current)).toBe(true);
    expect(isKnownMigrationHistory(filename, '0'.repeat(32), current)).toBe(false);
    expect(isKnownMigrationHistory(filename, old, '0'.repeat(32))).toBe(false);
    expect(isKnownMigrationHistory('0084_password_recovery.sql', old, current)).toBe(false);
  });
});
