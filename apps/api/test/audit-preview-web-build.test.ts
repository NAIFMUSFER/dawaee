import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../../..');
const script = resolve(root, 'scripts/build-audit-preview-web.mjs');

describe('audit preview web build hook', () => {
  it('keeps its guard self-test runnable without network or database access', () => {
    expect(existsSync(script)).toBe(true);
    const output = execFileSync(process.execPath, [script, '--self-test'], {
      cwd: root,
      encoding: 'utf8',
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
    });
    expect(output).toMatch(/AUDIT_PREVIEW_WEB_GUARDS: \d+ assertions passed/);
  });

  it('is a no-op for every non-preview Render service', () => {
    const run = spawnSync(process.execPath, [script], {
      cwd: root,
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        RENDER_SERVICE_ID: 'srv-dad9mvf10e5c73dva9vg',
        RENDER_EXTERNAL_URL: 'https://dawaee-api.onrender.com',
      },
    });
    expect(run.status).toBe(0);
    expect(run.stdout.trim()).toBe('AUDIT_PREVIEW_WEB_BUILD_SKIPPED');
    expect(run.stderr).toBe('');
  });

  it('is wired into the root build after the compiled product build', () => {
    const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { scripts?: { build?: string } };
    expect(pkg.scripts?.build).toContain('node scripts/build-audit-preview-web.mjs');
    expect(pkg.scripts?.build).toMatch(/^npm run build -w @dawaee\/shared/);
  });
});
