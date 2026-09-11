const assert = require('node:assert/strict');
const path = require('node:path');
const { createHarness, deferred, ApiError, NetworkError } = require('./profile-screen-harness.cjs');

// Exercise the checked-in screen with controlled I/O, never a rewritten copy.
// This is a screen-boundary regression, not native or browser E2E.
const screen = path.resolve(__dirname, '../app/medication/capture.tsx');
const hook = path.resolve(__dirname, '../src/hooks/useRequestScope.ts');
const OBJECT_KEY = 'synthetic-capture/A/label.png';

function makeHarness() {
  const rawUpload = deferred();
  const drafts = [];
  const navigation = [];
  const puts = [];
  const h = createHarness(screen, hook, {}, {
    __globals: {
      fetch: async (url, init) => {
        if (url === 'file://synthetic-label') return { blob: async () => ({ type: 'image/png', size: 32 }) };
        assert.equal(url, 'https://storage.invalid/synthetic-upload');
        puts.push(init);
        return rawUpload.promise;
      },
    },
    'expo-router': {
      useLocalSearchParams: () => ({ mode: 'upload' }),
      router: { replace: (route) => navigation.push(route), back: () => undefined },
    },
    'expo-image-picker': {
      requestMediaLibraryPermissionsAsync: async () => ({ granted: true }),
      launchImageLibraryAsync: async () => ({ canceled: false, assets: [{ uri: 'file://synthetic-label' }] }),
    },
    '@/storage/medication-draft': {
      clearMedicationDrafts: () => undefined,
      setMedicationConfirmDraft: (draft) => drafts.push(draft),
    },
  });
  return { h, rawUpload, drafts, navigation, puts };
}

function requests(h, route) { return h.requests.filter((r) => r.route === route); }
function one(h, route) {
  const values = requests(h, route);
  assert.equal(values.length, 1, `exactly one ${route} request is required`);
  return values[0];
}
function noOcr(f) {
  assert.equal(requests(f.h, '/v1/ocr/analyze').length, 0, 'OCR must wait for successful finalization');
  assert.equal(f.drafts.length, 0);
  assert.equal(f.navigation.length, 0);
}
async function startUpload(f) {
  const choose = f.h.find('Button', (p) => p.label === 'capture.chooseFile');
  assert.ok(choose);
  choose.onPress();
  await f.h.flush();
  const ticket = one(f.h, '/v1/uploads/request');
  assert.equal(ticket.payload.patientProfileId, 'A');
  ticket.resolve({
    objectKey: OBJECT_KEY,
    upload: { uploadUrl: 'https://storage.invalid/synthetic-upload', method: 'PUT', headers: { 'content-type': 'image/png' } },
  });
  await f.h.flush();
  assert.equal(f.puts.length, 1);
  assert.equal(f.puts[0].method, 'PUT');
}
async function startFinalization(f) {
  await startUpload(f);
  f.rawUpload.resolve({ ok: true, status: 200 });
  await f.h.flush();
  const finalize = one(f.h, '/v1/uploads/finalize');
  assert.equal(finalize.method, 'POST');
  assert.deepEqual(JSON.parse(JSON.stringify(finalize.payload)), { objectKey: OBJECT_KEY });
  noOcr(f);
  return finalize;
}
function scenario(name, run) {
  return { name, run: async () => {
    const f = makeHarness();
    try { await run(f); } finally { f.h.unmount(); }
  } };
}
function scenarios() {
  return [
    scenario('a rejected finalization cannot reach OCR or confirmation and remains recoverable', async (f) => {
      const finalize = await startFinalization(f);
      finalize.reject(new ApiError('upload_rejected'));
      await f.h.flush();
      noOcr(f);
      assert.equal(f.h.find('Loading'), null);
      assert.ok(f.h.find('Banner', (p) => p.tone === 'danger'));
      assert.ok(f.h.find('Button', (p) => p.label === 'medication.manualEntry'));
    }),
    scenario('a finalization network failure preserves offline feedback without bypassing verification', async (f) => {
      const finalize = await startFinalization(f);
      finalize.reject(new NetworkError('controlled finalization outage'));
      await f.h.flush();
      noOcr(f);
      assert.deepEqual(f.h.offlineWrites, [true]);
      assert.ok(f.h.find('Banner', (p) => p.title === 'notifications.offlineBanner'));
    }),
    scenario('late finalization failure cannot mark the next profile offline or show its error', async (f) => {
      const finalize = await startFinalization(f);
      f.h.switchProfile('B', false);
      finalize.reject(new NetworkError('old profile outage'));
      await f.h.flush();
      noOcr(f);
      assert.deepEqual(f.h.offlineWrites, []);
      assert.equal(f.h.find('Banner'), null);
    }),
    scenario('unmounting during finalization prevents OCR and draft side effects', async (f) => {
      const finalize = await startFinalization(f);
      f.h.unmount();
      finalize.resolve({ ok: true, objectKey: OBJECT_KEY });
      await f.h.flush();
      noOcr(f);
    }),
    scenario('a failed object PUT is never finalized or analyzed', async (f) => {
      await startUpload(f);
      f.rawUpload.resolve({ ok: false, status: 403 });
      await f.h.flush();
      assert.equal(requests(f.h, '/v1/uploads/finalize').length, 0);
      noOcr(f);
      assert.ok(f.h.find('Banner', (p) => p.tone === 'danger'));
    }),
    scenario('a profile switch while object PUT is pending stops finalization too', async (f) => {
      await startUpload(f);
      f.h.switchProfile('B', false);
      f.rawUpload.resolve({ ok: true, status: 200 });
      await f.h.flush();
      assert.equal(requests(f.h, '/v1/uploads/finalize').length, 0);
      noOcr(f);
    }),
  ];
}
module.exports = { scenarios };
