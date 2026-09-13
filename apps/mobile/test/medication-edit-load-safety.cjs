/** Actual medication editor + request hook with controlled I/O, not browser/native E2E. */
const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
const { createHarness, deferred, NetworkError, ApiError } = require('./profile-screen-harness.cjs');

const screen = path.resolve(__dirname, '../app/medication/edit.tsx');
const hook = path.resolve(__dirname, '../src/hooks/useRequestScope.ts');
const medicationId = 'synthetic-load-medication';

function medication() {
  return {
    id: medicationId,
    patientProfileId: 'A',
    name: 'HYDRATED MEDICATION',
    brandName: 'Loaded brand',
    genericName: 'Loaded generic',
    form: 'tablet',
    strengthValue: 10,
    strengthUnit: 'mg',
    manufacturer: 'Loaded maker',
    barcode: '0012345678905',
    instructions: 'Loaded instructions',
    doctorInstructions: 'Loaded doctor instructions',
    foodInstruction: 'no_preference',
    notes: 'Loaded notes',
    startDate: '2026-09-01',
    endDate: null,
    expiryDate: '2027-09-01',
  };
}

function setup(edit = true) {
  const gate = deferred();
  const writes = [];
  const navigations = [];
  let reads = 0;
  const h = createHarness(screen, hook, {}, {
    'expo-router': {
      Redirect: 'Redirect',
      router: {
        back() {},
        replace(route) { navigations.push(route); },
      },
    },
    '@/navigation/private-navigation': {
      getMedicationEditRouteIntent: (userId, patientProfileId) => edit
        && userId === 'synthetic-account' && patientProfileId === 'A'
        ? { userId, patientProfileId, medicationId }
        : null,
      setMedicationDetailRouteIntent() {},
      setMedicationScheduleRouteIntent() {},
    },
    '@/components/DateField': {
      DateField: 'DateField',
      todayLocalDate: () => '2026-09-13',
      isValidLocalDate: (value) => /^\d{4}-\d{2}-\d{2}$/.test(value),
    },
    '@/api/client': {
      NetworkError,
      ApiError,
      api: {
        get: async () => {
          reads += 1;
          return gate.promise;
        },
        patch: async (route, payload) => {
          writes.push({ method: 'PATCH', route, payload: JSON.parse(JSON.stringify(payload)) });
          return {};
        },
        post: async (route, payload) => {
          writes.push({ method: 'POST', route, payload: JSON.parse(JSON.stringify(payload)) });
          return { medication: { id: 'created-medication' } };
        },
      },
    },
    '@dawaee/shared': {
      FOOD_INSTRUCTIONS: ['no_preference'],
      MEDICATION_FORMS: ['tablet'],
      STRENGTH_UNITS: ['mg'],
    },
  });
  return { h, gate, writes, navigations, reads: () => reads };
}

function expectBlockedEdit(h, title) {
  assert.equal(h.find('Field'), null, 'A failed edit hydration must not expose a default clinical draft');
  assert.equal(h.find('Button', p => p.testID === 'save-medication'), null,
    'A failed edit hydration must not expose Save');
  const banner = h.find('Banner', p => p.tone === 'danger');
  assert.ok(banner, 'Load failure must stay visible');
  assert.equal(banner.title, title);
}

test('network failure while loading an existing medication fails closed before any editable draft', async () => {
  const ctx = setup(true);
  try {
    assert.equal(ctx.reads(), 1);
    ctx.gate.reject(new NetworkError('controlled offline'));
    await ctx.h.flush();
    expectBlockedEdit(ctx.h, 'notifications.offlineBanner');
    assert.deepEqual(ctx.writes, []);
  } finally { ctx.h.unmount(); }
});

test('non-network failure while loading an existing medication also fails closed', async () => {
  const ctx = setup(true);
  try {
    ctx.gate.reject(new Error('controlled server failure'));
    await ctx.h.flush();
    expectBlockedEdit(ctx.h, 'error.internal_error');
    assert.deepEqual(ctx.writes, []);
  } finally { ctx.h.unmount(); }
});

test('successful edit hydration preserves loaded metadata and allows an intentional PATCH', async () => {
  const ctx = setup(true);
  try {
    ctx.gate.resolve({ medication: medication() });
    await ctx.h.flush();
    assert.equal(ctx.h.find('Field', p => p.label === 'medication.name').value, 'HYDRATED MEDICATION');
    assert.equal(ctx.h.find('Field', p => p.label === 'medication.manufacturer').value, 'Loaded maker');
    assert.equal(ctx.h.find('Field', p => p.label === 'medication.barcode').value, '0012345678905');

    const name = ctx.h.find('Field', p => p.label === 'medication.name');
    name.onChangeText('HYDRATED MEDICATION UPDATED');
    await ctx.h.flush();
    const save = ctx.h.find('Button', p => p.testID === 'save-medication');
    assert.ok(save);
    save.onPress();
    await ctx.h.flush();

    assert.equal(ctx.writes.length, 1);
    assert.equal(ctx.writes[0].method, 'PATCH');
    assert.equal(ctx.writes[0].route, `/v1/medications/${medicationId}`);
    assert.equal(ctx.writes[0].payload.name, 'HYDRATED MEDICATION UPDATED');
    assert.equal(ctx.writes[0].payload.manufacturer, 'Loaded maker');
    assert.equal(ctx.writes[0].payload.barcode, '0012345678905');
    assert.deepEqual(ctx.navigations, ['/medication/detail']);
  } finally { ctx.h.unmount(); }
});

test('explicit create mode remains usable without a medication GET', async () => {
  const ctx = setup(false);
  try {
    await ctx.h.flush();
    assert.equal(ctx.reads(), 0);
    const name = ctx.h.find('Field', p => p.label === 'medication.name');
    assert.ok(name);
    name.onChangeText('NEW MEDICATION');
    await ctx.h.flush();
    const save = ctx.h.find('Button', p => p.testID === 'save-medication');
    assert.ok(save);
    save.onPress();
    await ctx.h.flush();

    assert.equal(ctx.writes.length, 1);
    assert.equal(ctx.writes[0].method, 'POST');
    assert.equal(ctx.writes[0].route, '/v1/medications');
    assert.equal(ctx.writes[0].payload.name, 'NEW MEDICATION');
    assert.deepEqual(ctx.navigations, ['/medication/schedule']);
  } finally { ctx.h.unmount(); }
});
