import { sanitizeOperationalError } from '@dawaee/shared';
import type { PoolClient } from 'pg';
import type { PushMessage } from '@dawaee/api/providers';
import type { WorkerContext } from '../context.js';

/**
 * Sends what the reminder job enqueued.
 *
 * Separated from escalation on purpose: a WhatsApp outage must not stop the
 * escalation clock, and a retry must not re-run the escalation decision.
 *
 * ── CLAIM, SEND, FINALISE — three phases, and the provider call is in none of
 * the transactions ────────────────────────────────────────────────────────
 *
 * This used to run claim, send and finalise inside ONE transaction, holding the
 * claimed rows under FOR UPDATE for the whole batch. So a transaction lived as
 * long as Expo took to answer; a slow send stalled every delivery behind it;
 * pool pressure scaled with provider latency rather than with work; and — the
 * one that reached users — a rollback after a SUCCESSFUL send returned the row
 * to `queued`, and the next tick sent the same medication reminder again.
 *
 * Now: a short transaction claims rows and commits, the provider is called with
 * nothing open, and a second short transaction records each outcome. No lock is
 * held across the network.
 *
 * The claim writes a `lease_until` and a fresh `lease_token`. The expiry is what
 * lets a crashed worker's deliveries return to the pool — `status='sending'`
 * alone is indistinguishable from a send still in progress, so without it a
 * dead worker strands its batch forever. The token is what stops the recovered
 * case going wrong: once a lease can expire, a stalled worker A and a recovering
 * worker B can both believe they own a row, and A returning to write its result
 * would describe a send B is also performing. Finalisation matches on the token,
 * so A writes nothing.
 *
 * DELIVERY SEMANTICS, stated plainly: at-least-once, with an unavoidable
 * duplicate window after an ambiguous provider result. Expo's push API exposes
 * no idempotency key this code can send, so a request that times out may or may
 * not have been accepted, and the retry may produce a second notification. See
 * `AMBIGUOUS_RESULT_POLICY` below for what is done about it.
 */

/**
 * How long a worker owns a claimed delivery.
 *
 * Long enough that a normal provider call — including the 10s HTTP timeout and
 * a retry inside the SDK — finishes well within it, so a healthy send is never
 * stolen mid-flight. Short enough that a crashed worker's reminders are picked
 * up by another replica on the order of one tick rather than one hour, because
 * the thing being delayed is a medication reminder.
 */
const LEASE_SECONDS = 120;

/**
 * AMBIGUOUS_RESULT_POLICY.
 *
 * A provider call that times out has an unknown outcome: Expo may have accepted
 * the message or may not. There is no idempotency key to make the retry safe,
 * so the choice is between a possible duplicate reminder and a possible missed
 * one.
 *
 * For a medication app the answer is not symmetric. A duplicate reminder is an
 * annoyance; a missed one can mean a dose not taken, and the escalation ladder
 * then alerts the family about a dose the patient never knew was due. So an
 * ambiguous result is RETRIED, and the duplicate window is accepted and
 * documented rather than closed by dropping the message.
 *
 * Expo tickets and receipts narrow this but do not close it. Verified against
 * Expo's "Sending notifications" documentation, retrieved 2026-09-05 — see
 * docs/PUSH-DELIVERY-SEMANTICS.md for the full write-up:
 *
 *   * a send returns a TICKET whose `status` is `ok` or `error`. `ok` means the
 *     message reached Expo's servers, explicitly NOT that it reached the user.
 *     `provider_message_id` below stores that ticket id and nothing more, so it
 *     must never be read as proof of delivery;
 *   * a RECEIPT, fetched later from `POST /--/api/v2/push/getReceipts`, says
 *     whether Expo's delivery to FCM/APNs succeeded — one hop further, still
 *     not the device or the notification tray;
 *   * receipts are cleared after 24 hours and are meant to be read ~15 minutes
 *     after sending, so reading them is a separate scheduled job, not something
 *     this loop can await;
 *   * Expo documents NO idempotency key and no request deduplication. A retry
 *     is a second message. Nothing here claims otherwise.
 *
 * So receipts would let a permanently-failed token be retired faster and give a
 * truer "delivered" signal than a ticket does. They cannot resolve the ambiguous
 * window above, because a send whose HTTP call timed out has no ticket id to
 * fetch a receipt for. NOT IMPLEMENTED — no receipt polling exists in this
 * codebase today.
 */
const AMBIGUOUS_IS_RETRYABLE = true;

/**
 * The provider outcomes whose result is genuinely UNKNOWN, as opposed to known
 * to have failed.
 *
 * `network_error` is the abort/timeout path: the request left this process and
 * no answer came back, so Expo may or may not have accepted it. A 5xx is the
 * same class — the request reached Expo and the response says nothing about
 * whether it was processed.
 *
 * Everything else is a definite answer: `DeviceNotRegistered` is a dead token,
 * `MessageTooBig` is a bad payload, and neither becomes true on a retry.
 *
 * Kept here rather than in the provider because it is a POLICY about medication
 * reminders, not a fact about Expo's wire protocol — the provider reports what
 * happened, this decides what to do about it.
 */
export function isAmbiguous(errorCode: string | undefined): boolean {
  return errorCode === 'network_error' || /^http_5\d\d$/.test(errorCode ?? '');
}

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
  lease_token: string;
}

/**
 * Phase 1 — claim, in its own transaction.
 *
 * One atomic UPDATE ... RETURNING rather than SELECT-then-UPDATE, so there is
 * no window between choosing a row and owning it. The `FOR UPDATE SKIP LOCKED`
 * subquery is what makes two replicas take disjoint sets instead of blocking on
 * each other.
 *
 * Claimable means: queued and due, OR already `sending` with an expired lease —
 * the second case is how a crashed worker's batch comes back.
 */
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
      RETURNING d.id, d.recipient_user_id, d.recipient_phone_e164, d.kind::text AS kind,
                d.channel::text AS channel, d.locale, d.title, d.body, d.payload,
                d.attempts, d.max_attempts, d.lease_token`,
    [ctx.now(), LEASE_SECONDS, limit],
  );
  return rows;
}

export async function dispatchJob(ctx: WorkerContext, client: PoolClient): Promise<{ itemsProcessed: number }> {
  // Phase 1: claim and COMMIT before any network call. `runJob` owns the
  // surrounding transaction, so the claim is committed by taking a separate
  // connection for it — the job's own transaction must not stay open across
  // the sends below.
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
    // Phase 2: the provider call, with NO transaction open and no lock held.
    const result = await sendOne(ctx, client, row);

    // Phase 3: record the outcome, guarded by the lease token. A worker whose
    // lease was reassigned while it was sending writes nothing.
    if (result.ok) {
      const applied = await finalise(ctx, row,
        `UPDATE notification_deliveries
            SET status = 'sent', sent_at = now(), provider = $3, provider_message_id = $4,
                error_code = NULL, lease_until = NULL
          WHERE id = $1 AND lease_token = $2`,
        [result.provider, result.providerMessageId ?? null]);
      if (applied) sent += 1;
    } else if (
      // An unknown outcome is retried per AMBIGUOUS_RESULT_POLICY; a known
      // failure is retried only if the provider says it is worth retrying.
      (isAmbiguous(result.errorCode) ? AMBIGUOUS_IS_RETRYABLE : (result.retryable ?? false))
      && row.attempts < row.max_attempts
    ) {
      // Exponential backoff, so a flapping provider is not hammered. `attempts`
      // was already incremented by the claim.
      const delaySeconds = Math.min(300, 30 * 2 ** Math.max(0, row.attempts - 1));
      await finalise(ctx, row,
        `UPDATE notification_deliveries
            SET status = 'queued', next_attempt_at = now() + make_interval(secs => $3),
                error_code = $4, error_detail = $5, provider = $6, lease_until = NULL
          WHERE id = $1 AND lease_token = $2`,
        [delaySeconds, result.errorCode ?? null, result.errorDetail ? sanitizeOperationalError(result.errorDetail) : null, result.provider]);
    } else {
      await finalise(ctx, row,
        `UPDATE notification_deliveries
            SET status = 'failed', error_code = $3, error_detail = $4, provider = $5,
                lease_until = NULL
          WHERE id = $1 AND lease_token = $2`,
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
 * Apply a terminal state, but only if this worker still holds the lease.
 *
 * Its own short transaction on its own connection: the job's transaction is not
 * held open across the sends, so each outcome is durable the moment it is
 * written rather than at the end of the batch. That is what removes the crash
 * window — a process that dies after this returns has already recorded the
 * result, and one that dies before it leaves a lease that expires.
 *
 * Returns false when the token no longer matches, which means another worker
 * recovered this delivery and owns its outcome.
 */
async function finalise(
  ctx: WorkerContext, row: DeliveryRow, sql: string, params: unknown[],
): Promise<boolean> {
  const c = await ctx.pool.connect();
  try {
    const { rowCount } = await c.query(sql, [row.id, row.lease_token, ...params]);
    if (rowCount === 0) {
      ctx.log.warn({ deliveryId: row.id }, 'lease was reassigned before this worker finished; result discarded');
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

