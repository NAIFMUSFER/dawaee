import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const PUBLIC = join(ROOT, 'apps/api/public');
// Collection-time reads: no local beforeAll can create its own passing fixture.
const preparedHtml = readFileSync(join(PUBLIC, 'index.html'), 'utf8');
const preparedHash = readFileSync(join(PUBLIC, 'index.html.script-sha256'), 'utf8').trim();
const workflow = readFileSync(join(ROOT, '.github/workflows/codeql.yml'), 'utf8');
const start = workflow.indexOf('\n  codeql:\n');
const end = workflow.indexOf('\n  secrets:\n', start);
assert.ok(start >= 0 && end > start, 'the actual CodeQL job must be present');
const codeqlJob = workflow.slice(start, end);

describe('real web artifacts at test and static-analysis boundaries', () => {
  it('has the same-origin generated application before suite hooks', () => {
    assert.ok(preparedHtml.includes('<!doctype html>'));
    assert.ok(preparedHtml.includes('window.location.origin'));
  });

  it('has the canonical script SHA-256 sidecar before an API starts', () => {
    const decoded = Buffer.from(preparedHash, 'base64');
    assert.equal(decoded.length, 32);
    assert.equal(decoded.toString('base64'), preparedHash);
  });

  it('builds the ignored production artifact before CodeQL initializes extraction', () => {
    const init = codeqlJob.indexOf('uses: github/codeql-action/init@');
    assert.ok(init >= 0);
    let previous = -1;
    for (const step of [
      'run: npm ci\n',
      'run: npm run build\n',
      'run: npm ci --prefix apps/mobile --legacy-peer-deps\n',
      'run: ./scripts/build-web.sh\n',
      'test -s apps/api/public/index.html\n',
      'test -s apps/api/public/index.html.script-sha256\n',
    ]) {
      const position = codeqlJob.indexOf(step);
      assert.ok(position > previous && position < init, `missing or misordered CodeQL preparation: ${step.trim()}`);
      previous = position;
    }
  });

  it('keeps security queries and result upload after artifact preparation', () => {
    const init = codeqlJob.indexOf('uses: github/codeql-action/init@');
    const analyze = codeqlJob.indexOf('uses: github/codeql-action/analyze@');
    assert.ok(analyze > init && init >= 0);
    assert.ok(codeqlJob.includes('queries: security-extended\n'));
    assert.ok(codeqlJob.includes('upload: always\n'));
    assert.ok(!codeqlJob.includes('continue-on-error: true'));
  });
});
