/** Actual stock TSX + request hook with controlled I/O; not native/browser E2E. */
const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
const { createHarness, deferred, NetworkError, ApiError } = require('./profile-screen-harness.cjs');

const screen = path.resolve(__dirname, '../app/medication/stock.tsx');
const hook = path.resolve(__dirname, '../src/hooks/useRequestScope.ts');
const medicationId = (profileId = 'A') => `synthetic-stock-${profileId}`;
const detail = (name = 'SYNTHETIC-STOCK-A') => ({ medication: { name } });
const stockResponse = (unit = 'ml') => ({
  stock: { unit, initialQuantity: 20, remainingQuantity: 9, trackingEnabled: true,
    lowStockThresholdDays: 7, lastRefillAt: null },
  forecast: null, transactions: [], refills: [],
});

function setup({ missingIntent = false, mutation } = {}) {
  let requestSequence = 0;
  const reads = [], writes = [], snoozeWrites = [], navigations = [];
  const record = async (method, route, payload) => {
    writes.push({ method, route, payload: JSON.parse(JSON.stringify(payload)) });
    return mutation ? mutation(writes.length) : {};
  };
  const h = createHarness(screen, hook, {
    permissions: ['view_medications', 'view_schedule', 'update_stock'],
  }, {
    '@/storage/offline-queue': { newClientEventId: () => `refill-request-${++requestSequence}` },
    'expo-router': { router: { back: () => { navigations.push('back'); } } },
    '@/navigation/private-navigation': {
      getMedicationStockRouteIntent: (userId, patientProfileId) =>
        !missingIntent && userId === 'synthetic-account'
          ? { userId, patientProfileId, medicationId: medicationId(patientProfileId) }
          : null,
    },
    '@/components/DateField': { todayLocalDate: () => '2026-09-13' },
    '@/storage/low-stock-snooze': {
      readSnooze: async () => null,
      clearSnooze: async (...args) => { snoozeWrites.push({ action: 'clear', args }); },
      setSnooze: async (...args) => { snoozeWrites.push({ action: 'set', args }); },
    },
    '@/api/client': { NetworkError, ApiError, api: {
      get: (route) => {
        const gate = deferred();
        reads.push({ route, ...gate });
        return gate.promise;
      },
      post: (route, payload) => record('POST', route, payload),
      put: (route, payload) => record('PUT', route, payload),
    } },
    '@dawaee/shared': { DOSE_UNITS: ['tablet', 'ml'] },
  });
  const button = (label) => h.find('Button', p => p.label === label);
  const field = (label) => {
    const value = h.find('Field', p => p.label === label);
    assert.ok(value, `missing field ${label}`);
    return value;
  };
  const set = async (label, value) => { field(label).onChangeText(value); await h.flush(); };
  const press = async (label) => {
    const value = button(label);
    assert.ok(value, `missing button ${label}`);
    assert.ok(!value.disabled && !value.loading, `${label} is not actionable`);
    value.onPress();
    await h.flush();
  };
  const answer = async (batch = reads.slice(0, 2), stock = stockResponse(), name) => {
    assert.equal(batch.length, 2);
    for (const read of batch) read.resolve(read.route.endsWith('/stock') ? stock : detail(name));
    await h.flush();
  };
  return { h, reads, writes, snoozeWrites, navigations, button, field, set, press, answer };
}

async function ready() {
  const ctx = setup();
  await ctx.answer();
  await ctx.press('stock.markRefilled');
  await ctx.set('refill.quantityAdded', '2,5');
  return ctx;
}

for (const failedPart of ['stock', 'detail']) {
  for (const failure of ['network', 'api']) {
    test(`${failedPart} ${failure} load failure cannot submit a default-unit refill or show false empty states`, async () => {
      const ctx = setup();
      try {
        for (const read of ctx.reads.slice()) {
          const part = read.route.endsWith('/stock') ? 'stock' : 'detail';
          if (part === failedPart) read.reject(failure === 'network'
            ? new NetworkError('controlled offline') : new ApiError('internal_error'));
          else read.resolve(part === 'stock' ? stockResponse() : detail());
        }
        await ctx.h.flush();
        const failedFrame = ctx.h.text();
        // Exercise the actual dangerous path on the old screen if it is exposed.
        if (ctx.button('stock.markRefilled')) {
          await ctx.press('stock.markRefilled');
          await ctx.set('refill.quantityAdded', '2');
          await ctx.press('refill.save');
        }
        assert.equal(ctx.writes.length, 0, 'a failed hydration must not POST a refill with the default tablet unit');
        assert.deepEqual(ctx.snoozeWrites, []);
        for (const label of ['stock.notTracked', 'refill.none', 'stock.noHistory']) {
          assert.ok(!failedFrame.includes(label), `load failure must not imply ${label}`);
        }
        assert.ok(ctx.h.find('Banner', p => p.tone === 'danger'));
        assert.ok(ctx.button('common.back'));
        assert.equal(ctx.button('stock.markRefilled'), null);
      } finally { ctx.h.unmount(); }
    });
  }
}

test('partial hydration stays non-mutating until both GETs succeed and preserves the loaded unit', async () => {
  const ctx = setup();
  try {
    assert.equal(ctx.reads.length, 2);
    assert.ok(ctx.h.find('Loading'));
    ctx.reads.find(r => r.route.endsWith('/stock')).resolve(stockResponse('ml'));
    await ctx.h.flush();
    assert.ok(ctx.h.find('Loading'));
    assert.equal(ctx.button('stock.markRefilled'), null);
    assert.deepEqual(ctx.writes, []);
    ctx.reads.find(r => !r.route.endsWith('/stock')).resolve(detail());
    await ctx.h.flush();
    await ctx.press('stock.markRefilled');
    assert.equal(ctx.h.find('Picker', p => p.label === 'schedule.doseUnit').value, 'ml');
  } finally { ctx.h.unmount(); }
});

test('missing route intent remains not-found with no reads, refill, or retry', async () => {
  const ctx = setup({ missingIntent: true });
  try {
    await ctx.h.flush();
    assert.deepEqual(ctx.reads, []);
    assert.ok(ctx.h.find('Banner', p => p.title === 'error.not_found'));
    assert.equal(ctx.button('stock.markRefilled'), null);
    assert.equal(ctx.button('common.retry'), null);
    await ctx.press('common.back');
    assert.deepEqual(ctx.navigations, ['back']);
  } finally { ctx.h.unmount(); }
});

test('successful response with stock null is legitimate untracked state, not failed hydration', async () => {
  const ctx = setup();
  try {
    await ctx.answer(undefined, { stock: null, forecast: null, transactions: [], refills: [] });
    assert.ok(ctx.h.text().includes('stock.notTracked'));
    assert.ok(ctx.h.text().includes('refill.none'));
    await ctx.press('stock.markRefilled');
    await ctx.set('refill.quantityAdded', '1');
    await ctx.press('refill.save');
    assert.equal(ctx.writes.length, 1);
    assert.equal(ctx.writes[0].payload.unit, 'tablet');
  } finally { ctx.h.unmount(); }
});

test('explicit retry recovers from failure without writing until the user saves', async () => {
  const ctx = setup();
  try {
    ctx.reads[0].reject(new NetworkError('controlled offline'));
    ctx.reads[1].resolve(detail());
    await ctx.h.flush();
    await ctx.press('common.retry');
    assert.ok(ctx.h.find('Loading'));
    assert.equal(ctx.reads.length, 4);
    assert.deepEqual(ctx.writes, []);
    await ctx.answer(ctx.reads.slice(2), stockResponse('ml'));
    assert.equal(ctx.h.find('Banner', p => p.tone === 'danger'), null);
    await ctx.press('stock.markRefilled');
    await ctx.set('refill.quantityAdded', '4');
    await ctx.press('refill.save');
    assert.equal(ctx.writes.length, 1);
    assert.deepEqual(ctx.writes[0], {
      method: 'POST', route: `/v1/medications/${medicationId()}/refill`,
      payload: { clientRequestId: 'refill-request-1', quantityAdded: 4, unit: 'ml', pharmacy: null, cost: null, note: null },
    });
  } finally { ctx.h.unmount(); }
});

test('failed refresh after a successful adjustment blocks further writes until an explicit retry', async () => {
  const ctx = setup();
  try {
    await ctx.answer();
    await ctx.press('+ 1');
    assert.deepEqual(ctx.writes, [{ method: 'PUT', route: `/v1/medications/${medicationId()}/stock`,
      payload: { delta: 1, reason: 'manual_correction' } }]);
    assert.equal(ctx.reads.length, 4);
    ctx.reads[2].reject(new NetworkError('controlled refresh failure'));
    ctx.reads[3].resolve(detail());
    await ctx.h.flush();
    assert.equal(ctx.button('+ 1'), null, 'stale stock must not remain actionable after a failed refresh');
    assert.equal(ctx.button('stock.markRefilled'), null);
    await ctx.press('common.retry');
    await ctx.answer(ctx.reads.slice(4), stockResponse('ml'));
    assert.equal(ctx.writes.length, 1, 'retry must not replay the already committed adjustment');
    assert.ok(ctx.button('+ 1'));
  } finally { ctx.h.unmount(); }
});

for (const invalid of ['abc', '1,2,3', 'Infinity', '1e309', '-1', '1000001']) {
  test(`entered cost ${JSON.stringify(invalid)} is rejected rather than erased or sent outside the API contract`, async () => {
    const ctx = await ready();
    try {
      await ctx.set('refill.cost', invalid);
      await ctx.press('refill.save');
      assert.equal(ctx.writes.length, 0, 'invalid supplied cost must not be sent as null or as an out-of-range number');
      assert.equal(ctx.field('refill.cost').value, invalid);
      assert.equal(ctx.field('refill.quantityAdded').value, '2,5');
      assert.ok(ctx.h.find('Banner', p => p.title === 'error.validation_failed'));
      assert.deepEqual(ctx.snoozeWrites, []);
      assert.equal(ctx.reads.length, 2);
    } finally { ctx.h.unmount(); }
  });
}

for (const [input, expected] of [['', null], ['   ', null], ['0', 0], ['12,50', 12.5], ['1000000', 1000000]]) {
  test(`valid optional cost ${JSON.stringify(input)} preserves intent and the hydrated medication/unit`, async () => {
    const ctx = await ready();
    try {
      await ctx.set('refill.cost', input);
      await ctx.set('refill.pharmacy', ' synthetic pharmacy ');
      await ctx.set('refill.note', ' synthetic note ');
      await ctx.press('refill.save');
      assert.deepEqual(ctx.writes, [{ method: 'POST', route: `/v1/medications/${medicationId()}/refill`,
        payload: { clientRequestId: 'refill-request-1', quantityAdded: 2.5, unit: 'ml', pharmacy: 'synthetic pharmacy', cost: expected, note: 'synthetic note' } }]);
      assert.deepEqual(ctx.snoozeWrites, [{ action: 'clear', args: ['synthetic-account', medicationId(), '2026-09-13'] }]);
      assert.equal(ctx.reads.length, 4);
    } finally { ctx.h.unmount(); }
  });
}

test('a profile switch does not let an old hydration unlock the new profile stock screen', async () => {
  const ctx = setup();
  try {
    const oldReads = ctx.reads.slice();
    ctx.h.switchProfile('B', false);
    assert.ok(ctx.h.find('Loading'));
    assert.equal(ctx.button('stock.markRefilled'), null);
    await ctx.h.flush();
    const newReads = ctx.reads.slice(2);
    assert.equal(newReads.length, 2);
    await ctx.answer(oldReads, stockResponse('tablet'), 'SYNTHETIC-OLD-A');
    assert.ok(ctx.h.find('Loading'));
    assert.ok(!ctx.h.text().includes('SYNTHETIC-OLD-A'));
    await ctx.answer(newReads, stockResponse('ml'), 'SYNTHETIC-NEW-B');
    await ctx.press('stock.markRefilled');
    await ctx.set('refill.quantityAdded', '3');
    await ctx.press('refill.save');
    assert.equal(ctx.writes.length, 1);
    assert.equal(ctx.writes[0].route, `/v1/medications/${medicationId('B')}/refill`);
    assert.equal(ctx.writes[0].payload.unit, 'ml');
  } finally { ctx.h.unmount(); }
});


test('two same-frame save presses send only one refill', async () => {
  const gate = deferred();
  const ctx = setup({ mutation: () => gate.promise });
  try {
    await ctx.answer(); await ctx.press('stock.markRefilled');
    await ctx.set('refill.quantityAdded', '5');
    const save = ctx.button('refill.save').onPress;
    save(); save(); await ctx.h.flush();
    assert.equal(ctx.writes.length, 1);
  } finally { gate.resolve({}); await ctx.h.flush(); ctx.h.unmount(); }
});

test('ambiguous network retry preserves the refill request identity', async () => {
  const ctx = setup({ mutation: attempt => { if (attempt === 1) throw new NetworkError(); return {}; } });
  try {
    await ctx.answer(); await ctx.press('stock.markRefilled');
    await ctx.set('refill.quantityAdded', '5'); await ctx.press('refill.save');
    const first = ctx.writes[0];
    assert.ok(first.payload.clientRequestId);
    await ctx.press('refill.save');
    assert.deepEqual(ctx.writes[1], first);
  } finally { ctx.h.unmount(); }
});

test('a new refill after acknowledged success uses a new request identity', async () => {
  const ctx = await ready();
  try {
    await ctx.press('refill.save'); const first = ctx.writes[0].payload.clientRequestId;
    assert.ok(first); await ctx.answer(ctx.reads.slice(2));
    await ctx.press('stock.markRefilled'); await ctx.set('refill.quantityAdded', '2,5');
    await ctx.press('refill.save');
    assert.notEqual(ctx.writes[1].payload.clientRequestId, first);
  } finally { ctx.h.unmount(); }
});
