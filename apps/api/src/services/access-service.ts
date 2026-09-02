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

export async function requireProfileAccess(
  tx: PoolClient,
  userId: string,
  profileId: string,
  permission: CaregiverPermission,
): Promise<ProfileAccess> {
  const access = await loadProfileAccess(tx, userId, profileId);
  assertCan(access, permission);
  return access;
}

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
