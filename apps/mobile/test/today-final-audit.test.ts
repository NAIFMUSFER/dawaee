import { describe, expect, it } from 'vitest';
import path from 'node:path';
const { createHarness, ApiError, NetworkError } = require('./profile-screen-harness.cjs');
const screen = path.resolve('apps/mobile/app/(tabs)/today.tsx');
const hook = path.resolve('apps/mobile/src/hooks/useRequestScope.ts');
const card = (h: any) => h.find('DoseCard', (p: any) => p.prominent);

describe('dose save failure and retry display', () => {
  it('blocks double taps and retains the saved state on server failure', async () => {
    const h = createHarness(screen, hook);
    try {
      h.answer(h.batch(), 'A'); await h.flush();
      card(h).onTaken(); card(h).onTaken(); await h.flush();
      const action = h.batch(); expect(action).toHaveLength(1);
      expect(card(h).dose.status).toBe('due');
      h.fail(action, new ApiError('internal_error')); await h.flush();
      expect(h.text()).toContain('today.actionSaveFailed');
      expect(card(h).dose.status).toBe('due');
      expect(h.queued).toHaveLength(0);
      card(h).onTaken(); await h.flush();
      expect(h.batch()).toHaveLength(1);
    } finally { h.unmount(); }
  });
  it('clears the optimistic offline status when the server readback disagrees', async () => {
    const h = createHarness(screen, hook);
    try {
      h.answer(h.batch(), 'A'); await h.flush();
      card(h).onTaken(); h.fail(h.batch(), new NetworkError()); await h.flush();
      expect(h.queued).toHaveLength(1);
      expect(h.text()).toContain('taken');
      const refresh = h.find('RefreshControl');
      refresh.onRefresh(); await h.flush();
      h.answer(h.batch(), 'A'); await h.flush();
      expect(card(h).dose.status).toBe('due');
    } finally { h.unmount(); }
  });
});
