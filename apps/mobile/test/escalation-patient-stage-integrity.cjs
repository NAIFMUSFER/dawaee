/** Actual escalation TSX + keyed request hook; controlled I/O, not native/browser E2E. */
const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
const { createHarness, NetworkError, ApiError } = require('./profile-screen-harness.cjs');

const screen = path.resolve(__dirname, '../app/caregiver/escalation.tsx');
const hook = path.resolve(__dirname, '../src/hooks/useRequestScope.ts');

const patient = (afterMinutes = 0) => ({ afterMinutes, target: 'patient', channels: ['push', 'local'] });
const caregiver = (afterMinutes = 30, target = 'primary_caregiver') => ({ afterMinutes, target, channels: ['push'] });

function all(tree, type, predicate = () => true) {
  const out = [];
  const walk = (value) => {
    if (!value || typeof value !== 'object') return;
    const actual = typeof value.type === 'function' ? value.type.name : value.type;
    if (actual === type && predicate(value.props)) out.push(value.props);
    for (const child of Object.values(value)) walk(child);
  };
  walk(tree);
  return out;
}

async function setup(stages) {
  const writes = [];
  const h = createHarness(screen, hook, { isSelf: true }, {
    'expo-router': { router: { back() {}, push() {} } },
    '@/api/client': { NetworkError, ApiError, api: {
      get: async (route) => {
        if (route === '/v1/escalation-policy') return {
          policy: { id: 'policy', medicationId: null, enabled: true, stages, quietHoursStart: null, quietHoursEnd: null },
          isDefault: false,
          defaultStages: [patient(0), patient(10), caregiver(30)],
        };
        if (route === '/v1/care-circle') return { caregivers: [], viewerRole: 'owner' };
        if (route === '/v1/today') return { today: [], next: null };
        throw new Error(`unexpected GET ${route}`);
      },
      put: async (route, body, query) => { writes.push({ route, body: structuredClone(body), query }); return {}; },
    } },
  });
  await h.flush();
  const advanced = h.find('Button', p => p.label === 'escalation.advanced');
  assert.ok(advanced);
  advanced.onPress();
  await h.flush();
  const buttons = (label) => all(h.tree, 'Button', p => p.label === label || p.label?.endsWith(label));
  const save = () => h.find('Button', p => p.testID === 'save-escalation');
  return { h, writes, buttons, save };
}

test('stage 0 non-patient targets are disabled and handler-guarded', async () => {
  const ctx = await setup([patient(0), caregiver(30)]);
  try {
    for (const label of ['escalation.targetPrimary', 'escalation.targetSecondary', 'escalation.targetAll']) {
      const first = ctx.buttons(label)[0];
      assert.ok(first);
      assert.equal(first.disabled, true);
      first.onPress();
      await ctx.h.flush();
    }
    assert.equal(ctx.save().disabled, true);
    assert.equal(ctx.writes.length, 0);
    assert.ok(ctx.h.text().includes('escalation.previewRemind'));
  } finally { ctx.h.unmount(); }
});

test('stage 0 cannot be moved later, even if its callback is invoked directly', async () => {
  const ctx = await setup([patient(0), caregiver(30)]);
  try {
    const downs = ctx.buttons('↓');
    assert.equal(downs[0].disabled, true);
    downs[0].onPress();
    await ctx.h.flush();
    assert.equal(ctx.save().disabled, true);
    assert.equal(ctx.writes.length, 0);
    assert.ok(ctx.h.text().includes('escalation.previewRemind'));
  } finally { ctx.h.unmount(); }
});

test('stage 1 cannot be moved earlier across the protected stage-0 boundary', async () => {
  const ctx = await setup([patient(0), caregiver(30)]);
  try {
    const ups = ctx.buttons('↑');
    assert.equal(ups[1].disabled, true);
    ups[1].onPress();
    await ctx.h.flush();
    assert.equal(ctx.save().disabled, true);
    assert.equal(ctx.writes.length, 0);
  } finally { ctx.h.unmount(); }
});

test('stage 0 cannot be removed through its guarded callback', async () => {
  const ctx = await setup([patient(0), caregiver(30)]);
  try {
    const removes = ctx.buttons('✕');
    assert.equal(removes[0].disabled, true);
    removes[0].onPress();
    await ctx.h.flush();
    assert.equal(ctx.save().disabled, true);
    assert.ok(ctx.h.text().includes('escalation.previewRemind'));
  } finally { ctx.h.unmount(); }
});

test('a legacy caregiver-first policy is fail-closed in the editor', async () => {
  const ctx = await setup([caregiver(0), patient(10)]);
  try {
    const quiet = ctx.h.find('Field', p => p.label === 'notify.quietFrom');
    assert.ok(quiet);
    quiet.onChangeText('22:00');
    await ctx.h.flush();
    assert.equal(ctx.save().disabled, true);
    ctx.save().onPress();
    await ctx.h.flush();
    assert.equal(ctx.writes.length, 0);
    assert.ok(ctx.h.find('Banner', p => p.tone === 'danger'));
  } finally { ctx.h.unmount(); }
});

test('a legacy caregiver-first policy can be corrected by choosing patient for stage 0', async () => {
  const ctx = await setup([caregiver(0), patient(10)]);
  try {
    const patientTargets = ctx.buttons('escalation.targetPatient');
    assert.equal(patientTargets[0].disabled, false);
    patientTargets[0].onPress();
    await ctx.h.flush();
    assert.equal(ctx.save().disabled, false);
    ctx.save().onPress();
    await ctx.h.flush();
    assert.equal(ctx.writes.length, 1);
    assert.equal(ctx.writes[0].body.stages[0].target, 'patient');
  } finally { ctx.h.unmount(); }
});

test('later stages remain editable and save without weakening stage 0', async () => {
  const ctx = await setup([patient(0), patient(10), caregiver(30)]);
  try {
    const primaryTargets = ctx.buttons('escalation.targetPrimary');
    assert.equal(primaryTargets[0].disabled, true);
    assert.equal(primaryTargets[1].disabled, false);
    primaryTargets[1].onPress();
    await ctx.h.flush();
    assert.equal(ctx.save().disabled, false);
    ctx.save().onPress();
    await ctx.h.flush();
    assert.equal(ctx.writes.length, 1);
    assert.equal(ctx.writes[0].body.stages[0].target, 'patient');
    assert.equal(ctx.writes[0].body.stages[1].target, 'primary_caregiver');
  } finally { ctx.h.unmount(); }
});

test('reordering among later stages remains available', async () => {
  const ctx = await setup([patient(0), patient(10), caregiver(30), caregiver(60, 'secondary_caregivers')]);
  try {
    const downs = ctx.buttons('↓');
    assert.equal(downs[2].disabled, false);
    downs[2].onPress();
    await ctx.h.flush();
    assert.equal(ctx.save().disabled, false);
    ctx.save().onPress();
    await ctx.h.flush();
    assert.equal(ctx.writes.length, 1);
    assert.equal(ctx.writes[0].body.stages[0].target, 'patient');
    assert.equal(ctx.writes[0].body.stages[2].target, 'secondary_caregivers');
    assert.equal(ctx.writes[0].body.stages[3].target, 'primary_caregiver');
  } finally { ctx.h.unmount(); }
});
