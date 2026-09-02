import type { PoolClient } from 'pg';
import type { AuditAction } from '@dawaee/shared';

/**
 * Audit trail.
 *
 * Written inside the same transaction as the change it describes, so the log
 * and the data can never disagree. The table is append-only (migration 0007)
 * and UPDATE/DELETE are revoked from the application role, so nothing in this
 * service — or above it — can rewrite history.
 */
export interface AuditEntry {
  actorUserId: string | null;
  actorRole?: 'patient' | 'caregiver' | 'system' | 'admin';
  patientProfileId: string | null;
  action: AuditAction | string;
  entityType: string;
  entityId: string | null;
  previousValue?: Record<string, unknown> | null;
  newValue?: Record<string, unknown> | null;
  requestId?: string | null;
  ipHash?: string | null;
}

/** Fields never copied into the audit log, even in a "before" snapshot. */
const NEVER_AUDITED = new Set(['code', 'codeHash', 'token', 'refreshToken', 'invitationTokenHash', 'qrTokenHash', 'password']);

function scrub(value: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!value) return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (NEVER_AUDITED.has(k)) continue;
    out[k] = v;
  }
  return out;
}

export async function recordAudit(tx: PoolClient, entry: AuditEntry): Promise<void> {
  await tx.query(
    `INSERT INTO audit_logs
       (actor_user_id, actor_role, patient_profile_id, action, entity_type, entity_id,
        previous_value, new_value, request_id, ip_hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      entry.actorUserId,
      entry.actorRole ?? 'patient',
      entry.patientProfileId,
      entry.action,
      entry.entityType,
      entry.entityId,
      scrub(entry.previousValue),
      scrub(entry.newValue),
      entry.requestId ?? null,
      entry.ipHash ?? null,
    ],
  );
}

/** Diff helper so an audit row carries only what actually changed. */
export function diffFields<T extends Record<string, unknown>>(
  before: T,
  after: Partial<T>,
): { previous: Record<string, unknown>; next: Record<string, unknown> } | null {
  const previous: Record<string, unknown> = {};
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(after)) {
    if (value === undefined) continue;
    if (JSON.stringify(before[key]) !== JSON.stringify(value)) {
      previous[key] = before[key];
      next[key] = value;
    }
  }
  return Object.keys(next).length ? { previous, next } : null;
}
