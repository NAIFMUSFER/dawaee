import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../../..');
const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fakePsql(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dawaee-release-backup-preflight-'));
  temps.push(dir);
  const p = join(dir, 'psql');
  writeFileSync(p, `#!/usr/bin/env bash
set -euo pipefail
args="$*"
printf '%s\\n' "$args" >> "$(dirname "$0")/calls"
if [[ "$args" == *"release_backup_"* ]]; then
  printf '%s\\n' "${'$'}{RELEASE_BACKUP_RESULT:-}"
elif [[ "$args" == *"SELECT current_user"* ]]; then
  printf 'dawaee_migrator\\n'
elif [[ "$args" == *"SELECT 1"* ]]; then
  printf '1\\n'
elif [[ "$args" == *"preflight_checks.sql"* ]]; then
  exit 0
fi
exit 0
`);
  chmodSync(p, 0o755);
  return dir;
}

function run(releaseBackupResult: string) {
  const dir = fakePsql();
  const result = spawnSync('bash', ['scripts/migrate.sh', '--preflight-only'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH ?? ''}`,
      DATABASE_URL: 'postgresql://example.invalid/postgres',
      DAWAEE_APP_PASSWORD: '',
      DAWAEE_WORKER_PASSWORD: '',
      MIGRATION_SET_ROLE: '',
      RELEASE_BACKUP_RESULT: releaseBackupResult,
    },
  });
  return { dir, result };
}

describe('release backup residue blocks migration preflight', () => {
  it('fails closed when a Dawaee release_backup schema is still attached to the target database', () => {
    const { dir, result } = run('release_backup_20990101_0000');

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('release_backup_20990101_0000');
    expect(result.stderr).toContain('release backup');
    expect(result.stdout).not.toContain('preflight complete');

    const calls = readFileSync(join(dir, 'calls'), 'utf8');
    expect(calls).toContain('release_backup_');
    expect(calls).toContain("relname = 'users'");
    expect(calls).toContain("relname = 'patient_profiles'");
  });

  it('keeps preflight read-only and successful when no recognized backup residue exists', () => {
    const { dir, result } = run('');

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('preflight complete — no migration was applied');
    const calls = readFileSync(join(dir, 'calls'), 'utf8');
    expect(calls).toContain('preflight_checks.sql');
  });
});
