import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../../..');
const familyScreen = readFileSync(resolve(ROOT, 'apps/mobile/app/(tabs)/family.tsx'), 'utf8');
const detailScreen = readFileSync(resolve(ROOT, 'apps/mobile/app/caregiver/detail.tsx'), 'utf8');
const legacyScreen = readFileSync(resolve(ROOT, 'apps/mobile/app/caregiver/[id].tsx'), 'utf8');
const handoff = readFileSync(resolve(ROOT, 'apps/mobile/src/navigation/private-navigation.ts'), 'utf8');

describe('caregiver detail browser URL privacy', () => {
  it('opens caregiver detail through a fixed browser path', () => {
    expect(familyScreen).toContain("router.push('/caregiver/detail')");
    expect(familyScreen).toContain('setCaregiverDetailRouteIntent');
    expect(familyScreen).not.toMatch(/router\.push\s*\(\s*`\/caregiver\/\$\{/);
  });

  it('does not recover a relationship id from Expo Router path/search parameters', () => {
    expect(detailScreen).not.toContain('useLocalSearchParams');
    expect(detailScreen).toContain('getCaregiverDetailRouteIntent');
    expect(detailScreen).not.toContain('setCaregiverDetailRouteIntent');
  });

  it('fails closed on the legacy dynamic route instead of ingesting its id', () => {
    expect(legacyScreen).not.toContain('useLocalSearchParams');
    expect(legacyScreen).not.toContain('setCaregiverDetailRouteIntent');
    expect(legacyScreen).toContain('<Redirect href="/(tabs)/family" />');
  });

  it('binds the private handoff to the active account and patient profile', () => {
    expect(handoff).toContain('interface CaregiverDetailRouteIntent extends RouteOwner');
    expect(handoff).toContain('slot.value.userId !== userId');
    expect(handoff).toContain('slot.value.patientProfileId !== patientProfileId');
    expect(handoff).toContain('Date.now() >= slot.expiresAt');
  });
});
