import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// js-yaml is supplied by the locked ESLint toolchain. Parse the actual YAML,
// rather than matching a commented-out trigger or a branch name in a step.
const { load } = createRequire(import.meta.url)('js-yaml') as {
  load: (source: string) => { on: Record<string, unknown> };
};

describe('F2: every candidate pull request receives CI and security gates', () => {
  for (const file of ['ci.yml', 'codeql.yml']) {
    it(`${file} cannot silently omit a candidate base or a changed path`, () => {
      const workflow = load(readFileSync(resolve('.github/workflows', file), 'utf8'));
      expect(Object.hasOwn(workflow.on, 'pull_request')).toBe(true);
      const pr = (workflow.on.pull_request ?? {}) as Record<string, unknown>;
      // Release candidates need the same gates as main/prepare. A path filter
      // would also leave a commit without evidence even on an accepted base.
      for (const filter of ['branches', 'branches-ignore', 'paths', 'paths-ignore']) {
        expect(pr[filter], `${file}: ${filter} excludes some candidate PRs`).toBeUndefined();
      }
      expect(Object.hasOwn(workflow.on, 'pull_request_target')).toBe(false);
    });
  }
});
