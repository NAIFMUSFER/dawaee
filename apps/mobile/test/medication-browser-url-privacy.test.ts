import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../../..');
const listScreen = readFileSync(resolve(ROOT, 'apps/mobile/app/(tabs)/medications.tsx'), 'utf8');
const detailScreen = readFileSync(resolve(ROOT, 'apps/mobile/app/medication/detail.tsx'), 'utf8');
const legacyScreen = readFileSync(resolve(ROOT, 'apps/mobile/app/medication/[id].tsx'), 'utf8');
const handoff = readFileSync(resolve(ROOT, 'apps/mobile/src/navigation/private-navigation.ts'), 'utf8');

describe('medication detail browser URL privacy', () => {
  it('opens medication detail through a fixed browser path', () => {
    expect(listScreen).toContain("router.push('/medication/detail')");
    expect(listScreen).toContain('setMedicationDetailRouteIntent');
    expect(listScreen).not.toMatch(/router\.push\s*\(\s*`\/medication\/\$\{/);
  });

  it('does not recover the medication id from Expo Router search/path parameters', () => {
    expect(detailScreen).not.toContain('useLocalSearchParams');
    expect(detailScreen).toContain('getMedicationDetailRouteIntent');
    expect(detailScreen).toContain("medicationId={medicationId}");
  });

  it('fails closed on the legacy dynamic route instead of ingesting its id', () => {
    expect(legacyScreen).not.toContain('useLocalSearchParams');
    expect(legacyScreen).not.toContain('setMedicationDetailRouteIntent');
    expect(legacyScreen).toContain('<Redirect href="/(tabs)/medications" />');
  });

  it('binds the process-local handoff to the active patient profile and expires it', () => {
    expect(handoff).toContain('userId');
    expect(handoff).toContain('patientProfileId');
    expect(handoff).toContain('Date.now() >= slot.expiresAt');
    expect(handoff).toContain('slot.value.userId !== userId');
    expect(handoff).toContain('slot.value.patientProfileId !== patientProfileId');
  });
});
