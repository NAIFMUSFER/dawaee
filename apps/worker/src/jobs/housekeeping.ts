import type { PoolClient } from 'pg';
import type { WorkerContext } from '../context.js';

/**
 * Retention and hygiene.
 *
 * Data that has served its purpose is deleted rather than kept "just in case" —
 * a medication app holds sensitive information, so the smallest defensible
 * footprint is the right one. Medical history is NOT touched here; only
 * transient operational rows are.
 */
export async function housekeepingJob(ctx: WorkerContext, client: PoolClient): Promise<{ itemsProcessed: number }> {
  let removed = 0;

  const { rows: otp } = await client.query<{ purge_expired_otp: number }>('SELECT app.purge_expired_otp(24)');
  removed += otp[0]?.purge_expired_otp ?? 0;

  // Invitations that were never accepted stop being usable at their expiry;
  // this just makes the stored status agree.
  const { rowCount: expired } = await client.query(
    `UPDATE caregiver_relationships
        SET status = 'expired', invitation_token_hash = NULL
      WHERE status = 'pending' AND invitation_expires_at IS NOT NULL AND invitation_expires_at <= now()`,
  );
  removed += expired ?? 0;

  /**
   * Sessions are purged through a function, not by touching the table.
   *
   * The worker has no privilege on `auth_sessions` at all: it holds refresh
   * token hashes, device names and IP hashes for every user, and DELETE would
   * have carried effective visibility of all of it. `app.cleanup_expired_sessions`
   * performs the one DELETE and returns a count.
   *
   * This statement is also why housekeeping had never completed. The worker was
   * granted no DELETE on anything, so the old `DELETE FROM auth_sessions` threw
   * "permission denied" on every run and aborted the job before any of the
   * retention below executed — which is why notification_deliveries still held
   * rows well past its 90-day limit.
   */
  const { rows: sessions } = await client.query<{ cleanup_expired_sessions: string }>(
    'SELECT app.cleanup_expired_sessions(30)',
  );
  removed += Number(sessions[0]?.cleanup_expired_sessions ?? 0);

  const { rowCount: deliveries } = await client.query(
    `DELETE FROM notification_deliveries
      WHERE created_at < now() - interval '90 days' AND status IN ('sent','delivered','read','skipped')`,
  );
  removed += deliveries ?? 0;

  const { rowCount: webhooks } = await client.query(
    `DELETE FROM provider_webhook_events WHERE received_at < now() - interval '30 days' AND processed_at IS NOT NULL`,
  );
  removed += webhooks ?? 0;

  const { rowCount: jobs } = await client.query(
    `DELETE FROM job_runs WHERE started_at < now() - interval '14 days'`,
  );
  removed += jobs ?? 0;

  // Objects whose upload was requested but never completed leave a dangling
  // row and, potentially, a partial object.
  const { rowCount: uploads } = await client.query(
    `DELETE FROM stored_objects WHERE uploaded_at IS NULL AND created_at < now() - interval '24 hours'`,
  );
  removed += uploads ?? 0;

  // Medications whose printed expiry has passed are flagged, not deleted, and
  // the app never tells anyone what to do with them.
  const { rowCount: expiredMeds } = await client.query(
    `UPDATE medications SET status = 'expired'
      WHERE status = 'active' AND expiry_date IS NOT NULL AND expiry_date < current_date`,
  );
  removed += expiredMeds ?? 0;

  // A completed course stops generating doses on its own.
  const { rowCount: completed } = await client.query(
    `UPDATE medications SET status = 'completed'
      WHERE status = 'active' AND end_date IS NOT NULL AND end_date < current_date`,
  );
  removed += completed ?? 0;

  if (removed > 0) ctx.log.info({ removed }, 'housekeeping completed');
  return { itemsProcessed: removed };
}
