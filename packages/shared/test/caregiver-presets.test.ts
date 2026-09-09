import { describe, expect, it } from 'vitest';
import {
  CAREGIVER_ROLE_PRESETS,
  type CaregiverPermission,
} from '../src/index.js';

/**
 * The API intentionally fails closed when a caregiver capability needs a table
 * the relationship cannot see. Presets shown to patients therefore must be
 * dependency-complete: a button labelled "Observer" cannot promise adherence
 * and then create a relationship that receives 403 from the adherence route.
 *
 * Keep this table aligned with the query dependencies enforced by
 * apps/api/src/services/access-service.ts. A change in either place should be a
 * deliberate product/security decision, not a silent preset regression.
 */
const DEPENDENCIES: Partial<Record<CaregiverPermission, readonly CaregiverPermission[]>> = {
  add_medication: ['view_medications'],
  edit_medication: ['view_medications'],
  edit_schedule: ['view_schedule', 'view_medications'],
  update_stock: ['view_medications'],
  confirm_dose: ['view_schedule', 'view_medications'],
  view_reports: ['view_medications', 'view_schedule'],
  view_adherence: ['view_schedule'],
};

describe('caregiver permission presets are usable as advertised', () => {
  it('includes every query dependency for every permission in every preset', () => {
    for (const [name, permissions] of Object.entries(CAREGIVER_ROLE_PRESETS)) {
      const granted = new Set(permissions);
      for (const permission of permissions) {
        for (const dependency of DEPENDENCIES[permission] ?? []) {
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
