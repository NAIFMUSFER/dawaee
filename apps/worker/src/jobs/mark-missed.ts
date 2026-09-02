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
  const { rowCount } = await client.query(
    `UPDATE dose_occurrences d
        SET status = 'missed',
            escalation_completed_at = COALESCE(d.escalation_completed_at, now())
       FROM medication_schedules s
      WHERE s.id = d.schedule_id
        AND d.status IN ('upcoming','due','pending_confirmation','snoozed')
        AND d.scheduled_at + make_interval(mins => s.missed_after_minutes) <= $1`,
    [ctx.now()],
  );
  if (rowCount) {
    await client.query(
      `INSERT INTO dose_events (dose_occurrence_id, patient_profile_id, type, metadata)
       SELECT id, patient_profile_id, 'missed', '{"source":"worker"}'::jsonb
         FROM dose_occurrences
        WHERE status = 'missed' AND updated_at > now() - interval '2 minutes'`,
    );
  }
  return { itemsProcessed: rowCount ?? 0 };
}
