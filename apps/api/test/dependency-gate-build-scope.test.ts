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

it.each([
  { effects: ['@expo/metro'], severity: 'high', expected: 'build', blocks: false },
  { effects: ['@expo/metro', 'mobile-runtime'], severity: 'high', expected: 'RUNTIME', blocks: true },
  { effects: ['@expo/metro'], severity: 'critical', expected: 'build', blocks: true },
])('keeps mobile build attribution bounded: $expected $severity', fixture => {
  const dir = mkdtempSync(join(tmpdir(), 'dawaee-audit-mobile-'));
  tempDirs.push(dir);
  const fakeNpm = join(dir, 'npm');
  writeFileSync(fakeNpm, '#!/bin/sh\nexec node "$(dirname "$0")/fake-npm.cjs" "$@"\n');
  chmodSync(fakeNpm, 0o755);
  const report = { vulnerabilities: {
    'synthetic-mobile-finding': {
      severity: fixture.severity, effects: fixture.effects, fixAvailable: false,
      via: [{ url: 'https://github.com/advisories/GHSA-synthetic-mobile' }],
    },
    '@expo/metro': { effects: ['expo'] },
    expo: { effects: [] },
    'mobile-runtime': { effects: [] },
  } };
  writeFileSync(join(dir, 'fake-npm.cjs'), `process.stdout.write(${JSON.stringify(JSON.stringify(report))});`);
  const result = spawnSync(process.execPath, ['scripts/audit-gate.mjs', '--workspace', 'mobile'], {
    cwd: ROOT, encoding: 'utf8', env: { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH ?? ''}` },
  });
  expect(result.stdout).toMatch(new RegExp(`${fixture.expected}\\s+${fixture.severity}\\s+open\\s+synthetic-mobile-finding`));
  expect(result.stdout.includes('UNACCEPTED ' + fixture.severity.toUpperCase())).toBe(fixture.blocks);
});
