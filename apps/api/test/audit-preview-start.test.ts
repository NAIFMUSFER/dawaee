import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { migrationFailureSummary } from '../../../scripts/audit-preview-start.mjs';

const script = resolve(import.meta.dirname, '../../..', 'scripts/audit-preview-start.mjs');

describe('managed audit preview bootstrap safety', () => {
  it('reports a changed applied migration without exposing child secrets', () => {
    const file = '0078_push_receipt_token_generation.sql';
    const error = { stderr: `postgres://secret@example/db\nERROR: ${file} was already applied but its contents have changed.\npassword=secret`, stdout: 'secret', message: 'secret' };
    expect(migrationFailureSummary(error, [file])).toBe(`AUDIT_MIGRATION_CHECKSUM_MISMATCH file=${file}`);
  });

  it('reports only the last known attempted migration and suppresses SQL and unknown filenames', () => {
    const file = '0084_password_recovery.sql';
    expect(migrationFailureSummary({ stdout: `  applying ${file}\n  applying 9999_secret.sql`, stderr: 'ERROR: secret SQL' }, [file]))
      .toBe(`AUDIT_MIGRATION_EXECUTION_FAILED file=${file}`);
    expect(migrationFailureSummary({ stderr: 'ERROR: 9999_secret.sql was already applied but its contents have changed.' }, [file]))
      .toBe('AUDIT_MIGRATION_SETUP_FAILED');
    expect(migrationFailureSummary(null, [file])).toBe('AUDIT_MIGRATION_SETUP_FAILED');
  });
  it('resolves the bootstrap inside this repository rather than its parent directory', () => {
    expect(existsSync(script)).toBe(true);
  });

  it('validates target identity, partial schemas and runtime credential isolation without connecting', () => {
    const output = execFileSync(process.execPath, [script, '--self-test'], { encoding: 'utf8' });
    expect(output).toMatch(/AUDIT_PREVIEW_GUARDS: \d+ assertions passed \(no database connection\)/);
  });

  it('refuses a production service before importing database clients or running migrations', () => {
    const run = spawnSync(process.execPath, [script, '--apply'], {
      encoding: 'utf8', env: { PATH: process.env.PATH, NODE_ENV: 'production',
        RENDER_SERVICE_ID: 'srv-dad9mvf10e5c73dva9vg',
        RENDER_EXTERNAL_URL: 'https://dawaee-api.onrender.com' },
    });
    expect(run.status).toBe(1);
    expect(run.stderr.trim()).toBe('AUDIT_SERVICE_MISMATCH');
    expect(run.stdout).toBe('');
  });

  it('never echoes a malformed database URL or its credentials into startup logs', () => {
    const secret = 'synthetic-credential-must-not-be-logged';
    const run = spawnSync(process.execPath, [script, '--apply'], {
      encoding: 'utf8', env: { PATH: process.env.PATH, NODE_ENV: 'test',
        RENDER_SERVICE_ID: 'srv-daipkbuk1f9s73952trg',
        RENDER_EXTERNAL_URL: 'https://dawaee-audit-preview.onrender.com',
        DATABASE_URL: `postgresql://owner:${secret}@production.example/postgres` },
    });
    expect(run.status).toBe(1);
    expect(run.stderr.trim()).toBe('AUDIT_DATABASE_TARGET_MISMATCH');
    expect(run.stdout + run.stderr).not.toContain(secret);
    expect(run.stdout).toBe('');
  });
});
