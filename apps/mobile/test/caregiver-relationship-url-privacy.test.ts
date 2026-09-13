import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const detail = readFileSync(resolve(import.meta.dirname, '../app/caregiver/[id].tsx'), 'utf8');
const family = readFileSync(resolve(import.meta.dirname, '../app/(tabs)/family.tsx'), 'utf8');

function caregiverMutationBodies(contents: string): string[] {
  const file = ts.createSourceFile('screen.tsx', contents, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const bodies: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && ts.isIdentifier(node.expression.expression)
      && node.expression.expression.text === 'api'
      && ['patch', 'put', 'post', 'delete'].includes(node.expression.name.text)
      && node.arguments[0]?.getText(file).includes('/v1/caregivers/')
    ) {
      bodies.push(node.arguments[1]?.getText(file) ?? '');
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return bodies;
}

describe('caregiver relationship identifiers stay out of API request URLs', () => {
  it('uses fixed mutation paths and carries relationshipId in request bodies', () => {
    for (const source of [detail, family]) {
      expect(source).not.toMatch(/api\.(?:patch|put|delete|post)\(`\/v1\/caregivers\/\$\{/);
    }

    expect(detail).toContain("api.patch('/v1/caregivers/permissions'");
    expect(detail).toContain("api.put('/v1/caregivers/notification-rules'");
    expect(detail).toContain("api.post('/v1/caregivers/revoke'");
    expect(caregiverMutationBodies(detail)).toHaveLength(3);
    expect(caregiverMutationBodies(detail).every((body) => body.includes('relationshipId: caregiver.id'))).toBe(true);

    expect(family).toContain("api.post('/v1/caregivers/revoke'");
    expect(caregiverMutationBodies(family)).toEqual(['{ relationshipId: caregiver.id }']);
  });
});
