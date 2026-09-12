import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { describe, it } from 'vitest';

const runner = fileURLToPath(new URL('./offline-today-rollover.cjs', import.meta.url));
const screen = fileURLToPath(new URL('../app/(tabs)/today.tsx', import.meta.url));
const sentinel = 'SYNTHETIC-CLI-PATH-EXECUTED';

/** Real Node subprocess, actual runner and unchanged screen scenarios. The
 * harmless external source is a canary, not a patient file. No network/native
 * operations occur; the existing screen harness still controls those APIs. */
function invoke(args: string[]) {
  return spawnSync(process.execPath, [runner, ...args], {
    cwd: tmpdir(), env: process.env, encoding: 'utf8', timeout: 10000,
  });
}

function withExternalSource(check: (source: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), 'dawaee-cli-path-'));
  const source = join(directory, 'synthetic.tsx');
  try {
    writeFileSync(source, `console.log('${sentinel}'); export default function Screen() { return null; }\n`);
    check(source);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe('offline Today CLI never evaluates caller-selected files', () => {
  it('runs all ten checked-in scenarios without depending on the current directory', () => {
    const result = invoke([]);
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /"total":10,"passed":10,"failed":0/);
  });

  it('rejects an external screen path before reading or evaluating its source', () => {
    withExternalSource((source) => {
      const result = invoke([source]);
      assert.equal(result.error, undefined);
      assert.equal(result.status, 64, result.stderr || result.stdout);
      assert.match(result.stderr, /accepts no file or hook arguments/);
      assert.doesNotMatch(result.stdout, new RegExp(sentinel));
    });
  });

  it('rejects an external hook override even when a legitimate screen is supplied', () => {
    withExternalSource((source) => {
      const result = invoke([screen, source]);
      assert.equal(result.error, undefined);
      assert.equal(result.status, 64, result.stderr || result.stdout);
      assert.match(result.stderr, /accepts no file or hook arguments/);
      assert.doesNotMatch(result.stdout, new RegExp(sentinel));
    });
  });
});
