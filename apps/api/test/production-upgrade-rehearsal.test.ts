import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const script = resolve(root, 'scripts/upgrade-rehearsal-0033-to-head.sh');

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
    expect(output).toContain('pending migrations: 13 (0034..0046), then no-op');
    expect(output).toContain('unsafe control    : 0034 refused mismatched units atomically at schema 0033');
  }, 120_000);
});
