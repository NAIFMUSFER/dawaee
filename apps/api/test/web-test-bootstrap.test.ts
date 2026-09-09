import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { beforeEach, describe, it, vi } from 'vitest';

const subprocess = vi.hoisted(() => ({ execFileSync: vi.fn() }));
vi.mock('node:child_process', () => subprocess);
import prepareWebTestBundle from '../../../vitest.global-setup.js';

const ROOT = resolve(import.meta.dirname, '../../..');

beforeEach(() => { subprocess.execFileSync.mockReset(); });

describe('complete web surface before endpoint authorization tests', () => {
  it('registers the build before test workers, independent of file order', () => {
    const configuration = readFileSync(join(ROOT, 'vitest.config.ts'), 'utf8');
    assert.ok(configuration.includes("globalSetup: ['./vitest.global-setup.ts']"));
  });

  it('always builds the actual source with fixed arguments and a bounded timeout', () => {
    prepareWebTestBundle();
    assert.deepEqual(subprocess.execFileSync.mock.calls, [[
      'bash', [join(ROOT, 'scripts/build-web.sh')], {
        cwd: ROOT, stdio: 'inherit', timeout: 120_000,
        env: { ...process.env, EXPO_PUBLIC_API_URL: 'https://dawaee.example.com' },
      },
    ]]);
  });

  it('does not convert a failed build into an API-only passing audit', () => {
    const failure = new Error('fixture: production web build failed');
    subprocess.execFileSync.mockImplementationOnce(() => { throw failure; });
    assert.throws(() => prepareWebTestBundle(), (error) => error === failure);
    assert.equal(subprocess.execFileSync.mock.calls.length, 1);
  });
});
