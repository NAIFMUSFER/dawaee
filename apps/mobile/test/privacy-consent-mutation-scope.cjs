const assert = require('node:assert/strict');
const { createHarness, deferred, NetworkError, ApiError } = require('./profile-screen-harness.cjs');

/** Controlled I/O around the actual TSX and request hook. No native/browser
 * delivery claim, external request, production data, or runtime-source edit. */
function scenarios(screen, hook) {
  function fixture() {
    const reads = [], writes = [];
    const api = {
      get: (route) => {
        const gate = deferred();
        reads.push({ route, ...gate });
        return gate.promise;
      },
      put: (route, body) => {
        const gate = deferred();
        writes.push({ route, body, ...gate });
        return gate.promise;
      },
    };
    const h = createHarness(screen, hook, {}, { '@/api/client': { api, NetworkError, ApiError } });
    const toggle = (label = 'privacy.ocr') => h.find('Switch', (p) => p.accessibilityLabel === label);
    const load = async (profileId = 'A', granted = true) => {
      const read = reads.at(-1);
      assert.equal(read.route, '/v1/me');
      read.resolve({ consents: [
        { type: 'ocr_image_processing', granted, patientProfileId: profileId },
        { type: 'analytics', granted: true, patientProfileId: profileId },
      ] });
      await h.flush();
    };
    return { h, reads, writes, toggle, load };
  }

  const cases = [
    ['a pending A mutation does not disable B after B loads', async (f) => {
      const { h, writes, toggle, load } = f;
      await load();
      toggle().onValueChange(false);
      await h.flush();
      assert.equal(writes[0].body.patientProfileId, 'A');
      assert.equal(toggle().disabled, true);
      h.switchProfile('B');
      await load('B');
      assert.equal(toggle().value, true);
      assert.equal(Boolean(toggle().disabled), false, 'A must not keep B disabled');
    }],
    ...[
      ['network', () => new NetworkError('synthetic A failure')],
      ['API', () => new ApiError('synthetic_A_failure')],
    ].map(([kind, failure]) => [`a late ${kind} failure from A does not publish a banner in B`, async (f) => {
      const { h, writes, toggle, load } = f;
      await load();
      toggle().onValueChange(false);
      await h.flush();
      h.switchProfile('B');
      await load('B');
      writes[0].reject(failure());
      await h.flush();
      assert.equal(toggle().value, true);
      assert.equal(h.find('Banner', (p) => p.tone === 'warning' || p.tone === 'danger'), null);
    }]),
    ['A to B to A does not resurrect a rollback from the first A visit', async (f) => {
      const { h, writes, toggle, load } = f;
      await load();
      toggle().onValueChange(false);
      await h.flush();
      h.switchProfile('B');
      await load('B');
      h.switchProfile('A');
      await load('A', false);
      assert.equal(toggle().value, false);
      writes[0].reject(new ApiError('synthetic_old_A_failure'));
      await h.flush();
      assert.equal(toggle().value, false, 'an equal profile key is not the same request lifetime');
      assert.equal(h.find('Banner', (p) => p.tone === 'danger'), null);
    }],
    ['completion in A cannot unlock a different consent still saving in B', async (f) => {
      const { h, writes, toggle, load } = f;
      await load();
      toggle().onValueChange(false);
      await h.flush();
      h.switchProfile('B');
      await load('B');
      assert.equal(Boolean(toggle('privacy.analytics').disabled), false);
      toggle('privacy.analytics').onValueChange(false);
      await h.flush();
      assert.equal(writes[1].body.patientProfileId, 'B');
      assert.equal(toggle('privacy.analytics').disabled, true);
      writes[0].resolve({});
      await h.flush();
      assert.equal(toggle('privacy.analytics').disabled, true, 'B still has an unsettled write');
      writes[1].resolve({});
      await h.flush();
      assert.equal(Boolean(toggle('privacy.analytics').disabled), false);
    }],
    ['different consent rows retain independent pending writes within one profile', async (f) => {
      const { h, writes, toggle, load } = f;
      await load();
      toggle().onValueChange(false);
      await h.flush();
      toggle('privacy.analytics').onValueChange(false);
      await h.flush();
      assert.equal(writes.length, 2);
      assert.equal(toggle().disabled, true, 'OCR must remain disabled while its own write is pending');
      assert.equal(toggle('privacy.analytics').disabled, true);
      writes[0].resolve({});
      await h.flush();
      assert.equal(Boolean(toggle().disabled), false);
      assert.equal(toggle('privacy.analytics').disabled, true);
      writes[1].resolve({});
      await h.flush();
      assert.equal(Boolean(toggle('privacy.analytics').disabled), false);
    }],
    ['a current-profile failure still rolls back, explains the error, and unlocks', async (f) => {
      const { h, writes, toggle, load } = f;
      await load();
      toggle().onValueChange(false);
      await h.flush();
      assert.equal(toggle().value, false);
      writes[0].reject(new ApiError('synthetic_current_failure'));
      await h.flush();
      assert.equal(toggle().value, true);
      assert.equal(Boolean(toggle().disabled), false);
      assert.equal(h.find('Banner', (p) => p.tone === 'danger')?.title, 'privacy.consentFailed');
    }],
    ['an unloaded new profile cannot submit a made-up default before its loading effect', async (f) => {
      const { h, writes, toggle, load } = f;
      await load();
      h.switchProfile('B', false);
      const current = toggle();
      assert.ok(!current || current.disabled, 'unknown B consent must not be an enabled false switch');
      current?.onValueChange(true);
      assert.equal(writes.length, 0);
      await h.flush();
      await load('B');
      assert.equal(Boolean(toggle().disabled), false);
    }],
    ['no active profile leaves consent controls non-actionable', async (f) => {
      const { h, writes, toggle, load } = f;
      await load();
      h.switchProfile(null);
      await load(null);
      const current = toggle();
      assert.ok(!current || current.disabled);
      current?.onValueChange(false);
      await h.flush();
      assert.equal(writes.length, 0);
    }],
  ];
  return cases.map(([name, run]) => ({
    name,
    run: async () => {
      const f = fixture();
      try { await run(f); } finally { f.h.unmount(); }
    },
  }));
}
module.exports = { scenarios };
