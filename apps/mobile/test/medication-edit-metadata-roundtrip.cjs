/** Executes the real editor and request-scope hook with controlled I/O.
 * This is a screen-boundary regression, not native/browser E2E or a live API test.
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
const { createHarness, NetworkError, ApiError } = require('./profile-screen-harness.cjs');

const screen = path.resolve(__dirname, '../app/medication/edit.tsx');
const hook = path.resolve(__dirname, '../src/hooks/useRequestScope.ts');
const medicationId = 'synthetic-metadata-medication';
const manufacturer = 'SYNTHETIC Manufacturer';
const barcode = '0012345678905';

function fixture(overrides = {}) {
  return {
    id: medicationId, patientProfileId: 'A', name: 'SYNTHETIC Metadata Medicine',
    brandName: null, genericName: null, form: 'tablet', strengthValue: null,
    strengthUnit: null, manufacturer, barcode, instructions: null,
    doctorInstructions: null, foodInstruction: 'no_preference', notes: 'Original note',
    startDate: '2026-09-01', endDate: null, expiryDate: null, ...overrides,
  };
}

function setup(metadata = {}) {
  const writes = [];
  const navigations = [];
  let reads = 0;
  const h = createHarness(screen, hook, {}, {
    'expo-router': {
      router: { back: () => undefined, replace: (route) => { navigations.push(route); } },
    },
    '@/navigation/private-navigation': {
      getMedicationEditRouteIntent: (userId, patientProfileId) =>
        userId === 'synthetic-account' && patientProfileId === 'A'
          ? { userId, patientProfileId, medicationId } : null,
      setMedicationDetailRouteIntent: () => undefined,
      setMedicationScheduleRouteIntent: () => undefined,
    },
    '@/components/DateField': {
      DateField: 'DateField',
      isValidLocalDate: (value) => /^\d{4}-\d{2}-\d{2}$/.test(value),
      todayLocalDate: () => '2026-09-13',
    },
    '@/api/client': {
      NetworkError, ApiError,
      api: {
        get: async () => { reads++; return { medication: fixture(metadata) }; },
        patch: async (route, payload) => { writes.push({ route, payload }); return {}; },
        post: async () => { throw new Error('Unexpected medication creation in edit mode'); },
      },
    },
    '@dawaee/shared': {
      FOOD_INSTRUCTIONS: ['no_preference'], MEDICATION_FORMS: ['tablet'], STRENGTH_UNITS: ['mg'],
    },
  });
  const field = (key) => {
    const found = h.find('Field', (props) => props.label === `medication.${key}`);
    assert.ok(found, `Missing ${key} input`);
    return found;
  };
  const load = async () => {
    await h.flush();
    assert.equal(reads, 1);
    assert.equal(field('name').value, 'SYNTHETIC Metadata Medicine');
  };
  const save = async () => {
    const button = h.find('Button', (props) => props.testID === 'save-medication');
    assert.ok(button, 'Missing save button');
    button.onPress();
    await h.flush();
    assert.equal(writes.length, 1, 'Must edit exactly once, not create or silently fail');
    assert.equal(writes[0].route, `/v1/medications/${medicationId}`);
    assert.deepEqual(navigations, ['/medication/detail']);
    return writes[0].payload;
  };
  return { h, field, load, save };
}

test('existing manufacturer and barcode populate their edit inputs', async () => {
  const { h, field, load } = setup();
  try {
    await load();
    assert.deepEqual({ manufacturer: field('manufacturer').value, barcode: field('barcode').value },
      { manufacturer, barcode });
  } finally { h.unmount(); }
});

test('changing only notes preserves existing metadata in the PATCH payload', async () => {
  const { h, field, load, save } = setup();
  try {
    await load();
    field('notes').onChangeText('Updated synthetic note');
    await h.flush();
    const payload = await save();
    assert.equal(payload.notes, 'Updated synthetic note');
    assert.deepEqual({ manufacturer: payload.manufacturer, barcode: payload.barcode },
      { manufacturer, barcode });
  } finally { h.unmount(); }
});

test('explicit metadata edits are saved and barcode leading zeros are retained', async () => {
  const { h, field, load, save } = setup();
  try {
    await load();
    field('manufacturer').onChangeText('SYNTHETIC Replacement');
    field('barcode').onChangeText('0009876543210');
    await h.flush();
    const payload = await save();
    assert.equal(payload.manufacturer, 'SYNTHETIC Replacement');
    assert.equal(payload.barcode, '0009876543210');
  } finally { h.unmount(); }
});

test('explicit clearing retains nullable PATCH semantics', async () => {
  const { h, field, load, save } = setup();
  try {
    await load();
    field('manufacturer').onChangeText('');
    field('barcode').onChangeText('');
    await h.flush();
    const payload = await save();
    assert.equal(payload.manufacturer, null);
    assert.equal(payload.barcode, null);
  } finally { h.unmount(); }
});

test('null metadata loads as empty inputs and round-trips as null', async () => {
  const { h, field, load, save } = setup({ manufacturer: null, barcode: null });
  try {
    await load();
    assert.equal(field('manufacturer').value, '');
    assert.equal(field('barcode').value, '');
    const payload = await save();
    assert.equal(payload.manufacturer, null);
    assert.equal(payload.barcode, null);
  } finally { h.unmount(); }
});
