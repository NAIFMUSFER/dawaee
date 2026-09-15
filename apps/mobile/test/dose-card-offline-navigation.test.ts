import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { fileURLToPath, URL } from 'node:url';
import { describe, expect, it } from 'vitest';

const componentFile = fileURLToPath(new URL('../src/components/DoseCard.tsx', import.meta.url));

function renderDoseCard(medicationId: string, onPress: () => void) {
  const React = {
    createElement: (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) => ({
      type,
      props: { ...(props ?? {}), children },
    }),
  };
  const modules: Record<string, unknown> = {
    react: { __esModule: true, default: React, ...React },
    'react-native': { View: 'View' },
    './ui.js': { Badge: 'Badge', Button: 'Button', Card: 'Card', Row: 'Row', Txt: 'Txt' },
    '../hooks/useTheme.js': {
      useTheme: () => ({
        elderlyMode: false,
        spacing: new Proxy({}, { get: () => 4 }),
        colors: new Proxy({}, { get: () => '#000' }),
      }),
    },
    '../i18n/index.js': {
      useI18n: () => ({
        t: (key: string) => key,
        formatTime: () => '08:00',
        formatMeasure: () => '1 tablet',
      }),
    },
    '../theme/index.js': { statusColors: () => ({ fg: '#000', bg: '#fff' }) },
    '@dawaee/core': { canUndo: () => false },
  };

  const code = ts.transpileModule(fs.readFileSync(componentFile, 'utf8'), {
    fileName: componentFile,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.React,
      esModuleInterop: true,
    },
  }).outputText;
  const exports: Record<string, unknown> = {};
  vm.runInNewContext(code, {
    exports,
    Date,
    require: (id: string) => {
      if (!(id in modules)) throw new Error(`unmocked DoseCard dependency: ${id}`);
      return modules[id];
    },
  }, { filename: componentFile });

  const DoseCard = exports.DoseCard as (props: Record<string, unknown>) => {
    type: unknown;
    props: Record<string, unknown>;
  };
  const dose = {
    id: 'dose-1',
    medicationId,
    scheduleId: 'schedule-1',
    scheduledAt: '2026-09-15T05:00:00.000Z',
    scheduledLocalDate: '2026-09-15',
    scheduledLocalTime: '08:00',
    scheduledTimezone: 'Asia/Riyadh',
    doseQuantity: 1,
    doseUnit: 'tablet',
    status: 'due',
    minutesLate: null,
    snoozedUntil: null,
    snoozeCount: 0,
    confirmedAt: null,
    escalationStage: 0,
    medication: {
      name: 'SYNTHETIC-MEDICATION',
      form: 'tablet',
      imageKey: null,
      strengthValue: null,
      strengthUnit: null,
      foodInstruction: 'no_preference',
      instructions: null,
    },
  };
  return DoseCard({ dose, prominent: false, onPress });
}

describe('DoseCard offline medication navigation', () => {
  it('does not expose a press target when cached dose identity has no medication id', () => {
    const onPress = () => undefined;
    const tree = renderDoseCard('', onPress);
    expect(tree.type).toBe('Card');
    expect(tree.props.onPress).toBeUndefined();
  });

  it('keeps medication detail navigation for an identified online dose', () => {
    const onPress = () => undefined;
    const tree = renderDoseCard('medication-1', onPress);
    expect(tree.props.onPress).toBe(onPress);
  });
});
