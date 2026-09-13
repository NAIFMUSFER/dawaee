/** Real editor and hook; controlled I/O, not a native renderer. */
const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
const { createHarness } = require('./profile-screen-harness.cjs');
const screen = path.resolve(__dirname, '../app/medication/edit.tsx');
const hook = path.resolve(__dirname, '../src/hooks/useRequestScope.ts');

function setup(signedIn = true, edit = false) {
  const app = {
    user: signedIn ? { id: 'synthetic-account' } : null,
    activeProfile: signedIn ? { id: 'A', timezone: 'Asia/Riyadh', isSelf: true, permissions: [] } : null,
  };
  const h = createHarness(screen, hook, {}, {
    'expo-router': { Redirect: 'Redirect', router: { back() {}, replace() {} } },
    '@/state/app-store': { useApp: () => app },
    '@/navigation/private-navigation': {
      getMedicationEditRouteIntent: (userId, patientProfileId) => edit
        && userId === 'synthetic-account' && patientProfileId === 'A'
        ? { userId, patientProfileId, medicationId: 'synthetic-medication' } : null,
      setMedicationDetailRouteIntent() {}, setMedicationScheduleRouteIntent() {},
    },
    '@/components/DateField': {
      DateField: 'DateField', todayLocalDate: () => '2026-09-13',
      isValidLocalDate: (value) => /^\d{4}-\d{2}-\d{2}$/.test(value),
    },
    '@dawaee/shared': {
      FOOD_INSTRUCTIONS: ['no_preference'], MEDICATION_FORMS: ['tablet'], STRENGTH_UNITS: ['mg'],
    },
  });
  return { h, app };
}

function expectSignIn(h) {
  assert.equal(h.find('Redirect')?.href, '/sign-in');
  assert.equal(h.find('Field'), null, 'Signed-out editor must not accept an unsavable draft');
  assert.equal(h.find('Button', p => p.testID === 'save-medication'), null);
}

function answer(request) {
  request.completed = true;
  request.resolve({ medication: {
    id: 'synthetic-medication', patientProfileId: 'A', name: 'SYNTHETIC AUTH MEDICATION',
    brandName: null, genericName: null, form: 'tablet', strengthValue: null, strengthUnit: null,
    manufacturer: 'SYNTHETIC Maker', barcode: '0012345678905', instructions: null,
    doctorInstructions: null, foodInstruction: 'no_preference', notes: null,
    startDate: '2026-09-13', endDate: null, expiryDate: null,
  } });
}

test('signed-out direct entry redirects before rendering clinical inputs or sending requests', () => {
  const { h } = setup(false);
  try { expectSignIn(h); assert.equal(h.requests.length, 0); }
  finally { h.unmount(); }
});

test('logout removes the editor in the first frame and a late load cannot restore it', async () => {
  const { h, app } = setup(true, true);
  try {
    assert.equal(h.requests.length, 1);
    app.user = null;
    app.activeProfile = null;
    h.render(false);
    expectSignIn(h);
    answer(h.requests[0]);
    await h.flush();
    expectSignIn(h);
    assert.ok(!h.text().includes('SYNTHETIC AUTH MEDICATION'));
    assert.equal(h.requests.length, 1);
  } finally { h.unmount(); }
});

test('authenticated create mode remains usable without a medication intent', async () => {
  const { h } = setup(true);
  try {
    await h.flush();
    assert.equal(h.find('Redirect'), null);
    assert.ok(h.find('Button', p => p.testID === 'save-medication'));
    assert.equal(h.find('Field', p => p.label === 'medication.name').value, '');
    assert.equal(h.requests.length, 0);
  } finally { h.unmount(); }
});

test('authenticated edit mode still reads its private intent and loads metadata', async () => {
  const { h } = setup(true, true);
  try {
    assert.equal(h.requests.length, 1);
    answer(h.requests[0]);
    await h.flush();
    assert.equal(h.find('Redirect'), null);
    assert.equal(h.find('Field', p => p.label === 'medication.name').value, 'SYNTHETIC AUTH MEDICATION');
    assert.equal(h.find('Field', p => p.label === 'medication.manufacturer').value, 'SYNTHETIC Maker');
    assert.equal(h.find('Field', p => p.label === 'medication.barcode').value, '0012345678905');
  } finally { h.unmount(); }
});
