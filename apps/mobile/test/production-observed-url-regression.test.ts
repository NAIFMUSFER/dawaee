import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../../..');
const SOURCE_ROOTS = [
  resolve(ROOT, 'apps/mobile/app'),
  resolve(ROOT, 'apps/mobile/src'),
];
const SOURCE_EXTENSIONS = /\.(?:cjs|js|jsx|mjs|ts|tsx)$/;

function sourceFiles(root: string): string[] {
  const files: string[] = [];
  for (const name of readdirSync(root)) {
    const file = resolve(root, name);
    if (statSync(file).isDirectory()) files.push(...sourceFiles(file));
    else if (SOURCE_EXTENSIONS.test(name)) files.push(file);
  }
  return files;
}

const sources = SOURCE_ROOTS.flatMap(sourceFiles);

/**
 * Render production request logs on 2026-09-13 showed real traffic from an
 * older web bundle to identifier-bearing routes such as
 * /v1/doses/<uuid>/taken and /v1/caregivers/<uuid>. The platform records the
 * path before application redaction is possible. This regression therefore
 * scans the complete shipped mobile source surface, not only the screens where
 * those routes were originally found, so a future caller cannot quietly
 * reintroduce either URL shape.
 */
describe('production-observed identifier-bearing URL regressions', () => {
  it('contains no dynamic dose-action API URL in shipped mobile source', () => {
    const offenders = sources.filter((file) => {
      const source = readFileSync(file, 'utf8');
      return /\/v1\/doses\/\$\{[^}]+\}\/(?:taken|skip|snooze|undo)/.test(source);
    });
    expect(offenders).toEqual([]);
  });

  it('contains no dynamic caregiver-relationship API URL in shipped mobile source', () => {
    const offenders = sources.filter((file) => {
      const source = readFileSync(file, 'utf8');
      return /\/v1\/caregivers\/\$\{[^}]+\}/.test(source);
    });
    expect(offenders).toEqual([]);
  });
});
