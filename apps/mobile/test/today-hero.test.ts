import { describe, expect, it } from 'vitest';
import { canUndo } from '@dawaee/core';

/**
 * Two rules the Today screen depends on, pinned here because both were wrong
 * in ways that only showed up on a real screen.
 *
 * 1. The hero card must never offer a dose from another day.
 *
 *    The server's `next` is the next unresolved dose on ANY day. So the
 *    instant a patient confirmed their last dose of the day, the hero swapped
 *    to tomorrow's — same medication, same time of day, indistinguishable —
 *    still carrying a "Taken" button. One tap, at the moment of most
 *    confusion, recorded a dose about twenty-four hours early.
 *
 * 2. Undo is offered exactly when the server would accept it.
 *
 *    The undo endpoint existed from the start and no screen ever called it, so
 *    a patient who confirmed the wrong medication could not correct it. Adding
 *    lock-screen buttons made a mis-tap likelier, not rarer.
 */

/** The rule the screen applies. Kept in one line so the test tests the rule. */
const heroEligible = (next: { scheduledLocalDate: string } | null, localDate: string) =>
  next !== null && next.scheduledLocalDate === localDate;

describe('the hero card on Today', () => {
  const TODAY = '2026-09-05';

  it("offers today's dose", () => {
    expect(heroEligible({ scheduledLocalDate: TODAY }, TODAY)).toBe(true);
  });

  it("never offers tomorrow's, which is how a dose got taken a day early", () => {
    expect(heroEligible({ scheduledLocalDate: '2026-09-06' }, TODAY)).toBe(false);
  });

  it('offers nothing when there is no next dose at all', () => {
    expect(heroEligible(null, TODAY)).toBe(false);
  });

  /**
   * Crossing midnight in the patient's own zone, not the device's. The server
   * sends `localDate` computed in the profile's timezone precisely so this
   * comparison is made in the timezone the patient actually lives in.
   */
  it("does not offer yesterday's leftover dose as the hero either", () => {
    expect(heroEligible({ scheduledLocalDate: '2026-09-04' }, TODAY)).toBe(false);
  });
});

describe('when undo is offered', () => {
  const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
  const now = new Date();

  it('is offered right after a confirmation', () => {
    expect(canUndo({ status: 'taken', confirmedAt: at(0) }, now)).toBe(true);
    expect(canUndo({ status: 'taken_late', confirmedAt: at(2) }, now)).toBe(true);
    expect(canUndo({ status: 'skipped', confirmedAt: at(2) }, now)).toBe(true);
  });

  it('is withdrawn once the window has passed', () => {
    expect(canUndo({ status: 'taken', confirmedAt: at(30) }, now)).toBe(false);
  });

  it('is never offered for a dose nobody has confirmed', () => {
    expect(canUndo({ status: 'due', confirmedAt: null }, now)).toBe(false);
    expect(canUndo({ status: 'missed', confirmedAt: null }, now)).toBe(false);
  });
});
