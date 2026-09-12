import type { FastifyInstance } from 'fastify';
import {
  AppError, caregiverNotificationRuleSchema, updateCaregiverPermissionsSchema,
} from '@dawaee/shared';
import { requireUuid } from '../lib/params.js';
import { withUser } from '../lib/db.js';
import { authenticate, currentUser } from '../middleware/context.js';
import { requireProfileOwner } from '../services/access-service.js';
import { recordAudit } from '../services/audit-service.js';

/**
 * Fixed-path caregiver mutations.
 *
 * Render records the public request path before Dawaee's logger can redact it.
 * Production evidence showed a real caregiver relationship UUID in that
 * platform access log. New clients therefore place relationshipId in the JSON
 * body, while the legacy parameterized routes stay available during rollout.
 *
 * These handlers intentionally preserve the same owner/RLS/audit checks as the
 * legacy routes. Moving the identifier is a transport/privacy change only; it
 * must not widen authorization.
 */

function relationshipIdFrom(body: unknown): string {
  const value = body && typeof body === 'object' && !Array.isArray(body)
    ? (body as { relationshipId?: unknown }).relationshipId
    : undefined;
  return requireUuid(value, 'relationshipId');
}

export function registerCaregiverPrivateRoutes(app: FastifyInstance): void {
  app.patch('/v1/caregivers/permissions', { preHandler: authenticate }, async (req) => {
    const relationshipId = relationshipIdFrom(req.body);
    // Zod strips relationshipId and validates the established mutation payload.
    const body = updateCaregiverPermissionsSchema.parse(req.body);
    const { userId } = currentUser(req);

    return withUser(userId, async (tx) => {
      const { rows: relRows } = await tx.query<{ patient_profile_id: string; permissions: string[] }>(
        'SELECT patient_profile_id, permissions FROM caregiver_relationships WHERE id = $1',
        [relationshipId],
      );
      if (!relRows[0]) throw AppError.notFound('Caregiver relationship not found');
      await requireProfileOwner(tx, userId, relRows[0].patient_profile_id);

      const { rows } = await tx.query(
        `UPDATE caregiver_relationships
            SET permissions = $2,
                escalation_priority = COALESCE($3, escalation_priority),
                role = COALESCE($4::caregiver_role, role)
          WHERE id = $1
          RETURNING id, permissions, escalation_priority, role::text AS role, status::text AS status`,
        [relationshipId, body.permissions, body.escalationPriority ?? null, body.role ?? null],
      );

      await recordAudit(tx, {
        actorUserId: userId, patientProfileId: relRows[0].patient_profile_id,
        action: 'caregiver.permissions_changed', entityType: 'caregiver_relationship',
        entityId: relationshipId, requestId: req.id, ipHash: req.ipHash,
        previousValue: { permissions: relRows[0].permissions },
        newValue: { permissions: body.permissions },
      });
      return { caregiver: rows[0] };
    });
  });

  app.put('/v1/caregivers/notification-rules', { preHandler: authenticate }, async (req) => {
    const relationshipId = relationshipIdFrom(req.body);
    const body = caregiverNotificationRuleSchema.parse(req.body);
    const { userId } = currentUser(req);

    return withUser(userId, async (tx) => {
      const { rows: relRows } = await tx.query<{ patient_profile_id: string }>(
        'SELECT patient_profile_id FROM caregiver_relationships WHERE id = $1', [relationshipId],
      );
      if (!relRows[0]) throw AppError.notFound('Caregiver relationship not found');
      await requireProfileOwner(tx, userId, relRows[0].patient_profile_id);

      const { rows } = await tx.query(
        `INSERT INTO caregiver_notification_rules
           (relationship_id, patient_profile_id, channel, mode, consecutive_missed_threshold,
            summary_time, quiet_hours_start, quiet_hours_end, enabled)
         VALUES ($1,$2,$3::notification_channel,$4::caregiver_notify_mode,$5,$6,$7,$8,$9)
         ON CONFLICT (relationship_id, channel) DO UPDATE
           SET mode = EXCLUDED.mode,
               consecutive_missed_threshold = EXCLUDED.consecutive_missed_threshold,
               summary_time = EXCLUDED.summary_time,
               quiet_hours_start = EXCLUDED.quiet_hours_start,
               quiet_hours_end = EXCLUDED.quiet_hours_end,
               enabled = EXCLUDED.enabled
         RETURNING channel::text AS channel, mode::text AS mode, consecutive_missed_threshold,
                   summary_time, quiet_hours_start, quiet_hours_end, enabled`,
        [
          relationshipId, relRows[0].patient_profile_id, body.channel, body.mode,
          body.consecutiveMissedThreshold, body.summaryTime ?? null,
          body.quietHoursStart ?? null, body.quietHoursEnd ?? null, body.enabled,
        ],
      );
      await recordAudit(tx, {
        actorUserId: userId, patientProfileId: relRows[0].patient_profile_id,
        action: 'caregiver.notify_rules_changed', entityType: 'caregiver_notification_rule',
        entityId: relationshipId, requestId: req.id, ipHash: req.ipHash,
        newValue: body as Record<string, unknown>,
      });
      return { rule: rows[0] };
    });
  });

  app.post('/v1/caregivers/revoke', { preHandler: authenticate }, async (req) => {
    const relationshipId = relationshipIdFrom(req.body);
    const { userId } = currentUser(req);

    return withUser(userId, async (tx) => {
      const { rows: relRows } = await tx.query<{ patient_profile_id: string; caregiver_user_id: string | null }>(
        'SELECT patient_profile_id, caregiver_user_id FROM caregiver_relationships WHERE id = $1',
        [relationshipId],
      );
      if (!relRows[0]) throw AppError.notFound('Caregiver relationship not found');

      const isSelfRemoval = relRows[0].caregiver_user_id === userId;
      if (!isSelfRemoval) await requireProfileOwner(tx, userId, relRows[0].patient_profile_id);

      await tx.query(
        `UPDATE caregiver_relationships
            SET status = 'revoked', revoked_at = now(), revoked_by_user_id = $2,
                invitation_token_hash = NULL
          WHERE id = $1`,
        [relationshipId, userId],
      );
      await tx.query(
        `UPDATE notification_deliveries SET status = 'skipped'
          WHERE relationship_id = $1 AND status IN ('queued','sending')`,
        [relationshipId],
      );
      await recordAudit(tx, {
        actorUserId: userId, patientProfileId: relRows[0].patient_profile_id,
        action: 'caregiver.revoked', entityType: 'caregiver_relationship',
        entityId: relationshipId, requestId: req.id, ipHash: req.ipHash,
        newValue: { selfRemoval: isSelfRemoval },
      });
      return { revoked: true, selfRemoval: isSelfRemoval };
    });
  });
}
