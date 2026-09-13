/** Actual schedule screen + request hook with controlled I/O; not browser/native E2E. */
const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
const { createHarness, NetworkError, ApiError } = require('./profile-screen-harness.cjs');

const screen = path.resolve(__dirname, '../app/medication/schedule.tsx');
const hook = path.resolve(__dirname, '../src/hooks/useRequestScope.ts');
const medicationId = 'synthetic-optional-constraint-medication';
const scheduleId = 'synthetic-optional-constraint-schedule';

function baseRule(kind) {
  if (kind === 'interval') return { kind, everyHours: 8, anchorTime: '08:00' };
  if (kind === 'as_needed') return { kind };
  throw new Error(`unsupported kind ${kind}`);
}

async function setup(kind, mode = 'create') {
  const writes = [];
  const navigations = [];
  const reads = [];
  const record = async (method, route, payload) => {
    writes.push({ method, route, payload: JSON.parse(JSON.stringify(payload)) });
    return {};
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
      DateField: 'DateField',
      todayLocalDate: () => '2026-09-13',
      isValidLocalDate: (value) => /^\d{4}-\d{2}-\d{2}$/.test(value),
    },
    '@/api/client': { NetworkError, ApiError, api: {
      get: async (route) => {
        reads.push(route);
        return { schedules: [{
          id: scheduleId,
          rule: baseRule(kind),
          doseQuantity: 1,
          doseUnit: 'tablet',
          startDate: '2026-09-01',
          endDate: null,
          active: true,
        }] };
      },
      post: (route, payload) => record('POST', route, payload),
      patch: (route, payload) => record('PATCH', route, payload),
    } },
    '@dawaee/shared': {
      DOSE_UNITS: ['tablet'],
      SCHEDULE_RULE_KINDS: ['fixed_times', 'interval', 'days_of_week', 'cycle', 'as_needed'],
    },
  });

  await h.flush();
  if (mode === 'create') {
    assert.equal(reads.length, 0);
    const picker = h.find('Picker', p => p.label === 'schedule.kind');
    assert.ok(picker);
    picker.onChange(kind);
    await h.flush();
  } else {
    assert.equal(reads.length, 1);
    assert.equal(reads[0], `/v1/medications/${medicationId}`);
  }

  const field = (label) => {
    const input = h.find('Field', p => p.label === label);
    assert.ok(input, `missing field ${label}`);
    return input;
  };
  const set = async (label, value) => {
    field(label).onChangeText(value);
    await h.flush();
  };
  const save = async () => {
    const button = h.find('Button', p => p.testID === 'save-schedule');
    assert.ok(button);
    button.onPress();
    await h.flush();
  };
  return { h, writes, navigations, field, set, save };
}

async function expectRejected(ctx) {
  await ctx.save();
  assert.equal(ctx.writes.length, 0, 'invalid optional constraints must not be omitted and sent as a different rule');
  assert.deepEqual(ctx.navigations, []);
  assert.ok(ctx.h.find('Banner', p => p.tone === 'warning'), 'invalid draft should remain visible with validation feedback');
}

for (const mode of ['create', 'edit']) {
  test(`interval ${mode}: a from-only active window is rejected instead of silently omitted`, async () => {
    const ctx = await setup('interval', mode);
    try {
      await ctx.set('schedule.activeFrom', '08:00');
      await expectRejected(ctx);
      assert.equal(ctx.field('schedule.activeFrom').value, '08:00');
      assert.equal(ctx.field('schedule.activeUntil').value, '');
    } finally { ctx.h.unmount(); }
  });

  test(`interval ${mode}: an until-only active window is rejected instead of silently omitted`, async () => {
    const ctx = await setup('interval', mode);
    try {
      await ctx.set('schedule.activeUntil', '18:00');
      await expectRejected(ctx);
    } finally { ctx.h.unmount(); }
  });

  test(`interval ${mode}: an invalid bound cannot erase an otherwise entered active window`, async () => {
    const ctx = await setup('interval', mode);
    try {
      await ctx.set('schedule.activeFrom', '08:00');
      await ctx.set('schedule.activeUntil', '12:60');
      await expectRejected(ctx);
      assert.equal(ctx.field('schedule.activeUntil').value, '12:60');
    } finally { ctx.h.unmount(); }
  });

  test(`as_needed ${mode}: maxPerDay outside 1..24 is rejected instead of omitted`, async () => {
    for (const invalid of ['0', '25']) {
      const ctx = await setup('as_needed', mode);
      try {
        await ctx.set('schedule.maxPerDay', invalid);
        await expectRejected(ctx);
        assert.equal(ctx.field('schedule.maxPerDay').value, invalid);
      } finally { ctx.h.unmount(); }
    }
  });

  test(`as_needed ${mode}: minHoursBetween outside 0..48 is rejected instead of omitted or sent to server`, async () => {
    for (const invalid of ['-1', '49']) {
      const ctx = await setup('as_needed', mode);
      try {
        await ctx.set('schedule.minHoursBetween', invalid);
        await expectRejected(ctx);
        assert.equal(ctx.field('schedule.minHoursBetween').value, invalid);
      } finally { ctx.h.unmount(); }
    }
  });
}

test('interval: fully blank optional window remains valid and omitted', async () => {
  const ctx = await setup('interval');
  try {
    await ctx.save();
    assert.equal(ctx.writes.length, 1);
    assert.deepEqual(ctx.writes[0].payload.rule, { kind: 'interval', everyHours: 8, anchorTime: '08:00' });
  } finally { ctx.h.unmount(); }
});

test('interval: complete valid optional window is preserved exactly', async () => {
  const ctx = await setup('interval');
  try {
    await ctx.set('schedule.activeFrom', '08:00');
    await ctx.set('schedule.activeUntil', '18:00');
    await ctx.save();
    assert.equal(ctx.writes.length, 1);
    assert.deepEqual(ctx.writes[0].payload.rule, {
      kind: 'interval', everyHours: 8, anchorTime: '08:00', activeFrom: '08:00', activeUntil: '18:00',
    });
  } finally { ctx.h.unmount(); }
});

test('as_needed: fully blank optional limits remain valid and omitted', async () => {
  const ctx = await setup('as_needed');
  try {
    await ctx.save();
    assert.equal(ctx.writes.length, 1);
    assert.deepEqual(ctx.writes[0].payload.rule, { kind: 'as_needed' });
  } finally { ctx.h.unmount(); }
});

test('as_needed: contract boundary values 24 and 48 are preserved', async () => {
  const ctx = await setup('as_needed', 'edit');
  try {
    await ctx.set('schedule.maxPerDay', '24');
    await ctx.set('schedule.minHoursBetween', '48');
    await ctx.save();
    assert.equal(ctx.writes.length, 1);
    assert.equal(ctx.writes[0].method, 'PATCH');
    assert.equal(ctx.writes[0].route, `/v1/schedules/${scheduleId}`);
    assert.deepEqual(ctx.writes[0].payload.rule, { kind: 'as_needed', maxPerDay: 24, minHoursBetween: 48 });
  } finally { ctx.h.unmount(); }
});
