import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ESCALATION_STAGES, describePolicy, escalationDedupeKey, evaluateEscalation,
  type CaregiverContext, type EvaluateEscalationInput,
} from '../src/escalation.js';
import type { DoseOccurrence, EscalationStage, NotificationChannel } from '@dawaee/shared';

// 20:00 Riyadh, matching the scenario in the brief.
const SCHEDULED = '2026-09-02T17:00:00.000Z';
const at = (riyadhTime: string) => {
  const [h, m] = riyadhTime.split(':').map(Number) as [number, number];
  return new Date(Date.UTC(2026, 8, 2, h - 3, m));
};

const th = { lateAfterMinutes: 15, missedAfterMinutes: 180 };

const caregiver = (
  id: string,
  priority: number,
  channels: NotificationChannel[] = ['push'],
  overrides: Partial<CaregiverContext> = {},
): CaregiverContext => ({
  relationship: {
    id,
    caregiverUserId: `user-${id}`,
    invitedPhoneE164: '+966500000000',
    invitedName: id,
    status: 'active',
    permissions: ['view_adherence', 'receive_notifications'],
    escalationPriority: priority,
  },
  rules: channels.map((channel) => ({
    channel,
    mode: 'missed_only' as const,
    consecutiveMissedThreshold: 2,
    quietHoursStart: null,
    quietHoursEnd: null,
    enabled: true,
  })),
  ...overrides,
});

const occurrence = (o: Partial<DoseOccurrence> = {}) =>
  ({
    id: 'dose-1',
    status: 'upcoming',
    scheduledAt: SCHEDULED,
    snoozedUntil: null,
    notifiedAt: null,
    escalationStage: 0,
    escalationCompletedAt: null,
    ...o,
  }) as DoseOccurrence;

const STAGES: EscalationStage[] = [
  { afterMinutes: 0, target: 'patient', channels: ['push', 'local'] },
  { afterMinutes: 10, target: 'patient', channels: ['push', 'local'] },
  { afterMinutes: 30, target: 'primary_caregiver', channels: ['push'] },
  { afterMinutes: 60, target: 'secondary_caregivers', channels: ['push'] },
];

function input(over: Partial<EvaluateEscalationInput> = {}): EvaluateEscalationInput {
  return {
    occurrence: occurrence(),
    policy: { enabled: true, stages: STAGES, quietHoursStart: null, quietHoursEnd: null },
    thresholds: th,
    caregivers: [caregiver('son', 1), caregiver('daughter', 5)],
    patient: { userId: 'pat-user', phoneE164: '+966511111111', displayName: 'Mohammed', timezone: 'Asia/Riyadh' },
    consecutiveMissedCount: 0,
    now: at('20:00'),
    ...over,
  };
}

describe('brief §17 / §66 — the full escalation scenario', () => {
  it('19:59 → nothing is due yet', () => {
    const d = evaluateEscalation(input({ now: at('19:59') }));
    expect(d.action).toBe('none');
    expect(d.reason).toBe('not_due');
  });

  it('20:00 → stage 1 notifies the patient only', () => {
    const d = evaluateEscalation(input({ now: at('20:00') }));
    expect(d.action).toBe('dispatch');
    expect(d.stageIndex).toBe(0);
    expect(d.recipients).toHaveLength(1);
    expect(d.recipients[0]!.kind).toBe('patient');
  });

  it('20:10 → stage 2 sends a second patient reminder, still no family', () => {
    const d = evaluateEscalation(input({ now: at('20:10'), occurrence: occurrence({ escalationStage: 1, notifiedAt: SCHEDULED }) }));
    expect(d.stageIndex).toBe(1);
    expect(d.recipients.every((r) => r.kind === 'patient')).toBe(true);
  });

  it('20:30 → stage 3 reaches the PRIMARY caregiver on WhatsApp, and only them', () => {
    const d = evaluateEscalation(input({ now: at('20:30'), occurrence: occurrence({ escalationStage: 2, notifiedAt: SCHEDULED }) }));
    expect(d.stageIndex).toBe(2);
    expect(d.recipients).toHaveLength(1);
    expect(d.recipients[0]!.relationshipId).toBe('son');
    expect(d.recipients[0]!.channels).toEqual(['push']);
  });

  it('20:35 patient confirms → escalation completes and NO further alert goes out', () => {
    const confirmed = occurrence({ status: 'taken_late', escalationStage: 3, notifiedAt: SCHEDULED });
    const atConfirm = evaluateEscalation(input({ now: at('20:35'), occurrence: confirmed }));
    expect(atConfirm.action).toBe('complete');
    expect(atConfirm.recipients).toHaveLength(0);

    // 21:00 would have been stage 4 (secondary caregivers). It must not fire.
    const later = evaluateEscalation(
      input({ now: at('21:00'), occurrence: occurrence({ ...confirmed, escalationCompletedAt: '2026-09-02T17:35:00.000Z' }) }),
    );
    expect(later.action).toBe('none');
    expect(later.reason).toBe('resolved');
  });

  it('21:00 without confirmation → stage 4 reaches the secondary caregiver only', () => {
    const d = evaluateEscalation(input({ now: at('21:00'), occurrence: occurrence({ escalationStage: 3, notifiedAt: SCHEDULED }) }));
    expect(d.stageIndex).toBe(3);
    expect(d.recipients.map((r) => r.relationshipId)).toEqual(['daughter']);
  });
});

describe('catch-up behaviour after worker downtime', () => {
  it('jumps to the highest due stage instead of replaying every one', () => {
    const d = evaluateEscalation(input({ now: at('21:05'), occurrence: occurrence({ escalationStage: 0 }) }));
    expect(d.stageIndex).toBe(3);
    expect(d.recipients.map((r) => r.relationshipId)).toEqual(['daughter']);
  });
});

describe('suppression rules', () => {
  it('does not escalate while the dose is snoozed', () => {
    const d = evaluateEscalation(
      input({ now: at('20:35'), occurrence: occurrence({ escalationStage: 2, snoozedUntil: '2026-09-02T18:00:00.000Z' }) }),
    );
    expect(d.reason).toBe('snoozed');
    expect(d.action).toBe('none');
  });

  it('does not repeat a stage already dispatched', () => {
    const d = evaluateEscalation(input({ now: at('20:31'), occurrence: occurrence({ escalationStage: 3 }) }));
    expect(d.reason).toBe('already_dispatched');
  });

  it('honours quiet hours for family alerts but never for the patient', () => {
    const policy = { enabled: true, stages: STAGES, quietHoursStart: '20:00', quietHoursEnd: '07:00' };
    const family = evaluateEscalation(input({ now: at('20:30'), policy, occurrence: occurrence({ escalationStage: 2 }) }));
    expect(family.reason).toBe('quiet_hours');

    const patient = evaluateEscalation(input({ now: at('20:00'), policy }));
    expect(patient.action).toBe('dispatch');
    expect(patient.recipients[0]!.kind).toBe('patient');
  });

  it('respects a disabled policy', () => {
    const d = evaluateEscalation(input({ policy: { enabled: false, stages: STAGES, quietHoursStart: null, quietHoursEnd: null } }));
    expect(d.reason).toBe('policy_disabled');
  });
});

describe('caregiver eligibility', () => {
  it('excludes a caregiver without the receive_notifications permission', () => {
    const noPerm = caregiver('son', 1);
    noPerm.relationship.permissions = ['view_adherence'];
    const d = evaluateEscalation(input({ now: at('20:30'), caregivers: [noPerm], occurrence: occurrence({ escalationStage: 2 }) }));
    expect(d.recipients).toHaveLength(0);
    expect(d.reason).toBe('no_recipients');
  });

  it('excludes a caregiver whose access was revoked mid-escalation', () => {
    const revoked = caregiver('son', 1);
    revoked.relationship.status = 'revoked';
    const d = evaluateEscalation(input({ now: at('20:30'), caregivers: [revoked], occurrence: occurrence({ escalationStage: 2 }) }));
    expect(d.recipients).toHaveLength(0);
  });

  /**
   * WhatsApp and SMS were removed as channels — both need a Saudi commercial
   * registration before a single message can be sent. The database enum still
   * carries the values, so a stage or a rule could still name one; the engine
   * must never select a channel it cannot deliver on, because a caregiver
   * "notified" over a dead channel is worse than one never notified at all.
   */
  it('never selects a channel the system cannot send on', () => {
    const withDeadChannel = caregiver('son', 1, ['whatsapp' as NotificationChannel]);
    const d = evaluateEscalation(input({
      now: at('20:30'), caregivers: [withDeadChannel],
      occurrence: occurrence({ escalationStage: 2 }),
    }));
    expect(d.recipients).toHaveLength(0);
  });

  it('never treats caregiver local/in-app rules as remotely delivered', () => {
    for (const channel of ['local', 'in_app'] as NotificationChannel[]) {
      const localOnly = caregiver('son', 1, [channel]);
      const stages: EscalationStage[] = [
        { afterMinutes: 30, target: 'primary_caregiver', channels: [channel] },
      ];
      const d = evaluateEscalation(input({
        now: at('20:30'), caregivers: [localOnly],
        occurrence: occurrence({ escalationStage: 0 }),
        policy: { enabled: true, stages, quietHoursStart: null, quietHoursEnd: null },
      }));
      expect(d.recipients, `${channel} produced a phantom caregiver delivery`).toHaveLength(0);
      expect(d.reason).toBe('no_recipients');
    }
  });

  it('honours a "never" notification rule', () => {
    const never = caregiver('son', 1, ['push']);
    never.rules[0]!.mode = 'never';
    const d = evaluateEscalation(input({ now: at('20:30'), caregivers: [never], occurrence: occurrence({ escalationStage: 2 }) }));
    expect(d.recipients).toHaveLength(0);
  });

  it('holds a "consecutive_missed" caregiver until the streak is reached', () => {
    const streaky = caregiver('son', 1, ['push']);
    streaky.rules[0]!.mode = 'consecutive_missed';
    streaky.rules[0]!.consecutiveMissedThreshold = 2;

    const first = evaluateEscalation(
      input({ now: at('20:30'), caregivers: [streaky], consecutiveMissedCount: 0, occurrence: occurrence({ escalationStage: 2 }) }),
    );
    expect(first.recipients).toHaveLength(0);

    const second = evaluateEscalation(
      input({ now: at('20:30'), caregivers: [streaky], consecutiveMissedCount: 1, occurrence: occurrence({ escalationStage: 2 }) }),
    );
    expect(second.recipients).toHaveLength(1);
  });

  it('excludes digest-only caregivers from real-time escalation', () => {
    const digest = caregiver('son', 1, ['push']);
    digest.rules[0]!.mode = 'daily_summary';
    const d = evaluateEscalation(input({ now: at('20:30'), caregivers: [digest], occurrence: occurrence({ escalationStage: 2 }) }));
    expect(d.recipients).toHaveLength(0);
  });

  it('treats every caregiver sharing the top priority as primary', () => {
    const d = evaluateEscalation(
      input({ now: at('20:30'), caregivers: [caregiver('son', 1), caregiver('wife', 1), caregiver('daughter', 5)], occurrence: occurrence({ escalationStage: 2 }) }),
    );
    expect(d.recipients.map((r) => r.relationshipId).sort()).toEqual(['son', 'wife']);
  });
});

describe('idempotency', () => {
  it('builds a stable dedupe key per occurrence, stage, recipient and channel', () => {
    const r = { kind: 'caregiver' as const, userId: 'u1', phoneE164: null, relationshipId: 'rel1', channels: ['push' as const], displayName: 'Son' };
    expect(escalationDedupeKey('dose-1', 2, r, 'push')).toBe('esc:dose-1:2:u1:push');
    expect(escalationDedupeKey('dose-1', 2, r, 'push')).toBe(escalationDedupeKey('dose-1', 2, r, 'push'));
    expect(escalationDedupeKey('dose-1', 3, r, 'push')).not.toBe(escalationDedupeKey('dose-1', 2, r, 'push'));
  });
});

describe('defaults', () => {
  it('ships a sane default ladder matching the brief', () => {
    expect(DEFAULT_ESCALATION_STAGES.map((s) => s.afterMinutes)).toEqual([0, 10, 30, 60]);
    expect(describePolicy({ enabled: true, stages: DEFAULT_ESCALATION_STAGES })).toHaveLength(4);
    expect(describePolicy({ enabled: false, stages: DEFAULT_ESCALATION_STAGES })).toHaveLength(0);
  });
});
