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
  it('keeps an unacknowledged Taken decision across stale reads and accepts server state after acknowledgement', async () => {
    const h = createHarness(screen, hook);
    try {
      h.answer(h.batch(), 'A'); await h.flush();
      card(h).onTaken(); h.fail(h.batch(), new NetworkError()); await h.flush();
      expect(h.queued).toHaveLength(1);
      expect(h.text()).toContain('taken');
      const refresh = h.find('RefreshControl');
      refresh.onRefresh(); await h.flush();
      h.answer(h.batch(), 'A'); await h.flush();
      const pending = h.find('DoseCard', (props: any) => props.dose.status === 'taken');
      expect(pending).toBeTruthy();
      expect(pending.onTaken).toBeUndefined();
      expect(h.queued).toHaveLength(1);
      // Model a sync acknowledgement followed by a later authoritative Undo.
      h.queued.splice(0);
      h.find('RefreshControl').onRefresh(); await h.flush();
      h.answer(h.batch(), 'A'); await h.flush();
      expect(card(h).dose.status).toBe('due');
    } finally { h.unmount(); }
  });
  for (const accepted of [false, true]) {
    it(`reconciles an ${accepted ? 'accepted' : 'refused'} queued decision when the follow-up GET is offline`, async () => {
      const h = createHarness(screen, hook);
      try {
        h.answer(h.batch(), 'A'); await h.flush();
        const cache = structuredClone(h.cacheWrites.at(-1));
        card(h).onTaken(); h.fail(h.batch(), new NetworkError()); await h.flush();
        expect(h.queued).toHaveLength(1);
        expect(h.find('DoseCard', (p: any) => p.dose.status === 'taken')).toBeTruthy();
        const settled = h.queued.shift();
        if (accepted) cache.doses.find((d: any) => d.id === settled.doseOccurrenceId).status = 'taken';
        h.cacheReader = async () => cache;
        h.find('RefreshControl').onRefresh(); await h.flush();
        h.fail(h.batch(), new NetworkError()); await h.flush();
        expect(h.queued).toHaveLength(0);
        expect(h.find('DoseCard', (p: any) => p.dose.id === settled.doseOccurrenceId).dose.status)
          .toBe(accepted ? 'taken' : 'due');
      } finally { h.unmount(); }
    });
  }
});
