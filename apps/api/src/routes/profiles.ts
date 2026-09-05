import type { FastifyInstance } from 'fastify';
import {
  AppError, ERROR_CODES, applyTravelDecisionSchema, createProfileSchema,
  requestDeletionSchema, setConsentSchema, updateMeSchema,
  updatePreferencesSchema, updateProfileSchema,
} from '@dawaee/shared';
import { detectTimezoneChange } from '@dawaee/core';
import { withUser, withUserReadOnly } from '../lib/db.js';

/**
 * How long an account is kept after erasure is requested.
 *
 * Not zero: a request made from a stolen or briefly-borrowed phone must be
 * recoverable by the real owner, and an irreversible action with no window is
 * its own hazard. Not long either — this is an erasure right, not a
 * retention policy.
 */
const DELETION_GRACE_DAYS = 14;
import { authenticate, currentUser } from '../middleware/context.js';
import { listAccessibleProfiles, loadProfileAccess, requireProfileOwner } from '../services/access-service.js';
import { recordAudit } from '../services/audit-service.js';
import { rematerializeSchedule, scheduleFromRow } from '../services/materializer.js';
import { now as serverNow } from '../lib/clock.js';

export function registerProfileRoutes(app: FastifyInstance): void {
  app.addHook('preHandler', async (req) => {
    if (req.url.startsWith('/v1/profiles') || req.url.startsWith('/v1/me')) await authenticate(req, null as never);
  });

  app.get('/v1/me', async (req) => {
    const { userId } = currentUser(req);
    return withUserReadOnly(userId, async (tx) => {
      const { rows } = await tx.query(
        `SELECT u.id, u.phone_e164, u.email, u.display_name, u.locale, u.timezone, u.created_at,
                p.locale AS pref_locale, p.numeral_system, p.calendar_system, p.elderly_mode,
                p.text_scale, p.high_contrast, p.voice_reminders_enabled, p.voice_confirmation_enabled,
                p.show_medication_in_notifications,
                p.app_lock_enabled, p.app_lock_areas, p.quiet_hours_start, p.quiet_hours_end,
                p.default_snooze_minutes, p.low_stock_threshold_days, p.expiry_warning_days
           FROM users u LEFT JOIN user_preferences p ON p.user_id = u.id
          WHERE u.id = $1`,
        [userId],
      );
      const u = rows[0];
      if (!u) throw AppError.notFound('Account not found');

      const { rows: consents } = await tx.query(
        'SELECT type::text AS type, granted, version, granted_at FROM consents WHERE user_id = $1',
        [userId],
      );

      return {
        user: {
          id: u.id, phoneE164: u.phone_e164, email: u.email, displayName: u.display_name,
          locale: u.locale, timezone: u.timezone, createdAt: u.created_at,
        },
        preferences: {
          locale: u.pref_locale ?? u.locale,
          numeralSystem: u.numeral_system ?? 'latn',
          calendarSystem: u.calendar_system ?? 'gregory',
          elderlyMode: u.elderly_mode ?? false,
          textScale: Number(u.text_scale ?? 1),
          highContrast: u.high_contrast ?? false,
          voiceRemindersEnabled: u.voice_reminders_enabled ?? false,
          voiceConfirmationEnabled: u.voice_confirmation_enabled ?? false,
          // Default false on a row that predates the column, so a missing value
          // is the private setting rather than the disclosing one.
          showMedicationInNotifications: u.show_medication_in_notifications ?? false,
          appLockEnabled: u.app_lock_enabled ?? false,
          appLockAreas: u.app_lock_areas ?? [],
          quietHoursStart: u.quiet_hours_start, quietHoursEnd: u.quiet_hours_end,
          defaultSnoozeMinutes: u.default_snooze_minutes ?? 10,
          lowStockThresholdDays: u.low_stock_threshold_days ?? 7,
          expiryWarningDays: u.expiry_warning_days ?? 30,
        },
        consents: consents.map((c) => ({ type: c.type, granted: c.granted, version: c.version, grantedAt: c.granted_at })),
      };
    });
  });

  /**
   * Update the signed-in user's own record.
   *
   * The body used to be a bare cast with no schema: `locale`, `timezone` and
   * `email` were written exactly as sent. Two consequences, one of them worse
   * than it looks. An arbitrary `timezone` string is what every dose in the
   * account is materialized against, so a malformed value is a broken
   * schedule, not a cosmetic defect. And because `users.email` is uniquely
   * indexed, an unvalidated write turned this into a cheap authenticated
   * oracle for whether any given email address has an account — at 300
   * requests a minute against a medication app, where merely having an
   * account is health-adjacent.
   */
  app.patch('/v1/me', async (req) => {
    const { userId } = currentUser(req);
    const body = updateMeSchema.parse(req.body);
    return withUser(userId, async (tx) => {
      const { rows } = await tx.query(
        `UPDATE users SET
           display_name = COALESCE($2, display_name),
           locale = COALESCE($3, locale),
           timezone = COALESCE($4, timezone),
           email = COALESCE($5, email)
         WHERE id = $1
         RETURNING id, display_name, locale, timezone, email`,
        [userId, body.displayName ?? null, body.locale ?? null, body.timezone ?? null,
         body.email ? body.email.trim().toLowerCase() : null],
      );
      return { user: rows[0] };
    });
  });

  app.patch('/v1/me/preferences', async (req) => {
    const body = updatePreferencesSchema.parse(req.body);
    const { userId } = currentUser(req);
    return withUser(userId, async (tx) => {
      const { rows } = await tx.query(
        `INSERT INTO user_preferences (user_id) VALUES ($1)
         ON CONFLICT (user_id) DO UPDATE SET
           locale = COALESCE($2, user_preferences.locale),
           numeral_system = COALESCE($3, user_preferences.numeral_system),
           calendar_system = COALESCE($4, user_preferences.calendar_system),
           elderly_mode = COALESCE($5, user_preferences.elderly_mode),
           text_scale = COALESCE($6, user_preferences.text_scale),
           high_contrast = COALESCE($7, user_preferences.high_contrast),
           voice_reminders_enabled = COALESCE($8, user_preferences.voice_reminders_enabled),
           voice_confirmation_enabled = COALESCE($9, user_preferences.voice_confirmation_enabled),
           app_lock_enabled = COALESCE($10, user_preferences.app_lock_enabled),
           app_lock_areas = COALESCE($11, user_preferences.app_lock_areas),
           quiet_hours_start = COALESCE($12, user_preferences.quiet_hours_start),
           quiet_hours_end = COALESCE($13, user_preferences.quiet_hours_end),
           default_snooze_minutes = COALESCE($14, user_preferences.default_snooze_minutes),
           low_stock_threshold_days = COALESCE($15, user_preferences.low_stock_threshold_days),
           expiry_warning_days = COALESCE($16, user_preferences.expiry_warning_days),
           show_medication_in_notifications = COALESCE($17, user_preferences.show_medication_in_notifications)
         RETURNING *`,
        [
          userId, body.locale ?? null, body.numeralSystem ?? null, body.calendarSystem ?? null,
          body.elderlyMode ?? null, body.textScale ?? null, body.highContrast ?? null,
          body.voiceRemindersEnabled ?? null, body.voiceConfirmationEnabled ?? null,
          body.appLockEnabled ?? null, body.appLockAreas ?? null,
          body.quietHoursStart ?? null, body.quietHoursEnd ?? null,
          body.defaultSnoozeMinutes ?? null, body.lowStockThresholdDays ?? null, body.expiryWarningDays ?? null,
          body.showMedicationInNotifications ?? null,
        ],
      );
      return { preferences: rows[0] };
    });
  });

  /**
   * Consent. OCR image processing is gated on an
   * explicit grant recorded here, and withdrawal takes effect immediately
   * because the escalation engine reads this on every send.
   */
  app.put('/v1/me/consents', async (req) => {
    const body = setConsentSchema.parse(req.body);
    const { userId } = currentUser(req);
    return withUser(userId, async (tx) => {
      // The profile id arrives in the BODY, and nothing checked it. Row level
      // security does not catch this: the consents policy constrains user_id
      // only, and a foreign key check does not apply the referenced table's
      // policies — so one patient could write a consent row, and an entry in
      // the append-only audit trail, scoped to another patient's profile.
      // Confirmed against a live database before this line existed.
      //
      // A consent is a statement the profile's OWNER makes. A caregiver, even
      // one with wide permissions, does not consent on someone else's behalf.
      if (body.patientProfileId) {
        await requireProfileOwner(tx, userId, body.patientProfileId);
      }

      const { rows } = await tx.query(
        `INSERT INTO consents (user_id, patient_profile_id, type, granted, version, granted_at, withdrawn_at, ip_hash)
         VALUES ($1,$2,$3,$4,$5, CASE WHEN $4 THEN now() END, CASE WHEN NOT $4 THEN now() END, $6)
         ON CONFLICT (user_id, COALESCE(patient_profile_id, '00000000-0000-0000-0000-000000000000'::uuid), type)
         DO UPDATE SET granted = EXCLUDED.granted, version = EXCLUDED.version,
                       granted_at = CASE WHEN EXCLUDED.granted THEN now() ELSE consents.granted_at END,
                       withdrawn_at = CASE WHEN NOT EXCLUDED.granted THEN now() END,
                       ip_hash = EXCLUDED.ip_hash
         RETURNING type::text AS type, granted, version`,
        [userId, body.patientProfileId ?? null, body.type, body.granted, body.version, req.ipHash],
      );
      await recordAudit(tx, {
        actorUserId: userId,
        patientProfileId: body.patientProfileId ?? null,
        action: body.granted ? 'consent.granted' : 'consent.withdrawn',
        entityType: 'consent', entityId: body.type, requestId: req.id, ipHash: req.ipHash,
        newValue: { type: body.type, granted: body.granted, version: body.version },
      });
      return { consent: rows[0] };
    });
  });

  /**
   * Ask for the account to be erased.
   *
   * The privacy screen has always offered this, behind a two-step
   * confirmation, and always called an endpoint that did not exist — the
   * request failed every time against a real server, and only looked like it
   * worked in the preview build, whose stub answered success. A screen that
   * promises an erasure right and silently cannot exercise it is worse than
   * one that never offered it.
   *
   * It marks rather than deletes, deliberately. Erasure has to cascade across
   * every profile, dose, note and caregiver link, and it has to survive a
   * crash halfway through; doing that inside one request, while the person
   * waits, is how half-deleted accounts happen. The mark is the durable,
   * auditable record that they asked, and the deadline is what the request is
   * measured against.
   *
   * Requesting twice is not an error — someone unsure whether the first one
   * registered must not be told "no" — so the original timestamp is kept.
   */
  app.post('/v1/me/deletion-request', {
    config: { rateLimit: { max: 5, timeWindow: '10 minutes' } },
  }, async (req) => {
    const body = requestDeletionSchema.parse(req.body);
    if (!body.confirm) {
      throw AppError.badRequest(ERROR_CODES.VALIDATION_FAILED, 'Deletion must be explicitly confirmed');
    }
    const { userId } = currentUser(req);

    return withUser(userId, async (tx) => {
      const { rows } = await tx.query<{ deletion_requested_at: string }>(
        `UPDATE users
            SET deletion_requested_at = COALESCE(deletion_requested_at, now())
          WHERE id = $1
        RETURNING deletion_requested_at`,
        [userId],
      );
      const requestedAt = rows[0]?.deletion_requested_at;
      if (!requestedAt) throw AppError.notFound('Account not found');

      // Every device is silenced at once. Continuing to send medication
      // reminders to someone who has asked to be erased is the most visible
      // way to ignore the request.
      await tx.query('UPDATE push_tokens SET active = false WHERE user_id = $1', [userId]);

      await recordAudit(tx, {
        actorUserId: userId,
        patientProfileId: null,
        action: 'account.deletion_requested',
        entityType: 'user', entityId: userId,
        requestId: req.id, ipHash: req.ipHash,
        newValue: { requestedAt },
      });

      const scheduledFor = new Date(
        new Date(requestedAt).getTime() + DELETION_GRACE_DAYS * 24 * 60 * 60 * 1000,
      ).toISOString();
      return { requested: true, requestedAt, scheduledFor };
    });
  });

  // ------------------------------------------------------------- profiles

  app.get('/v1/profiles', async (req) => {
    const { userId } = currentUser(req);
    return { profiles: await withUserReadOnly(userId, (tx) => listAccessibleProfiles(tx, userId)) };
  });

  app.post('/v1/profiles', async (req) => {
    const body = createProfileSchema.parse(req.body);
    const { userId } = currentUser(req);
    return withUser(userId, async (tx) => {
      const { rows } = await tx.query(
        `INSERT INTO patient_profiles
           (owner_user_id, display_name, birth_year, timezone, home_timezone, travel_policy, is_self)
         VALUES ($1,$2,$3,$4,$4,$5,$6)
         RETURNING id, display_name, birth_year, timezone, home_timezone, travel_policy::text AS travel_policy, is_self`,
        [userId, body.displayName, body.birthYear ?? null, body.timezone, body.travelPolicy, body.isSelf],
      );
      const profile = rows[0]!;
      await recordAudit(tx, {
        actorUserId: userId, patientProfileId: profile.id, action: 'profile.created',
        entityType: 'patient_profile', entityId: profile.id, requestId: req.id, ipHash: req.ipHash,
        newValue: { displayName: body.displayName },
      });
      return { profile };
    });
  });

  app.get('/v1/profiles/:profileId', async (req) => {
    const { profileId } = req.params as { profileId: string };
    const { userId } = currentUser(req);
    return withUserReadOnly(userId, async (tx) => {
      const access = await loadProfileAccess(tx, userId, profileId);
      if (access.role === 'none') throw AppError.notFound('Patient profile not found');
      return {
        profile: {
          id: access.profile.id,
          displayName: access.profileDisplayName,
          timezone: access.profileTimezone,
          homeTimezone: access.profileHomeTimezone,
          role: access.role,
          permissions: access.relationship?.permissions ?? null,
        },
      };
    });
  });

  app.patch('/v1/profiles/:profileId', async (req) => {
    const { profileId } = req.params as { profileId: string };
    const body = updateProfileSchema.parse(req.body);
    const { userId } = currentUser(req);
    return withUser(userId, async (tx) => {
      await requireProfileOwner(tx, userId, profileId);
      const { rows } = await tx.query(
        `UPDATE patient_profiles SET
           display_name = COALESCE($2, display_name),
           birth_year = COALESCE($3, birth_year),
           timezone = COALESCE($4, timezone),
           home_timezone = COALESCE($5, home_timezone),
           travel_policy = COALESCE($6, travel_policy)
         WHERE id = $1
         RETURNING id, display_name, birth_year, timezone, home_timezone, travel_policy::text AS travel_policy`,
        [profileId, body.displayName ?? null, body.birthYear ?? null, body.timezone ?? null,
         body.homeTimezone ?? null, body.travelPolicy ?? null],
      );
      await recordAudit(tx, {
        actorUserId: userId, patientProfileId: profileId, action: 'profile.updated',
        entityType: 'patient_profile', entityId: profileId, requestId: req.id, ipHash: req.ipHash,
        newValue: body as Record<string, unknown>,
      });
      return { profile: rows[0] };
    });
  });

  // --------------------------------------------------------- travel mode

  /**
   * Reports a device timezone that differs from the schedule's, WITHOUT
   * changing anything. The client shows the choice; nothing moves until the
   * patient answers. Silently shifting medication times is the exact failure
   * this endpoint exists to prevent.
   */
  app.post('/v1/profiles/:profileId/timezone-check', async (req) => {
    const { profileId } = req.params as { profileId: string };
    const { deviceTimezone } = req.body as { deviceTimezone: string };
    const { userId } = currentUser(req);

    return withUser(userId, async (tx) => {
      const access = await requireProfileOwner(tx, userId, profileId);
      const detection = detectTimezoneChange(access.profileTimezone, deviceTimezone, serverNow());
      if (!detection.changed) return { changed: false };

      const { rows } = await tx.query(
        `INSERT INTO travel_prompts (patient_profile_id, detected_timezone, previous_timezone, offset_shift_hours)
         VALUES ($1,$2,$3,$4) RETURNING id`,
        [profileId, deviceTimezone, access.profileTimezone, detection.offsetShiftHours],
      );
      return {
        changed: true,
        promptId: rows[0]!.id,
        from: detection.from,
        to: detection.to,
        offsetShiftHours: detection.offsetShiftHours,
        options: ['keep_home_time', 'follow_local_time', 'dismiss'],
      };
    });
  });

  app.post('/v1/profiles/:profileId/timezone-decision', async (req) => {
    const { profileId } = req.params as { profileId: string };
    const body = applyTravelDecisionSchema.parse({ ...(req.body as object), patientProfileId: profileId });
    const { userId } = currentUser(req);
    const now = serverNow();

    return withUser(userId, async (tx) => {
      const access = await requireProfileOwner(tx, userId, profileId);
      await tx.query(
        `UPDATE travel_prompts SET decision = $2, decided_at = now()
          WHERE patient_profile_id = $1 AND decision IS NULL`,
        [profileId, body.decision],
      );
      if (body.decision === 'dismiss') return { applied: false, decision: body.decision };

      const newTz = body.decision === 'keep_home_time' ? access.profileHomeTimezone : body.detectedTimezone;
      await tx.query('UPDATE patient_profiles SET timezone = $2 WHERE id = $1', [profileId, newTz]);

      let regenerated = 0;
      if (body.decision === 'follow_local_time') {
        // Re-anchor the wall-clock times to the new zone, then rebuild only
        // the untouched future doses.
        await tx.query(
          `UPDATE medication_schedules SET timezone = $2 WHERE patient_profile_id = $1 AND active`,
          [profileId, newTz],
        );
        const { rows } = await tx.query(
          `SELECT id, medication_id, patient_profile_id, rule, rule_kind::text AS rule_kind, dose_quantity,
                  dose_unit::text AS dose_unit, timezone, start_date, end_date, missed_after_minutes,
                  late_after_minutes, active, created_by
             FROM medication_schedules WHERE patient_profile_id = $1 AND active`,
          [profileId],
        );
        for (const row of rows) {
          const result = await rematerializeSchedule(tx, scheduleFromRow(row), now);
          regenerated += result.created;
        }
      }

      await recordAudit(tx, {
        actorUserId: userId, patientProfileId: profileId, action: 'schedule.updated',
        entityType: 'travel_decision', entityId: profileId, requestId: req.id, ipHash: req.ipHash,
        previousValue: { timezone: access.profileTimezone },
        newValue: { timezone: newTz, decision: body.decision },
      });

      return { applied: true, decision: body.decision, timezone: newTz, dosesRegenerated: regenerated };
    });
  });
}
