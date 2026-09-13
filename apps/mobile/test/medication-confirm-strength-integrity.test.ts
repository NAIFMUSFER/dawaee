import { describe, expect, it } from 'vitest';
import path from 'node:path';

const { createHarness } = require('./profile-screen-harness.cjs') as {
  createHarness: (file: string, hookFile: string, profile?: object, overrides?: object) => any;
};

const screen = path.resolve(process.cwd(), 'apps/mobile/app/medication/confirm.tsx');
const hook = path.resolve(process.cwd(), 'apps/mobile/src/hooks/useRequestScope.ts');

function setup() {
  const prefills: any[] = [];
  const replacements: string[] = [];
  const h = createHarness(screen, hook, {}, {
    'expo-router': {
      router: {
        back: () => undefined,
        push: () => undefined,
        replace: (route: string) => { replacements.push(route); },
      },
    },
    '@/components/DateField': {
      DateField: 'DateField',
      isValidLocalDate: (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value),
    },
    '@/storage/medication-draft': {
      clearMedicationDrafts: () => undefined,
      getMedicationConfirmDraft: (profileId: string) => ({
        patientProfileId: profileId,
        imageKey: `image-${profileId}`,
        remainingLines: 0,
        detected: {
          name: { value: 'SYNTHETIC-OCR-MEDICATION', confidence: 0.99 },
        },
      }),
      setMedicationPrefillDraft: (value: any) => { prefills.push(JSON.parse(JSON.stringify(value))); },
    },
    '@dawaee/shared': {
      MEDICATION_FORMS: ['tablet'],
      STRENGTH_UNITS: ['mg'],
    },
  });
  return { h, prefills, replacements };
}

function strengthField(h: any) {
  return h.find('Field', (props: any) => props.label === 'medication.strengthValue');
}

async function enterStrength(h: any, value: string) {
  strengthField(h).onChangeText(value);
  await h.flush();
}

async function next(h: any) {
  const button = h.find('Button', (props: any) => props.label === 'common.next');
  expect(button).toBeTruthy();
  button.onPress();
  await h.flush();
}

describe('OCR confirmation strength validation', () => {
  for (const value of ['abc', 'not-a-number', '0', '-1', '100001']) {
    it(`does not silently discard or forward invalid confirmed strength ${value}`, async () => {
      const { h, prefills, replacements } = setup();
      try {
        await enterStrength(h, value);
        await next(h);
        expect(prefills).toEqual([]);
        expect(replacements).toEqual([]);
        expect(strengthField(h).value).toBe(value);
        expect(strengthField(h).error).toBe('error.validation_failed');
      } finally {
        h.unmount();
      }
    });
  }

  it('preserves a valid confirmed strength in the profile-bound prefill draft', async () => {
    const { h, prefills, replacements } = setup();
    try {
      await enterStrength(h, '500');
      await next(h);
      expect(prefills).toHaveLength(1);
      expect(prefills[0].patientProfileId).toBe('A');
      expect(prefills[0].strengthValue).toBe(500);
      expect(prefills[0].strengthUnit).toBe('mg');
      expect(replacements).toEqual(['/medication/quick-create?source=capture']);
    } finally {
      h.unmount();
    }
  });

  it('keeps an intentionally blank strength optional', async () => {
    const { h, prefills, replacements } = setup();
    try {
      await enterStrength(h, '');
      await next(h);
      expect(prefills).toHaveLength(1);
      expect(prefills[0].strengthValue).toBeNull();
      expect(prefills[0].strengthUnit).toBeNull();
      expect(replacements).toEqual(['/medication/quick-create?source=capture']);
    } finally {
      h.unmount();
    }
  });
});
