import type { PoolClient } from 'pg';
import { AppError, type CaregiverPermission } from '@dawaee/shared';
import { assertCan, resolveRole, type AccessContext } from '@dawaee/core';

/**
 * Resolves what the caller may do with a given patient profile.
 *
 * This is the application-layer half of the defence in depth. Postgres RLS
 * (migration 0008) enforces the same boundary independently, so a mistake here
 * degrades to "the database refuses and the user sees a 404" rather than to a
 * data leak.
 */

export interface ProfileAccess extends AccessContext {
  role: 'owner' | 'caregiver' | 'none';
  profileTimezone: string;
  profileHomeTimezone: string;
  profileDisplayName: string;
}

export async function loadProfileAccess(
  tx: PoolClient,
  userId: string,
  profileId: string,
): Promise<ProfileAccess> {
  const { rows } = await tx.query<{
    id: string; owner_user_id: string; linked_user_id: string | null; archived_at: Date | null;
    timezone: string; home_timezone: string; display_name: string;
    rel_status: string | null; rel_permissions: string[] | null; rel_expires: Date | null;
  }>(
    `SELECT pp.id, pp.owner_user_id, pp.linked_user_id, pp.archived_at,
            pp.timezone, pp.home_timezone, pp.display_name,
            cr.status::text AS rel_status, cr.permissions AS rel_permissions,
            cr.invitation_expires_at AS rel_expires
       FROM patient_profiles pp
       LEFT JOIN caregiver_relationships cr
              ON cr.patient_profile_id = pp.id
             AND cr.caregiver_user_id = $2
             AND cr.status = 'active'
      WHERE pp.id = $1`,
    [profileId, userId],
  );

  const row = rows[0];
  // RLS already hides other patients' profiles; this turns "invisible" into a
  // clean 404 rather than a confusing empty response.
  if (!row) throw AppError.notFound('Patient profile not found');

  const ctx: AccessContext = {
    userId,
    profile: {
      id: row.id,
      ownerUserId: row.owner_user_id,
      linkedUserId: row.linked_user_id,
      archivedAt: row.archived_at ? row.archived_at.toISOString() : null,
    },
    relationship: row.rel_status
      ? {
          status: row.rel_status as 'active',
          permissions: (row.rel_permissions ?? []) as CaregiverPermission[],
          invitationExpiresAt: row.rel_expires ? row.rel_expires.toISOString() : null,
        }
      : null,
  };

  return {
    ...ctx,
    role: resolveRole(ctx),
    profileTimezone: row.timezone,
    profileHomeTimezone: row.home_timezone,
    profileDisplayName: row.display_name,
  };
}

/**
 * Requires every permission a route's query actually needs.
 *
 * Accepts a list because a permission check that names one thing while the
 * query reads two is not a check, it is a silence. Measured at the baseline
 * commit: a caregiver granted `view_schedule` and `view_history` — the narrow
 * "see when the pills are due" grant a patient would choose for a neighbour —
 * got 200 with an empty array from `/v1/today` and `/v1/doses`, and 404 from
 * `/v1/doses/:id`. Not a permission error anywhere; just nothing, with no
 * indication why.
 *
 * The cause is that a dose is not readable on its own. Every dose query inner
 * joins `medications` to render the row, and that table's RLS policy requires
 * `view_medications`. So the application layer said `view_schedule` was
 * enough while the database required two permissions, and the disagreement
 * surfaced as an empty screen rather than as a refusal.
 *
 * Resolved in favour of the database's answer, per the product decision that
 * seeing the schedule entails seeing which medication it is for: the routes
 * now ask for what they read. A caregiver missing `view_medications` gets
 * `Missing permission: view_medications`, which is the true reason and is
 * actionable — the patient can grant it.
 *
 * The permissions are checked in the order given, so the message names the
 * route's primary permission first when both are absent.
 */
export async function requireProfileAccess(
  tx: PoolClient,
  userId: string,
  profileId: string,
  permission: CaregiverPermission | readonly CaregiverPermission[],
): Promise<ProfileAccess> {
  const access = await loadProfileAccess(tx, userId, profileId);
  for (const p of Array.isArray(permission) ? permission : [permission as CaregiverPermission]) {
    assertCan(access, p);
  }
  return access;
}

/**
 * The permission set required to read a dose row.
 *
 * `view_medications` is in every one of these because `DOSE_LIST_SELECT` and
 * the report query inner join `medications`. If those joins ever become LEFT
 * joins — showing a caregiver "a dose at 08:00" without saying which medicine,
 * which is the other coherent product answer — this constant is the one place
 * that has to change.
 */
export const DOSE_READ = ['view_schedule', 'view_medications'] as const;
export const DOSE_HISTORY_READ = ['view_history', 'view_medications'] as const;
export const DOSE_CONFIRM = ['confirm_dose', 'view_medications'] as const;
export const REPORT_READ = ['view_reports', 'view_medications'] as const;

export async function requireProfileOwner(
  tx: PoolClient,
  userId: string,
  profileId: string,
): Promise<ProfileAccess> {
  const access = await loadProfileAccess(tx, userId, profileId);
  if (access.role !== 'owner') {
    throw AppError.forbidden('Only the patient or profile owner can perform this action');
  }
  return access;
}

/** Resolves the profile a medication belongs to, without trusting client input. */
export async function profileIdForMedication(tx: PoolClient, medicationId: string): Promise<string> {
  const { rows } = await tx.query<{ patient_profile_id: string }>(
    'SELECT patient_profile_id FROM medications WHERE id = $1',
    [medicationId],
  );
  if (!rows[0]) throw AppError.notFound('Medication not found');
  return rows[0].patient_profile_id;
}

export async function profileIdForDose(tx: PoolClient, doseId: string): Promise<string> {
  const { rows } = await tx.query<{ patient_profile_id: string }>(
    'SELECT patient_profile_id FROM dose_occurrences WHERE id = $1',
    [doseId],
  );
  if (!rows[0]) throw AppError.notFound('Dose not found');
  return rows[0].patient_profile_id;
}

export async function profileIdForSchedule(tx: PoolClient, scheduleId: string): Promise<string> {
  const { rows } = await tx.query<{ patient_profile_id: string }>(
    'SELECT patient_profile_id FROM medication_schedules WHERE id = $1',
    [scheduleId],
  );
  if (!rows[0]) throw AppError.notFound('Schedule not found');
  return rows[0].patient_profile_id;
}

/** Every profile the caller can see, with the role they hold on each. */
export async function listAccessibleProfiles(tx: PoolClient, userId: string) {
  const { rows } = await tx.query<{
    id: string; display_name: string; is_self: boolean; timezone: string; home_timezone: string;
    travel_policy: string; birth_year: number | null; avatar_key: string | null;
    owner_user_id: string; linked_user_id: string | null; archived_at: Date | null;
    permissions: string[] | null;
  }>(
    `SELECT pp.id, pp.display_name, pp.is_self, pp.timezone, pp.home_timezone, pp.travel_policy,
            pp.birth_year, pp.avatar_key, pp.owner_user_id, pp.linked_user_id, pp.archived_at,
            cr.permissions
       FROM patient_profiles pp
       LEFT JOIN caregiver_relationships cr
              ON cr.patient_profile_id = pp.id AND cr.caregiver_user_id = $1 AND cr.status = 'active'
      WHERE pp.archived_at IS NULL
      ORDER BY pp.is_self DESC, pp.created_at`,
    [userId],
  );

  return rows.map((r) => {
    const isOwner = r.owner_user_id === userId || r.linked_user_id === userId;
    return {
      id: r.id,
      displayName: r.display_name,
      isSelf: r.is_self,
      timezone: r.timezone,
      homeTimezone: r.home_timezone,
      travelPolicy: r.travel_policy,
      birthYear: r.birth_year,
      avatarKey: r.avatar_key,
      role: isOwner ? ('owner' as const) : ('caregiver' as const),
      permissions: isOwner ? null : (r.permissions ?? []),
    };
  });
}
