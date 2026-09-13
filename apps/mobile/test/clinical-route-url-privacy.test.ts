import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../../..');
const MOBILE = resolve(ROOT, 'apps/mobile');

const NAVIGATION_SOURCES = [
  'app/(tabs)/today.tsx',
  'app/(tabs)/history.tsx',
  'app/(tabs)/medications.tsx',
  'app/(tabs)/family.tsx',
  'app/caregiver/accept.tsx',
  'app/caregiver/[id].tsx',
  'app/medication/[id].tsx',
  'app/medication/quick-create.tsx',
  'app/medication/edit.tsx',
  'app/medication/schedule.tsx',
  'app/medication/stock.tsx',
  'src/components/MedicationDetailView.tsx',
] as const;

const HANDOFFS = [
  ['app/(tabs)/today.tsx', 'setMedicationDetailRouteIntent', '/medication/detail'],
  ['app/(tabs)/history.tsx', 'setMedicationDetailRouteIntent', '/medication/detail'],
  ['app/(tabs)/medications.tsx', 'setMedicationDetailRouteIntent', '/medication/detail'],
  ['app/(tabs)/family.tsx', 'setCaregiverDetailRouteIntent', '/caregiver/detail'],
  ['app/medication/quick-create.tsx', 'setMedicationDetailRouteIntent', '/medication/detail'],
  ['app/medication/edit.tsx', 'setMedicationScheduleRouteIntent', '/medication/schedule'],
  ['app/medication/schedule.tsx', 'setMedicationDetailRouteIntent', '/medication/detail'],
  ['src/components/MedicationDetailView.tsx', 'setMedicationEditRouteIntent', '/medication/edit'],
  ['src/components/MedicationDetailView.tsx', 'setMedicationScheduleRouteIntent', '/medication/schedule'],
  ['src/components/MedicationDetailView.tsx', 'setMedicationStockRouteIntent', '/medication/stock'],
] as const;

function source(relative: string): string {
  return readFileSync(resolve(MOBILE, relative), 'utf8');
}

function routerArguments(relative: string): string[] {
  const contents = source(relative);
  const file = ts.createSourceFile(relative, contents, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: string[] = [];

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && ts.isIdentifier(node.expression.expression)
      && node.expression.expression.text === 'router'
      && ['push', 'replace', 'setParams'].includes(node.expression.name.text)
    ) {
      found.push(node.arguments.map((argument) => argument.getText(file)).join(', '));
    }
    ts.forEachChild(node, visit);
  };

  visit(file);
  return found;
}

describe('clinical browser-route URL privacy', () => {
  it.each(NAVIGATION_SOURCES)('%s never serializes a stable clinical identifier into router state', (relative) => {
    const argumentsText = routerArguments(relative).join('\n');

    expect(argumentsText).not.toMatch(/\/(?:medication|caregiver)\/\$\{/);
    expect(argumentsText).not.toMatch(/[?&](?:id|profileId|medicationId|scheduleId)=/);
    expect(argumentsText).not.toMatch(/\b(?:profileId|medicationId|scheduleId)\s*:/);
  });

  it('serves fixed detail paths and makes legacy dynamic routes fail closed', () => {
    const medicationDetail = source('app/medication/detail.tsx');
    const caregiverDetail = source('app/caregiver/detail.tsx');
    const legacyMedication = source('app/medication/[id].tsx');
    const legacyCaregiver = source('app/caregiver/[id].tsx');

    expect(medicationDetail).toContain('getMedicationDetailRouteIntent');
    expect(medicationDetail).not.toContain('useLocalSearchParams');
    expect(caregiverDetail).toContain('getCaregiverDetailRouteIntent');
    expect(caregiverDetail).not.toContain('useLocalSearchParams');

    expect(legacyMedication).not.toContain('useLocalSearchParams');
    expect(legacyMedication).not.toContain('setMedicationDetailRouteIntent');
    expect(legacyMedication).toContain('<Redirect href="/(tabs)/medications" />');

    expect(legacyCaregiver).not.toContain('useLocalSearchParams');
    expect(legacyCaregiver).not.toContain('setCaregiverDetailRouteIntent');
    expect(legacyCaregiver).toContain('<Redirect href="/(tabs)/family" />');
  });

  it.each(HANDOFFS)('%s sets %s before navigating to fixed path %s', (relative, setter, fixedPath) => {
    expect(source(relative)).toContain(`${setter}({`);
    expect(routerArguments(relative).some((argument) => argument.includes(fixedPath))).toBe(true);
  });

  it('keeps the identifier handoff process-local and bound to both account and patient', () => {
    const intent = source('src/navigation/private-navigation.ts');
    expect(intent).toContain('userId: string');
    expect(intent).toContain('patientProfileId: string');
    expect(intent).toContain('const TTL_MS = 15 * 60 * 1000');
    expect(intent).not.toMatch(/AsyncStorage|SecureStore|localStorage|sessionStorage/);
  });
});
