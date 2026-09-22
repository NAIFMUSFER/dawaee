/** Real schedule screen and request hook; controlled I/O, not browser/native E2E. */
const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
const { createHarness, NetworkError, ApiError } = require('./profile-screen-harness.cjs');

const screen = path.resolve(__dirname, '../app/medication/schedule.tsx');
const hook = path.resolve(__dirname, '../src/hooks/useRequestScope.ts');
const medicationId = 'synthetic-time-medication';
const scheduleId = 'synthetic-time-schedule';
const kinds = ['fixed_times', 'days_of_week', 'cycle'];

async function setup(kind, mode = 'create') {
  const writes = [], navigations = [], reads = [];
  const record = async (method, route, payload) => {
    writes.push({ method, route, payload: JSON.parse(JSON.stringify(payload)) });
    return {};
  };
  const rule = { kind, times: ['19:47', '06:13'],
    ...(kind === 'days_of_week' ? { weekdays: [0, 2] } : {}),
    ...(kind === 'cycle' ? { daysOn: 21, daysOff: 7, cycleAnchorDate: '2026-09-01' } : {}),
  };
  const h = createHarness(screen, hook, {}, {
    'expo-router': { router: { back() {}, replace: (route) => { navigations.push(route); } } },
    '@/navigation/private-navigation': {
      getMedicationScheduleRouteIntent: (userId, patientProfileId) =>
        userId === 'synthetic-account' && patientProfileId === 'A'
          ? { userId, patientProfileId, medicationId, mode, scheduleId: mode === 'edit' ? scheduleId : undefined }
          : null,
      setMedicationDetailRouteIntent() {},
    },
    '@/components/DateField': {
      DateField: 'DateField', todayLocalDate: () => '2026-09-13',
      isValidLocalDate: (value) => /^\d{4}-\d{2}-\d{2}$/.test(value),
    },
    '@/api/client': { NetworkError, ApiError, api: {
      get: async (route) => {
        reads.push(route);
        return { schedules: [{ id: scheduleId, rule, doseQuantity: 2, doseUnit: 'tablet',
          startDate: '2026-09-01', endDate: null, active: true }] };
      },
      post: (route, payload) => record('POST', route, payload),
      patch: (route, payload) => record('PATCH', route, payload),
    } },
    '@dawaee/shared': {
      DOSE_UNITS: ['tablet', 'ml'],
      SCHEDULE_RULE_KINDS: [...kinds, 'interval', 'as_needed'],
    },
  });
  const field = (index) => {
    const input = h.find('Field', p => p.label === `schedule.times ${index}`);
    assert.ok(input, `Missing time input ${index}`);
    return input;
  };
  const change = async (index, value) => { field(index).onChangeText(value); await h.flush(); };
  const selectKind = async (value) => {
    const picker = h.find('Picker', p => p.label === 'schedule.kind');
    assert.ok(picker);
    picker.onChange(value);
    await h.flush();
  };
  const save = async () => {
    const button = h.find('Button', p => p.testID === 'save-schedule');
    assert.ok(button, 'Keep the form available for correction');
    button.onPress();
    await h.flush();
  };
  await h.flush();
  if (mode === 'create') {
    assert.equal(reads.length, 0);
    await selectKind(kind);
    h.find('Button', p => p.label === 'schedule.addTime').onPress();
    await h.flush();
    await change(1, '19:47');
    await change(2, '06:13');
  } else {
    assert.equal(reads.length, 1);
    assert.equal(reads[0], `/v1/medications/${medicationId}`);
    assert.equal(field(1).value, '19:47', 'Edit must first hydrate its real schedule');
  }
  return { h, writes, navigations, field, change, selectKind, save };
}

for (const mode of ['create', 'edit']) {
  test(`${mode}: changing the dose unit requires a new quantity and preserves the schedule`, async () => {
    const ctx = await setup('fixed_times', mode);
    const quantity = () => ctx.h.find('Field', p => p.label === 'schedule.doseQuantity');
    const unit = () => ctx.h.find('Picker', p => p.label === 'schedule.doseUnit');
    try {
      quantity().onChangeText('6'); await ctx.h.flush();
      unit().onChange('tablet'); await ctx.h.flush();
      assert.equal(quantity().value, '6');
      unit().onChange('ml'); await ctx.h.flush();
      assert.equal(quantity().value, '');
      await ctx.save(); assert.equal(ctx.writes.length, 0);
      assert.equal(ctx.field(1).value, '19:47');
      unit().onChange('tablet'); await ctx.h.flush();
      assert.equal(quantity().value, '');
      quantity().onChangeText('3'); await ctx.h.flush();
      await ctx.save();
      assert.equal(ctx.writes.length, 1);
      assert.equal(ctx.writes[0].method, mode === 'edit' ? 'PATCH' : 'POST');
      assert.equal(ctx.writes[0].payload.doseQuantity, 3);
      assert.equal(ctx.writes[0].payload.doseUnit, 'tablet');
      assert.deepEqual(ctx.writes[0].payload.rule.times, ['06:13', '19:47']);
    } finally { ctx.h.unmount(); }
  });
}
