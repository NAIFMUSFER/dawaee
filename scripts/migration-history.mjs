import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

// Two exact, already-shipped versions of ONE migration. The original bytes
// are archived in db/history; 0085 converges their resulting function bodies.
// Do not normalize or rewrite the database ledger. Unknown changes still fail.
export function isKnownMigrationHistory(filename, applied, current) {
  return filename === '0078_push_receipt_token_generation.sql'
    && applied === 'ec497f38ff1917c25496d7b5e60b26c9'
    && current === 'a24625df6ace47e998761c803c8b5ee2';
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = process.argv.length === 5
    && isKnownMigrationHistory(...process.argv.slice(2)) ? 0 : 1;
}
