import { describe, expect, it } from 'vitest';
import { detectTimezoneChange, planTravelDecision } from '../src/travel.js';
import { localTimeInZone } from '../src/time.js';

const NOW = new Date('2026-09-02T09:00:00Z');

describe('detectTimezoneChange', () => {
  it('reports no change when the device matches the schedule', () => {
    expect(detectTimezoneChange('Asia/Riyadh', 'Asia/Riyadh', NOW).changed).toBe(false);
  });
  it('reports the signed shift when travelling west', () => {
    // Riyadh UTC+3 → London UTC+1 in September: the wall clock moves back 2h.
    const d = detectTimezoneChange('Asia/Riyadh', 'Europe/London', NOW);
    expect(d.changed).toBe(true);
    expect(d.offsetShiftHours).toBe(-2);
  });
  it('reports the signed shift when travelling east', () => {
    const d = detectTimezoneChange('Asia/Riyadh', 'Asia/Tokyo', NOW);
    expect(d.offsetShiftHours).toBe(6);
  });
});

describe('planTravelDecision', () => {
  const schedule = {
    id: 'sch-1',
    timezone: 'Asia/Riyadh',
    rule: { kind: 'fixed_times' as const, times: ['08:00', '20:00'] },
  };

  it('keep_home_time leaves the instants untouched', () => {
    const plan = planTravelDecision(schedule, 'Asia/Riyadh', 'Europe/London', 'keep_home_time', NOW);
    expect(plan.newTimezone).toBe('Asia/Riyadh');
    expect(plan.regenerate).toBe(false);
    expect(plan.preview.every((p) => p.was === p.becomes)).toBe(true);
  });

  it('follow_local_time re-anchors the same wall clock to the new zone', () => {
    const plan = planTravelDecision(schedule, 'Asia/Riyadh', 'Europe/London', 'follow_local_time', NOW);
    expect(plan.newTimezone).toBe('Europe/London');
    expect(plan.regenerate).toBe(true);
    // 08:00 Riyadh (05:00Z) becomes 08:00 London (07:00Z).
    expect(plan.preview[0]!.was).toBe('2026-09-02T05:00:00.000Z');
    expect(plan.preview[0]!.becomes).toBe('2026-09-02T07:00:00.000Z');
    expect(localTimeInZone(new Date(plan.preview[0]!.becomes), 'Europe/London')).toBe('08:00');
  });

  it('produces a preview the confirmation screen can render, never applying silently', () => {
    const plan = planTravelDecision(schedule, 'Asia/Riyadh', 'Asia/Tokyo', 'follow_local_time', NOW);
    expect(plan.preview).toHaveLength(2);
    expect(plan.preview.every((p) => p.was !== p.becomes)).toBe(true);
  });

  it('handles an interval rule by previewing its anchor', () => {
    const plan = planTravelDecision(
      { id: 's2', timezone: 'Asia/Riyadh', rule: { kind: 'interval', everyHours: 8, anchorTime: '06:00' } },
      'Asia/Riyadh', 'Europe/London', 'follow_local_time', NOW,
    );
    expect(plan.preview).toHaveLength(1);
  });
});
