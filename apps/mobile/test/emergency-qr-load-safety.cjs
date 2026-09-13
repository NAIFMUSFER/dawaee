/** Actual QR TSX + keyed request hook; controlled I/O, not native/browser E2E. */
const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
const { createHarness, deferred, NetworkError, ApiError } = require('./profile-screen-harness.cjs');

const screen = path.resolve(__dirname, '../app/settings/emergency-qr.tsx');
const hook = path.resolve(__dirname, '../src/hooks/useRequestScope.ts');
const qrUrl = 'https://example.invalid/e#SYNTHETIC-ONE-TIME-CAPABILITY';
const writeLabels = ['emergency.qrEnable', 'emergency.qrRotate', 'emergency.qrDisable'];
const theme = {
  colors: new Proxy({}, { get: () => '#000' }),
  spacing: new Proxy({}, { get: () => 4 }),
  font: new Proxy({}, { get: () => 16 }),
  elderlyMode: false,
  lineHeight: value => value * 1.4,
};
const card = (qrEnabled = false, includeConditions = true) => ({
  includeMedications: false, includeAllergies: true, includeContacts: false,
  includeConditions, qrEnabled, qrViewCount: 2, qrLastViewedAt: null,
});

function setup() {
  const reads = [], writes = [], copied = [];
  const hosts = new Proxy({ Clipboard: { setString: value => copied.push(value) } }, {
    get: (target, key) => key === '__esModule' ? true : target[key] ?? String(key),
  });
  const h = createHarness(screen, hook, { isSelf: true }, {
    'react-native': hosts,
    'expo-router': { router: { back() {}, push() {} } },
    '@/hooks/useTheme': { useTheme: () => theme },
    '@/components/QrCode': { QrCode: 'QrCode', encodeQr: () => ({ ok: true }) },
    '@dawaee/shared': { MESSAGES: { en: { 'error.internal_error': 'Internal error' } } },
    '@/api/client': { NetworkError, ApiError, api: {
      get: (route, query) => {
        const gate = deferred(); reads.push({ route, query, ...gate }); return gate.promise;
      },
      post: (route, payload, query) => {
        const gate = deferred(); writes.push({ route, payload, query, ...gate }); return gate.promise;
      },
    } },
  });
  const button = label => h.find('Button', props => props.label === label);
  const press = async label => {
    const control = button(label);
    assert.ok(control, `missing ${label}`);
    assert.ok(!control.disabled && !control.loading, `${label} must be actionable`);
    control.onPress();
    await h.flush();
  };
  const hydrate = async (value = card(), index = reads.length - 1) => {
    assert.equal(reads[index].route, '/v1/emergency/card');
    reads[index].resolve({ card: value });
    await h.flush();
  };
  return { h, reads, writes, copied, button, press, hydrate };
}

async function noUnknownMutation(ctx) {
  const before = ctx.writes.length;
  // Exercise any action that the real screen currently offers, rather than
  // merely checking a source pattern or assuming the client would not tap it.
  for (const label of writeLabels) {
    const button = ctx.button(label);
    if (button && !button.disabled && !button.loading) {
      button.onPress();
      await ctx.h.flush();
    }
  }
  assert.equal(ctx.writes.length, before, 'unknown card state must not offer an enable/rotate/disable POST');
  assert.equal(ctx.h.find('SectionTitle', p => JSON.stringify(p.children).includes('emergency.qrDisabledState')), null,
    'a pending or failed GET is not evidence that the existing QR is disabled');
}

test('initial pending card GET cannot be mistaken for disabled QR or offer a write', async () => {
  const ctx = setup();
  try {
    assert.equal(ctx.reads.length, 1);
    assert.ok(ctx.h.find('Loading'));
    await noUnknownMutation(ctx);
  } finally { ctx.h.unmount(); }
});

for (const [label, error] of [
  ['network', () => new NetworkError('controlled offline')],
  ['API', () => new ApiError('internal_error')],
  ['unexpected', () => new Error('controlled failure')],
]) {
  test(`${label} initial GET failure blocks writes and provides explicit read-only retry`, async () => {
    const ctx = setup();
    try {
      ctx.reads[0].reject(error());
      await ctx.h.flush();
      await noUnknownMutation(ctx);
      assert.ok(ctx.h.find('Banner', p => p.tone === 'danger' || p.tone === 'warning'));
      await ctx.press('common.retry');
      assert.equal(ctx.reads.length, 2);
      assert.equal(ctx.writes.length, 0);
      await noUnknownMutation(ctx);
    } finally { ctx.h.unmount(); }
  });
}

test('successful card:null remains a valid first-time enable and preserves the returned one-time link', async () => {
  const ctx = setup();
  try {
    await ctx.hydrate(null);
    await ctx.press('emergency.qrEnable');
    assert.equal(ctx.writes.length, 1);
    assert.equal(ctx.writes[0].route, '/v1/emergency/qr/enable');
    assert.equal(ctx.writes[0].payload, undefined);
    assert.equal(ctx.writes[0].query.profileId, 'A');
    ctx.writes[0].resolve({ enabled: true, qrUrl });
    await ctx.h.flush();
    assert.equal(ctx.reads.length, 2);
    assert.ok(ctx.h.text().includes(qrUrl), 'do not lose a committed one-time link while refreshing the card');
    await ctx.press('emergency.qrCopy');
    assert.deepEqual(ctx.copied, [qrUrl]);
    await ctx.hydrate(card(true));
    assert.ok(ctx.button('emergency.qrRotate'));
    assert.ok(ctx.button('emergency.qrDisable'));
    assert.equal(ctx.button('emergency.qrEnable'), null);
  } finally { ctx.h.unmount(); }
});

test('hydrated disabled card preserves existing disclosure values and explicit enable', async () => {
  const ctx = setup();
  try {
    await ctx.hydrate(card(false));
    for (const text of [
      'emergency.includeMedications — common.off',
      'emergency.includeAllergies — common.on',
      'emergency.includeContacts — common.off',
    ]) assert.ok(ctx.h.text().includes(text));
    assert.ok(ctx.button('emergency.qrEnable'));
    assert.equal(ctx.button('emergency.qrRotate'), null);
    assert.equal(ctx.writes.length, 0);
  } finally { ctx.h.unmount(); }
});

test('hydrated enabled card offers rotate with its warning and disable, never first-time enable', async () => {
  const ctx = setup();
  try {
    await ctx.hydrate(card(true));
    assert.ok(ctx.button('emergency.qrDisable'));
    assert.equal(ctx.button('emergency.qrRotate').accessibilityHint, 'emergency.qrRotateWarning');
    assert.equal(ctx.button('emergency.qrEnable'), null);
    assert.ok(ctx.h.text().includes('emergency.qrRotateWarning'));
    assert.equal(ctx.writes.length, 0);
  } finally { ctx.h.unmount(); }
});

for (const enabled of [true, false]) {
  test(`conditions disclosure reflects server includeConditions=${enabled}`, async () => {
    const ctx = setup();
    try {
      await ctx.hydrate(card(false, enabled));
      assert.ok(ctx.h.text().includes(`emergency.includeConditions — common.${enabled ? 'on' : 'off'}`),
        'what a scan reveals must include the existing conditions-note disclosure flag');
      assert.equal(ctx.writes.length, 0);
    } finally { ctx.h.unmount(); }
  });
}

test('retry after an initial failure discovers an already-enabled QR without rotating it', async () => {
  const ctx = setup();
  try {
    ctx.reads[0].reject(new NetworkError());
    await ctx.h.flush();
    await ctx.press('common.retry');
    await ctx.hydrate(card(true));
    assert.ok(ctx.button('emergency.qrRotate'));
    assert.equal(ctx.button('emergency.qrEnable'), null);
    assert.equal(ctx.writes.length, 0);
  } finally { ctx.h.unmount(); }
});

test('committed enable plus failed refresh keeps the one-time link; retry never replays the mutation', async () => {
  for (const error of [new NetworkError(), new ApiError('internal_error')]) {
    const ctx = setup();
    try {
      await ctx.hydrate(card(false));
      await ctx.press('emergency.qrEnable');
      ctx.writes[0].resolve({ enabled: true, qrUrl });
      await ctx.h.flush();
      ctx.reads[1].reject(error);
      await ctx.h.flush();
      assert.ok(ctx.h.text().includes(qrUrl));
      await noUnknownMutation(ctx);
      await ctx.press('common.retry');
      assert.equal(ctx.reads.length, 3);
      await ctx.hydrate(card(true));
      assert.equal(ctx.writes.length, 1);
      assert.ok(ctx.h.text().includes(qrUrl));
      assert.ok(ctx.button('emergency.qrDisable'));
    } finally { ctx.h.unmount(); }
  }
});

test('committed disable plus failed refresh removes the link and retry never repeats the disable', async () => {
  const ctx = setup();
  try {
    await ctx.hydrate(card(false));
    await ctx.press('emergency.qrEnable');
    ctx.writes[0].resolve({ enabled: true, qrUrl });
    await ctx.h.flush();
    await ctx.hydrate(card(true));
    await ctx.press('emergency.qrDisable');
    assert.equal(ctx.writes[1].route, '/v1/emergency/qr/disable');
    ctx.writes[1].resolve({ enabled: false });
    await ctx.h.flush();
    ctx.reads[2].reject(new NetworkError());
    await ctx.h.flush();
    assert.ok(!ctx.h.text().includes(qrUrl));
    await noUnknownMutation(ctx);
    await ctx.press('common.retry');
    await ctx.hydrate(card(false));
    assert.equal(ctx.writes.length, 2);
    assert.ok(ctx.button('emergency.qrEnable'));
  } finally { ctx.h.unmount(); }
});

test('no active profile renders the profile selection state without QR actions', async () => {
  const ctx = setup();
  try {
    ctx.h.switchProfile(null);
    await ctx.h.flush();
    assert.ok(ctx.h.text().includes('settings.switchProfile'));
    await noUnknownMutation(ctx);
  } finally { ctx.h.unmount(); }
});

test('profile switch removes an emitted one-time link in the first new-profile frame', async () => {
  const ctx = setup();
  try {
    await ctx.hydrate(card(false));
    await ctx.press('emergency.qrEnable');
    ctx.writes[0].resolve({ enabled: true, qrUrl });
    await ctx.h.flush();
    assert.ok(ctx.h.text().includes(qrUrl));
    ctx.h.switchProfile('B', false);
    assert.ok(!ctx.h.text().includes(qrUrl));
    assert.equal(ctx.button('emergency.qrEnable'), null);
  } finally { ctx.h.unmount(); }
});

test('late old-profile card response cannot enable actions for the new profile', async () => {
  const ctx = setup();
  try {
    ctx.h.switchProfile('B');
    await ctx.hydrate(card(true), 0);
    await noUnknownMutation(ctx);
    await ctx.hydrate(card(false), 1);
    await ctx.press('emergency.qrEnable');
    assert.equal(ctx.writes.length, 1);
    assert.equal(ctx.writes[0].query.profileId, 'B');
  } finally { ctx.h.unmount(); }
});
