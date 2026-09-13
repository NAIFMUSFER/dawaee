import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { expect, it } from 'vitest';

it('preserves medication metadata through the real editor load/edit/save boundary', () => {
  const result = spawnSync(process.execPath, [
    '--test', path.resolve(process.cwd(), 'apps/mobile/test/medication-edit-metadata-roundtrip.cjs'),
  ], { encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024 });
  if (result.error) throw result.error;
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  expect(result.stdout).toContain('# tests 5');
  expect(result.stdout).toContain('# pass 5');
  expect(result.stdout).toContain('# fail 0');
}, 35_000);
