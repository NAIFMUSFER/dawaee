import { sanitizeOperationalError, t, type Locale } from '@dawaee/shared';
import type { PoolClient } from 'pg';
import type { PushMessage } from '@dawaee/api/providers';
import type { WorkerContext } from '../context.js';

const LEASE_SECONDS = 120;
const AMBIGUOUS_IS_RETRYABLE = true;

export function isAmbiguous(errorCode: string | undefined): boolean {
  return errorCode === 'network_error' || /^http_5\d\d$/.test(errorCode ?? '');
}

interface DeliveryRow {
  id: string;
  patient_profile_id: string | null;
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
      RETURNING d.id, d.patient_profile_id, d.recipient_user_id, d.recipient_phone_e164,
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
    // invoking an external provider. This also retires legacy queued rows that
    // pre-date the database trigger/backfill in migration 0049.
    if (!await caregiverDeliveryStillAuthorized(client, row)) {
      await finalise(ctx, row,
        `UPDATE notification_deliveries
            SET status = 'skipped', lease_until = NULL, lease_token = NULL
          WHERE id = $1 AND status = 'sending' AND lease_token = $2`,
        []);
      continue;
    }

    const result = await sendOne(ctx, client, row);

    if (result.ok) {
      const applied = await finalise(ctx, row,
        `UPDATE notification_deliveries
            SET status = 'sent', sent_at = $3::timestamptz, provider = $4, provider_message_id = $5,
                error_code = NULL, lease_until = NULL
          WHERE id = $1 AND lease_token = $2 AND status = 'sending'`,
        [ctx.now(), result.provider, result.providerMessageId ?? null]);
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

/**
 * Relationship-backed deliveries are capabilities, not immutable messages.
 * The patient can narrow a caregiver at any time. Every caregiver delivery
 * therefore still needs an active relationship plus receive_notifications at
 * dispatch time. Daily/weekly summaries additionally expose adherence and
 * schedule-derived data, matching the same two data permissions required by
 * /v1/adherence and by the digest producer itself.
 */
async function caregiverDeliveryStillAuthorized(client: PoolClient, row: DeliveryRow): Promise<boolean> {
  if (!row.relationship_id) return true;
  if (!row.patient_profile_id || !row.recipient_user_id) return false;

  const { rows } = await client.query<{ permissions: string[] }>(
    `SELECT permissions
       FROM caregiver_relationships
      WHERE id = $1
        AND patient_profile_id = $2
        AND caregiver_user_id = $3
        AND status = 'active'`,
    [row.relationship_id, row.patient_profile_id, row.recipient_user_id],
  );
  const permissions = rows[0]?.permissions;
  if (!permissions?.includes('receive_notifications')) return false;

  if (row.kind === 'daily_summary' || row.kind === 'weekly_summary') {
    return permissions.includes('view_adherence') && permissions.includes('view_schedule');
  }
  return true;
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
  provider: string;
  providerMessageId?: string;
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
): Promise<{ body: string | null; payload: Record<string, unknown> }> {
  if (!row.patient_profile_id) return { body: row.body, payload: row.payload };

  const { rows } = await client.query<{ show_medication: boolean }>(
    `SELECT COALESCE(up.show_medication_in_notifications, false) AS show_medication
       FROM patient_profiles pp
       LEFT JOIN user_preferences up ON up.user_id = COALESCE(pp.linked_user_id, pp.owner_user_id)
      WHERE pp.id = $1`,
    [row.patient_profile_id],
  );
  let mayRevealMedication = rows[0]?.show_medication === true;

  // The patient's lock-screen preference controls whether medication identity
  // may appear at all. For caregiver deliveries there is a second independent
  // authorization boundary: current relationship state and view_medications.
  // Re-check it here because a delivery can be queued before a permission is
  // narrowed or the relationship is revoked.
  if (mayRevealMedication && row.relationship_id) {
    const { rows: permissionRows } = await client.query<{ can_view_medication: boolean }>(
      `SELECT status = 'active'
              AND caregiver_user_id = $2
              AND 'view_medications' = ANY(permissions) AS can_view_medication
         FROM caregiver_relationships
        WHERE id = $1 AND patient_profile_id = $3`,
      [row.relationship_id, row.recipient_user_id, row.patient_profile_id],
    );
    mayRevealMedication = permissionRows[0]?.can_view_medication === true;
  }

  if (mayRevealMedication) return { body: row.body, payload: row.payload };

  // A delivery can wait in the outbox for minutes after it was composed. The
  // privacy preference and caregiver authorization are therefore checked again
  // at the last possible moment. Copy rather than mutate the claimed row so a
  // failed provider call retains the durable record and a later retry
  // re-evaluates both boundaries.
  const payload = { ...row.payload };
  delete payload.medicationName;
  delete payload.medications;

  return { body: privateBody(row, payload), payload };
}

async function sendPush(ctx: WorkerContext, client: PoolClient, row: DeliveryRow): Promise<SendOutcome> {
  if (!row.recipient_user_id) {
    return { ok: false, provider: ctx.providers.push.name, errorCode: 'no_recipient', retryable: false };
  }

  const { rows: tokens } = await client.query<{ token: string }>(
    'SELECT token FROM push_tokens WHERE user_id = $1 AND active ORDER BY last_seen_at DESC LIMIT 5',
    [row.recipient_user_id],
  );
  if (tokens.length === 0) {
    return { ok: false, provider: ctx.providers.push.name, errorCode: 'no_active_device', retryable: false };
  }

  const safe = await applyCurrentNotificationPrivacy(client, row);
  const grouped = safe.payload.grouped === true;
  const messages: PushMessage[] = tokens.map((t) => ({
    token: t.token,
    title: row.title ?? '',
    body: safe.body ?? '',
    data: {
      deliveryId: row.id,
      kind: grouped ? 'dose_group_reminder' : row.kind,
      doseId: grouped ? '' : String(safe.payload.doseId ?? ''),
      doseIds: grouped ? JSON.stringify(safe.payload.doseIds ?? []) : '[]',
      actions: JSON.stringify(safe.payload.actions ?? []),
    },
    priority: row.kind === 'dose_reminder' || row.kind === 'dose_reminder_repeat' || row.kind === 'escalation'
      ? 'high' : 'default',
    // A grouped reminder must not expose a single-dose Taken/Snooze/Skip action.
    // The patient opens the app and confirms each medicine independently.
    categoryId: row.kind.startsWith('dose_reminder') && !grouped ? 'MEDICATION_REMINDER' : undefined,
    sound: 'default',
  }));

  const results = await ctx.providers.push.send(messages);

  const dead = results.flatMap((r) => r.invalidTokens ?? []);
  if (dead.length) {
    await client.query('UPDATE push_tokens SET active = false WHERE token = ANY($1::text[])', [dead]);
    ctx.log.info({ count: dead.length }, 'deactivated push tokens the provider reported as unregistered');
  }

  const anyOk = results.some((r) => r.ok);
  const first = results.find((r) => !r.ok);
  return anyOk
    ? { ok: true, provider: ctx.providers.push.name, providerMessageId: results.find((r) => r.ok)?.providerMessageId }
    : {
        ok: false,
        provider: ctx.providers.push.name,
        errorCode: first?.errorCode,
        errorDetail: first?.errorDetail,
        retryable: first?.retryable ?? false,
      };
}
