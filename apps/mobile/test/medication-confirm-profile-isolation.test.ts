import { describe, expect, it } from 'vitest';
import path from 'node:path';

const { createHarness } = require('./profile-screen-harness.cjs') as {
  createHarness: (file: string, hookFile: string, profile?: object, overrides?: object) => any;
};

const screen = path.resolve(process.cwd(), 'apps/mobile/app/medication/confirm.tsx');
const hook = path.resolve(process.cwd(), 'apps/mobile/src/hooks/useRequestScope.ts');

function draft(label: string) {
  return {
    patientProfileId: label,
    imageKey: `image-${label}`,
    remainingLines: 0,
    detected: {
      name: { value: `SYNTHETIC-${label}-ONLY`, confidence: 0.99 },
    },
  };
}

function overrides() {
  return {
    'expo-router': {
      router: { back: () => undefined, push: () => undefined, replace: () => undefined },
    },
    '@/components/DateField': {
      DateField: 'DateField',
      isValidLocalDate: (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value),
    },
    '@/storage/medication-draft': {
      clearMedicationDrafts: () => undefined,
      getMedicationConfirmDraft: (profileId: string) => draft(profileId),
      setMedicationPrefillDraft: () => undefined,
    },
    '@dawaee/shared': {
      MEDICATION_FORMS: ['tablet'],
      STRENGTH_UNITS: ['mg'],
    },
  };
}

function nameField(h: any) {
  return h.find('Field', (props: any) => props.label === 'medication.name');
}

describe('OCR confirmation profile isolation', () => {
  it('does not keep patient A OCR form state on the first patient B frame', () => {
    const h = createHarness(screen, hook, {}, overrides());
    try {
      expect(nameField(h)?.value).toBe('SYNTHETIC-A-ONLY');

      h.switchProfile('B', false);

      expect(h.app.activeProfile.id).toBe('B');
      expect(h.text()).not.toContain('SYNTHETIC-A-ONLY');
      expect(nameField(h)?.value).toBe('SYNTHETIC-B-ONLY');
    } finally {
      h.unmount();
    }
  });
});
