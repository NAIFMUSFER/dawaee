import { describe, expect, it } from 'vitest';
import { updateEscalationPolicySchema } from '../src/index.js';

const patient = { afterMinutes: 0, target: 'patient' as const, channels: ['push' as const] };
const caregiver = { afterMinutes: 10, target: 'primary_caregiver' as const, channels: ['push' as const] };

function policy(stages: Array<typeof patient | typeof caregiver>, enabled = true) {
  return {
    enabled,
    stages,
    quietHoursStart: null,
    quietHoursEnd: null,
  };
}

describe('escalation patient-first contract', () => {
  it('accepts an enabled ladder that starts with the patient', () => {
    expect(updateEscalationPolicySchema.safeParse(policy([patient, caregiver])).success).toBe(true);
  });

  it('rejects an enabled ladder that starts with a caregiver', () => {
    const result = updateEscalationPolicySchema.safeParse(policy([
      { ...caregiver, afterMinutes: 0 },
      { ...patient, afterMinutes: 10 },
    ]));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path.join('.') === 'stages.0.target')).toBe(true);
    }
  });

  it('rejects an enabled empty ladder instead of silently disabling patient reminders', () => {
    expect(updateEscalationPolicySchema.safeParse(policy([])).success).toBe(false);
  });

  it('preserves the historical disabled-empty policy shape', () => {
    expect(updateEscalationPolicySchema.safeParse(policy([], false)).success).toBe(true);
  });

  it('still rejects non-increasing stages through the underlying contract', () => {
    expect(updateEscalationPolicySchema.safeParse(policy([
      patient,
      { ...caregiver, afterMinutes: 0 },
    ])).success).toBe(false);
  });
});
