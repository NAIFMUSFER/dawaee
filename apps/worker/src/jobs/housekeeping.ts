import type { PoolClient } from 'pg';
import type { WorkerContext } from '../context.js';
import { runStep, type StepOutcome } from './housekeeping-step.js';

/**
 * Retention and hygiene.
 *
 * Data that has served its purpose is deleted rather than kept "just in case" —
 * a medication app holds sensitive information, so the smallest defensible
 * footprint is the right one. Medical history is NOT touched here except when
 * the account owner has explicitly requested full account erasure and the
 * fourteen-day grace period has elapsed.
 */
export async function housekeepingJob(
  ctx: WorkerContext, client: PoolClient,
): Promise<{ itemsProcessed: number; failures: Array<{ step: string; error: string }> }> {
  const outcome: StepOutcome = { removed: 0, failures: [] };

  await runStep(ctx, client, outcome, 'otp', async () => {
    const { rows } = await client.query<{ purge_expired_otp: number }>('SELECT app.purge_expired_otp(24)');
    return rows[0]?.purge_expired_otp ?? 0;
  });

  // Invitations that were never accepted stop being usable at their expiry;
  // this just makes the stored status agree.
  await runStep(ctx, client, outcome, 'expired', async () => (await client.query(
    `UPDATE caregiver_relationships
        SET status = 'expired', invitation_token_hash = NULL
      WHERE status = 'pending' AND invitation_expires_at IS NOT NULL AND invitation_expires_at <= now()`,
  )).rowCount ?? 0);

  /**
   * Sessions are purged through a function, not by touching the table.
   *
   * The worker has no privilege on `auth_sessions` at all: it holds refresh
   * token hashes, device names and IP hashes for every user, and DELETE would
   * have carried effective visibility of all of it. `app.cleanup_expired_sessions`
   * performs the one DELETE and returns a count.
   */
  await runStep(ctx, client, outcome, 'sessions', async () => {
    const { rows } = await client.query<{ cleanup_expired_sessions: string }>(
      'SELECT app.cleanup_expired_sessions(30)',
    );
    return Number(rows[0]?.cleanup_expired_sessions ?? 0);
  });

  await runStep(ctx, client, outcome, 'deliveries', async () => (await client.query(
    `DELETE FROM notification_deliveries
      WHERE created_at < now() - interval '90 days' AND status IN ('sent','delivered','read','skipped')`,
  )).rowCount ?? 0);

  // Rate-limit windows are minutes long; a day is already generous.
  await runStep(ctx, client, outcome, 'rateBuckets', async () => {
    const { rows } = await client.query<{ purge_rate_buckets: number }>('SELECT app.purge_rate_buckets(24)');
    return rows[0]?.purge_rate_buckets ?? 0;
  });

  await runStep(ctx, client, outcome, 'webhooks', async () => (await client.query(
    `DELETE FROM provider_webhook_events WHERE received_at < now() - interval '30 days' AND processed_at IS NOT NULL`,
  )).rowCount ?? 0);

  await runStep(ctx, client, outcome, 'jobs', async () => (await client.query(
    `DELETE FROM job_runs WHERE started_at < now() - interval '14 days'`,
  )).rowCount ?? 0);

  /**
   * Upload tickets do not currently have a server callback that flips
   * `uploaded_at`: direct S3/R2 PUTs bypass the API. Only OLD, UNREFERENCED
   * tickets are therefore safe to classify as abandoned.
   *
   * P20 CI reproduced the least-privilege production boundary here: doing the
   * reference test directly required SELECT on `prescriptions`, which the
   * worker intentionally does not have, and `permission denied` aborted the
   * entire housekeeping function before account erasure could run. Do not widen
   * the worker to prescription PHI. Migration 0039 exposes only a bounded list
   * of safe object keys through a pinned SECURITY DEFINER function.
   *
   * Delete the physical bytes first, then ask the narrow metadata-removal
   * function to re-check the references at deletion time. Each object gets its
   * own savepoint, so one provider outage does not retain all other objects.
   */
  const { rows: abandonedObjects } = await client.query<{ object_key: string }>(
    'SELECT object_key FROM app.list_abandoned_object_keys(24, 100)',
  );
  for (const object of abandonedObjects) {
    await runStep(ctx, client, outcome, 'uploads', async () => {
      await ctx.providers.storage.deleteObject(object.object_key);
      const { rows } = await client.query<{ removed: boolean }>(
        'SELECT app.remove_abandoned_object_metadata($1) AS removed',
        [object.object_key],
      );
      return rows[0]?.removed ? 1 : 0;
    });
  }

  /**
   * Final account erasure.
   *
   * The HTTP route returns a concrete `scheduledFor` fourteen days after the
   * durable request marker. The worker now consumes that marker, but it does so
   * without broadening its database reach: migration 0039 returns only ids that
   * are already due and only object keys that belong to the departing user's
   * own data. A caregiver-uploaded image attached to somebody else's profile is
   * that patient's medical record and is deliberately not returned.
   *
   * The database delete independently re-checks the grace period under a row
   * lock. Physical deletion happens first. If object storage is unavailable,
   * the account remains scheduled and the failed step is retried rather than
   * falsely claiming erasure while bytes remain outside PostgreSQL.
   */
  const { rows: dueAccounts } = await client.query<{ user_id: string }>(
    'SELECT user_id FROM app.list_due_account_ids(14, 100)',
  );
  for (const account of dueAccounts) {
    await runStep(ctx, client, outcome, 'accountDeletion', async () => {
      const { rows: objects } = await client.query<{ object_key: string }>(
        'SELECT object_key FROM app.list_due_account_object_keys($1, 14)',
        [account.user_id],
      );
      for (const object of objects) {
        await ctx.providers.storage.deleteObject(object.object_key);
      }

      const { rows } = await client.query<{ erased: boolean }>(
        'SELECT app.erase_due_account($1, 14) AS erased',
        [account.user_id],
      );
      return rows[0]?.erased ? 1 : 0;
    });
  }

  /**
   * ── Both statements below compare against the PATIENT'S local date, not
   * `current_date` ────────────────────────────────────────────────────────
   *
   * `expiry_date` and `end_date` are `date` columns holding a patient-local
   * calendar date — "this course ends on the 10th" means the 10th where the
   * patient lives. `current_date` is the calendar date in the DATABASE session's
   * zone, which is `Etc/UTC` in every environment. Comparing the two compares a
   * local date against a UTC date, and the error is one whole day for part of
   * every day.
   *
   * The fix takes the instant from the worker (`ctx.now()`) rather than the
   * database, so the job is deterministic and testable, and converts it to each
   * patient's own calendar date. `$1::timestamptz AT TIME ZONE p.timezone`
   * yields that patient's wall-clock time; casting it to `date` yields their
   * calendar date. DST is handled by the zone rules rather than by arithmetic.
   */
  const nowInstant = ctx.now();

  // Medications whose printed expiry has passed are flagged, not deleted, and
  // the app never tells anyone what to do with them.
  await runStep(ctx, client, outcome, 'expiredMeds', async () => (await client.query(
    `UPDATE medications m SET status = 'expired'
       FROM patient_profiles p
      WHERE p.id = m.patient_profile_id
        AND m.status = 'active' AND m.expiry_date IS NOT NULL
        AND m.expiry_date < ($1::timestamptz AT TIME ZONE p.timezone)::date`,
    [nowInstant],
  )).rowCount ?? 0);

  // A completed course stops generating doses on its own.
  await runStep(ctx, client, outcome, 'completed', async () => (await client.query(
    `UPDATE medications m SET status = 'completed'
       FROM patient_profiles p
      WHERE p.id = m.patient_profile_id
        AND m.status = 'active' AND m.end_date IS NOT NULL
        AND m.end_date < ($1::timestamptz AT TIME ZONE p.timezone)::date`,
    [nowInstant],
  )).rowCount ?? 0);

  if (outcome.removed > 0 || outcome.failures.length > 0) {
    ctx.log.info(
      { removed: outcome.removed, failed: outcome.failures.length },
      'housekeeping completed',
    );
  }
  return { itemsProcessed: outcome.removed, failures: outcome.failures };
}
