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
 * Product-level permission dependencies imposed by the queries behind a
 * capability.
 *
 * Custom caregiver grants are allowed, but a write/read capability cannot work
 * if a table its handler necessarily joins is hidden by RLS. The standard nurse
 * preset already contains these bundles; this table makes the same invariant
 * hold for custom permission sets and turns opaque RLS-driven empty responses
 * into explicit 403s before the query starts.
 *
 * P20 evidence:
 * - add_medication without view_medications could not complete its own
 *   duplicate/RETURNING path;
 * - edit_schedule without view_schedule failed while materializing the first
 *   occurrences because the ON CONFLICT path must see the schedule/doses;
 * - edit_medication/update_stock first resolve a medication row, which itself
 *   requires view_medications;
 * - confirm_dose first resolves the dose occurrence and then renders medication
 *   identity, so the confirmation grant is useful only with schedule + medicine
 *   visibility;
 * - reports inner-join dose_occurrences, medications AND medication_schedules.
 *   A custom caregiver holding view_reports + view_medications but not
 *   view_schedule therefore passed the API check and received HTTP 200 with an
 *   empty report because the schedule RLS policy removed every joined row.
 */
const PERMISSION_DEPENDENCIES: Partial<Record<CaregiverPermission, readonly CaregiverPermission[]>> = {
  add_medication: ['view_medications'],
  edit_medication: ['view_medications'],
  edit_schedule: ['view_schedule', 'view_medications'],
  update_stock: ['view_medications'],
  confirm_dose: ['view_schedule', 'view_medications'],
  view_reports: ['view_medications', 'view_schedule'],
};

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
 * The permissions are checked in the order given, so the message names the
 * route's primary permission first when both are absent. Dependencies are
 * checked immediately after their primary permission.
 */
export async function requireProfileAccess(
  tx: PoolClient,
  userId: string,
  profileId: string,
  permission: CaregiverPermission | readonly CaregiverPermission[],
): Promise<ProfileAccess> {
  const access = await loadProfileAccess(tx, userId, profileId);
  const requested = Array.isArray(permission)
    ? permission as readonly CaregiverPermission[]
    : [permission as CaregiverPermission];

  const checked = new Set<CaregiverPermission>();
  for (const p of requested) {
    if (!checked.has(p)) {
      assertCan(access, p);
      checked.add(p);
    }
    for (const dependency of PERMISSION_DEPENDENCIES[p] ?? []) {
      if (checked.has(dependency)) continue;
      assertCan(access, dependency);
      checked.add(dependency);
    }
  }
  return access;
}

/** The permission sets required by compound reads. */
export const DOSE_READ = ['view_schedule', 'view_medications'] as const;
export const DOSE_HISTORY_READ = ['view_history', 'view_medications'] as const;
export const DOSE_CONFIRM = ['confirm_dose', 'view_schedule', 'view_medications'] as const;
export const REPORT_READ = ['view_reports', 'view_medications', 'view_schedule'] as const;

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
