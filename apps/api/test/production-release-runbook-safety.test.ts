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

  it('pins the deploy identity after merge instead of reusing the candidate head', () => {
    expect(runbook).toContain('CANDIDATE_SHA');
    expect(runbook).toContain('RELEASE_SHA="$(git rev-parse HEAD)"');
    expect(runbook).toContain('git merge-base --is-ancestor "$CANDIDATE_SHA" "$RELEASE_SHA"');
    expect(runbook).toContain('same `RELEASE_SHA`');
  });

  it('uses release-time deploy identities and preserves the proven production blocker checks', () => {
    expect(runbook).toContain('PRE_RELEASE_API_DEPLOY');
    expect(runbook).toContain('PRE_RELEASE_WORKER_DEPLOY');
    expect(runbook).toContain('permission denied for table dose_occurrences');
    expect(runbook).toContain('Render platform request logs');
    expect(runbook).toContain('no stable\n  profile, medication, dose, schedule, upload-object or caregiver relationship\n  identifiers in paths or queries');
  });

  it('keeps platform-owned Supabase extension maintenance out of ordinary migrations', () => {
    expect(runbook).toContain('must be owner of function set_limit');
    expect(runbook).toContain('ALTER EXTENSION pg_trgm SET SCHEMA extensions;');
    expect(runbook).toContain('ALTER EXTENSION btree_gist SET SCHEMA extensions;');
    expect(runbook).toContain('medications_name_trgm_idx');
    expect(runbook).toContain('rerun the Supabase Security Advisor');
    expect(runbook).toContain('Do not add either `ALTER EXTENSION` statement to a numbered Dawaee migration');
    expect(runbook).toContain('do not grant the migration role superuser/BYPASSRLS');
  });
});
