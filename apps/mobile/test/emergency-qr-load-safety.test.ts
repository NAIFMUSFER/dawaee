import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { expect, it } from 'vitest';

it('requires loaded emergency QR state and complete disclosure before QR mutations', () => {
  const result = spawnSync(process.execPath, [
    '--test', '--test-reporter=tap',
    path.resolve(process.cwd(), 'apps/mobile/test/emergency-qr-load-safety.cjs'),
  ], { encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024 });
  if (result.error) throw result.error;
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  expect(result.stdout).toContain('# tests 15');
  expect(result.stdout).toContain('# pass 15');
  expect(result.stdout).toContain('# fail 0');
}, 35_000);
