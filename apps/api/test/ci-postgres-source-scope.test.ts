import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../../..');
const workflow = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8');
const block = workflow.match(/ {6}- name: Install PostgreSQL client matching the server\n[\s\S]*? {8}run: \|\n((?: {10}[^\n]*\n|\n)+)/)?.[1];
assert.ok(block, 'the PostgreSQL installer must remain an executable workflow step');
const script = block.replace(/^ {10}/gm, '');

/** Execute the actual workflow shell, replacing only external commands. The
 * fake repository rejects a broad refresh, just as Chrome's real hash mismatch
 * blocked CI 274. This is command-ordering regression, not a real apt install.
 * No root commands, remote downloads or package mutations are performed here. */
function runInstaller(major: '16' | '17', fault: 'none' | 'key' | 'index' | 'install' = 'none') {
  const directory = mkdtempSync(join(tmpdir(), 'dawaee-ci-source-'));
  const log = join(directory, 'commands.txt');
  const preamble = String.raw`
    sudo() {
      printf '%s\n' "$*" >> "$COMMAND_LOG"
      case "$1" in
        install) return 0 ;;
        curl) [ "$FAULT" != key ] || return 22 ;;
        tee) while IFS= read -r line; do printf 'source:%s\n' "$line" >> "$COMMAND_LOG"; done ;;
        apt-get)
          if [[ " $* " == *" update "* ]]; then
            [[ " $* " == *" Dir::Etc::sourcelist=/etc/apt/sources.list.d/pgdg.list "* ]] || return 100
            [[ " $* " == *" Dir::Etc::sourceparts=- "* ]] || return 100
            [[ " $* " == *" APT::Get::List-Cleanup=0 "* ]] || return 100
            [ "$FAULT" != index ] || return 100
          elif [[ " $* " == *" install "* ]]; then
            [ "$FAULT" != install ] || return 87
          else
            return 96
          fi
          ;;
        *) return 97 ;;
      esac
    }
    lsb_release() { printf 'noble\n'; }
    psql() { printf 'verified-client-version\n' >> "$COMMAND_LOG"; }
  `;
  try {
    const result = spawnSync('bash', ['-c', preamble + script.replaceAll('${{ matrix.postgres }}', major)], {
      env: { ...process.env, COMMAND_LOG: log, FAULT: fault }, encoding: 'utf8', timeout: 5000,
    });
    assert.equal(result.error, undefined);
    return { status: result.status, commands: readFileSync(log, 'utf8'), stderr: result.stderr };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe('CI PostgreSQL installer scopes repository refresh without weakening trust', () => {
  for (const major of ['16', '17'] as const) {
    it(`installs PostgreSQL ${major} despite an unrelated broken repository`, () => {
      const result = runInstaller(major);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.commands, new RegExp(`apt-get install -y postgresql-client-${major}`));
      assert.match(result.commands, /verified-client-version/);
      assert.match(result.commands, /source:deb \[signed-by=\/usr\/share\/postgresql-common\/pgdg\/apt.postgresql.org.asc\]/);
      assert.match(result.commands, /https:\/\/apt.postgresql.org\/pub\/repos\/apt noble-pgdg main/);
    });
  }

  it('still fails closed if the required PostgreSQL index cannot be verified', () => {
    const result = runInstaller('17', 'index');
    assert.equal(result.status, 100);
    assert.doesNotMatch(result.commands, /apt-get install|verified-client-version/);
  });

  it('does not install after failure to retrieve the signing key', () => {
    const result = runInstaller('17', 'key');
    assert.equal(result.status, 22);
    assert.doesNotMatch(result.commands, /apt-get|verified-client-version/);
  });

  it('propagates package installation failures rather than reporting success', () => {
    const result = runInstaller('17', 'install');
    assert.equal(result.status, 87);
    assert.doesNotMatch(result.commands, /verified-client-version/);
  });

  it('does not bypass signatures, hashes, or errors to make the install green', () => {
    assert.match(script, /set -euo pipefail/);
    assert.match(script, /https:\/\/www.postgresql.org\/media\/keys\/ACCC4CF8.asc/);
    assert.doesNotMatch(script, /allow-unauthenticated|allow-insecure|trusted\s*=\s*yes|Verify-Peer\s*=\s*false|\|\|\s*(true|:)/i);
    assert.doesNotMatch(script, /Acquire::Allow|APT::Get::Allow|Check-Valid-Until/i);
  });

  it('retains both PostgreSQL versions, ordinary ownership checks and the entire test command', () => {
    assert.match(workflow, /postgres: \['17', '16'\]/);
    assert.match(workflow, /migration owner is \$attrs, so every RLS test is vacuous/);
    assert.match(workflow, /- name: Unit and integration tests\n {8}run: npm test/);
    assert.doesNotMatch(workflow, /continue-on-error:\s*true/);
  });
});
