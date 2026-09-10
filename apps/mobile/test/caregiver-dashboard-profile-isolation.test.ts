import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../../..');
const source = (path: string) => readFileSync(join(ROOT, path), 'utf8');

/**
 * The caregiver dashboard can switch among followed patients without leaving
 * the route. Patient A's fulfilled state must disappear in the same render that
 * selects B, and any A request still in flight must lose permission to write
 * global/offline or local clinical state after that switch.
 */
describe('caregiver dashboard patient isolation', () => {
  it('remounts clinical state when patient identity or permissions change', () => {
    const src = source('apps/mobile/app/caregiver/dashboard.tsx');
    expect(src).toContain("import { profileScopeKey, useRequestScope } from '@/hooks/useRequestScope';");
    expect(src).toMatch(/<CaregiverPatientDashboard[\s\S]*?key=\{profileScopeKey\(user\?\.id, patient\)\}/);
  });

  it('fences late patient requests before every state-writing completion path', () => {
    const src = source('apps/mobile/app/caregiver/dashboard.tsx');
    expect(src).toContain('const { begin: beginLoad } = useRequestScope(profileScopeKey(undefined, patient));');
    expect(src).toContain('const isCurrent = beginLoad();');
    expect(src).toMatch(/await Promise\.all\([\s\S]*?\);\s*if \(!isCurrent\(\)\) return;\s*setToday\(todayRes\)/);
    expect(src).toMatch(/catch \(err\) \{\s*if \(!isCurrent\(\)\) return;/);
    expect(src).toMatch(/finally \{\s*if \(isCurrent\(\)\) \{\s*setLoading\(false\);\s*setRefreshing\(false\);/);
  });

  it('does not translate an initial network outage into false clinical empty states', () => {
    const src = source('apps/mobile/app/caregiver/dashboard.tsx');
    expect(src).toContain(
      'const loadFailedWithoutClinicalData = (offline || error !== null) && today === null && adherence === null;',
    );
    expect(src).toMatch(/if \(err instanceof NetworkError\) setOffline\(true\);/);
    expect(src).toMatch(/loadFailedWithoutClinicalData \? null : !canSeeToday[\s\S]*?caregiver\.noDosesToday/);
    expect(src).toMatch(/loadFailedWithoutClinicalData \? null : !can\('view_adherence'\)[\s\S]*?caregiver\.notShared/);
  });
});
