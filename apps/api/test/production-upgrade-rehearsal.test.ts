import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const script = resolve(root, 'scripts/upgrade-rehearsal-0033-to-head.sh');
const hotfixScript = resolve(root, 'scripts/upgrade-rehearsal-hotfix-0047.sh');
const migrationsDir = resolve(root, 'db/migrations');

const migrations = readdirSync(migrationsDir)
  .filter((name) => /^\d{4}_.*\.sql$/.test(name))
  .sort();
const pending = migrations.filter((name) => Number(name.slice(0, 4)) > 33);
const latest = migrations.at(-1)!;
const latestNumber = latest.slice(0, 4);

describe('production-shaped migration upgrade', () => {
  it('rehearses schema 0033 through current head with the real migration runner', () => {
    const dbName = `dawaee_upgrade_${process.pid}`;
    const output = execFileSync('bash', [script, dbName], {
      cwd: root,
      env: process.env,
      encoding: 'utf8',
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    expect(output).toContain('PRODUCTION-SHAPED UPGRADE REHEARSAL PASSED');
    expect(output).toContain('baseline          : 0033_caregiver_revoke_notification_policy.sql');
    expect(output).toContain(`upgraded through : ${latest}`);
    expect(output).toContain(`pending migrations: ${pending.length} (0034..${latestNumber}), then no-op`);
    expect(output).toContain('unsafe control    : 0034 refused mismatched units atomically at schema 0033');
  }, 120_000);

  it('rehearses the actual production ledger with emergency 0047 already applied out of order', () => {
    const dbName = `dawaee_upgrade_hotfix_${process.pid}`;
    const output = execFileSync('bash', [hotfixScript, dbName], {
      cwd: root,
      env: process.env,
      encoding: 'utf8',
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    expect(output).toContain('PRODUCTION-HOTFIX UPGRADE REHEARSAL PASSED');
    expect(output).toContain('baseline          : 0001..0033 + 0047_worker_materialization_privileges.sql');
    expect(output).toContain(`catch-up          : ${migrations.length - 34} migration(s), recorded 0047 skipped`);
    expect(output).toContain(`upgraded through  : ${latest}`);
    expect(output).toContain('0047 privileges   : preserved least-privilege boundary');
  }, 120_000);
});
