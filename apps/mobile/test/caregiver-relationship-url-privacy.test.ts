import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const detail = readFileSync(resolve(import.meta.dirname, '../app/caregiver/[id].tsx'), 'utf8');
const family = readFileSync(resolve(import.meta.dirname, '../app/(tabs)/family.tsx'), 'utf8');

describe('caregiver relationship identifiers stay out of API request URLs', () => {
  it('uses fixed mutation paths and carries relationshipId in request bodies', () => {
    for (const source of [detail, family]) {
      expect(source).not.toMatch(/api\.(?:patch|put|delete|post)\(`\/v1\/caregivers\/\$\{/);
    }

    expect(detail).toContain("api.patch('/v1/caregivers/permissions'");
    expect(detail).toContain("api.put('/v1/caregivers/notification-rules'");
    expect(detail).toContain("api.post('/v1/caregivers/revoke'");
    expect((detail.match(/relationshipId: caregiver\.id/g) ?? [])).toHaveLength(3);

    expect(family).toContain("api.post('/v1/caregivers/revoke'");
    expect((family.match(/relationshipId: caregiver\.id/g) ?? [])).toHaveLength(1);
  });
});