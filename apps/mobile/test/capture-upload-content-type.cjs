/** Actual capture TSX + keyed request hook; controlled I/O, not native/browser E2E. */
const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
const { createHarness, deferred, NetworkError } = require('./profile-screen-harness.cjs');

const screen = path.resolve(__dirname, '../app/medication/capture.tsx');
const hook = path.resolve(__dirname, '../src/hooks/useRequestScope.ts');

class ApiError extends Error {
  constructor(code, status = 400, message = code) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function setup({ assetMimeType, blobType }) {
  const requests = [];
  const picker = {
    requestMediaLibraryPermissionsAsync: async () => ({ granted: true }),
    launchImageLibraryAsync: async () => ({
      canceled: false,
      assets: [{ uri: 'file://synthetic-image', mimeType: assetMimeType }],
    }),
  };
  const fetchCalls = [];
  const controlledFetch = async (url, options) => {
    fetchCalls.push({ url, options });
    if (url === 'file://synthetic-image') {
      return { blob: async () => ({ type: blobType, size: 321 }) };
    }
    return { ok: true };
  };
  const api = {
    post: (route, body) => {
      const gate = deferred();
      requests.push({ route, body, ...gate });
      return gate.promise;
    },
    put: () => Promise.resolve({}),
  };
  const h = createHarness(screen, hook, {}, {
    __globals: { fetch: controlledFetch },
    'react-native': {
      __esModule: true,
      Platform: { OS: 'ios' },
      View: 'View',
    },
    'expo-router': {
      router: { replace() {}, back() {}, push() {} },
      useLocalSearchParams: () => ({ mode: 'upload' }),
    },
    'expo-image-picker': picker,
    '@/api/client': { NetworkError, ApiError, api },
    '@/storage/medication-draft': {
      clearMedicationDrafts() {},
      setMedicationConfirmDraft() {},
    },
  });
  const choose = h.find('Button', props => props.label === 'capture.chooseFile');
  assert.ok(choose, 'upload mode must expose choose file');
  return { h, requests, fetchCalls, choose };
}

async function chooseAndFlush(ctx) {
  ctx.choose.onPress();
  await ctx.h.flush();
}

for (const mime of ['image/png', 'image/webp', 'image/heic']) {
  test(`picker MIME ${mime} is preserved when React Native Blob.type is empty`, async () => {
    const ctx = setup({ assetMimeType: mime, blobType: '' });
    try {
      await chooseAndFlush(ctx);
      assert.equal(ctx.requests.length, 1);
      assert.equal(ctx.requests[0].route, '/v1/uploads/request');
      // The screen runs in the VM harness, so its object prototype belongs to a
      // different realm. Normalize through JSON before structural comparison;
      // this keeps the regression about the request payload rather than realm
      // identity while still pinning every serialized field and value.
      assert.deepEqual(JSON.parse(JSON.stringify(ctx.requests[0].body)), {
        purpose: 'medication_image',
        contentType: mime,
        byteSize: 321,
        patientProfileId: 'A',
      });
    } finally { ctx.h.unmount(); }
  });
}

test('an allowed Blob.type remains authoritative when picker metadata is absent', async () => {
  const ctx = setup({ assetMimeType: null, blobType: 'image/webp' });
  try {
    await chooseAndFlush(ctx);
    assert.equal(ctx.requests.length, 1);
    assert.equal(ctx.requests[0].body.contentType, 'image/webp');
  } finally { ctx.h.unmount(); }
});

test('an explicit unsupported picker MIME fails closed before requesting an upload lease', async () => {
  const ctx = setup({ assetMimeType: 'image/gif', blobType: '' });
  try {
    await chooseAndFlush(ctx);
    assert.equal(ctx.requests.length, 0);
    assert.equal(ctx.fetchCalls.length, 1, 'must inspect only the local file and never contact an upload URL');
    assert.ok(ctx.h.find('Banner', props => props.tone === 'danger'));
  } finally { ctx.h.unmount(); }
});

test('a conflicting non-image Blob.type without picker metadata fails closed', async () => {
  const ctx = setup({ assetMimeType: null, blobType: 'application/octet-stream' });
  try {
    await chooseAndFlush(ctx);
    assert.equal(ctx.requests.length, 0);
    assert.ok(ctx.h.find('Banner', props => props.tone === 'danger'));
  } finally { ctx.h.unmount(); }
});