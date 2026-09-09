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
   * The old cleanup deleted only the database row. If the direct upload had in
   * fact succeeded, the private object remained in S3/R2 forever with no
   * metadata left to find it again. There was also no worker DELETE policy on
   * this FORCE-RLS table, so that direct DELETE could silently match zero rows.
   *
   * Delete the physical bytes first, then ask a narrow SECURITY DEFINER
   * function to remove metadata only if the same reference checks still hold.
   * Each object gets its own savepoint: one provider outage does not retain all
   * the other objects or stop unrelated housekeeping classes.
   */
  const { rows: abandonedObjects } = await client.query<{ object_key: string }>(
    `SELECT so.object_key
       FROM stored_objects so
      WHERE so.uploaded_at IS NULL
        AND so.created_at < now() - interval '24 hours'
        AND NOT EXISTS (SELECT 1 FROM medications m WHERE m.image_key = so.object_key)
        AND NOT EXISTS (SELECT 1 FROM prescriptions p WHERE p.image_key = so.object_key)
        AND NOT EXISTS (SELECT 1 FROM patient_profiles pp WHERE pp.avatar_key = so.object_key)`,
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
   * The HTTP route has always returned a concrete `scheduledFor` value fourteen
   * days after `deletion_requested_at`, but before P20 no job consumed that
   * marker at all. A deletion request could sit in `users` forever.
   *
   * For a due user, remove only object bytes that would disappear with THEIR
   * data: unattached uploads and uploads attached to profiles they own. An
   * image a caregiver uploaded into somebody else's profile is that patient's
   * medical record and must survive; migration 0038 makes uploader attribution
   * nullable so erasure can remove the person without deleting another
   * patient's data.
   *
   * The database delete itself is worker-only SECURITY DEFINER and independently
   * re-checks the grace period under a row lock. Physical deletion happens
   * first. If object storage is unavailable, the account remains scheduled and
   * the failed step is retried rather than falsely claiming erasure while bytes
   * remain outside PostgreSQL.
   */
  const { rows: dueAccounts } = await client.query<{ id: string }>(
    `SELECT id
       FROM users
      WHERE deletion_requested_at IS NOT NULL
        AND deletion_requested_at <= now() - interval '14 days'
      ORDER BY deletion_requested_at
      LIMIT 100`,
  );
  for (const account of dueAccounts) {
    await runStep(ctx, client, outcome, 'accountDeletion', async () => {
      const { rows: objects } = await client.query<{ object_key: string }>(
        `SELECT so.object_key
           FROM stored_objects so
           LEFT JOIN patient_profiles pp ON pp.id = so.patient_profile_id
          WHERE so.owner_user_id = $1
            AND (so.patient_profile_id IS NULL OR pp.owner_user_id = $1)`,
        [account.id],
      );
      for (const object of objects) {
        await ctx.providers.storage.deleteObject(object.object_key);
      }

      const { rows } = await client.query<{ erased: boolean }>(
        'SELECT app.erase_due_account($1, 14) AS erased',
        [account.id],
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
