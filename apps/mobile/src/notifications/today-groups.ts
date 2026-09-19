import type { DoseView } from '../api/types.js';

const pending = new Set<DoseView['status']>(['upcoming', 'due', 'pending_confirmation', 'snoozed']);

export function canActOnTodayDose(dose: DoseView, now: number): boolean {
  return pending.has(dose.status) && Date.parse(dose.scheduledAt) <= now;
}

export interface DoseTimeGroup {
  scheduledAt: string;
  doses: DoseView[];
}

/** Group occurrences by their actual instant, never just a displayed clock time. */
export function groupTodayDoses(doses: DoseView[], now: number) {
  const due = new Map<number, DoseTimeGroup>();
  const upcoming = new Map<number, DoseTimeGroup>();
  const recorded: DoseView[] = [];
  const unique = [...new Map(doses.map(dose => [dose.id, dose])).values()]
    .sort((a, b) => Date.parse(a.scheduledAt) - Date.parse(b.scheduledAt));
  for (const dose of unique) {
    if (!pending.has(dose.status)) { recorded.push(dose); continue; }
    const isDue = canActOnTodayDose(dose, now);
    const groups = isDue ? due : upcoming;
    const instant = Date.parse(dose.scheduledAt);
    let group = groups.get(instant);
    if (!group) {
      group = { scheduledAt: dose.scheduledAt, doses: [] };
      groups.set(instant, group);
    }
    // A cached/upcoming occurrence becomes due as the clock passes its time.
    group.doses.push(isDue && dose.status === 'upcoming' ? { ...dose, status: 'due' } : dose);
  }
  return { due: [...due.values()], upcoming: [...upcoming.values()], recorded };
}
