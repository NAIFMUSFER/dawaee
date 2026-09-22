import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
const { createHarness, ApiError } = createRequire(import.meta.url)('./profile-screen-harness.cjs');
const root = resolve(import.meta.dirname, '../../..');
const harness = () => createHarness(resolve(root, 'apps/mobile/app/(tabs)/history.tsx'),
  resolve(root, 'apps/mobile/src/hooks/useRequestScope.ts'));

async function firstPage(h: any) {
  const first = h.batch().find((r: any) => r.route === '/v1/doses');
  const answer = first.resolve;
  first.resolve = (value: any) => answer({ ...value, nextCursor: 'page-2' });
  h.answer(h.batch(), 'FIRST');
  await h.flush();
  return h.batch().find((r: any) => r.route === '/v1/doses');
}

describe('history loads every page before presenting a complete calendar', () => {
  it('follows the next page and retains both pages', async () => {
    const h = harness();
    try {
      const next = await firstPage(h);
      expect(next?.payload.cursor).toBe('page-2');
      expect(h.text()).not.toContain('SYNTHETIC-FIRST-ONLY');
      h.answer([next], 'SECOND'); await h.flush();
      expect(h.text()).toContain('SYNTHETIC-FIRST-ONLY');
      expect(h.text()).toContain('SYNTHETIC-SECOND-ONLY');
    } finally { h.unmount(); }
  });

  it('does not publish a partial first page when a later page fails', async () => {
    const h = harness();
    try {
      const next = await firstPage(h);
      expect(next).toBeDefined();
      h.fail([next], new ApiError('controlled_page_failure')); await h.flush();
      expect(h.text()).not.toContain('SYNTHETIC-FIRST-ONLY');
      expect(h.text()).toContain('error.controlled_page_failure');
    } finally { h.unmount(); }
  });

  it('discards a late page from the previous profile', async () => {
    const h = harness();
    try {
      const next = await firstPage(h);
      expect(next).toBeDefined();
      h.switchProfile('B');
      h.answer(h.batch().filter((r: any) => r !== next), 'B'); await h.flush();
      h.answer([next], 'LATE-A'); await h.flush();
      expect(h.text()).toContain('SYNTHETIC-B-ONLY');
      expect(h.text()).not.toContain('SYNTHETIC-LATE-A-ONLY');
      expect(h.text()).not.toContain('SYNTHETIC-FIRST-ONLY');
    } finally { h.unmount(); }
  });
});
