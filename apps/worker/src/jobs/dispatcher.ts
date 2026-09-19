import { createHash } from 'node:crypto';
import { sanitizeOperationalError, t, type Locale } from '@dawaee/shared';
import type { PoolClient } from 'pg';
import type { PushMessage } from '@dawaee/api/providers';
import type { WorkerContext } from '../context.js';
import { quietHoursResumeAt } from '@dawaee/core';
import { currentPatientReminder, currentStockReminder } from './delivery-state.js';

const LEASE_SECONDS = 120;
const AMBIGUOUS_IS_RETRYABLE = true;

function fingerprintPushToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function isAmbiguous(errorCode: string | undefined): boolean {
  return errorCode === 'network_error' || /^http_5\d\d$/.test(errorCode ?? '');
}

interface DeliveryRow {
  id: string;
  patient_profile_id: string | null;
  dose_occurrence_id: string | null;
  recipient_user_id: string | null;
  recipient_phone_e164: string | null;
  relationship_id: string | null;
  kind: string;
  channel: string;
  locale: string;
  title: string | null;
  body: string | null;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
  lease_token: string;
}

interface ReceiptTicket {
  providerMessageId: string;
  pushTokenId: string;
  tokenFingerprint: string;
}

export async function claimDeliveries(
  ctx: WorkerContext, client: PoolClient, limit = 200,
): Promise<DeliveryRow[]> {
  const { rows } = await client.query<DeliveryRow>(
    `UPDATE notification_deliveries d
        SET status = 'sending',
            attempts = d.attempts + 1,
            lease_until = $1::timestamptz + make_interval(secs => $2),
            lease_token = gen_random_uuid()
      WHERE d.id IN (
        SELECT id FROM notification_deliveries
         WHERE (status = 'queued' AND next_attempt_at <= $1)
            OR (status = 'sending' AND lease_until IS NOT NULL AND lease_until <= $1)
         ORDER BY next_attempt_at
         LIMIT $3
         FOR UPDATE SKIP LOCKED
      )
      RETURNING d.id, d.patient_profile_id, d.dose_occurrence_id, d.recipient_user_id, d.recipient_phone_e164,
                d.relationship_id, d.kind::text AS kind, d.channel::text AS channel, d.locale,
                d.title, d.body, d.payload, d.attempts, d.max_attempts, d.lease_token`,
    [ctx.now(), LEASE_SECONDS, limit],
  );
  return rows;
}

export async function dispatchJob(ctx: WorkerContext, client: PoolClient): Promise<{ itemsProcessed: number }> {
  const claimClient = await ctx.pool.connect();
  let rows: DeliveryRow[];
  try {
    await claimClient.query('BEGIN');
    rows = await claimDeliveries(ctx, claimClient);
    await claimClient.query('COMMIT');
  } catch (err) {
    await claimClient.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    claimClient.release();
  }
  if (rows.length === 0) return { itemsProcessed: 0 };

  let sent = 0;
  for (const row of rows) {
    // A delivery can sit in the outbox after the relationship that authorised
    // it has been narrowed. Re-check at the last application boundary before
    // invoking an external provider.
    if (!await caregiverDeliveryStillAuthorized(client, row)) {
      await finalise(ctx, row,
        `UPDATE notification_deliveries
            SET status = 'skipped', lease_until = NULL, lease_token = NULL
          WHERE id = $1 AND status = 'sending' AND lease_token = $2`,
        []);
      continue;
    }

    const deferredUntil = await nonUrgentResumeAt(client, row, ctx.now());
    if (deferredUntil) {
      await finalise(ctx, row,
        `UPDATE notification_deliveries
            SET status = 'queued', next_attempt_at = $3, attempts = GREATEST(0, attempts - 1),
                lease_until = NULL, lease_token = NULL
          WHERE id = $1 AND lease_token = $2 AND status = 'sending'`, [deferredUntil]);
      continue;
    }

    const result = await sendOne(ctx, client, row);

    if (result.leaseExpired) {
      // A later member of a claimed batch may wait longer than the lease.
      // Return it to the queue instead of sending without ownership or dropping it.
      await finalise(ctx, row,
        `UPDATE notification_deliveries
            SET status = 'queued', next_attempt_at = $3, attempts = GREATEST(0, attempts - 1),
                lease_until = NULL, lease_token = NULL
          WHERE id = $1 AND status = 'sending' AND lease_token = $2`, [ctx.now()]);
    } else if (result.skipped) {
      await finalise(ctx, row,
        `UPDATE notification_deliveries
            SET status = 'skipped', lease_until = NULL, lease_token = NULL
          WHERE id = $1 AND status = 'sending' AND lease_token = $2`,
        []);
    } else if (result.ok) {
      const applied = await finalise(ctx, row,
        `UPDATE notification_deliveries
            SET status = 'sent', sent_at = $3::timestamptz, provider = $4, provider_message_id = $5,
                provider_receipts = $6::jsonb, error_code = NULL, error_detail = NULL, lease_until = NULL
          WHERE id = $1 AND lease_token = $2 AND status = 'sending'`,
        [ctx.now(), result.provider, result.providerMessageId ?? null, JSON.stringify(result.receiptTickets ?? [])]);
      if (applied) sent += 1;
    } else if (
      (isAmbiguous(result.errorCode) ? AMBIGUOUS_IS_RETRYABLE : (result.retryable ?? false))
      && row.attempts < row.max_attempts
    ) {
      const delaySeconds = Math.min(300, 30 * 2 ** Math.max(0, row.attempts - 1));
      await finalise(ctx, row,
        `UPDATE notification_deliveries
            SET status = 'queued', next_attempt_at = $3::timestamptz + make_interval(secs => $4),
                error_code = $5, error_detail = $6, provider = $7, lease_until = NULL
          WHERE id = $1 AND lease_token = $2 AND status = 'sending'`,
        [
          ctx.now(), delaySeconds, result.errorCode ?? null,
          result.errorDetail ? sanitizeOperationalError(result.errorDetail) : null, result.provider,
        ]);
    } else {
      await finalise(ctx, row,
        `UPDATE notification_deliveries
            SET status = 'failed', error_code = $3, error_detail = $4, provider = $5,
                lease_until = NULL
          WHERE id = $1 AND lease_token = $2 AND status = 'sending'`,
        [result.errorCode ?? null, result.errorDetail ? sanitizeOperationalError(result.errorDetail) : null, result.provider]);
      ctx.log.warn(
        { deliveryId: row.id, channel: row.channel, errorCode: result.errorCode },
        'notification delivery failed permanently',
      );
    }
  }

  return { itemsProcessed: sent };
}

async function caregiverDeliveryStillAuthorized(client: PoolClient, row: DeliveryRow): Promise<boolean> {
  if (!row.relationship_id) return true;
  if (!row.patient_profile_id || !row.recipient_user_id) return false;

  const { rows } = await client.query<{ permissions: string[] }>(
    `SELECT permissions
       FROM caregiver_relationships
      WHERE id = $1
        AND patient_profile_id = $2
        AND caregiver_user_id = $3
        AND app.caregiver_identity_verified(id)
        AND status = 'active'`,
    [row.relationship_id, row.patient_profile_id, row.recipient_user_id],
  );
  const permissions = rows[0]?.permissions;
  if (!permissions?.includes('receive_notifications')) return false;

  if (row.kind === 'daily_summary' || row.kind === 'weekly_summary') {
    if (!permissions.includes('view_adherence') || !permissions.includes('view_schedule')) return false;
    const { rows: rules } = await client.query(
      `SELECT id FROM caregiver_notification_rules
        WHERE relationship_id = $1 AND enabled AND mode::text = $2 AND channel::text = $3
          AND ($4::text IS NULL OR id::text = $4)`,
      [row.relationship_id, row.kind, row.channel, typeof row.payload.ruleId === 'string' ? row.payload.ruleId : null],
    );
    return rules.length > 0;
  }
  if (row.kind === 'escalation') {
    const { rows: rules } = await client.query(
      `SELECT id FROM caregiver_notification_rules WHERE relationship_id=$1
        AND enabled AND channel::text=$2 AND mode IN ('every_dose','missed_only','consecutive_missed')`,
      [row.relationship_id, row.channel],
    );
    return rules.length > 0;
  }
  return true;
}

async function nonUrgentResumeAt(client: PoolClient, row: DeliveryRow, now: Date): Promise<Date | null> {
  if (!['low_stock', 'expiry_warning', 'daily_summary', 'weekly_summary'].includes(row.kind) || !row.recipient_user_id) return null;
  const { rows } = await client.query<{ timezone: string; quiet_hours_start: string | null; quiet_hours_end: string | null }>(
    `SELECT u.timezone, up.quiet_hours_start::text, up.quiet_hours_end::text
       FROM users u LEFT JOIN user_preferences up ON up.user_id = u.id WHERE u.id = $1`, [row.recipient_user_id],
  );
  const prefs = rows[0];
  const globalResume = prefs ? quietHoursResumeAt(now, prefs.timezone, prefs.quiet_hours_start?.slice(0, 5) ?? null,
    prefs.quiet_hours_end?.slice(0, 5) ?? null) : null;
  if (!row.relationship_id) return globalResume;
  const { rows: rules } = await client.query<{ timezone: string; quiet_hours_start: string | null; quiet_hours_end: string | null }>(
    `SELECT pp.timezone, r.quiet_hours_start::text, r.quiet_hours_end::text
       FROM caregiver_notification_rules r
       JOIN patient_profiles pp ON pp.id = r.patient_profile_id
      WHERE r.relationship_id = $1 AND r.enabled AND r.channel::text = $2`, [row.relationship_id, row.channel],
  );
  const rule = rules[0];
  const ruleResume = rule ? quietHoursResumeAt(now, rule.timezone, rule.quiet_hours_start?.slice(0, 5) ?? null,
    rule.quiet_hours_end?.slice(0, 5) ?? null) : null;
  // Both clocks are explicit: account quiet hours use the recipient's zone;
  // circle-specific rules use the patient's calendar, like their digest time.
  if (!globalResume) return ruleResume;
  return ruleResume && ruleResume > globalResume ? ruleResume : globalResume;
}

async function finalise(
  ctx: WorkerContext, row: DeliveryRow, sql: string, params: unknown[],
): Promise<boolean> {
  const c = await ctx.pool.connect();
  try {
    const { rowCount } = await c.query(sql, [row.id, row.lease_token, ...params]);
    if (rowCount === 0) {
      ctx.log.warn(
        { deliveryId: row.id },
        'delivery lease is no longer active; provider result discarded',
      );
      return false;
    }
    return true;
  } finally {
    c.release();
  }
}

interface SendOutcome {
  ok: boolean;
  skipped?: boolean;
  leaseExpired?: boolean;
  provider: string;
  providerMessageId?: string;
  receiptTickets?: ReceiptTicket[];
  errorCode?: string;
  errorDetail?: string;
  retryable?: boolean;
}

async function sendOne(ctx: WorkerContext, client: PoolClient, row: DeliveryRow): Promise<SendOutcome> {
  switch (row.channel) {
    case 'push':
      return sendPush(ctx, client, row);
    case 'local':
    case 'in_app':
      return { ok: true, provider: 'device_local' };
    default:
      return { ok: false, provider: 'none', errorCode: 'unsupported_channel', retryable: false };
  }
}

function privateBody(row: DeliveryRow, payload: Record<string, unknown>): string | null {
  const locale = (row.locale === 'en' ? 'en' : 'ar') as Locale;
  const time = typeof payload.scheduledLocalTime === 'string' ? payload.scheduledLocalTime : '';

  if (row.kind === 'dose_reminder') {
    return t(locale, 'reminder.bodyPrivate', { time });
  }
  if (row.kind === 'dose_reminder_repeat') {
    return t(locale, 'reminder.repeatPrivate', { time });
  }
  if (row.kind === 'escalation') {
    const patient = typeof payload.patientName === 'string' ? payload.patientName : '';
    return t(locale, 'caregiver.missedAlertPrivate', { patient, time });
  }
  if (row.kind === 'low_stock') {
    const qty = typeof payload.remaining === 'number' || typeof payload.remaining === 'string'
      ? String(payload.remaining) : '';
    const days = typeof payload.daysRemaining === 'number' || typeof payload.daysRemaining === 'string'
      ? String(payload.daysRemaining) : '';
    const unit = typeof payload.unit === 'string' ? payload.unit : '';
    return `${t(locale, 'stock.remaining', { qty, unit })}. ${t(locale, 'stock.runsOutIn', { days })}.`;
  }
  if (row.kind === 'expiry_warning') {
    const date = typeof payload.expiryDate === 'string' ? payload.expiryDate : '';
    return date ? `${t(locale, 'expiry.warningTitle')} — ${date}.` : t(locale, 'expiry.warningTitle');
  }
  return row.body;
}

async function applyCurrentNotificationPrivacy(
  client: PoolClient, row: DeliveryRow,
): Promise<{ body: string | null; payload: Record<string, unknown>; showMedication: boolean }> {
  if (!row.patient_profile_id) return { body: row.body, payload: row.payload, showMedication: false };

  const { rows } = await client.query<{ show_medication: boolean }>(
    `SELECT COALESCE(up.show_medication_in_notifications, false) AS show_medication
       FROM patient_profiles pp
       LEFT JOIN user_preferences up ON up.user_id = COALESCE(pp.linked_user_id, pp.owner_user_id)
      WHERE pp.id = $1`,
    [row.patient_profile_id],
  );
  let mayRevealMedication = rows[0]?.show_medication === true;

  if (mayRevealMedication && row.relationship_id) {
    const { rows: permissionRows } = await client.query<{ can_view_medication: boolean }>(
      `SELECT status = 'active'
              AND caregiver_user_id = $2
              AND app.caregiver_identity_verified(id)
              AND 'view_medications' = ANY(permissions) AS can_view_medication
         FROM caregiver_relationships
        WHERE id = $1 AND patient_profile_id = $3`,
      [row.relationship_id, row.recipient_user_id, row.patient_profile_id],
    );
    mayRevealMedication = permissionRows[0]?.can_view_medication === true;
  }

  if (mayRevealMedication) return { body: row.body, payload: row.payload, showMedication: true };

  const payload = { ...row.payload };
  delete payload.medicationName;
  delete payload.medications;

  return { body: privateBody(row, payload), payload, showMedication: false };
}

async function sendPush(ctx: WorkerContext, client: PoolClient, row: DeliveryRow): Promise<SendOutcome> {
  if (!row.recipient_user_id) {
    return { ok: false, provider: ctx.providers.push.name, errorCode: 'no_recipient', retryable: false };
  }

  // Like finalisation, renewal commits on a separate connection. The job's
  // client holds its advisory-lock transaction until all sends finish; writing
  // this row there would block our own later finalisation connection.
  const renewed = await finalise(ctx, row,
    `UPDATE notification_deliveries SET lease_until = $3::timestamptz + make_interval(secs => $4)
      WHERE id = $1 AND lease_token = $2 AND status = 'sending' AND lease_until > $3`,
    [ctx.now(), LEASE_SECONDS],
  );
  if (!renewed) return { ok: false, leaseExpired: true, provider: ctx.providers.push.name };

  // Receipt reconciliation needs the internal endpoint id as well as the
  // provider token. The SECURITY DEFINER helper returns only live-session
  // endpoints and keeps auth-session data outside the worker role.
  const { rows: tokens } = await client.query<{ push_token_id: string; token: string }>(
    'SELECT push_token_id, token FROM app.list_live_push_endpoints($1, 5)',
    [row.recipient_user_id],
  );
  if (tokens.length === 0) {
    return { ok: false, provider: ctx.providers.push.name, errorCode: 'no_active_device', retryable: false };
  }

  let safe = await applyCurrentNotificationPrivacy(client, row);
  if (!row.relationship_id && ['dose_reminder', 'dose_reminder_repeat'].includes(row.kind)) {
    const current = await currentPatientReminder(client, row, ctx.now(), safe.showMedication);
    if (!current) return { ok: false, skipped: true, provider: ctx.providers.push.name };
    safe = { ...current, showMedication: safe.showMedication };
  }
  if (!row.relationship_id && row.kind === 'low_stock') {
    const current = await currentStockReminder(client, row, ctx.now(), safe.showMedication);
    if (!current) return { ok: false, skipped: true, provider: ctx.providers.push.name };
    safe = { ...current, showMedication: safe.showMedication };
  }
  // A caregiver's lock screen and push provider are not an authenticated
  // medical-record view. Never forward names, dose identifiers or dose actions,
  // even when the patient opted into detailed reminders on their own device.
  // Preserve the detailed outbox record for authorized in-app access.
  const caregiver = row.relationship_id !== null || row.kind === 'escalation';
  const english = row.locale === 'en';
  const grouped = !caregiver && safe.payload.grouped === true;
  const messages: PushMessage[] = tokens.map((token): PushMessage => ({
    token: token.token,
    title: caregiver
      ? (english ? 'Dawaee — Follow-up alert' : 'دوائي — تنبيه متابعة')
      : row.title ?? '',
    body: caregiver
      ? (english
          ? 'You have a follow-up alert. Open Dawaee to view the details.'
          : 'لديك تنبيه يحتاج إلى متابعتك. افتح دوائي لعرض التفاصيل.')
      : safe.body ?? '',
    data: caregiver ? { deliveryId: row.id, kind: row.kind } : {
      deliveryId: row.id,
      kind: grouped ? 'dose_group_reminder' : row.kind,
      doseId: grouped ? '' : String(safe.payload.doseId ?? ''),
      doseIds: grouped ? JSON.stringify(safe.payload.doseIds ?? []) : '[]',
      actions: JSON.stringify(safe.payload.actions ?? []),
      ...(safe.payload.reason === 'snooze' ? {
        intentId: String(safe.payload.intentId ?? ''),
        expectedSnoozedUntil: String(safe.payload.expectedSnoozedUntil ?? ''),
      } : {}),
    },
    priority: row.kind === 'dose_reminder' || row.kind === 'dose_reminder_repeat' || row.kind === 'escalation'
      ? 'high' : 'default',
    categoryId: !caregiver && row.kind.startsWith('dose_reminder') && !grouped ? 'MEDICATION_REMINDER' : undefined,
    sound: 'default',
  }));

  if (row.kind === 'escalation') {
    // A confirmation/cancellation/snooze can arrive after the outbox claim while
    // resolving devices/privacy. Re-read the authoritative occurrence and our
    // exact live lease immediately before the external send. This prevents
    // known-stale alerts; it cannot retract a push already accepted by Expo.
    const { rows: pending } = await client.query<{ still_pending: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM notification_deliveries nd
         JOIN dose_occurrences d ON d.id = nd.dose_occurrence_id
         JOIN medications m ON m.id = d.medication_id
         JOIN medication_schedules s ON s.id = d.schedule_id AND s.medication_id = m.id
          WHERE nd.id = $1 AND nd.lease_token = $2 AND nd.status = 'sending'
            AND nd.lease_until > $3::timestamptz
            AND d.patient_profile_id = nd.patient_profile_id
            AND m.status = 'active' AND s.active
            AND COALESCE((SELECT ep.enabled FROM escalation_policies ep
              WHERE ep.patient_profile_id = d.patient_profile_id
                AND (ep.medication_id = d.medication_id OR ep.medication_id IS NULL)
              ORDER BY ep.medication_id NULLS LAST LIMIT 1), true)
            AND d.status NOT IN ('taken','taken_late','skipped','cancelled')
            AND (d.snoozed_until IS NULL OR d.snoozed_until <= $3::timestamptz)
            AND (nd.payload->'intentVersions'->>d.id::text) IS NOT DISTINCT FROM
              CASE WHEN d.snoozed_until IS NOT NULL THEN d.client_event_id::text END
       ) AS still_pending`,
      [row.id, row.lease_token, ctx.now()],
    );
    if (pending[0]?.still_pending !== true) {
      return { ok: false, skipped: true, provider: ctx.providers.push.name };
    }
  }

  const results = await ctx.providers.push.send(messages);

  const dead = results.flatMap((result) => result.invalidTokens ?? []);
  if (dead.length) {
    await client.query('UPDATE push_tokens SET active = false WHERE token = ANY($1::text[])', [dead]);
    ctx.log.info({ count: dead.length }, 'deactivated push tokens the provider reported as unregistered');
  }

  const receiptTickets: ReceiptTicket[] = results.flatMap((result, index) => {
    const endpoint = tokens[index];
    return result.ok && result.providerMessageId && endpoint
      ? [{
          providerMessageId: result.providerMessageId,
          pushTokenId: endpoint.push_token_id,
          tokenFingerprint: fingerprintPushToken(endpoint.token),
        }]
      : [];
  });
  const anyOk = results.some((result) => result.ok);
  const first = results.find((result) => !result.ok);
  return anyOk
    ? {
        ok: true,
        provider: ctx.providers.push.name,
        providerMessageId: results.find((result) => result.ok)?.providerMessageId,
        receiptTickets,
      }
    : {
        ok: false,
        provider: ctx.providers.push.name,
        errorCode: first?.errorCode,
        errorDetail: first?.errorDetail,
        retryable: first?.retryable ?? false,
      };
}
