import type { PoolClient } from 'pg';
import type { PushMessage } from '@dawaee/api/providers';
import type { WorkerContext } from '../context.js';

/**
 * Sends what the reminder job enqueued.
 *
 * Separated from escalation on purpose: a WhatsApp outage must not stop the
 * escalation clock, and a retry must not re-run the escalation decision. Rows
 * are claimed with FOR UPDATE SKIP LOCKED so several workers can drain the
 * queue at once without ever sending the same message twice.
 */

interface DeliveryRow {
  id: string;
  recipient_user_id: string | null;
  recipient_phone_e164: string | null;
  kind: string;
  channel: string;
  locale: string;
  title: string | null;
  body: string | null;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
}

export async function dispatchJob(ctx: WorkerContext, client: PoolClient): Promise<{ itemsProcessed: number }> {
  const now = ctx.now();

  const { rows } = await client.query<DeliveryRow>(
    `SELECT id, recipient_user_id, recipient_phone_e164, kind::text AS kind, channel::text AS channel,
            locale, title, body, payload, attempts, max_attempts
       FROM notification_deliveries
      WHERE status IN ('queued')
        AND next_attempt_at <= $1
      ORDER BY next_attempt_at
      LIMIT 200
      FOR UPDATE SKIP LOCKED`,
    [now],
  );
  if (rows.length === 0) return { itemsProcessed: 0 };

  await client.query(
    `UPDATE notification_deliveries SET status = 'sending', attempts = attempts + 1
      WHERE id = ANY($1::uuid[])`,
    [rows.map((r) => r.id)],
  );

  let sent = 0;
  for (const row of rows) {
    const result = await sendOne(ctx, client, row);
    if (result.ok) {
      sent += 1;
      await client.query(
        `UPDATE notification_deliveries
            SET status = 'sent', sent_at = now(), provider = $2, provider_message_id = $3, error_code = NULL
          WHERE id = $1`,
        [row.id, result.provider, result.providerMessageId ?? null],
      );
    } else if (result.retryable && row.attempts + 1 < row.max_attempts) {
      // Exponential backoff, so a flapping provider is not hammered.
      const delaySeconds = Math.min(300, 30 * 2 ** row.attempts);
      await client.query(
        `UPDATE notification_deliveries
            SET status = 'queued', next_attempt_at = now() + make_interval(secs => $2),
                error_code = $3, error_detail = $4, provider = $5
          WHERE id = $1`,
        [row.id, delaySeconds, result.errorCode ?? null, result.errorDetail ?? null, result.provider],
      );
    } else {
      await client.query(
        `UPDATE notification_deliveries
            SET status = 'failed', error_code = $2, error_detail = $3, provider = $4
          WHERE id = $1`,
        [row.id, result.errorCode ?? null, result.errorDetail ?? null, result.provider],
      );
      ctx.log.warn(
        { deliveryId: row.id, channel: row.channel, errorCode: result.errorCode },
        'notification delivery failed permanently',
      );
    }
  }

  return { itemsProcessed: sent };
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
      // Local notifications are scheduled by the device from its cached
      // prefetch window; the server records the intent but sends nothing.
      return { ok: true, provider: 'device_local' };
    default:
      // Includes 'whatsapp' and 'sms', which the database enum still carries.
      // A row queued for a channel this deployment cannot send on fails once,
      // permanently, and says why — it is never retried and never silently
      // reported as delivered.
      return { ok: false, provider: 'none', errorCode: 'unsupported_channel', retryable: false };
  }
}

async function sendPush(ctx: WorkerContext, client: PoolClient, row: DeliveryRow): Promise<SendOutcome> {
  if (!row.recipient_user_id) return { ok: false, provider: ctx.providers.push.name, errorCode: 'no_recipient', retryable: false };

  const { rows: tokens } = await client.query<{ token: string }>(
    'SELECT token FROM push_tokens WHERE user_id = $1 AND active ORDER BY last_seen_at DESC LIMIT 5',
    [row.recipient_user_id],
  );
  if (tokens.length === 0) {
    // No registered device is a real, actionable state: the app surfaces
    // "alerts are disabled on this device" rather than failing silently.
    return { ok: false, provider: ctx.providers.push.name, errorCode: 'no_active_device', retryable: false };
  }

  const messages: PushMessage[] = tokens.map((t) => ({
    token: t.token,
    title: row.title ?? '',
    body: row.body ?? '',
    data: {
      deliveryId: row.id,
      kind: row.kind,
      doseId: String(row.payload.doseId ?? ''),
      actions: JSON.stringify(row.payload.actions ?? []),
    },
    // Medication reminders get the strongest priority each OS actually allows
    // for a non-exempt app: a high-importance Android channel and iOS
    // time-sensitive interruption level.
    priority: row.kind === 'dose_reminder' || row.kind === 'dose_reminder_repeat' || row.kind === 'escalation'
      ? 'high' : 'default',
    categoryId: row.kind.startsWith('dose_reminder') ? 'MEDICATION_REMINDER' : undefined,
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
        ok: false, provider: ctx.providers.push.name,
        errorCode: first?.errorCode, errorDetail: first?.errorDetail, retryable: first?.retryable ?? false,
      };
}

