import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(import.meta.dirname, '../app/caregiver/[id].tsx'), 'utf8');

describe('caregiver relationship identifiers stay out of public request URLs', () => {
  it('uses fixed mutation paths and carries relationshipId in request bodies', () => {
    expect(source).not.toMatch(/api\.(?:patch|put|delete|post)\(`\/v1\/caregivers\/\$\{/);
    expect(source).toContain("api.patch('/v1/caregivers/permissions'");
    expect(source).toContain("api.put('/v1/caregivers/notification-rules'");
    expect(source).toContain("api.post('/v1/caregivers/revoke'");
    expect((source.match(/relationshipId: caregiver\.id/g) ?? [])).toHaveLength(3);
  });
});