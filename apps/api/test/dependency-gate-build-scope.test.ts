import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../../..');
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('dependency gate includes root build-toolchain advisories', () => {
  it('rejects a critical advisory that exists only outside --omit=dev', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dawaee-audit-npm-'));
    tempDirs.push(dir);
    const fakeNpm = join(dir, process.platform === 'win32' ? 'npm.cmd' : 'npm');
    const body = process.platform === 'win32'
      ? '@echo off\r\nnode "%~dp0\\fake-npm.cjs" %*\r\n'
      : '#!/bin/sh\nexec node "$(dirname "$0")/fake-npm.cjs" "$@"\n';
    writeFileSync(fakeNpm, body);
    if (process.platform !== 'win32') chmodSync(fakeNpm, 0o755);
    writeFileSync(join(dir, 'fake-npm.cjs'), `
const args = process.argv.slice(2);
const runtimeOnly = args.includes('--omit=dev');
const report = runtimeOnly
  ? { vulnerabilities: {} }
  : { vulnerabilities: {
      'synthetic-build-critical': {
        severity: 'critical',
        via: [{ url: 'https://github.com/advisories/GHSA-synthetic-build-critical' }],
        effects: [],
        fixAvailable: false
      }
    } };
process.stdout.write(JSON.stringify(report));
`);

    const result = spawnSync(
      process.execPath,
      ['scripts/audit-gate.mjs', '--workspace', 'root'],
      {
        cwd: ROOT,
        encoding: 'utf8',
        env: { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH ?? ''}` },
      },
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('UNACCEPTED CRITICAL [build]');
    expect(result.stdout).toContain('synthetic-build-critical');
  });
});
