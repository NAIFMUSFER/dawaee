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

const KEY_PATH = '/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc';
const KEY_URL = 'https://www.postgresql.org/media/keys/ACCC4CF8.asc';
const REPOSITORY_URL = 'https://apt.postgresql.org/pub/repos/apt';

/** Compare complete captured argument records, not URL substrings. A literal
 * dot must not match another hostname character, and a trusted URL embedded in
 * an unrelated URL must not pass. Reject missing/extra source or curl records,
 * and bind the downloaded key path to the signed-by path. This parses data only;
 * it neither evaluates shell input nor passes arguments to another process. */
function assertSignedSources(commands: string): void {
  const records = commands.trim().split('\n').map((line) => line.trim().split(/\s+/));
  assert.deepEqual(records.filter(([command]) => command === 'curl'), [
    ['curl', '-fsSL', '-o', KEY_PATH, KEY_URL],
  ], 'the installer must download exactly the expected signing key');
  assert.deepEqual(records.filter(([command]) => command?.startsWith('source:')), [
    ['source:deb', `[signed-by=${KEY_PATH}]`, REPOSITORY_URL, 'noble-pgdg', 'main'],
  ], 'the installer must configure exactly the expected signed repository');
}

describe('CI PostgreSQL installer scopes repository refresh without weakening trust', () => {
  for (const major of ['16', '17'] as const) {
    it(`installs PostgreSQL ${major} despite an unrelated broken repository`, () => {
      const result = runInstaller(major);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.commands, new RegExp(`apt-get install -y postgresql-client-${major}`));
      assert.match(result.commands, /verified-client-version/);
      assertSignedSources(result.commands);
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
    assertSignedSources(runInstaller('17').commands);
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

// Mutate only inert command-log text, never executable workflow text. The same
// assertion guards the real captured installer commands and these adversarial
// controls, so a permissive hostname/substring check cannot silently return.
describe('CI source assertions reject lookalikes and embedded URLs', () => {
  const mutations: Array<[string, (commands: string) => string]> = [
    ['repository hostname with substituted dots', (text) => text.replace(REPOSITORY_URL, 'https://aptXpostgresqlYorg/pub/repos/apt')],
    ['key hostname with substituted dots', (text) => text.replace(KEY_URL, 'https://wwwXpostgresqlYorg/media/keys/ACCC4CF8.asc')],
    ['key filename with substituted dot', (text) => text.replace(KEY_URL, KEY_URL.replace('.asc', 'Xasc'))],
    ['extra key filename suffix', (text) => text.replace(KEY_URL, `${KEY_URL}.untrusted`)],
    ['trusted repository URL embedded in another URL', (text) => text.replace(REPOSITORY_URL, `https://unrelated.invalid/?redirect=${REPOSITORY_URL}`)],
    ['trusted key URL embedded in another URL', (text) => text.replace(KEY_URL, `https://unrelated.invalid/?redirect=${KEY_URL}`)],
    ['additional repository despite one valid source', (text) => `${text}source:deb [signed-by=${KEY_PATH}] https://unrelated.invalid/apt noble-pgdg main\n`],
    ['additional key download despite one valid download', (text) => `${text}curl -fsSL -o ${KEY_PATH} https://unrelated.invalid/key.asc\n`],
    ['missing key download', (text) => text.split('\n').filter((line) => !line.startsWith('curl ')).join('\n')],
    ['missing repository record', (text) => text.split('\n').filter((line) => !line.startsWith('source:')).join('\n')],
  ];
  for (const [name, mutate] of mutations) {
    it(`rejects ${name}`, () => {
      const result = runInstaller('17');
      assert.equal(result.status, 0, result.stderr);
      assertSignedSources(result.commands);
      const changed = mutate(result.commands);
      assert.notEqual(changed, result.commands, 'the mutation must actually change the fixture');
      assert.throws(() => assertSignedSources(changed), assert.AssertionError);
    });
  }
});
