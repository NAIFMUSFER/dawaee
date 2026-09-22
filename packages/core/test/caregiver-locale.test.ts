import { describe, expect, it } from 'vitest';
import {
  evaluateEscalation,
  type CaregiverContext,
  type EvaluateEscalationInput,
} from '../src/escalation.js';

const scheduledAt = '2026-09-02T17:00:00.000Z';

function baseInput(): EvaluateEscalationInput {
  const caregiver = {
    relationship: {
      id: 'rel-english-caregiver',
      caregiverUserId: 'caregiver-user',
      invitedPhoneE164: null,
      invitedName: 'Caregiver',
      status: 'active',
      permissions: ['view_adherence', 'receive_notifications'],
      escalationPriority: 1,
    },
    rules: [{
      channel: 'push',
      mode: 'missed_only',
      consecutiveMissedThreshold: 1,
      quietHoursStart: null,
      quietHoursEnd: null,
      enabled: true,
    }],
    // A linked caregiver can have a different UI language from the patient.
    // Keep the intersection cast until the production type carries locale;
    // this test intentionally fails against the pre-fix engine because the
    // locale is currently discarded while resolving the recipient.
    locale: 'en',
  } as CaregiverContext & { locale: 'en' };

  return {
    occurrence: {
      id: 'dose-caregiver-locale',
      status: 'pending_confirmation',
      scheduledAt,
      snoozedUntil: null,
      notifiedAt: scheduledAt,
      escalationStage: 2,
      escalationCompletedAt: null,
    },
    policy: {
      enabled: true,
      stages: [
        { afterMinutes: 0, target: 'patient', channels: ['push'] },
        { afterMinutes: 10, target: 'patient', channels: ['push'] },
        { afterMinutes: 30, target: 'primary_caregiver', channels: ['push'] },
      ],
      quietHoursStart: null,
      quietHoursEnd: null,
    },
    thresholds: { lateAfterMinutes: 15, missedAfterMinutes: 180 },
    caregivers: [caregiver],
    patient: {
      userId: 'patient-user',
      phoneE164: null,
      displayName: 'Patient',
      timezone: 'Asia/Riyadh',
    },
    consecutiveMissedCount: 0,
    now: new Date('2026-09-02T17:30:00.000Z'),
  };
}

describe('caregiver notification locale regression', () => {
  it('preserves the caregiver locale on the resolved dispatch recipient', () => {
    const decision = evaluateEscalation(baseInput());

    expect(decision.action).toBe('dispatch');
    expect(decision.recipients).toHaveLength(1);
    expect(decision.recipients[0]!.kind).toBe('caregiver');
    expect((decision.recipients[0] as typeof decision.recipients[0] & { locale?: string }).locale).toBe('en');
  });
});
