import { describe, expect, it } from 'vitest';
import {
  CAREGIVER_PERMISSION_DEPENDENCIES,
  CAREGIVER_ROLE_PRESETS,
  completeCaregiverPermissions,
  toggleCaregiverPermission,
} from '../src/index.js';

/**
 * The API intentionally fails closed when a caregiver capability needs a table
 * the relationship cannot see. Presets shown to patients therefore must be
 * dependency-complete: a button labelled "Observer" cannot promise adherence
 * and then create a relationship that receives 403 from the adherence route.
 *
 * The dependency graph is shared by API and mobile. These tests pin both the
 * presets and the custom-toggle closure so the UI cannot create a grant the API
 * knows is internally unusable.
 */
describe('caregiver permission presets are usable as advertised', () => {
  it('includes every query dependency for every permission in every preset', () => {
    for (const [name, permissions] of Object.entries(CAREGIVER_ROLE_PRESETS)) {
      const granted = new Set(permissions);
      for (const permission of permissions) {
        for (const dependency of CAREGIVER_PERMISSION_DEPENDENCIES[permission] ?? []) {
          expect(
            granted.has(dependency),
            `${name} grants ${permission} but omits required ${dependency}`,
          ).toBe(true);
        }
      }
    }
  });

  it('observer can actually use the adherence capability it advertises', () => {
    expect(CAREGIVER_ROLE_PRESETS.observer).toContain('view_adherence');
    expect(CAREGIVER_ROLE_PRESETS.observer).toContain('view_schedule');
    expect(CAREGIVER_ROLE_PRESETS.observer).not.toContain('view_medications');
  });
});

describe('custom caregiver grants stay dependency-complete', () => {
  it('adding adherence also adds schedule visibility, but not medication identity', () => {
    expect(completeCaregiverPermissions(['view_adherence'])).toEqual([
      'view_schedule',
      'view_adherence',
    ]);
  });

  it('adding dose confirmation adds both tables its handler must read', () => {
    expect(toggleCaregiverPermission([], 'confirm_dose')).toEqual([
      'view_medications',
      'view_schedule',
      'confirm_dose',
    ]);
  });

  it('removing schedule visibility also removes capabilities that cannot work without it', () => {
    const before = completeCaregiverPermissions([
      'view_medications',
      'view_schedule',
      'view_adherence',
      'view_history',
      'view_reports',
      'receive_notifications',
      'update_stock',
      'confirm_dose',
    ]);
    const after = toggleCaregiverPermission(before, 'view_schedule');

    expect(after).toEqual([
      'view_medications',
      'receive_notifications',
      'update_stock',
    ]);
  });
});
