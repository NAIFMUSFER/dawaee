import type { FastifyInstance } from 'fastify';
import { ERROR_CODES, updateEmergencyCardSchema } from '@dawaee/shared';
import { requireUuid } from '../lib/params.js';
import { withUser, withUserReadOnly, withTransaction } from '../lib/db.js';
import { randomToken, sha256 } from '../lib/crypto.js';
import { loadConfig } from '../config.js';
import { authenticate, currentUser } from '../middleware/context.js';
import { requireProfileAccess, requireProfileOwner } from '../services/access-service.js';
import { recordAudit } from '../services/audit-service.js';

/**
 * Emergency card and QR.
 *
 * The QR is the most sensitive surface in the product: anyone holding the code
 * can read it without signing in. Three things keep that safe —
 *  1. it is OFF by default and the patient chooses field by field what appears,
 *  2. the resolver runs inside the database and returns only those fields, so
 *     there is no path from a scan to the account, and
 *  3. rotating or disabling it takes effect on the next scan, immediately.
 */
export function registerEmergencyRoutes(app: FastifyInstance): void {
  const cfg = loadConfig();

  app.addHook('preHandler', async (req) => {
    // The public scan endpoint is deliberately unauthenticated.
    if (req.url.startsWith('/v1/emergency') && !req.url.startsWith('/v1/emergency/scan')) {
      await authenticate(req, null as never);
    }
  });

  app.get('/v1/emergency/card', async (req) => {
    const profileId = requireUuid((req.query as { profileId?: string }).profileId, 'profileId');
    const { userId } = currentUser(req);

    return withUserReadOnly(userId, async (tx) => {
      const access = await requireProfileAccess(tx, userId, profileId, 'view_emergency_card');
      const { rows } = await tx.query(
        `SELECT id, blood_type, allergies, conditions_note, emergency_contacts,
                include_medications, include_allergies, include_contacts, include_conditions,
                qr_enabled, qr_rotated_at, qr_view_count, qr_last_viewed_at, updated_at
           FROM emergency_cards WHERE patient_profile_id = $1`,
        [profileId],
      );
      const card = rows[0];
      return {
        card: card
          ? {
              id: card.id, patientDisplayName: access.profileDisplayName,
              bloodType: card.blood_type, allergies: card.allergies,
              conditionsNote: card.conditions_note, emergencyContacts: card.emergency_contacts,
              includeMedications: card.include_medications, includeAllergies: card.include_allergies,
              includeContacts: card.include_contacts,
              includeConditions: card.include_conditions, qrEnabled: card.qr_enabled,
              qrRotatedAt: card.qr_rotated_at, qrViewCount: card.qr_view_count,
              qrLastViewedAt: card.qr_last_viewed_at, updatedAt: card.updated_at,
            }
          : null,
        provenanceKey: 'emergency.userProvided',
      };
    });
  });

  app.put('/v1/emergency/card', async (req) => {
    const profileId = requireUuid((req.query as { profileId?: string }).profileId, 'profileId');
    const body = updateEmergencyCardSchema.parse(req.body);
    const { userId } = currentUser(req);

    return withUser(userId, async (tx) => {
      await requireProfileOwner(tx, userId, profileId);
      const { rows } = await tx.query(
        `INSERT INTO emergency_cards
           (patient_profile_id, blood_type, allergies, conditions_note, emergency_contacts,
            include_medications, include_allergies, include_contacts, include_conditions)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (patient_profile_id) DO UPDATE
           SET blood_type = EXCLUDED.blood_type, allergies = EXCLUDED.allergies,
               conditions_note = EXCLUDED.conditions_note,
               emergency_contacts = EXCLUDED.emergency_contacts,
               include_medications = EXCLUDED.include_medications,
               include_allergies = EXCLUDED.include_allergies,
               include_contacts = EXCLUDED.include_contacts,
               include_conditions = EXCLUDED.include_conditions
         RETURNING id, qr_enabled`,
        [
          profileId, body.bloodType ?? null, body.allergies, body.conditionsNote ?? null,
          JSON.stringify(body.emergencyContacts), body.includeMedications,
          body.includeAllergies, body.includeContacts, body.includeConditions,
        ],
      );
      await recordAudit(tx, {
        actorUserId: userId, patientProfileId: profileId, action: 'emergency_card.updated',
        entityType: 'emergency_card', entityId: rows[0]!.id, requestId: req.id, ipHash: req.ipHash,
        newValue: { allergyCount: body.allergies.length, contactCount: body.emergencyContacts.length },
      });
      return { card: { id: rows[0]!.id, qrEnabled: rows[0]!.qr_enabled } };
    });
  });

  /** Enable or rotate the QR. The raw token is returned exactly once. */
  app.post('/v1/emergency/qr/enable', async (req) => {
    const profileId = requireUuid((req.query as { profileId?: string }).profileId, 'profileId');
    const { userId } = currentUser(req);
    const token = randomToken(24);

    return withUser(userId, async (tx) => {
      await requireProfileOwner(tx, userId, profileId);
      const { rows } = await tx.query(
        `INSERT INTO emergency_cards (patient_profile_id, qr_enabled, qr_token_hash, qr_rotated_at)
         VALUES ($1, true, $2, now())
         ON CONFLICT (patient_profile_id) DO UPDATE
           SET qr_enabled = true, qr_token_hash = EXCLUDED.qr_token_hash,
               qr_rotated_at = now(), qr_view_count = 0
         RETURNING id`,
        [profileId, sha256(token)],
      );
      await recordAudit(tx, {
        actorUserId: userId, patientProfileId: profileId, action: 'emergency_card.qr_enabled',
        entityType: 'emergency_card', entityId: rows[0]!.id, requestId: req.id, ipHash: req.ipHash,
      });
      return {
        enabled: true,
        /**
         * The capability lives in the URL fragment, not the path/query.
         * Browsers never send a fragment in an HTTP request, so Render/CDN edge
         * request logs cannot acquire the bearer token before our application
         * logger has a chance to redact it. The /e screen consumes the fragment,
         * removes it from browser history, and presents it to the resolver in an
         * Authorization header over TLS.
         */
        qrUrl: `${cfg.PUBLIC_APP_URL}/e#${token}`,
        token,
      };
    });
  });

  app.post('/v1/emergency/qr/disable', async (req) => {
    const profileId = requireUuid((req.query as { profileId?: string }).profileId, 'profileId');
    const { userId } = currentUser(req);

    return withUser(userId, async (tx) => {
      await requireProfileOwner(tx, userId, profileId);
      const { rows } = await tx.query(
        `UPDATE emergency_cards SET qr_enabled = false, qr_token_hash = NULL
          WHERE patient_profile_id = $1 RETURNING id`,
        [profileId],
      );
      if (rows[0]) {
        await recordAudit(tx, {
          actorUserId: userId, patientProfileId: profileId, action: 'emergency_card.qr_disabled',
          entityType: 'emergency_card', entityId: rows[0].id, requestId: req.id, ipHash: req.ipHash,
        });
      }
      return { enabled: false };
    });
  });

  /**
   * Public scan. The route shape is retained so the endpoint inventory and old
   * clients do not gain a second public surface, but in production the path
   * parameter is deliberately inert. The capability must arrive in the
   * Authorization header. A fixed path value (`card`) is all the current client
   * sends, so infrastructure request logs contain no reusable secret.
   *
   * The path fallback is TEST-ONLY to keep the long-standing disclosure/rotation
   * suite exercising the database resolver while the dedicated transport
   * regression asserts the production boundary. Production currently has zero
   * enabled QR cards, so there is no deployed legacy token that needs a path
   * compatibility window.
   */
  app.get('/v1/emergency/scan/:token', {
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const authorization = req.headers.authorization;
    const bearer = typeof authorization === 'string'
      ? authorization.match(/^Bearer ([A-Za-z0-9_-]{32})$/)?.[1]
      : undefined;
    const legacyPathToken = (req.params as { token?: string }).token;
    const token = bearer ?? (cfg.NODE_ENV === 'test' ? legacyPathToken : undefined);

    reply.header('cache-control', 'no-store, no-cache, must-revalidate, private');
    reply.header('pragma', 'no-cache');
    reply.header('expires', '0');

    if (!token) {
      return reply.status(404).send({
        error: { code: ERROR_CODES.NOT_FOUND, message: 'This emergency code is not active' },
      });
    }

    const rows = await withTransaction(async (tx) => {
      const result = await tx.query(
        'SELECT * FROM app.resolve_emergency_qr($1)', [sha256(token)],
      );
      return result.rows;
    });

    if (!rows[0]) {
      return reply.status(404).send({
        error: { code: ERROR_CODES.NOT_FOUND, message: 'This emergency code is not active' },
      });
    }
    const card = rows[0] as {
      patient_display_name: string; blood_type: string | null; allergies: string[];
      conditions_note: string | null; emergency_contacts: unknown; medications: unknown;
    };

    return {
      patientName: card.patient_display_name,
      bloodType: card.blood_type,
      allergies: card.allergies,
      conditionsNote: card.conditions_note,
      emergencyContacts: card.emergency_contacts,
      medications: card.medications,
      provenanceKey: 'emergency.userProvided',
      notice: 'Information provided by the user. Not a medical record.',
    };
  });
}
