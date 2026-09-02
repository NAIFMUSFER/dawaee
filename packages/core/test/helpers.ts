import type { MedicationSchedule, ScheduleRule } from '@dawaee/shared';

export function makeSchedule(overrides: Partial<MedicationSchedule> & { rule: ScheduleRule }): MedicationSchedule {
  return {
    id: 'sch-1',
    medicationId: 'med-1',
    patientProfileId: 'pat-1',
    ruleKind: overrides.rule.kind,
    doseQuantity: 1,
    doseUnit: 'tablet',
    timezone: 'Asia/Riyadh',
    startDate: '2026-09-01',
    endDate: null,
    missedAfterMinutes: 120,
    lateAfterMinutes: 15,
    active: true,
    createdBy: 'usr-1',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}
