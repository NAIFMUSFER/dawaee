import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const runbook = readFileSync(resolve(root, 'docs/PRODUCTION-RELEASE-RUNBOOK.md'), 'utf8');
const migrations = readdirSync(resolve(root, 'db/migrations'))
  .filter((name) => /^\d{4}_.*\.sql$/.test(name))
  .sort();

describe('production release runbook cannot drift behind the migration artefact', () => {
  it('derives the live/pending migration set instead of encoding a historical boundary', () => {
    expect(migrations.length).toBeGreaterThan(0);
    expect(runbook).toContain('release-migrations.txt');
    expect(runbook).toContain('pre-release-ledger-names.txt');
    expect(runbook).toContain('pre-release-ledger-checksums.txt');
    expect(runbook).toContain('pending-migrations.txt');
    expect(runbook).toContain('unexpected-production-migrations.txt');
    expect(runbook).toContain('TARGET_MIGRATION');
    expect(runbook).toContain('TARGET_COUNT');
    expect(runbook).toContain('PENDING_COUNT');

    expect(runbook).not.toContain('applied 11 migration(s)');
    expect(runbook).not.toContain('ends at `0019_client_event_scope.sql`');
    expect(runbook).not.toContain('Migrations at `0030`');
    expect(runbook).not.toContain('db7061f1');
  });

  it('uses release-time deploy identities and preserves the proven production blocker checks', () => {
    expect(runbook).toContain('PRE_RELEASE_API_DEPLOY');
    expect(runbook).toContain('PRE_RELEASE_WORKER_DEPLOY');
    expect(runbook).toContain('permission denied for table dose_occurrences');
    expect(runbook).toContain('Render platform request logs');
    expect(runbook).toContain('no stable\n  profile, medication, dose, schedule, upload-object or caregiver relationship\n  identifiers in paths or queries');
  });
});
