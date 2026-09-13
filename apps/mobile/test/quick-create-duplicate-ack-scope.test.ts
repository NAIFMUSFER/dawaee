import { describe, expect, it } from 'vitest';
import path from 'node:path';

const { createHarness, ApiError } = require('./profile-screen-harness.cjs') as {
  createHarness: (file: string, hookFile: string, profile?: object, overrides?: object) => any;
  ApiError: new (code: string) => Error;
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
      todayLocalDate: () => '2026-09-13',
    },
    '@/components/TimeField': {
      TimeField: 'TimeField',
      isValidTime: (value: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(value),
    },
    '@/storage/medication-draft': {
      clearMedicationDrafts: () => undefined,
      getMedicationPrefillDraft: () => null,
    },
    '@dawaee/shared': { DOSE_UNITS: ['tablet'] },
  };
}

function nameField(h: any) {
  return h.find('Field', (props: any) => props.label === 'medication.name');
}

function saveButton(h: any) {
  return h.find('Button', (props: any) => props.label === 'common.save');
}

function addAnywayButton(h: any) {
  return h.find('Button', (props: any) => props.label === 'medication.addAnyway');
}

async function enterName(h: any, value: string) {
  nameField(h).onChangeText(value);
  await h.flush();
}

async function submit(h: any) {
  saveButton(h).onPress();
  await h.flush();
  const pending = h.batch();
  expect(pending).toHaveLength(1);
  expect(pending[0].route).toBe('/v1/medications');
  return pending[0];
}

async function rejectDuplicate(h: any, request: any) {
  request.completed = true;
  request.reject(new ApiError('duplicate_medication'));
  await h.flush();
  expect(addAnywayButton(h)).toBeTruthy();
}

describe('quick-create duplicate acknowledgement scope', () => {
  it('clears a duplicate acknowledgement prompt when the medication identity name changes', async () => {
    const h = createHarness(screen, hook, { isSelf: true }, overrides());
    try {
      await enterName(h, 'SYNTHETIC-DUPLICATE-A');
      const first = await submit(h);
      expect(first.payload.acknowledgeDuplicate).toBeUndefined();
      await rejectDuplicate(h, first);

      await enterName(h, 'SYNTHETIC-DUPLICATE-B');
      expect(addAnywayButton(h)).toBeNull();

      const second = await submit(h);
      expect(second.payload.name).toBe('SYNTHETIC-DUPLICATE-B');
      expect(second.payload.acknowledgeDuplicate).toBeUndefined();
      second.completed = true;
      second.resolve({ medication: { id: 'created-after-recheck' } });
      await h.flush();
    } finally {
      h.unmount();
    }
  });

  it('still sends explicit acknowledgement when the warned medication identity is unchanged', async () => {
    const replacements: string[] = [];
    const h = createHarness(screen, hook, { isSelf: true }, overrides(replacements));
    try {
      await enterName(h, 'SYNTHETIC-DUPLICATE-STABLE');
      const first = await submit(h);
      await rejectDuplicate(h, first);

      const addAnyway = addAnywayButton(h);
      expect(addAnyway).toBeTruthy();
      addAnyway.onPress();
      await h.flush();

      const pending = h.batch();
      expect(pending).toHaveLength(1);
      expect(pending[0].payload.name).toBe('SYNTHETIC-DUPLICATE-STABLE');
      expect(pending[0].payload.acknowledgeDuplicate).toBe(true);
      pending[0].completed = true;
      pending[0].resolve({ medication: { id: 'created-after-explicit-ack' } });
      await h.flush();
      expect(replacements).toEqual(['/medication/detail']);
    } finally {
      h.unmount();
    }
  });
});
