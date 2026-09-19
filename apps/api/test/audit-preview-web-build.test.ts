import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../../..');
const script = resolve(root, 'scripts/build-audit-preview-web.mjs');

describe('audit preview web build hook', () => {
  it('reinstalls locked mobile dependencies before exporting a cached preview and stops on install failure', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'tadawee-preview-build-'));
    try {
      for (const path of ['scripts', 'bin', 'apps/mobile/node_modules', 'apps/api/public']) mkdirSync(resolve(dir, path), { recursive: true });
      writeFileSync(resolve(dir, 'scripts/build-audit-preview-web.mjs'), readFileSync(script));
      writeFileSync(resolve(dir, 'bin/npm'), `#!/bin/sh
test "$*" = "ci --legacy-peer-deps" || exit 2
test "$FAIL_INSTALL" != 1 || exit 3
touch node_modules/locked-install
` , { mode: 0o755 });
      writeFileSync(resolve(dir, 'bin/python3'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      writeFileSync(resolve(dir, 'bin/bash'), `#!/bin/sh
test "$1" = --version && exit 0
test -f apps/mobile/node_modules/locked-install || exit 4
touch apps/api/public/index.html apps/api/public/index.html.script-sha256
`, { mode: 0o755 });
      const env = { PATH: `${resolve(dir, 'bin')}:/usr/bin:/bin`,
        RENDER_SERVICE_ID: 'srv-daipkbuk1f9s73952trg', RENDER_EXTERNAL_URL: 'https://dawaee-audit-preview.onrender.com' };
      const run = spawnSync(process.execPath, [resolve(dir, 'scripts/build-audit-preview-web.mjs')], { env, encoding: 'utf8' });
      expect(run.status, run.stderr).toBe(0);
      expect(existsSync(resolve(dir, 'apps/mobile/node_modules/locked-install'))).toBe(true);
      // npm receives only the allowlisted environment, so simulate failure by
      // replacing the executable, not by forwarding an arbitrary environment.
      writeFileSync(resolve(dir, 'bin/npm'), '#!/bin/sh\nexit 3\n', { mode: 0o755 });
      rmSync(resolve(dir, 'apps/api/public/index.html'));
      const failed = spawnSync(process.execPath, [resolve(dir, 'scripts/build-audit-preview-web.mjs')], { env, encoding: 'utf8' });
      expect(failed.status).toBe(1);
      expect(failed.stderr).toContain('AUDIT_PREVIEW_WEB_INSTALL_FAILED');
      expect(existsSync(resolve(dir, 'apps/api/public/index.html'))).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
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
