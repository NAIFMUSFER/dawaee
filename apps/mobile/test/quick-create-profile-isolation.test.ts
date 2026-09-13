import { describe, expect, it } from 'vitest';
import path from 'node:path';

const { createHarness } = require('./profile-screen-harness.cjs') as {
  createHarness: (file: string, hookFile: string, profile?: object, overrides?: object) => any;
};

const screen = path.resolve(process.cwd(), 'apps/mobile/app/medication/quick-create.tsx');
const hook = path.resolve(process.cwd(), 'apps/mobile/src/hooks/useRequestScope.ts');

function overrides(replacements: string[] = []) {
  return {
    'expo-router': {
      useLocalSearchParams: () => ({}),
      router: {
        back: () => undefined,
        push: () => undefined,
        replace: (route: string) => { replacements.push(route); },
      },
    },
    '@/components/DateField': {
      DateField: 'DateField',
      isValidLocalDate: (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value),
      todayLocalDate: () => '2026-09-11',
    },
    '@/components/TimeField': {
      TimeField: 'TimeField',
      isValidTime: (value: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(value),
    },
    '@/storage/medication-draft': {
      clearMedicationDrafts: () => undefined,
      getMedicationPrefillDraft: () => null,
    },
    '@dawaee/shared': {
      DOSE_UNITS: ['tablet'],
    },
  };
}

function nameField(h: any) {
  return h.find('Field', (props: any) => props.label === 'medication.name');
}

describe('quick-create medication profile isolation', () => {
  it('does not carry patient A form contents into patient B after ProfileSwitcher changes profile', () => {
    const h = createHarness(screen, hook, { isSelf: true }, overrides());
    try {
      const fieldA = nameField(h);
      expect(fieldA?.value).toBe('');
      fieldA.onChangeText('SYNTHETIC-A-MEDICATION-ONLY');
      h.render();
      expect(nameField(h)?.value).toBe('SYNTHETIC-A-MEDICATION-ONLY');

      h.switchProfile('B');

      expect(h.text()).not.toContain('SYNTHETIC-A-MEDICATION-ONLY');
      expect(nameField(h)?.value).toBe('');
    } finally {
      h.unmount();
    }
  });

  it('late patient A save completion cannot navigate the already-switched patient B UI', async () => {
    const replacements: string[] = [];
    const h = createHarness(screen, hook, { isSelf: true }, overrides(replacements));
    try {
      nameField(h).onChangeText('SYNTHETIC-A-MEDICATION-ONLY');
      h.render();
      const save = h.find('Button', (props: any) => props.label === 'common.save');
      expect(save).toBeTruthy();
      save.onPress();

      const pending = h.batch();
      expect(pending).toHaveLength(1);
      expect(pending[0].route).toBe('/v1/medications');
      expect(pending[0].payload.patientProfileId).toBe('A');

      h.switchProfile('B');
      pending[0].completed = true;
      pending[0].resolve({ medication: { id: 'medication-created-for-A' } });
      await h.flush();

      expect(replacements).toEqual([]);
      expect(h.app.activeProfile.id).toBe('B');
    } finally {
      h.unmount();
    }
  });
});
