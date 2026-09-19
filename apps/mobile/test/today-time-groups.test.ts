import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { canActOnTodayDose, groupTodayDoses } from '../src/notifications/today-groups.js';
import type { DoseView } from '../src/api/types.js';

const { createHarness } = createRequire(import.meta.url)('./profile-screen-harness.cjs');
const now = Date.parse('2026-09-18T09:00:00Z');
const dose = (id: string, scheduledAt: string, status: DoseView['status'] = 'upcoming') => ({
  id, scheduledAt, status, medicationId: `med-${id}`, scheduledLocalDate: '2026-09-18',
  scheduledTimezone: 'Asia/Riyadh', doseQuantity: 1, doseUnit: 'tablet',
  medication: { name: id, foodInstruction: 'no_preference' },
} as DoseView);

describe('Today only offers confirmation for the current time groups', () => {
  it('groups simultaneous occurrences across timezone spellings and separates future and recorded doses', () => {
    const a = dose('a', '2026-09-18T09:00:00Z');
    const b = dose('b', '2026-09-18T12:00:00+03:00');
    const future = dose('future', '2026-09-18T09:00:01Z', 'due');
    const taken = dose('taken', '2026-09-18T08:00:00Z', 'taken');
    const groups = groupTodayDoses([future, a, taken, b, a], now);
    expect(groups.due).toHaveLength(1);
    expect(groups.due[0]!.doses.map(d => d.id)).toEqual(['a', 'b']);
    expect(groups.due[0]!.doses.every(d => d.status === 'due')).toBe(true);
    expect(groups.upcoming[0]!.doses.map(d => d.id)).toEqual(['future']);
    expect(groups.recorded.map(d => d.id)).toEqual(['taken']);
    expect(canActOnTodayDose(future, now)).toBe(false);
    expect(canActOnTodayDose(dose('bad', 'invalid', 'due'), now)).toBe(false);
  });

  it('keeps both due medications actionable, with no future callbacks, and dispatches only the selected dose', async () => {
    let clock = now;
    let tick: (() => void) | undefined;
    class Clock extends Date { static now() { return clock; } }
    const h = createHarness(resolve('apps/mobile/app/(tabs)/today.tsx'), resolve('apps/mobile/src/hooks/useRequestScope.ts'), {}, {
      __globals: { Date: Clock, setInterval: (fn: () => void) => { tick = fn; return 1; }, clearInterval: () => {} },
    });
    try {
      const a = dose('a', '2026-09-18T09:00:00Z');
      const b = dose('b', a.scheduledAt);
      const future = dose('future', '2026-09-18T10:00:00Z');
      h.requests[0].completed = true;
      h.requests[0].resolve({ today: [a, b, future], next: future, prefetch: [], timezone: 'Asia/Riyadh', localDate: '2026-09-18' });
      await h.flush();
      expect(h.find('View', (p: any) => p.testID === 'today-due-group')).toBeTruthy();
      expect(h.find('DoseCard', (p: any) => p.dose.id === 'a').onTaken).toBeTypeOf('function');
      const futureCard = h.find('DoseCard', (p: any) => p.dose.id === 'future');
      for (const action of ['onTaken', 'onSkip', 'onSnooze', 'onUndo']) expect(futureCard[action]).toBeUndefined();
      const bCard = h.find('DoseCard', (p: any) => p.dose.id === 'b');
      // A clock correction after render must not let a captured handler act early.
      clock = now - 1;
      bCard.onTaken(); await h.flush();
      expect(h.requests.filter((r: any) => r.method === 'POST')).toHaveLength(0);
      clock = now;
      bCard.onTaken(); await h.flush();
      const posts = h.requests.filter((r: any) => r.method === 'POST');
      expect(posts).toHaveLength(1);
      expect(posts[0].payload.doseId).toBe('b');
      expect(posts[0].payload.action).toBe('taken');
      // Passing time updates the existing screen without a pull-to-refresh.
      clock = Date.parse(future.scheduledAt); tick?.(); await h.flush();
      expect(h.find('DoseCard', (p: any) => p.dose.id === 'future').onTaken).toBeTypeOf('function');
    } finally { h.unmount(); }
  });
});
