import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../../..');
const layoutPath = resolve(ROOT, 'apps/mobile/app/_layout.tsx');

function source(): string {
  return readFileSync(layoutPath, 'utf8');
}

describe('clinical process-local auth/profile boundary', () => {
  it('purges stale ids and medication drafts synchronously before descendant routes can read them', () => {
    const contents = source();
    const shellStart = contents.indexOf('function Shell()');
    const shellReturn = contents.indexOf('  return (', shellStart);
    const beforeDescendantRender = contents.slice(shellStart, shellReturn);

    expect(contents).toContain("import { clearClinicalRouteIntents } from '@/navigation/private-navigation';");
    expect(contents).toContain("import { clearMedicationDrafts } from '@/storage/medication-draft';");
    expect(beforeDescendantRender).toContain('const clinicalRouteScope =');
    expect(beforeDescendantRender).toContain('signedIn');
    expect(beforeDescendantRender).toContain('user?.id');
    expect(beforeDescendantRender).toContain('activeProfile?.id');
    expect(beforeDescendantRender).toContain('const previousClinicalRouteScope = useRef<string | null>(null);');
    expect(beforeDescendantRender).toMatch(
      /if \(previousClinicalRouteScope\.current !== clinicalRouteScope\) \{[\s\S]*?clearClinicalRouteIntents\(\);[\s\S]*?clearMedicationDrafts\(\);[\s\S]*?previousClinicalRouteScope\.current = clinicalRouteScope;[\s\S]*?\}/,
    );

    // A passive effect is too late: a child can already have read a stale
    // medication/caregiver id or OCR-derived medication draft.
    expect(beforeDescendantRender).not.toMatch(
      /useEffect\(\(\) => \{\s*(?:clearClinicalRouteIntents|clearMedicationDrafts)\(\);/,
    );
  });
});
