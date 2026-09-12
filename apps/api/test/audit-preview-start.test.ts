import { execFileSync, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const script = resolve(import.meta.dirname, '../../../..', 'scripts/audit-preview-start.mjs');

describe('managed audit preview bootstrap safety', () => {
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
