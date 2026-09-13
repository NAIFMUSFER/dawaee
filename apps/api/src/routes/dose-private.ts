import type { FastifyInstance } from 'fastify';
import {
  AppError, ERROR_CODES, confirmDoseSchema, skipDoseSchema, snoozeDoseSchema,
} from '@dawaee/shared';
import { requireUuid } from '../lib/params.js';
import { withUser } from '../lib/db.js';
import { authenticate, currentUser } from '../middleware/context.js';
import { DOSE_CONFIRM, profileIdForDose, requireProfileAccess } from '../services/access-service.js';
import { confirmDose, skipDoseAction, snoozeDose, undoDose } from '../services/dose-service.js';
import { now as serverNow } from '../lib/clock.js';

/**
 * Privacy-preserving transport for interactive dose actions.
 *
 * Render records the HTTP request path before Dawaee's logger can redact it.
 * The legacy `/v1/doses/:doseId/taken|snooze|skip|undo` routes therefore expose
 * both a stable health-linked identifier and the action performed. New clients
 * use this single fixed path and carry both pieces of routing metadata in the
 * authenticated JSON body instead. The legacy routes remain during rollout.
 *
 * This is transport-only: authorization, early-action safety, idempotency,
 * stock movement and audit semantics are delegated to the same services used
 * by the legacy endpoints.
 */
export function registerDosePrivateRoutes(app: FastifyInstance): void {
  app.addHook('preHandler', async (req) => {
    if (req.url.startsWith('/v1/dose/action')) await authenticate(req, null as never);
  });

  app.post('/v1/dose/action', async (req) => {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      throw AppError.badRequest(ERROR_CODES.VALIDATION_FAILED, 'Invalid dose action');
    }

    const raw = req.body as Record<string, unknown>;
    const doseId = requireUuid(typeof raw.doseId === 'string' ? raw.doseId : undefined, 'doseId');
    const action = raw.action;
    if (!['taken', 'snooze', 'skip', 'undo'].includes(String(action))) {
      throw AppError.badRequest(ERROR_CODES.VALIDATION_FAILED, 'Invalid dose action');
    }

    const { userId } = currentUser(req);
    const now = serverNow();

    return withUser(userId, async (tx) => {
      const profileId = await profileIdForDose(tx, doseId);
      const access = await requireProfileAccess(tx, userId, profileId, DOSE_CONFIRM);

      if (action === 'taken') {
        const body = confirmDoseSchema.parse(raw);
        return confirmDose(tx, {
          doseId,
          userId,
          actorRole: access.role === 'owner' ? 'patient' : 'caregiver',
          clientEventId: body.clientEventId,
          takenAt: body.takenAt,
          method: access.role === 'caregiver' ? 'caregiver' : body.method,
          deviceId: body.deviceId,
          voiceConfidence: body.voiceConfidence,
          note: body.note,
          now,
          requestId: req.id,
          ipHash: req.ipHash,
        });
      }

      if (action === 'snooze') {
        const body = snoozeDoseSchema.parse(raw);
        return snoozeDose(tx, {
          doseId,
          userId,
          minutes: body.minutes,
          clientEventId: body.clientEventId,
          deviceId: body.deviceId,
          now,
          requestId: req.id,
          ipHash: req.ipHash,
        });
      }

      if (action === 'skip') {
        const body = skipDoseSchema.parse(raw);
        return skipDoseAction(tx, {
          doseId,
          userId,
          reason: body.reason,
          clientEventId: body.clientEventId,
          deviceId: body.deviceId,
          now,
          requestId: req.id,
          ipHash: req.ipHash,
        });
      }

      return undoDose(tx, { doseId, userId, now, requestId: req.id, ipHash: req.ipHash });
    });
  });
}
