import type { FastifyInstance } from 'fastify';
import {
  AppError, CAREGIVER_ROLE_PRESETS, ERROR_CODES, acceptInvitationSchema, caregiverNotificationRuleSchema,
  inviteCaregiverSchema, updateCaregiverPermissionsSchema, updateEscalationPolicySchema, t,
} from '@dawaee/shared';
import { DEFAULT_ESCALATION_STAGES } from '@dawaee/core';
import { loadConfig } from '../config.js';
import { requireUuid } from '../lib/params.js';
import { withUser, withUserReadOnly } from '../lib/db.js';
import { maskPhone, normalizePhone, randomToken, sha256 } from '../lib/crypto.js';
import { authenticate, currentUser } from '../middleware/context.js';
import { loadProfileAccess, requireProfileAccess, requireProfileOwner } from '../services/access-service.js';
import { recordAudit } from '../services/audit-service.js';

/**
 * Family Care Circle.
 *
 * Two invariants run through this whole file:
 *  1. No caregiver sees anything before the patient explicitly authorizes it.
 *  2. The patient can revoke that authorization at any moment, and revocation
 *     takes effect on the very next request — there is no cached grant.
 */
export function registerCaregiverRoutes(app: FastifyInstance): void {
  const cfg = loadConfig();

  app.addHook('preHandler', async (req) => {
    if (req.url.startsWith('/v1/caregivers') || req.url.startsWith('/v1/escalation') || req.url.startsWith('/v1/care-circle')) {
      await authenticate(req, null as never);
    }
  });

  app.get('/v1/care-circle', async (req) => {
    const profileId = requireUuid((req.query as { profileId?: string }).profileId, 'profileId');
    const { userId } = currentUser(req);

    return withUserReadOnly(userId, async (tx) => {
      const access = await loadProfileAccess(tx, userId, profileId);
      if (access.role === 'none') throw AppError.notFound('Patient profile not found');

      const { rows } = await tx.query(
        `SELECT cr.id, cr.caregiver_user_id, cr.invited_name, cr.invited_phone_e164,
                cr.role::text AS role, cr.status::text AS status, cr.permissions,
                cr.escalation_priority, cr.invitation_expires_at, cr.accepted_at, cr.created_at,
                u.display_name AS caregiver_name
           FROM caregiver_relationships cr
           LEFT JOIN users u ON u.id = cr.caregiver_user_id
          WHERE cr.patient_profile_id = $1 AND cr.status <> 'revoked'
          ORDER BY cr.escalation_priority, cr.created_at`,
        [profileId],
      );

      const { rows: rules } = await tx.query(
        `SELECT relationship_id, channel::text AS channel, mode::text AS mode,
                consecutive_missed_threshold, summary_time, quiet_hours_start, quiet_hours_end, enabled
           FROM caregiver_notification_rules WHERE patient_profile_id = $1`,
        [profileId],
      );

      return {
        caregivers: rows.map((r) => ({
          id: r.id,
          // The patient wrote "أحمد"; the caregiver's own account may still be
          // named after their phone number. Show the patient their own label.
          name: r.invited_name ?? r.caregiver_name,
          // Only the patient sees the full number; caregivers see it masked.
          phone: access.role === 'owner' ? r.invited_phone_e164 : maskPhone(r.invited_phone_e164 ?? ''),
          role: r.role,
          status: r.status,
          permissions: r.permissions,
          escalationPriority: r.escalation_priority,
          invitationExpiresAt: r.invitation_expires_at,
          acceptedAt: r.accepted_at,
          isYou: r.caregiver_user_id === userId,
          notificationRules: rules.filter((x) => x.relationship_id === r.id).map((x) => ({
            channel: x.channel, mode: x.mode,
            consecutiveMissedThreshold: x.consecutive_missed_threshold,
            summaryTime: x.summary_time, quietHoursStart: x.quiet_hours_start,
            quietHoursEnd: x.quiet_hours_end, enabled: x.enabled,
          })),
        })),
        viewerRole: access.role,
        presets: CAREGIVER_ROLE_PRESETS,
      };
    });
  });

  /** Invite a caregiver. Only the patient can do this. */
  app.post('/v1/caregivers/invite', async (req) => {
    const body = inviteCaregiverSchema.parse(req.body);
    const { userId } = currentUser(req);
    const phone = normalizePhone(body.invitedPhone);
    if (!phone) throw AppError.badRequest(ERROR_CODES.VALIDATION_FAILED, 'Invalid caregiver phone number');

    const result = await withUser(userId, async (tx) => {
      const access = await requireProfileOwner(tx, userId, body.patientProfileId);

      // The raw token exists only in the outgoing message; the database keeps
      // a hash, so a database leak does not hand out care-circle access.
      const token = randomToken(32);
      const { rows } = await tx.query(
        `INSERT INTO caregiver_relationships
           (patient_profile_id, invited_phone_e164, invited_name, role, status, permissions,
            escalation_priority, invitation_token_hash, invitation_expires_at, invitation_channel,
            invited_by_user_id)
         VALUES ($1,$2,$3,$4::caregiver_role,'pending',$5,$6,$7, now() + ($8 || ' hours')::interval, $9, $10)
         RETURNING id, invitation_expires_at`,
        [
          body.patientProfileId, phone, body.invitedName, body.role, body.permissions,
          body.escalationPriority, sha256(token), String(body.expiresInHours), body.channel, userId,
        ],
      );
      const relationship = rows[0]!;

      // Default notification rules so a new caregiver is useful immediately —
      // missed-only, which is the least intrusive setting that still works.
      await tx.query(
        `INSERT INTO caregiver_notification_rules (relationship_id, patient_profile_id, channel, mode)
         VALUES ($1,$2,'push','missed_only'), ($1,$2,'whatsapp','missed_only')
         ON CONFLICT (relationship_id, channel) DO NOTHING`,
        [relationship.id, body.patientProfileId],
      );

      await recordAudit(tx, {
        actorUserId: userId, patientProfileId: body.patientProfileId, action: 'caregiver.invited',
        entityType: 'caregiver_relationship', entityId: relationship.id, requestId: req.id, ipHash: req.ipHash,
        newValue: { role: body.role, permissions: body.permissions, channel: body.channel },
      });

      return { relationshipId: relationship.id, token, expiresAt: relationship.invitation_expires_at, patientName: access.profileDisplayName };
    });

    const link = `${cfg.PUBLIC_APP_URL}/invite/${result.token}`;
    const locale = 'ar' as const;
    const message = t(locale, 'family.inviteBody', {
      patient: result.patientName, hours: body.expiresInHours, link,
    });

    // The invitation is handed to the patient to pass on themselves — by
    // whichever messenger they already use. The app does not send it: the two
    // channels it could have sent on both need a commercial registration, and
    // an invitation the patient forwards is a channel that always works.
    return {
      relationshipId: result.relationshipId,
      expiresAt: result.expiresAt,
      // The patient shares these themselves; there is no delivery to report.
      invitationLink: link,
      // The ready-written message, so the app can offer a share sheet rather
      // than making the patient compose an explanation of what the link is.
      invitationMessage: message,
    };
  });

  /**
   * Accept an invitation. Token validation happens inside the database
   * (`app.accept_caregiver_invitation`), which also burns the token so a link
   * cannot be reused or shared onward.
   */
  app.post('/v1/caregivers/accept', async (req) => {
    const body = acceptInvitationSchema.parse(req.body);
    const { userId } = currentUser(req);

    return withUser(userId, async (tx) => {
      const { rows } = await tx.query<{ relationship_id: string | null; patient_profile_id: string | null; outcome: string }>(
        'SELECT * FROM app.accept_caregiver_invitation($1, $2)',
        [sha256(body.token), userId],
      );
      const outcome = rows[0]?.outcome ?? 'invalid';

      if (outcome === 'expired') throw new AppError(ERROR_CODES.INVITATION_EXPIRED, 410, 'This invitation has expired');
      if (outcome === 'already_used') throw new AppError(ERROR_CODES.INVITATION_ALREADY_USED, 409, 'This invitation was already used');
      if (outcome === 'self') throw AppError.badRequest(ERROR_CODES.INVITATION_INVALID, 'You cannot be your own caregiver');
      if (outcome !== 'accepted') throw new AppError(ERROR_CODES.INVITATION_INVALID, 404, 'Invitation not found');

      await recordAudit(tx, {
        actorUserId: userId, actorRole: 'caregiver',
        patientProfileId: rows[0]!.patient_profile_id,
        action: 'caregiver.accepted', entityType: 'caregiver_relationship',
        entityId: rows[0]!.relationship_id, requestId: req.id, ipHash: req.ipHash,
      });

      const { rows: profile } = await tx.query(
        'SELECT id, display_name FROM patient_profiles WHERE id = $1',
        [rows[0]!.patient_profile_id],
      );
      return { accepted: true, relationshipId: rows[0]!.relationship_id, profile: profile[0] ?? null };
    });
  });

  app.patch('/v1/caregivers/:relationshipId/permissions', async (req) => {
    const { relationshipId } = req.params as { relationshipId: string };
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

  app.put('/v1/caregivers/:relationshipId/notification-rules', async (req) => {
    const { relationshipId } = req.params as { relationshipId: string };
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
        entityId: relationshipId, requestId: req.id, ipHash: req.ipHash, newValue: body as Record<string, unknown>,
      });
      return { rule: rows[0] };
    });
  });

  /** Revoke access. Immediate: the next request from that caregiver fails. */
  app.delete('/v1/caregivers/:relationshipId', async (req) => {
    const { relationshipId } = req.params as { relationshipId: string };
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
      // Any queued notification to this caregiver is dropped rather than sent
      // after their access ended.
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

  // ------------------------------------------------------ escalation policy

  app.get('/v1/escalation-policy', async (req) => {
    const { medicationId } = req.query as { medicationId?: string };
    const profileId = requireUuid((req.query as { profileId?: string }).profileId, 'profileId');
    const { userId } = currentUser(req);

    return withUserReadOnly(userId, async (tx) => {
      await requireProfileAccess(tx, userId, profileId, 'view_schedule');
      const { rows } = await tx.query(
        `SELECT id, medication_id, enabled, stages, quiet_hours_start, quiet_hours_end
           FROM escalation_policies
          WHERE patient_profile_id = $1
            AND (medication_id IS NOT DISTINCT FROM $2::uuid OR medication_id IS NULL)
          ORDER BY medication_id NULLS LAST`,
        [profileId, medicationId ?? null],
      );
      const policy = rows[0];
      return {
        policy: policy
          ? {
              id: policy.id, medicationId: policy.medication_id, enabled: policy.enabled,
              stages: policy.stages, quietHoursStart: policy.quiet_hours_start,
              quietHoursEnd: policy.quiet_hours_end,
            }
          : { id: null, medicationId: null, enabled: true, stages: DEFAULT_ESCALATION_STAGES, quietHoursStart: null, quietHoursEnd: null },
        isDefault: !policy,
        defaultStages: DEFAULT_ESCALATION_STAGES,
      };
    });
  });

  app.put('/v1/escalation-policy', async (req) => {
    const profileId = requireUuid((req.query as { profileId?: string }).profileId, 'profileId');
    const body = updateEscalationPolicySchema.parse(req.body);
    const { userId } = currentUser(req);

    return withUser(userId, async (tx) => {
      await requireProfileOwner(tx, userId, profileId);
      const { rows } = await tx.query(
        `INSERT INTO escalation_policies
           (patient_profile_id, medication_id, enabled, stages, quiet_hours_start, quiet_hours_end)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (patient_profile_id) WHERE medication_id IS NULL DO UPDATE
           SET enabled = EXCLUDED.enabled, stages = EXCLUDED.stages,
               quiet_hours_start = EXCLUDED.quiet_hours_start, quiet_hours_end = EXCLUDED.quiet_hours_end
         RETURNING id, medication_id, enabled, stages, quiet_hours_start, quiet_hours_end`,
        [
          profileId, body.medicationId ?? null, body.enabled, JSON.stringify(body.stages),
          body.quietHoursStart ?? null, body.quietHoursEnd ?? null,
        ],
      );
      await recordAudit(tx, {
        actorUserId: userId, patientProfileId: profileId, action: 'caregiver.notify_rules_changed',
        entityType: 'escalation_policy', entityId: rows[0]!.id, requestId: req.id, ipHash: req.ipHash,
        newValue: { enabled: body.enabled, stages: body.stages },
      });
      return { policy: rows[0] };
    });
  });
}
