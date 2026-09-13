import type {
  CaregiverPermission, CaregiverRelationship, DoseOccurrence, EscalationPolicy, EscalationStage,
  LocalTime, NotificationChannel, UUID,
} from '@dawaee/shared';
import { deriveStatus, isTerminal, type DoseThresholds } from './dose-status.js';
import { isWithinQuietHours, localTimeInZone, minutesToMs } from './time.js';

/**
 * The smart escalation engine.
 *
 * Design principle from the product brief: never notify the whole family at
 * once. Escalation walks outward — patient, then a repeat, then the primary
 * caregiver, then the rest — and stops the instant the dose is confirmed.
 */

export const DEFAULT_ESCALATION_STAGES: EscalationStage[] = [
  { afterMinutes: 0, target: 'patient', channels: ['push', 'local'] },
  { afterMinutes: 10, target: 'patient', channels: ['push', 'local'] },
  { afterMinutes: 30, target: 'primary_caregiver', channels: ['push'] },
  { afterMinutes: 60, target: 'secondary_caregivers', channels: ['push'] },
];

export interface EscalationRecipient {
  kind: 'patient' | 'caregiver';
  userId: UUID | null;
  phoneE164: string | null;
  relationshipId: UUID | null;
  channels: NotificationChannel[];
  displayName: string | null;
}

export interface EscalationDecision {
  /** Nothing to do — the common case on most ticks. */
  action: 'none' | 'dispatch' | 'complete';
  /** Index into `policy.stages`; also written back to `escalationStage`. */
  stageIndex: number | null;
  stage: EscalationStage | null;
  recipients: EscalationRecipient[];
  reason:
    | 'not_due'
    | 'resolved'
    | 'snoozed'
    | 'quiet_hours'
    | 'policy_disabled'
    | 'no_recipients'
    | 'stage_due'
    | 'already_dispatched';
}

export interface CaregiverContext {
  relationship: Pick<
    CaregiverRelationship,
    'id' | 'caregiverUserId' | 'invitedPhoneE164' | 'invitedName' | 'status' | 'permissions' | 'escalationPriority'
  >;
  /** Per-channel delivery rules the caregiver (or patient) configured. */
  rules: Array<{
    channel: NotificationChannel;
    mode: 'every_dose' | 'missed_only' | 'consecutive_missed' | 'daily_summary' | 'weekly_summary' | 'never';
    consecutiveMissedThreshold: number;
    quietHoursStart: LocalTime | null;
    quietHoursEnd: LocalTime | null;
    enabled: boolean;
  }>;
  /** Set false when the patient has not consented to WhatsApp for this profile. */
}

export interface EvaluateEscalationInput {
  occurrence: Pick<
    DoseOccurrence,
    'id' | 'status' | 'scheduledAt' | 'snoozedUntil' | 'notifiedAt' | 'escalationStage' | 'escalationCompletedAt'
  >;
  policy: Pick<EscalationPolicy, 'enabled' | 'stages' | 'quietHoursStart' | 'quietHoursEnd'>;
  thresholds: DoseThresholds;
  caregivers: readonly CaregiverContext[];
  patient: { userId: UUID; phoneE164: string | null; displayName: string; timezone: string };
  /** Streak used by the `consecutive_missed` caregiver rule. */
  consecutiveMissedCount: number;
  now: Date;
}

export function evaluateEscalation(input: EvaluateEscalationInput): EscalationDecision {
  const { occurrence, policy, now, thresholds } = input;
  const none = (reason: EscalationDecision['reason']): EscalationDecision => ({
    action: 'none', stageIndex: null, stage: null, recipients: [], reason,
  });

  // A dose that has been answered ends its escalation immediately, whatever
  // stage it had reached. This is what stops the 20:30 caregiver alert from
  // being followed by a 21:00 one after the patient confirms at 20:35.
  if (isTerminal(occurrence.status)) {
    return occurrence.escalationCompletedAt
      ? none('resolved')
      : { action: 'complete', stageIndex: occurrence.escalationStage, stage: null, recipients: [], reason: 'resolved' };
  }
  if (!policy.enabled || policy.stages.length === 0) return none('policy_disabled');

  const status = deriveStatus(occurrence, now, thresholds);
  if (status === 'snoozed') return none('snoozed');
  if (status === 'upcoming') return none('not_due');

  const scheduled = new Date(occurrence.scheduledAt).getTime();

  // Catch-up behaviour: if the worker was down, jump to the HIGHEST stage that
  // is now due rather than replaying every intermediate one. A patient who is
  // an hour late gets one caregiver alert, not four notifications at once.
  let dueIndex = -1;
  for (let i = 0; i < policy.stages.length; i++) {
    const stage = policy.stages[i]!;
    if (now.getTime() >= scheduled + minutesToMs(stage.afterMinutes)) dueIndex = i;
    else break;
  }
  if (dueIndex < 0) return none('not_due');
  // `escalationStage` stores the 1-based count of stages already dispatched.
  if (dueIndex + 1 <= occurrence.escalationStage) return none('already_dispatched');

  const stage = policy.stages[dueIndex]!;
  const patientLocalTime = localTimeInZone(now, input.patient.timezone);

  // Quiet hours never silence the patient's own reminder — only outward
  // escalation to other people.
  if (
    stage.target !== 'patient' &&
    isWithinQuietHours(patientLocalTime, policy.quietHoursStart, policy.quietHoursEnd)
  ) {
    return none('quiet_hours');
  }

  const recipients = resolveRecipients(stage, input, patientLocalTime);
  if (recipients.length === 0) {
    // Still advance the pointer, otherwise a stage with no valid recipient
    // blocks every later stage forever.
    return { action: 'dispatch', stageIndex: dueIndex, stage, recipients: [], reason: 'no_recipients' };
  }
  return { action: 'dispatch', stageIndex: dueIndex, stage, recipients, reason: 'stage_due' };
}

function resolveRecipients(
  stage: EscalationStage,
  input: EvaluateEscalationInput,
  patientLocalTime: LocalTime,
): EscalationRecipient[] {
  if (stage.target === 'patient') {
    const channels = stage.channels.filter((c) => c === 'push' || c === 'local' || c === 'in_app');
    if (channels.length === 0) return [];
    return [
      {
        kind: 'patient',
        userId: input.patient.userId,
        phoneE164: input.patient.phoneE164,
        relationshipId: null,
        channels,
        displayName: input.patient.displayName,
      },
    ];
  }

  const eligible = input.caregivers
    .filter((c) => c.relationship.status === 'active')
    .filter((c) => c.relationship.permissions.includes('receive_notifications' as CaregiverPermission))
    .sort((a, b) => a.relationship.escalationPriority - b.relationship.escalationPriority);

  if (eligible.length === 0) return [];

  let selected: CaregiverContext[];
  if (stage.target === 'primary_caregiver') {
    const topPriority = eligible[0]!.relationship.escalationPriority;
    selected = eligible.filter((c) => c.relationship.escalationPriority === topPriority);
  } else if (stage.target === 'secondary_caregivers') {
    const topPriority = eligible[0]!.relationship.escalationPriority;
    selected = eligible.filter((c) => c.relationship.escalationPriority > topPriority);
  } else {
    selected = eligible;
  }

  const out: EscalationRecipient[] = [];
  for (const c of selected) {
    const channels = stage.channels.filter((channel) =>
      channelAllowed(channel, c, input.consecutiveMissedCount, patientLocalTime),
    );
    if (channels.length === 0) continue;
    out.push({
      kind: 'caregiver',
      userId: c.relationship.caregiverUserId,
      phoneE164: c.relationship.invitedPhoneE164,
      relationshipId: c.relationship.id,
      channels,
      displayName: c.relationship.invitedName,
    });
  }
  return out;
}

function channelAllowed(
  channel: NotificationChannel,
  caregiver: CaregiverContext,
  consecutiveMissedCount: number,
  patientLocalTime: LocalTime,
): boolean {
  // `local` and `in_app` are device-side channels. The server dispatcher has no
  // way to cause either one on a caregiver's phone; treating them as successful
  // would record a notification that no caregiver ever saw. Remote caregiver
  // escalation is push-only until another real provider is wired end to end.
  if (channel !== 'push') return false;

  const rule = caregiver.rules.find((r) => r.channel === channel);
  // No rule configured for this channel means the caregiver never opted into it.
  if (!rule || !rule.enabled) return false;
  if (rule.mode === 'never' || rule.mode === 'daily_summary' || rule.mode === 'weekly_summary') return false;
  if (rule.mode === 'consecutive_missed' && consecutiveMissedCount + 1 < rule.consecutiveMissedThreshold) return false;
  if (isWithinQuietHours(patientLocalTime, rule.quietHoursStart, rule.quietHoursEnd)) return false;
  return true;
}

/**
 * Stable idempotency key. The delivery table has a unique index on it, so a
 * worker restart mid-dispatch can never double-message a caregiver.
 */
export function escalationDedupeKey(
  occurrenceId: UUID,
  stageIndex: number,
  recipient: EscalationRecipient,
  channel: NotificationChannel,
): string {
  const who = recipient.userId ?? recipient.phoneE164 ?? recipient.relationshipId ?? 'unknown';
  return `esc:${occurrenceId}:${stageIndex}:${who}:${channel}`;
}

/** Human-readable preview of a policy, used by the settings screen. */
export function describePolicy(policy: Pick<EscalationPolicy, 'enabled' | 'stages'>): string[] {
  if (!policy.enabled) return [];
  return policy.stages.map((s, i) => `${i + 1}. +${s.afterMinutes}m → ${s.target} via ${s.channels.join(', ')}`);
}
