import type { PoolClient } from 'pg';
import type { WorkerContext } from '../context.js';

/**
 * Persists the `missed` status once a dose is past its window.
 *
 * Status is derived on read everywhere, so this is not what makes a dose
 * missed — it makes the stored row agree with the derived truth, which keeps
 * history queries and the caregiver dashboard cheap.
 *
 * Note what it does NOT do: it never suggests a corrective action. A missed
 * dose ends here, with the app pointing the patient to their doctor or
 * pharmacist.
 */
export async function markMissedJob(ctx: WorkerContext, client: PoolClient): Promise<{ itemsProcessed: number }> {
  /**
   * The status change and its history are one statement.
   *
   * They used to be two: an UPDATE, then an INSERT that re-queried
   * `status='missed' AND updated_at > now() - interval '2 minutes'`. That is a
   * time window rather than a set of changed rows, so any later tick that
   * missed anything at all re-wrote events for everything missed in the
   * preceding two minutes. Two medications an hour apart were enough — the
   * tick that missed the second wrote a second 'missed' event for the first.
   *
   * The occurrence status was idempotent; its history was not, and the history
   * is what a clinician-facing adherence report counts. A duplicated miss
   * inflates non-adherence for a dose that was missed once.
   *
   * `UPDATE ... RETURNING` inside a CTE makes the rows that changed the exact
   * rows that get events, in one transactional step: there is no window in
   * which a status exists without its event, and no second execution can
   * observe the first one's rows as "recent" and claim them.
   *
   * `ON CONFLICT DO NOTHING` pairs with the partial unique index added in
   * migration 0025. Belt and braces on purpose — the CTE is the fix, the index
   * is what stops a future edit from quietly reintroducing the bug.
   */
  const { rows } = await client.query<{ marked: number }>(
    `WITH newly_missed AS (
       UPDATE dose_occurrences d
          SET status = 'missed',
              escalation_completed_at = COALESCE(d.escalation_completed_at, now())
         FROM medication_schedules s
        WHERE s.id = d.schedule_id
          AND d.status IN ('upcoming','due','pending_confirmation','snoozed')
          AND d.scheduled_at + make_interval(mins => s.missed_after_minutes) <= $1
        RETURNING d.id, d.patient_profile_id
     ), events AS (
       INSERT INTO dose_events (dose_occurrence_id, patient_profile_id, type, metadata)
       SELECT id, patient_profile_id, 'missed', '{"source":"worker"}'::jsonb
         FROM newly_missed
       ON CONFLICT DO NOTHING
       RETURNING 1
     )
     SELECT (SELECT count(*) FROM newly_missed)::int AS marked`,
    [ctx.now()],
  );

  return { itemsProcessed: rows[0]?.marked ?? 0 };
}
