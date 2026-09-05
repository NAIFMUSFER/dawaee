import type { PoolClient } from 'pg';
import type { WorkerContext } from '../context.js';
import { runStep, type StepOutcome } from './housekeeping-step.js';

/**
 * Retention and hygiene.
 *
 * Data that has served its purpose is deleted rather than kept "just in case" —
 * a medication app holds sensitive information, so the smallest defensible
 * footprint is the right one. Medical history is NOT touched here; only
 * transient operational rows are.
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
   *
   * This statement is also why housekeeping had never completed. The worker was
   * granted no DELETE on anything, so the old `DELETE FROM auth_sessions` threw
   * "permission denied" on every run and aborted the job before any of the
   * retention below executed — which is why notification_deliveries still held
   * rows well past its 90-day limit.
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

  await runStep(ctx, client, outcome, 'webhooks', async () => (await client.query(
    `DELETE FROM provider_webhook_events WHERE received_at < now() - interval '30 days' AND processed_at IS NOT NULL`,
  )).rowCount ?? 0);

  await runStep(ctx, client, outcome, 'jobs', async () => (await client.query(
    `DELETE FROM job_runs WHERE started_at < now() - interval '14 days'`,
  )).rowCount ?? 0);

  // Objects whose upload was requested but never completed leave a dangling
  // row and, potentially, a partial object.
  await runStep(ctx, client, outcome, 'uploads', async () => (await client.query(
    `DELETE FROM stored_objects WHERE uploaded_at IS NULL AND created_at < now() - interval '24 hours'`,
  )).rowCount ?? 0);

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
   * The direction of the error depends on the sign of the offset, and only one
   * direction is harmless:
   *
   *   patient AHEAD of UTC (Asia/Riyadh, +3): the UTC date lags the local date,
   *   so a course is marked completed up to three hours LATE. Nothing is
   *   generated in that window — `expandSchedule` already stops at the local end
   *   of `end_date` — so this is invisible.
   *
   *   patient BEHIND UTC (America/Los_Angeles, -7): the UTC date runs AHEAD, so
   *   from 17:00 local on the final day `end_date < current_date` is already
   *   true. The medication is marked `completed` while the patient still has
   *   doses to take that evening — and `reminders` requires `m.status='active'`,
   *   so those reminders are silently never sent. The same applies to
   *   `expired`. A patient in California would stop being reminded on the last
   *   evening of every course.
   *
   * Saudi Arabia is UTC+3 with no DST, so today's users sit on the harmless
   * side of this. That is a property of who happens to be using the app, not of
   * the code, and `medication_schedules.timezone` and
   * `patient_profiles.timezone` are per-row for exactly that reason.
   *
   * The fix takes the instant from the worker (`ctx.now()`) rather than the
   * database, so the job is deterministic and testable, and converts it to each
   * patient's own calendar date. `$1::timestamptz AT TIME ZONE p.timezone`
   * yields that patient's wall-clock time; casting it to `date` yields their
   * calendar date. DST is handled by the zone rules rather than by arithmetic.
   *
   * Deliberately NOT fixed by setting the database session timezone: there is
   * no single session timezone that is correct for two patients in different
   * zones, so that would only move the bug.
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
    // Both numbers, always, when either is non-zero: "removed 400" alone reads
    // like success even when three retention classes silently did nothing.
    ctx.log.info(
      { removed: outcome.removed, failed: outcome.failures.length },
      'housekeeping completed',
    );
  }
  return { itemsProcessed: outcome.removed, failures: outcome.failures };
}
