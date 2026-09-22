/** Actual schedule TSX and request hook with controlled I/O, not native/browser E2E. */
const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
const { createHarness, deferred, NetworkError, ApiError } = require('./profile-screen-harness.cjs');

const screen = path.resolve(__dirname, '../app/medication/schedule.tsx');
const hook = path.resolve(__dirname, '../src/hooks/useRequestScope.ts');
const medicationId = 'synthetic-load-medication';
const scheduleId = 'synthetic-load-schedule';
const fixture = (overrides = {}) => ({
  id: scheduleId, rule: { kind: 'fixed_times', times: ['06:13', '19:47'] },
  ruleKind: 'fixed_times', doseQuantity: 2, doseUnit: 'capsule', timezone: 'Asia/Riyadh',
  startDate: '2026-09-01', endDate: '2026-10-01', missedAfterMinutes: 120,
  lateAfterMinutes: 30, active: true, ...overrides,
});
const plain = (value) => JSON.parse(JSON.stringify(value));

function setup({ mode = 'edit', selected = scheduleId, intent = true, mutation } = {}) {
  const reads = [], writes = [], navigations = [];
  const write = async (method, route, payload) => {
    writes.push({ method, route, payload: plain(payload) });
    return mutation ? mutation(writes.length) : {};
  };
  const theme = { colors: new Proxy({}, { get: () => '#000' }),
    spacing: new Proxy({}, { get: () => 4 }), radius: { xl: 8 } };
  const h = createHarness(screen, hook, {}, {
    '@/hooks/useTheme': { useTheme: () => theme },
    'expo-router': { router: { back() {}, replace: (route) => { navigations.push(route); } } },
    '@/navigation/private-navigation': {
      getMedicationScheduleRouteIntent: (userId, patientProfileId) => intent
        && userId === 'synthetic-account' && patientProfileId === 'A'
        ? { userId, patientProfileId, medicationId, mode, scheduleId: selected } : null,
      setMedicationDetailRouteIntent() {},
    },
    '@/components/DateField': {
      DateField: 'DateField', todayLocalDate: () => '2026-09-13',
      isValidLocalDate: (value) => /^\d{4}-\d{2}-\d{2}$/.test(value),
    },
    '@/api/client': {
      NetworkError, ApiError, api: {
        get: (route) => { const gate = deferred(); reads.push({ route, ...gate }); return gate.promise; },
        patch: (route, payload) => write('PATCH', route, payload),
        post: (route, payload) => write('POST', route, payload),
      },
    },
    '@dawaee/shared': {
      DOSE_UNITS: ['tablet', 'capsule'],
      SCHEDULE_RULE_KINDS: ['fixed_times', 'interval', 'days_of_week', 'cycle', 'as_needed'],
    },
  });
  const saveButton = () => h.find('Button', p => p.testID === 'save-schedule');
  const load = async (schedules = [fixture()]) => {
    assert.equal(reads.length, 1);
    assert.equal(reads[0].route, `/v1/medications/${medicationId}`);
    reads[0].resolve({ schedules });
    await h.flush();
  };
  const save = async () => {
    assert.ok(saveButton(), 'A successfully loaded/created schedule must remain savable');
    saveButton().onPress();
    await h.flush();
  };
  return { h, reads, writes, navigations, saveButton, load, save };
}

async function assertBlocked(ctx, message) {
  // Exercise any mistakenly offered Save against the controlled API boundary.
  // This records the old default PATCH/POST, without touching any real server.
  ctx.saveButton()?.onPress();
  await ctx.h.flush();
  assert.equal(ctx.writes.length, 0, 'An unresolved edit must send neither PATCH nor POST');
  assert.equal(ctx.saveButton(), null, 'Do not offer Save for an unloaded edit');
  assert.equal(ctx.h.find('Field'), null, 'Do not present fallback dose/time inputs as an existing schedule');
  assert.ok(ctx.h.find('Banner', p => p.title === message), 'Explain the load failure');
  assert.ok(ctx.h.find('Button', p => p.label === 'common.back'), 'Keep a safe exit');
  assert.deepEqual(ctx.navigations, []);
}

for (const [label, selected, error, message] of [
  ['network failure with explicit selection', scheduleId, new NetworkError(), 'notifications.offlineBanner'],
  ['API failure with explicit selection', scheduleId, new ApiError('internal_error'), 'error.internal_error'],
  ['network failure without explicit selection', null, new NetworkError(), 'notifications.offlineBanner'],
]) {
  test(`edit stays blocked after ${label}`, async () => {
    const ctx = setup({ selected });
    try {
      assert.equal(ctx.reads.length, 1);
      assert.equal(ctx.saveButton(), null);
      ctx.reads[0].reject(error);
      await ctx.h.flush();
      await assertBlocked(ctx, message);
    } finally { ctx.h.unmount(); }
  });
}

test('an absent selected schedule cannot be replaced by defaults or a different schedule', async () => {
  const ctx = setup();
  try {
    await ctx.load([fixture({ id: 'synthetic-other-schedule' })]);
    await assertBlocked(ctx, 'error.not_found');
  } finally { ctx.h.unmount(); }
});

test('an empty schedule list in edit mode must not fall through to creation', async () => {
  const ctx = setup({ selected: null });
  try {
    await ctx.load([]);
    await assertBlocked(ctx, 'error.not_found');
  } finally { ctx.h.unmount(); }
});

test('successful explicit selection preserves loaded timing and patches only its schedule', async () => {
  const ctx = setup();
  try {
    await ctx.load();
    assert.equal(ctx.h.find('Field', p => p.label === 'schedule.times 1').value, '06:13');
    const quantity = ctx.h.find('Field', p => p.label === 'schedule.doseQuantity');
    assert.equal(quantity.value, '2');
    quantity.onChangeText('3');
    await ctx.h.flush();
    await ctx.save();
    assert.deepEqual(ctx.writes, [{ method: 'PATCH', route: `/v1/schedules/${scheduleId}`, payload: {
      rule: { kind: 'fixed_times', times: ['06:13', '19:47'] }, doseQuantity: 3,
      doseUnit: 'capsule', startDate: '2026-09-01', endDate: '2026-10-01',
    } }]);
    assert.deepEqual(ctx.navigations, ['/medication/detail']);
  } finally { ctx.h.unmount(); }
});

test('edit without an explicit selection still loads and patches the active schedule', async () => {
  const ctx = setup({ selected: null });
  try {
    await ctx.load([fixture({ id: 'synthetic-inactive', active: false }), fixture()]);
    await ctx.save();
    assert.equal(ctx.writes.length, 1);
    assert.equal(ctx.writes[0].method, 'PATCH');
    assert.equal(ctx.writes[0].route, `/v1/schedules/${scheduleId}`);
  } finally { ctx.h.unmount(); }
});

test('explicit create mode still creates a schedule without an edit-load request', async () => {
  const ctx = setup({ mode: 'create', selected: null });
  try {
    assert.equal(ctx.reads.length, 0);
    await ctx.save();
    assert.equal(ctx.writes.length, 1);
    assert.equal(ctx.writes[0].method, 'POST');
    assert.equal(ctx.writes[0].route, `/v1/medications/${medicationId}/schedules`);
    assert.equal(ctx.writes[0].payload.timezone, 'Asia/Riyadh');
    assert.deepEqual(ctx.navigations, ['/medication/detail']);
  } finally { ctx.h.unmount(); }
});

test('a late load after switching patient cannot enable a default or previous-patient form', async () => {
  const ctx = setup();
  try {
    ctx.h.switchProfile('B', false);
    assert.equal(ctx.h.find('Field'), null);
    ctx.reads[0].resolve({ schedules: [fixture()] });
    await ctx.h.flush();
    await assertBlocked(ctx, 'error.not_found');
    assert.ok(!ctx.h.text().includes('06:13'));
    assert.equal(ctx.reads.length, 1);
  } finally { ctx.h.unmount(); }
});

test('a missing private route intent stays closed without loading or saving', async () => {
  const ctx = setup({ intent: false });
  try {
    await ctx.h.flush();
    await assertBlocked(ctx, 'error.not_found');
    assert.equal(ctx.reads.length, 0);
  } finally { ctx.h.unmount(); }
});

test('high-risk confirmation remains explicit after a successful edit load', async () => {
  const error = new ApiError('high_risk_confirmation_required');
  error.meta = { changes: ['dose_quantity'], before: { doseQuantity: 2 } };
  const ctx = setup({ mutation: (attempt) => { if (attempt === 1) throw error; return {}; } });
  try {
    await ctx.load();
    ctx.h.find('Field', p => p.label === 'schedule.doseQuantity').onChangeText('3');
    await ctx.h.flush();
    await ctx.save();
    assert.equal(ctx.writes.length, 1);
    assert.equal(ctx.writes[0].payload.confirmHighRiskChange, undefined);
    assert.deepEqual(ctx.navigations, []);
    const confirm = ctx.h.find('Button', p => p.label === 'medication.confirmChange');
    assert.ok(confirm);
    confirm.onPress();
    await ctx.h.flush();
    assert.equal(ctx.writes.length, 2);
    assert.equal(ctx.writes[1].payload.confirmHighRiskChange, true);
    assert.equal(ctx.writes[1].method, 'PATCH');
    assert.deepEqual(ctx.navigations, ['/medication/detail']);
  } finally { ctx.h.unmount(); }
});

test('a mutation failure does not discard a successfully loaded draft or disable retry', async () => {
  const ctx = setup({ mutation: (attempt) => { if (attempt === 1) throw new NetworkError(); return {}; } });
  try {
    await ctx.load();
    await ctx.save();
    assert.ok(ctx.h.find('Banner', p => p.title === 'notifications.offlineBanner'));
    assert.equal(ctx.h.find('Field', p => p.label === 'schedule.times 1').value, '06:13');
    await ctx.save();
    assert.equal(ctx.writes.length, 2);
    assert.deepEqual(ctx.writes[1], ctx.writes[0]);
    assert.deepEqual(ctx.navigations, ['/medication/detail']);
  } finally { ctx.h.unmount(); }
});


for (const [label, dates] of [
  ['invalid start', { startDate: 'bad-date' }],
  ['missing start', { startDate: '' }],
  ['invalid end', { endDate: 'bad-date' }],
  ['reversed range', { startDate: '2026-10-02', endDate: '2026-10-01' }],
]) {
  test(`${label} cannot silently replace clinical schedule dates`, async () => {
    const ctx = setup();
    try {
      await ctx.load([fixture(dates)]); await ctx.save();
      assert.equal(ctx.writes.length, 0);
      assert.deepEqual(ctx.navigations, []);
      assert.ok(ctx.h.text().includes('error.validation_failed'));
    } finally { ctx.h.unmount(); }
  });
}
