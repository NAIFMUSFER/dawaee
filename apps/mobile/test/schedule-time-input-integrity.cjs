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
const previewKeys = ['schedule.previewFixed', 'schedule.previewWeekly', 'schedule.previewCycle'];

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
      DOSE_UNITS: ['tablet'],
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

async function rejected(ctx) {
  await ctx.save();
  assert.equal(ctx.writes.length, 0, 'Never send a silently filtered subset of the entered times');
  assert.deepEqual(ctx.navigations, []);
  assert.ok(ctx.h.find('Banner', p => p.tone === 'warning'), 'Explain the invalid draft');
  for (const key of previewKeys) assert.ok(!ctx.h.text().includes(key), 'Do not preview a partial schedule as valid');
}

for (const kind of kinds) {
  for (const mode of ['create', 'edit']) {
    for (const [label, invalid] of [['invalid hour', '25:00'], ['invalid minute', '12:60'], ['incomplete', '1'], ['blank', '']]) {
      test(`${kind} ${mode}: ${label} second time blocks the entire save`, async () => {
        const ctx = await setup(kind, mode);
        try {
          await ctx.change(2, invalid);
          await rejected(ctx);
          assert.equal(ctx.field(1).value, '19:47');
          assert.equal(ctx.field(2).value, invalid, 'Keep invalid input so the user can correct or remove it');
        } finally { ctx.h.unmount(); }
      });
    }
  }

  test(`${kind}: correcting an invalid time saves both sorted times without losing edit identity`, async () => {
    const ctx = await setup(kind, 'edit');
    try {
      await ctx.change(2, '25:00');
      await rejected(ctx);
      await ctx.change(2, '06:13');
      await ctx.save();
      assert.equal(ctx.writes.length, 1);
      assert.equal(ctx.writes[0].method, 'PATCH');
      assert.equal(ctx.writes[0].route, `/v1/schedules/${scheduleId}`);
      assert.deepEqual(ctx.writes[0].payload.rule.times, ['06:13', '19:47']);
      assert.equal(ctx.writes[0].payload.confirmHighRiskChange, undefined);
      assert.equal(ctx.h.find('Banner', p => p.tone === 'warning'), null);
      assert.deepEqual(ctx.navigations, ['/medication/detail']);
    } finally { ctx.h.unmount(); }
  });

  test(`${kind}: removing an unwanted time is an explicit action and preserves the remaining time`, async () => {
    const ctx = await setup(kind);
    try {
      await ctx.change(1, '25:00');
      // The first Remove button corresponds to the first time input.
      ctx.h.find('Button', p => p.label === 'common.remove').onPress();
      await ctx.h.flush();
      await ctx.save();
      assert.equal(ctx.writes.length, 1);
      assert.equal(ctx.writes[0].method, 'POST');
      assert.deepEqual(ctx.writes[0].payload.rule.times, ['06:13']);
    } finally { ctx.h.unmount(); }
  });

  test(`${kind}: valid boundary times are both retained and sorted on creation`, async () => {
    const ctx = await setup(kind);
    try {
      await ctx.change(1, '23:59');
      await ctx.change(2, '00:00');
      await ctx.save();
      assert.equal(ctx.writes.length, 1);
      assert.equal(ctx.writes[0].route, `/v1/medications/${medicationId}/schedules`);
      assert.deepEqual(ctx.writes[0].payload.rule.times, ['00:00', '23:59']);
      assert.equal(ctx.writes[0].payload.rule.kind, kind);
    } finally { ctx.h.unmount(); }
  });
}

for (const kind of ['interval', 'as_needed']) {
  test(`switching to ${kind} ignores hidden time-list fields, not its own rule`, async () => {
    const ctx = await setup('fixed_times');
    try {
      await ctx.change(2, '25:00');
      await ctx.selectKind(kind);
      assert.equal(ctx.h.find('Field', p => p.label === 'schedule.times 2'), null);
      await ctx.save();
      assert.equal(ctx.writes.length, 1);
      assert.equal(ctx.writes[0].payload.rule.kind, kind);
      assert.equal(ctx.writes[0].payload.rule.times, undefined);
    } finally { ctx.h.unmount(); }
  });
}
