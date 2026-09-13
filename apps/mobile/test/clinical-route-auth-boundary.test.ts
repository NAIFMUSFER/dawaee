import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../../..');
const layoutPath = resolve(ROOT, 'apps/mobile/app/_layout.tsx');

function source(): string {
  return readFileSync(layoutPath, 'utf8');
}

describe('clinical route intent auth/profile boundary', () => {
  it('purges stale ids synchronously before descendant routes can read them', () => {
    const contents = source();
    const shellStart = contents.indexOf('function Shell()');
    const shellReturn = contents.indexOf('  return (', shellStart);
    const beforeDescendantRender = contents.slice(shellStart, shellReturn);

    expect(contents).toContain("import { clearClinicalRouteIntents } from '@/navigation/private-navigation';");
    expect(beforeDescendantRender).toContain('const clinicalRouteScope =');
    expect(beforeDescendantRender).toContain('signedIn');
    expect(beforeDescendantRender).toContain('user?.id');
    expect(beforeDescendantRender).toContain('activeProfile?.id');
    expect(beforeDescendantRender).toContain('const previousClinicalRouteScope = useRef<string | null>(null);');
    expect(beforeDescendantRender).toMatch(
      /if \(previousClinicalRouteScope\.current !== clinicalRouteScope\) \{[\s\S]*?clearClinicalRouteIntents\(\);[\s\S]*?previousClinicalRouteScope\.current = clinicalRouteScope;[\s\S]*?\}/,
    );

    // A passive effect is too late: the fixed detail child has already rendered
    // and captured an old medication/caregiver id before effects are committed.
    expect(beforeDescendantRender).not.toMatch(
      /useEffect\(\(\) => \{\s*clearClinicalRouteIntents\(\);/,
    );
  });
});
