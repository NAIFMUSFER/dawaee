/* Independent complement to the installer command doubles: use real APT to
 * enumerate the sources selected by the actual CI update invocation. --print-uris
 * does not fetch indexes. All source/cache fixtures live in a temporary directory;
 * no sudo, package installation, production connection or OS mutation occurs. */
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function workflowUpdateArgs(workflowFile) {
  const source = fs.readFileSync(workflowFile, 'utf8');
  const step = source.split('      - name: Install PostgreSQL client matching the server\n')[1]?.split(/\n {6}- /)[0];
  assert.ok(step, 'the actual PostgreSQL installer step must exist');
  const body = step.split('        run: |\n')[1];
  assert.ok(body, 'the installer must retain an executable shell body');
  const updates = body.replace(/\\\n\s*/g, ' ').split('\n').map(line => line.trim())
    .filter(line => line.startsWith('sudo apt-get ') && /\bupdate$/.test(line));
  assert.equal(updates.length, 1, 'expected exactly one APT index update invocation');
  // Capture shell tokenization only. Never execute the workflow's update command.
  const result = spawnSync('bash', ['-c', String.raw`
    set -euo pipefail
    sudo() { [ "$1" = apt-get ]; shift; printf '%s\0' "$@"; }
  ` + updates[0]], { encoding: 'utf8', timeout: 5000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.split('\0').filter(Boolean);
}

function selectedUris(updateArgs) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dawaee-apt-selection-'));
  try {
    const parts = path.join(directory, 'sources.list.d');
    const source = path.join(directory, 'sources.list');
    const pgdg = path.join(parts, 'pgdg.list');
    fs.mkdirSync(parts);
    fs.mkdirSync(path.join(directory, 'lists', 'partial'), { recursive: true });
    fs.mkdirSync(path.join(directory, 'cache'));
    fs.writeFileSync(source, '');
    fs.writeFileSync(pgdg, 'deb https://apt.postgresql.org/pub/repos/apt noble-pgdg main\n');
    fs.writeFileSync(path.join(parts, 'unrelated.list'), 'deb https://unrelated.invalid/ubuntu noble main\n');
    const args = updateArgs.map(arg => arg.replace('/etc/apt/sources.list.d/pgdg.list', pgdg));
    const result = spawnSync('apt-get', [
      '-o', `Dir::Etc::sourcelist=${source}`,
      '-o', `Dir::Etc::sourceparts=${parts}`,
      '-o', `Dir::State::lists=${path.join(directory, 'lists')}`,
      '-o', `Dir::Cache=${path.join(directory, 'cache')}`,
      ...args, '--print-uris',
    ], { encoding: 'utf8', timeout: 5000 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

function scenarios(workflowFile) {
  return [
    {
      name: 'positive control: unscoped APT discovers PGDG and an unrelated repository',
      run() {
        const output = selectedUris(['update']);
        assert.match(output, /https:\/\/apt\.postgresql\.org\//);
        assert.match(output, /https:\/\/unrelated\.invalid\//);
      },
    },
    {
      name: 'the real CI invocation makes APT select PGDG only',
      run() {
        const output = selectedUris(workflowUpdateArgs(workflowFile));
        assert.match(output, /https:\/\/apt\.postgresql\.org\//);
        assert.doesNotMatch(output, /https:\/\/unrelated\.invalid\//);
      },
    },
  ];
}
module.exports = { scenarios };
if (require.main === module) {
  const cases = scenarios(process.argv[2] || path.join(__dirname, '../.github/workflows/ci.yml'));
  let failed = 0;
  for (const scenario of cases) {
    try { scenario.run(); console.log(`PASS ${scenario.name}`); }
    catch (error) { failed++; console.log(`FAIL ${scenario.name}\n${error.message}`); }
  }
  console.log(JSON.stringify({ total: cases.length, passed: cases.length - failed, failed }));
  process.exitCode = failed ? 1 : 0;
}
