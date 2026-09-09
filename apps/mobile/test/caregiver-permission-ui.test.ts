import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The server fails closed when a caregiver permission is missing a query
 * dependency. Both places where a patient edits those grants must therefore use
 * the shared closure helper rather than treating thirteen switches as unrelated
 * booleans. Otherwise the UI can save a switch as "on" while the corresponding
 * route returns 403.
 */
const ROOT = resolve(import.meta.dirname, '../../..');
const source = (path: string) => readFileSync(join(ROOT, path), 'utf8');

describe('caregiver permission editors cannot create unusable grants', () => {
  for (const [name, path] of [
    ['invite', 'apps/mobile/app/caregiver/invite.tsx'],
    ['existing caregiver', 'apps/mobile/app/caregiver/[id].tsx'],
  ] as const) {
    it(`${name} uses the shared dependency-aware toggle`, () => {
      const src = source(path);
      expect(src).toContain('toggleCaregiverPermission');
      expect(src).toMatch(/setPermissions\(\(current\)\s*=>\s*toggleCaregiverPermission\(current, permission\)\)/);
    });
  }
});
