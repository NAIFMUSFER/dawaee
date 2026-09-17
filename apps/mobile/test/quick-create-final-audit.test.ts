import { describe, expect, it } from 'vitest';
import path from 'node:path';
const { createHarness, NetworkError } = require('./profile-screen-harness.cjs');
const screen = path.resolve('apps/mobile/app/medication/quick-create.tsx');
const hook = path.resolve('apps/mobile/src/hooks/useRequestScope.ts');
function setup() {
  return createHarness(screen, hook, { isSelf: true }, {
    'expo-router': { useLocalSearchParams: () => ({}), router: { back() {}, replace() {} } },
    '@/components/DateField': { DateField: 'DateField', isValidLocalDate: (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v), todayLocalDate: () => '2026-09-16' },
    '@/components/TimeField': { TimeField: 'TimeField', isValidTime: (v: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(v) },
    '@/storage/medication-draft': { clearMedicationDrafts() {}, getMedicationPrefillDraft: () => null },
  });
}
const field = (h: any, label: string) => h.find('Field', (p: any) => p.label === label);
const button = (h: any, label: string) => h.find('Button', (p: any) => p.label === label);
const save = (h: any) => button(h, 'common.save').onPress();
const quantityLabel = 'Amount per dose (or enter another amount)';

describe('reported medication entry defects', () => {
  it('saves custom Arabic six, four distinct times, all weekdays and matching stock units', async () => {
    const h = setup();
    try {
      field(h, 'medication.name').onChangeText('Synthetic audit entry');
      field(h, quantityLabel).onChangeText('٦');
      field(h, 'stock.currentQuantity (unit.tablet)').onChangeText('٦٠');
      await h.flush();
      for (const [i, value] of ['10:13', '12:27', '23:59'].entries()) {
        button(h, 'schedule.addTime').onPress(); await h.flush();
        const time = h.find('TimeField', (p: any) => p.label === `schedule.times ${i + 2}`);
        expect(time.value).toBe(''); // A new appointment is an explicit decision.
        time.onChange(value); await h.flush();
      }
      save(h); save(h); await h.flush();
      expect(h.requests).toHaveLength(1);
      const request = h.requests[0];
      expect(request.payload.schedule.doseQuantity).toBe(6);
      expect(request.payload.schedule.rule.times).toEqual(['08:00', '10:13', '12:27', '23:59']);
      expect(request.payload.schedule.rule.weekdays).toEqual([0,1,2,3,4,5,6]);
      expect(request.payload.stock).toMatchObject({ initialQuantity: 60, unit: 'tablet' });
      const originalId = request.payload.clientRequestId;
      request.completed = true; request.reject(new NetworkError()); await h.flush();
      expect(field(h, quantityLabel).value).toBe('٦');
      save(h); await h.flush();
      expect(h.requests[1].payload.clientRequestId).toBe(originalId);
    } finally { h.unmount(); }
  });
  it('blocks duplicate times and invalid numbers, retaining the draft for correction', async () => {
    const h = setup();
    try {
      field(h, 'medication.name').onChangeText('Synthetic entry');
      button(h, 'schedule.addTime').onPress(); await h.flush();
      h.find('TimeField', (p: any) => p.label === 'schedule.times 2').onChange('08:00'); await h.flush();
      save(h); await h.flush();
      expect(h.requests).toHaveLength(0);
      expect(h.text()).toContain('schedule.duplicateTime');
      button(h, 'common.remove').onPress(); await h.flush();
      for (const value of ['', '0', '-2', '١/٠', '1001']) {
        field(h, quantityLabel).onChangeText(value); await h.flush(); save(h); await h.flush();
        expect(h.requests).toHaveLength(0);
      }
      field(h, quantityLabel).onChangeText('١/٢'); await h.flush(); save(h); await h.flush();
      expect(h.requests[0].payload.schedule.doseQuantity).toBe(0.5);
    } finally { h.unmount(); }
  });
  it('requires a unit decision after a form change without silently changing the amount', async () => {
    const h = setup();
    try {
      field(h, 'medication.name').onChangeText('Synthetic syrup');
      field(h, quantityLabel).onChangeText('6');
      h.find('Picker', (p: any) => p.label === 'medication.form').onChange('syrup'); await h.flush();
      expect(h.find('DoseUnitPicker').value).toBe('tablet');
      save(h); await h.flush(); expect(h.requests).toHaveLength(0);
      h.find('DoseUnitPicker').onChange('ml'); await h.flush(); save(h); await h.flush();
      expect(h.requests[0].payload).toMatchObject({ form: 'syrup', schedule: { doseQuantity: 6, doseUnit: 'ml' } });
    } finally { h.unmount(); }
  });
});
