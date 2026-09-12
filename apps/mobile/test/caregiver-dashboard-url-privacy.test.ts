import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../../..');
const dashboard = readFileSync(resolve(ROOT, 'apps/mobile/app/caregiver/dashboard.tsx'), 'utf8');

describe('caregiver dashboard browser URL privacy', () => {
  it('does not use a patient profile id as Expo Router search state', () => {
    expect(dashboard).not.toContain('useLocalSearchParams');
    expect(dashboard).not.toContain('router.setParams');
    expect(dashboard).not.toMatch(/setParams\s*\(\s*\{\s*profileId/);
  });

  it('switches followed patients through application state instead of the public URL', () => {
    expect(dashboard).toMatch(/useApp\(\)[\s\S]{0,220}setActiveProfile/);
    expect(dashboard).toContain('onPress={() => setActiveProfile(p.id)}');
  });
});
