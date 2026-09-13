import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../../..');
const layoutPath = resolve(ROOT, 'apps/mobile/app/_layout.tsx');

function source(): string {
  return readFileSync(layoutPath, 'utf8');
}

function effectClearsClinicalIntentsOnAuthOrProfileBoundary(): boolean {
  const contents = source();
  const file = ts.createSourceFile(layoutPath, contents, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let found = false;

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === 'useEffect'
      && node.arguments.length >= 2
      && ts.isArrayLiteralExpression(node.arguments[1])
    ) {
      const body = node.arguments[0].getText(file);
      const dependencies = node.arguments[1].elements.map((element) => element.getText(file));
      if (
        body.includes('clearClinicalRouteIntents()')
        && dependencies.includes('signedIn')
        && dependencies.includes('user?.id')
        && dependencies.includes('activeProfile?.id')
      ) {
        found = true;
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(file);
  return found;
}

describe('clinical route intent auth/profile boundary', () => {
  it('purges process-local clinical ids when authentication or patient ownership context changes', () => {
    const contents = source();

    expect(contents).toContain("import { clearClinicalRouteIntents } from '@/navigation/private-navigation';");
    expect(effectClearsClinicalIntentsOnAuthOrProfileBoundary()).toBe(true);
  });
});
