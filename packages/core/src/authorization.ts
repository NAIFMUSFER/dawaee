import type { CaregiverPermission, CaregiverRelationship, PatientProfile, UUID } from '@dawaee/shared';
import { AppError } from '@dawaee/shared';

/**
 * Authorization decisions, kept as pure functions so they can be unit-tested
 * exhaustively and reused by the API, the worker and the portal.
 *
 * Defence in depth: this layer runs on every request AND PostgreSQL row-level
 * security enforces the same boundary at the database. Neither is trusted alone.
 */

export type ActorRole = 'owner' | 'caregiver' | 'none';

export interface AccessContext {
  userId: UUID;
  profile: Pick<PatientProfile, 'id' | 'ownerUserId' | 'linkedUserId' | 'archivedAt'>;
  relationship?: Pick<CaregiverRelationship, 'status' | 'permissions' | 'invitationExpiresAt'> | null;
}

export function resolveRole(ctx: AccessContext): ActorRole {
  if (ctx.profile.ownerUserId === ctx.userId) return 'owner';
  if (ctx.profile.linkedUserId === ctx.userId) return 'owner';
  if (ctx.relationship && ctx.relationship.status === 'active') return 'caregiver';
  return 'none';
}

/** Owners hold every permission implicitly; caregivers hold only what was granted. */
export function effectivePermissions(ctx: AccessContext): Set<CaregiverPermission> {
  const role = resolveRole(ctx);
  if (role === 'owner') {
    return new Set<CaregiverPermission>([
      'view_medications', 'view_schedule', 'view_adherence', 'view_history', 'view_reports',
      'view_emergency_card', 'receive_notifications', 'edit_schedule', 'add_medication',
      'edit_medication', 'update_stock', 'confirm_dose', 'manage_caregivers',
    ]);
  }
  if (role === 'caregiver' && ctx.relationship) return new Set(ctx.relationship.permissions);
  return new Set();
}

export function can(ctx: AccessContext, permission: CaregiverPermission): boolean {
  return effectivePermissions(ctx).has(permission);
}

/** Throws a 403 rather than a 404 only when the caller already proved profile access. */
export function assertCan(ctx: AccessContext, permission: CaregiverPermission): void {
  if (resolveRole(ctx) === 'none') {
    // Do not leak the existence of another patient's profile.
    throw AppError.notFound();
  }
  if (!can(ctx, permission)) {
    throw AppError.forbidden(`Missing permission: ${permission}`);
  }
}

/** Only the profile owner may change who has access. */
export function assertOwner(ctx: AccessContext): void {
  if (resolveRole(ctx) !== 'owner') {
    throw AppError.forbidden('Only the patient or profile owner can perform this action');
  }
}

export function isInvitationUsable(
  rel: Pick<CaregiverRelationship, 'status' | 'invitationExpiresAt'>,
  now: Date,
): { ok: true } | { ok: false; reason: 'expired' | 'not_pending' } {
  if (rel.status !== 'pending') return { ok: false, reason: 'not_pending' };
  if (!rel.invitationExpiresAt || new Date(rel.invitationExpiresAt).getTime() <= now.getTime()) {
    return { ok: false, reason: 'expired' };
  }
  return { ok: true };
}

/**
 * Changes that alter what a patient physically takes require a second,
 * explicit confirmation in the UI. This is a usability safeguard against
 * mis-taps — it is NOT clinical validation, and the app never judges whether
 * the new value is medically appropriate.
 */
export interface HighRiskCheckInput {
  before: { doseQuantity?: number; doseUnit?: string; ruleJson?: string; name?: string; strengthValue?: number | null };
  after: { doseQuantity?: number; doseUnit?: string; ruleJson?: string; name?: string; strengthValue?: number | null };
}

export type HighRiskChange = 'dose_quantity' | 'dose_unit' | 'schedule_timing' | 'medication_identity' | 'strength';

export function detectHighRiskChanges(input: HighRiskCheckInput): HighRiskChange[] {
  const changes: HighRiskChange[] = [];
  const { before, after } = input;
  if (after.doseQuantity !== undefined && before.doseQuantity !== undefined && after.doseQuantity !== before.doseQuantity) {
    changes.push('dose_quantity');
  }
  if (after.doseUnit !== undefined && before.doseUnit !== undefined && after.doseUnit !== before.doseUnit) {
    changes.push('dose_unit');
  }
  if (after.ruleJson !== undefined && before.ruleJson !== undefined && after.ruleJson !== before.ruleJson) {
    changes.push('schedule_timing');
  }
  if (after.name !== undefined && before.name !== undefined && after.name.trim() !== before.name.trim()) {
    changes.push('medication_identity');
  }
  if (
    after.strengthValue !== undefined &&
    before.strengthValue !== undefined &&
    after.strengthValue !== before.strengthValue
  ) {
    changes.push('strength');
  }
  return changes;
}
