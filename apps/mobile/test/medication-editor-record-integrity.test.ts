import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
const { createHarness } = require('./profile-screen-harness.cjs');

function editor() {
  const writes: any[] = [];
  let intentAvailable = true;
  const h = createHarness(resolve('apps/mobile/app/medication/edit.tsx'), resolve('apps/mobile/src/hooks/useRequestScope.ts'), { role: 'owner' }, {
    '@/navigation/private-navigation': {
      getMedicationEditRouteIntent: () => intentAvailable ? { medicationId: 'synthetic-medication' } : null,
      setMedicationDetailRouteIntent() {}, setMedicationScheduleRouteIntent() {},
    },
    '@/components/DateField': { DateField: 'DateField', todayLocalDate: () => '2026-09-19',
      isValidLocalDate: (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) },
    '@/api/client': { api: {
      get: async () => ({ medication: { id: 'synthetic-medication', name: 'Synthetic medicine', form: 'tablet',
        strengthValue: 500, strengthUnit: 'mg', startDate: '2026-09-19', endDate: null,
        imageKey: 'original-private-photo', foodInstruction: 'no_preference' } }),
      patch: async (route: string, body: unknown) => { writes.push({ route, body }); },
      post: async () => { throw new Error('An editor must not create another medicine'); },
    } },
  });
  return { h, writes, expireIntent: () => { intentAvailable = false; } };
}

describe('medication edit preserves the saved record', () => {
  it.each([['٥٠٠', 500], ['٥٠٠٫٥', 500.5], ['۵۰۰', 500]])('saves Arabic strength %s without clearing it', async (raw, value) => {
    const { h, writes } = editor();
    try {
      await h.flush();
      h.find('Field', (p: any) => p.label === 'medication.strengthValue').onChangeText(raw);
      await h.flush(); h.find('Button', (p: any) => p.testID === 'save-medication').onPress(); await h.flush();
      expect(writes).toHaveLength(1);
      expect(writes[0].body).toMatchObject({ strengthValue: value, strengthUnit: 'mg', imageKey: 'original-private-photo' });
    } finally { h.unmount(); }
  });
  it('rejects invalid nonempty strength without silently clearing the original', async () => {
    const { h, writes } = editor();
    try {
      await h.flush(); h.find('Field', (p: any) => p.label === 'medication.strengthValue').onChangeText('abc');
      await h.flush(); h.find('Button', (p: any) => p.testID === 'save-medication').onPress(); await h.flush();
      expect(writes).toEqual([]); expect(h.text()).toContain('error.validation_failed');
      expect(h.find('Field', (p: any) => p.label === 'medication.strengthValue').value).toBe('abc');
    } finally { h.unmount(); }
  });
  it('saves a changed photo with the same medication and preserves long editing sessions', async () => {
    const { h, writes, expireIntent } = editor();
    try {
      await h.flush(); expireIntent();
      h.find('MedicationImageField').onChange('new-finalized-private-photo'); await h.flush();
      h.find('Button', (p: any) => p.testID === 'save-medication').onPress(); await h.flush();
      expect(writes).toHaveLength(1);
      expect(writes[0]).toMatchObject({ route: '/v1/medications/synthetic-medication', body: { imageKey: 'new-finalized-private-photo' } });
      expect(h.text()).toContain('medication.editTitle');
    } finally { h.unmount(); }
  });
});
