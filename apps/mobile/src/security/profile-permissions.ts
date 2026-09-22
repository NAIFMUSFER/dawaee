import type { CaregiverPermission } from '@dawaee/shared';
import type { ProfileSummary } from '../api/types.js';

/** Ownership includes dependent profiles; caregiver grants stay explicit. */
export function hasProfilePermission(profile: ProfileSummary | null | undefined, permission: CaregiverPermission): boolean {
  return !!profile && (profile.role === 'owner' || (!profile.role && profile.isSelf) || !!profile.permissions?.includes(permission));
}
