import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../../..');
const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fakePsql(canSet = true): string {
  const dir = mkdtempSync(join(tmpdir(), 'dawaee-migrate-role-'));
  temps.push(dir);
  const p = join(dir, 'psql');
  writeFileSync(p, `#!/usr/bin/env bash
set -euo pipefail
args="$*"
role_set=false
if [[ -n "${'$'}{PSQLRC:-}" && -f "${'$'}PSQLRC" ]] && grep -q '^SET ROLE dawaee_owner;$' "${'$'}PSQLRC"; then
  role_set=true
fi
if [[ "$args" == *"pg_has_role"* ]]; then
  ${canSet ? "printf 't\\n'" : "printf 'f\\n'"}
elif [[ "$args" == *"SELECT current_user"* ]]; then
  if [[ "$role_set" == true ]]; then printf 'dawaee_owner\\n'; else printf 'postgres\\n'; fi
elif [[ "$args" == *"SELECT session_user"* ]]; then
  printf 'postgres\\n'
elif [[ "$args" == *"string_agg"* ]]; then
  printf '\\n'
fi
exit 0
`);
  chmodSync(p, 0o755);
  return dir;
}

function run(extraEnv: Record<string, string>, pathDir: string) {
  return spawnSync('bash', ['scripts/migrate.sh', '--preflight-only'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${pathDir}:${process.env.PATH ?? ''}`,
      DATABASE_URL: 'postgresql://example.invalid/postgres',
      DAWAEE_APP_PASSWORD: '',
      DAWAEE_WORKER_PASSWORD: '',
      ...extraEnv,
    },
  });
}

describe('migration effective role handoff', () => {
  it('authenticates with the connection role but runs preflight as the explicit schema owner', () => {
    const result = run({ MIGRATION_SET_ROLE: 'dawaee_owner' }, fakePsql(true));
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("connected as 'postgres', assuming migration role 'dawaee_owner'");
    expect(result.stdout).toContain("preflight: migrating as 'dawaee_owner'");
    expect(result.stdout).toContain('preflight complete — no migration was applied');
  });

  it('fails closed when the authenticated connection cannot SET the requested role', () => {
    const result = run({ MIGRATION_SET_ROLE: 'dawaee_owner' }, fakePsql(false));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("cannot SET ROLE 'dawaee_owner'");
  });

  it('rejects a deployment-supplied role value that could become SQL or startup-file injection', () => {
    const result = run({ MIGRATION_SET_ROLE: 'dawaee_owner; RESET ROLE' }, fakePsql(true));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('must be a lowercase unquoted Postgres identifier');
  });
});
